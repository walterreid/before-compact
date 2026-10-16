// Drives hooks/register.js through one simulated compaction with a stub mods API.
// Run from the plugin directory: claude plugin test   (needs Claude Code 2.1.287+)
//
// What it proves: the PreCompact hook snapshots the context, the SessionStart(compact)
// hook picks up the status records the script wrote, the first settle completes the log
// entry with the after-numbers, the second settle does not duplicate it, and the pane
// draws the row with two ✓ marks. What it cannot prove: that a live session fires these
// events, or the .catch handlers (nothing in the mod can be made to throw from a stub).
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const SESSION = 'sess1'
const STATUS = `${HOME}/.claude/before-compact/status-${SESSION}.json`
const BUNDLE = '/data/precompact-sess1.txt'

// The two records scripts/extract_tail.mjs writes (see recordStatus there).
const STATUS_LOG = [
  { at: '2026-10-16T14:58:00.000Z', event: 'PreCompact', trigger: 'manual', written: true, bundle: BUNDLE,
    turns: 32, chars: 4000, tokens_est: 1000, transcript: '/x.jsonl' },
  { at: '2026-10-16T14:58:05.000Z', event: 'SessionStart', source: 'compact', origin: 'prepared by the PreCompact hook',
    chars: 4100, tokens_est: 1025, bundle: BUNDLE, transcript: '/x.jsonl' },
]

// What Claude Code passes to the ui.render hook for this pane.
const PANE = {
  plugin: 'before-compact',
  component: 'Pane',
  requestId: 'before-compact',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Before Compact', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('one compaction: snapshot before, status after, one completed row in the pane', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME })

  // Live numbers the mod reads; the test changes them between the two events.
  let live = { tokens: 82000, window: 200000, percent: 41 }
  let messages = 143
  on('session.usage', () => ({ value: { startedAt: 0, context: live, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: Array.from({ length: messages }, () => ({ role: 'user', text: 'x', toolUses: [] })) }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/work' }))

  // Filesystem: the status file and the bundle exist; nothing else does, so
  // findTranscript returns null and --probe is never run.
  on('fs.exists', ($, e) => ({ value: e.path === STATUS || e.path === BUNDLE }))
  on('fs.read', ($, e) => ({ value: e.path === STATUS ? JSON.stringify(STATUS_LOG) : e.path === BUNDLE ? 'LAST BEFORE COMPACTION' : '' }))
  on('process.run', () => ({ deny: 'process.run must not be called when no transcript was found' }))

  const toasts: string[] = []
  const logs: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })

  // Answer the classic events after the mod passes them on with next(e).
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))

  // --- before: Claude Code is about to compact ---
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'manual' })
  expect(toasts).toEqual(['Compaction starting — saving your last turns'])

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /compacting now \(manual\) — before: 82k tokens, 143 messages/ })).toBeDefined()
  await ui.unmount()

  // --- after: the window was rewritten, the script has written both records ---
  live = { tokens: 19000, window: 200000, percent: 10 }
  messages = 7
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })

  // Nothing is read until the first settle at 1.5 s.
  await clock.advance(1000)
  expect(toasts.length).toBe(1)

  await clock.advance(500)
  expect(toasts).toEqual(['Compaction starting — saving your last turns', 'Restored 1k tokens of your voice'])
  expect(logs).toEqual(['compaction: 82k → 19k tokens, 143 → 7 messages; bundle re-injected'])

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}manual {3}82k → 19k tokens {3}143 → 7 messages$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact {2}✓ saved 32 user turns \(~1k tokens\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SessionStart ✓ re-injected ~1k tokens \(prepared by the PreCompact hook\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacting now/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /last error/ })).toBeUndefined()

  // The bundle tab shows what was put back.
  await ui.press({ key: 'tab-bundle' })
  expect(await ui.find({ type: 'Text', text: 'LAST BEFORE COMPACTION' })).toBeDefined()
  // The tab is module state, so go back to the monitor before the next mount.
  await ui.press({ key: 'tab-monitor' })
  await ui.unmount()

  // --- the second settle at 6 s must not add a second row or a second toast ---
  await clock.advance(4500)
  expect(toasts.length).toBe(2)
  expect(logs.length).toBe(1)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#2 / })).toBeUndefined()
  await ui.unmount()
})

test('a compaction with no status record shows two ✗ marks, not a crash', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50000, window: 200000, percent: 25 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))

  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'auto' })
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })
  await clock.advance(6000)

  // No record ever arrived, so the entry stays pending: the pane says so and shows no error.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /compacting now \(auto\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact save: waiting for the hook…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last error/ })).toBeUndefined()
  await ui.unmount()
})

test('a failed --probe shows the useful error line, not node\'s loader preamble', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME })
  const PROJ = `${HOME}/.claude/projects/-work`
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200000, percent: 1 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/work' }))
  // The projects dir exists and holds one transcript; nothing else exists.
  on('fs.exists', ($, e) => ({ value: e.path === PROJ }))
  on('fs.list', () => ({ value: [{ name: 'abc.jsonl' }] }))
  on('fs.stat', () => ({ value: { mtimeMs: 1 } }))
  // What node prints when the script path no longer exists (the stale-copy case).
  const STDERR = "node:internal/modules/cjs/loader:1573\n  throw err;\n  ^\n\nError: Cannot find module '/Users/walterreid/.claude/skills/before-compact/scripts/extract_tail.mjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1573:15)\n{\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v22.0.0\n"
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: STDERR } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const err = await ui.find({ type: 'Text', text: /^\(last error:/ })
  expect(err).toBeDefined()
  // The line must carry the module path, which is the only part that tells you what went wrong.
  expect(err!.text).toMatch(/Cannot find module '\/Users\/walterreid\/\.claude\/skills\/before-compact\/scripts\/extract_tail\.mjs'/)
  expect(err!.text).not.toMatch(/throw err/)
  // And the transcript line must not claim the transcript is missing when the probe is what failed.
  expect(await ui.find({ type: 'Text', text: /Transcript on disk: not found/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Transcript on disk: .*probe failed/ })).toBeDefined()
  await ui.unmount()
})
