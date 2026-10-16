// Drives hooks/register.js through simulated compactions with a stub mods API.
// Run from the plugin directory: claude plugin test   (needs Claude Code 2.1.287+)
//
// What it proves: the session.compact hook records the engine's own token and
// message counts, the trigger, the instructions, the duration and the summary the
// engine installed (the result's first message, shown on the Summary tab); the classic
// PreCompact and SessionStart hooks pick up the script's status records after their
// next(e); the pane draws the row with two ✓ marks; a precompute and a vetoed
// compaction leave no row; a subagent's compaction gets its own row; and the hook
// returns the result untouched (phase 1 observes only).
//
// The fold handles either order of the script's PreCompact record against the mod's
// session.compact hook: the first test has the record on disk when classic.PreCompact's
// next(e) resolves; 'the other order' test has it land only at SessionStart time, after
// session.compact has already made the row. What the tests cannot prove: which order a
// live engine uses, that a live SessionStart(compact) settings hook finishes inside the
// mod hook's next(e), or that $.state survives a real reload (the kit holds state for
// one test only).
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const SESSION = 'sess1'
const STATUS = `${HOME}/.claude/before-compact/status-${SESSION}.json`
const BUNDLE = '/data/precompact-sess1.txt'

// The two records scripts/extract_tail.mjs writes (see recordStatus there).
const ARC = '/data/arc-sess1.txt'
const PRE = { at: '2026-10-16T14:58:00.000Z', event: 'PreCompact', trigger: 'manual', written: true, bundle: BUNDLE,
  turns: 32, chars: 4000, tokens_est: 1000, arc: ARC, arc_written: true, arc_turns: 62, arc_chars: 44000, arc_tokens_est: 11000, transcript: '/x.jsonl' }
const POST = { at: '2026-10-16T14:58:05.000Z', event: 'SessionStart', source: 'compact', origin: 'prepared by the PreCompact hook',
  chars: 4100, tokens_est: 1025, bundle: BUNDLE, transcript: '/x.jsonl', injected: true }

// What Claude Code passes to the ui.render hook for this pane.
const PANE = {
  plugin: 'before-compact',
  component: 'Pane',
  requestId: 'before-compact',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Before Compact', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// A transcript of n messages in $.session.messages()'s shape, each with the
// engine's handle, as session.compact's e.messages carries them.
const transcript = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}`, toolUses: [], handle: `h${i}` } as const))

const SUMMARY = { role: 'user', text: 'This session is being continued from a previous conversation. Summary.', toolUses: [] } as const

// The stubs every test needs; `status` is what the status file holds right now.
function stubs($: any, on: any, status: { log: unknown[] }) {
  mock.clock(on)
  mock.env(on, { HOME })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 82000, window: 200000, percent: 41 }, rateLimits: [], cost: 0 } }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/work' }))
  // Filesystem: the status file (when it has records) and the bundle exist; nothing
  // else does, so findTranscript returns null and --probe is never run.
  on('fs.exists', ($: any, e: any) => ({ value: (e.path === STATUS && status.log.length > 0) || e.path === BUNDLE }))
  on('fs.read', ($: any, e: any) => ({ value: e.path === STATUS ? JSON.stringify(status.log) : e.path === BUNDLE ? 'LAST BEFORE COMPACTION' : '' }))
  on('process.run', () => ({ deny: 'process.run must not be called when no transcript was found' }))
  const toasts: string[] = []
  const logs: string[] = []
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($: any, e: any) => { logs.push(e.text); return { value: undefined } })
  // Answer the classic events after the mod passes them on with next(e).
  on('classic.PreCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  return { toasts, logs }
}

test('one compaction: PreCompact opens it, session.compact fills the numbers, SessionStart closes it', async ($, on) => {
  const status = { log: [] as unknown[] }
  const { toasts, logs } = stubs($, on, status)
  // The engine's answer to session.compact: the summary plus six kept messages, and its own counts.
  on('session.compact', () => ({ messages: [SUMMARY, ...transcript(6)], tokensBefore: 82000, tokensAfter: 19000 }))

  // --- before: the PreCompact settings hook runs inside next(e) and writes its record ---
  status.log = [PRE]
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'manual' })
  expect(toasts).toEqual(['Compaction starting — saving your last turns'])

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^● compacting now \(manual\) — started \d\d:\d\d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact save: ✓ 32 turns, ~1k tokens/ })).toBeDefined()
  await ui.unmount()

  // --- the compaction: the mod observes the result and leaves it untouched ---
  const result = await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages: transcript(143) } as any)
  expect(result).toEqual({ messages: [SUMMARY, ...transcript(6)], tokensBefore: 82000, tokensAfter: 19000 })

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}manual {3}82k → 19k tokens {3}143 → 7 messages {3}\d+\.\d s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}instructions: keep the plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact {2}✓ saved 32 user turns \(~1k tokens\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SessionStart \? no status record \(press r\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacting now/ })).toBeUndefined()
  await ui.unmount()

  // --- after: the SessionStart settings hook prints the bundle and writes its record inside next(e) ---
  status.log = [PRE, POST]
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })
  expect(toasts).toEqual(['Compaction starting — saving your last turns', 'Restored 1k tokens of your voice'])
  expect(logs).toEqual([expect.stringMatching(/^compaction: 82k → 19k tokens, 143 → 7 messages in \d+\.\d s; bundle re-injected$/)])

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SessionStart ✓ re-injected ~1k tokens \(prepared by the PreCompact hook\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#2 / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /last error/ })).toBeUndefined()

  // The bundle tab shows what was put back.
  await ui.press({ key: 'tab-bundle' })
  expect(await ui.find({ type: 'Text', text: 'LAST BEFORE COMPACTION' })).toBeDefined()
  // The tab is module state, so go back to the monitor before the next mount.
  await ui.press({ key: 'tab-monitor' })
  await ui.unmount()

  // --- a second SessionStart with the same records (a resume, a refresh) adds nothing ---
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })
  expect(toasts.length).toBe(2)
  expect(logs.length).toBe(1)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  await ui.unmount()
})

test('the Summary tab: the result\'s first message, with the token counts and the arc size above it', async ($, on) => {
  const status = { log: [] as unknown[] }
  stubs($, on, status)
  const SUM = { role: 'user', text: 'This session is being continued from a previous conversation. The user asked for a pane; the plan was kept; the arc was written.', toolUses: [] } as const
  on('session.compact', () => ({ messages: [SUM, ...transcript(6)], tokensBefore: 82000, tokensAfter: 19000 }))

  // Before any compaction the tab says so.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-summary' })
  expect(await ui.find({ type: 'Text', text: /^No compaction watched yet this session/ })).toBeDefined()
  await ui.unmount()

  status.log = [PRE]
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'manual' })
  await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages: transcript(143) } as any)

  // Tab 3 (the module remembers the tab): the numbers line, the arc path, then the summary text.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#1 {2}82k → 19k tokens {3}summary 128 chars \(~32 tokens\) {3}arc on disk 44k chars \(~11k tokens, 62 turns\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `arc: ${ARC}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^instructions given to the summarizer: keep the plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: SUM.text })).toBeDefined()
  // The bundle is not on this tab, and the monitor's rows are not either.
  expect(await ui.find({ type: 'Text', text: 'LAST BEFORE COMPACTION' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Compactions this session/ })).toBeUndefined()
  // The tab's Button is titled Summary with hotkey 3 (the kit presses by key, not by hotkey).
  const button = await ui.find({ type: 'Button', key: 'tab-summary' })
  expect(button?.props).toMatchObject({ label: 'Summary', hotkey: '3' })
  await ui.press({ key: 'tab-monitor' })
  expect(await ui.find({ type: 'Text', text: SUM.text })).toBeUndefined()
  await ui.unmount()
})

test('a summary longer than 9,500 chars is cut for the pane, not for the engine', async ($, on) => {
  const status = { log: [] as unknown[] }
  stubs($, on, status)
  const long = { role: 'user', text: 'S'.repeat(12000), toolUses: [] } as const
  const answer = { messages: [long, ...transcript(2)], tokensBefore: 90000, tokensAfter: 30000 }
  on('session.compact', () => answer)
  const result = await $.session.compact({ trigger: 'auto', messages: transcript(10) } as any)
  expect(result).toEqual(answer)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-summary' })
  const t = await ui.find({ type: 'Text', text: /^S{9500}\n…\[truncated for the pane\]$/ })
  expect(t).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#1 {2}90k → 30k tokens {3}summary 10k chars/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /arc on disk no record \(press r\)/ })).toBeDefined()
  await ui.press({ key: 'tab-monitor' })
  await ui.unmount()
})

test('the other order: PreCompact record lands after session.compact; the row still gets both marks', async ($, on) => {
  const status = { log: [] as unknown[] }
  stubs($, on, status)
  on('session.compact', () => ({ messages: [SUMMARY, ...transcript(6)], tokensBefore: 82000, tokensAfter: 19000 }))
  // classic.PreCompact fires but its status record is NOT yet on disk when next(e) resolves
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'manual' })
  await $.session.compact({ trigger: 'manual', messages: transcript(143) } as any)
  // both records appear only now
  status.log = [PRE, POST]
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacting now/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact {2}✓ saved 32 user turns/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SessionStart ✓ re-injected/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#2 / })).toBeUndefined()
  await ui.unmount()
})

test('a compaction with no status record shows the numbers and two ? marks, not a crash', async ($, on) => {
  const status = { log: [] as unknown[] }
  const { toasts } = stubs($, on, status)
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 50000, tokensAfter: 4000 }))

  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'auto' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /compacting now \(auto\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact save: waiting for the hook…/ })).toBeDefined()
  await ui.unmount()

  await $.session.compact({ trigger: 'auto', messages: transcript(20) } as any)
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })

  // No record ever arrived: the row has the engine's numbers and says so for both hooks, with no error.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}auto {3}50k → 4k tokens {3}20 → 1 messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact {2}\? no status record \(press r\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SessionStart \? no status record \(press r\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacting now/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /last error/ })).toBeUndefined()
  expect(toasts).toEqual(['Compaction starting — saving your last turns'])
  await ui.unmount()
})

test('a precompute, a vetoed compaction and a subagent compaction', async ($, on) => {
  const status = { log: [] as unknown[] }
  stubs($, on, status)
  let answer: any = { messages: [SUMMARY], tokensBefore: 10, tokensAfter: 5 }
  on('session.compact', () => answer)

  // A precompute parks its result and installs nothing: no row.
  await $.session.compact({ trigger: 'precompute', messages: transcript(4) } as any)
  // A vetoed compaction leaves the conversation as it is: no row, and the pending entry is dropped.
  await $.classic.PreCompact({ hook_event_name: 'PreCompact', session_id: SESSION, transcript_path: '/x.jsonl', trigger: 'manual' })
  answer = { skip: 'a hook said no' }
  const vetoed = await $.session.compact({ trigger: 'manual', messages: transcript(4) } as any)
  expect(vetoed).toEqual({ skip: 'a hook said no' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacting now/ })).toBeUndefined()
  await ui.unmount()

  // A subagent's own compaction gets a row of its own, tagged with the agent.
  answer = { messages: [SUMMARY], tokensBefore: 30000, tokensAfter: 2000 }
  await $.session.compact({ trigger: 'auto', agentId: 'agent-7', messages: transcript(9) } as any)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Compactions this session: 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}agent agent-7 {2}auto {3}30k → 2k tokens {3}9 → 1 messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /a subagent's own compaction/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PreCompact {2}/ })).toBeUndefined()
  await ui.unmount()
})

// --- the experiment (userConfig inject_in_mod) ------------------------------------
// The kit seeds register(on, options) from the manifest's defaults, where the flag is
// off; a config.set event is how a test turns it on, the same event /config fires.
// What these prove: the returned messages, the marker, and the pane row. What they
// cannot prove: that the engine keeps the appended handled messages in the next
// request. That needs a live /compact.

test('inject_in_mod on: the last user turns go back after the summary, handles intact, and the script is told to stand down', async ($, on) => {
  const status = { log: [] as unknown[] }
  const { toasts } = stubs($, on, status)
  on('config.set', ($, e) => ({ value: e.value }))
  const writes: { path: string; text: string }[] = []
  on('fs.write', ($, e) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } })
  const kept = transcript(4)
  on('session.compact', () => ({ messages: [SUMMARY, ...kept], tokensBefore: 82000, tokensAfter: 19000 }))

  await $.config.set({ key: 'before-compact.inject_in_mod', value: true } as any)
  await $.config.set({ key: 'before-compact.inject_turns', value: 3 } as any)

  // Ten turns (even = user), then a user turn that is only harness noise and one
  // that is only a tool result: neither is a voice sample, so neither goes back.
  const old = [
    ...transcript(10),
    { role: 'user', text: '<system-reminder>noise</system-reminder>', toolUses: [], handle: 'h-noise' },
    { role: 'user', text: '', toolUses: [], handle: 'h-tool' },
  ] as const
  const result: any = await $.session.compact({ trigger: 'manual', messages: old } as any)

  // The engine's own part of the result is untouched; the appended part follows it.
  expect(result.tokensBefore).toBe(82000)
  expect(result.tokensAfter).toBe(19000)
  expect(result.messages.slice(0, 5)).toEqual([SUMMARY, ...kept])
  expect(result.messages[5].role).toBe('user')
  expect(result.messages[5].handle).toBeUndefined()
  expect(result.messages[5].text).toMatch(/^\[before-compact\] The 3 messages after this one are verbatim user turns from just before this context was compacted/)
  // The last three user turns that say something, oldest first, as the engine handed them (handles h4, h6, h8).
  expect(result.messages.slice(6)).toEqual([old[4], old[6], old[8]])
  expect(result.messages.length).toBe(9)

  // The stand-down marker went to the status directory before the hook returned.
  expect(writes.length).toBe(1)
  expect(writes[0].path).toBe(`${HOME}/.claude/before-compact/injected-${SESSION}.json`)
  const marker = JSON.parse(writes[0].text)
  expect(marker).toEqual({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), trigger: 'manual', appended: 3, chars: 18 })

  // The pane row counts the appended turns in the after-number and shows the Mod line.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}manual {3}82k → 19k tokens {3}12 → 9 messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}Mod {10}✓ appended 3 user turns \(~18 chars\) after the summary$/ })).toBeDefined()
  await ui.unmount()

  // The script read the marker, printed nothing, and said so in its record.
  status.log = [{ at: '2026-10-16T15:00:05.000Z', event: 'SessionStart', source: 'compact', injected: false,
    origin: 'stood down: the mod appended 3 user turns after the summary', mod_appended: 3, mod_chars: 18, bundle: BUNDLE, transcript: '/x.jsonl' }]
  await $.classic.SessionStart({ hook_event_name: 'SessionStart', session_id: SESSION, transcript_path: '/x.jsonl', source: 'compact' })
  expect(toasts).toEqual(['Compaction done — the mod appended 3 of your turns after the summary'])
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SessionStart – stood down \(stood down: the mod appended 3 user turns after the summary\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}Mod {10}✓ appended 3 user turns \(~18 chars\) after the summary$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /marker was missed/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /last error/ })).toBeUndefined()
  await ui.unmount()
})

test('inject_in_mod off (the default): the result is untouched and no marker is written', async ($, on) => {
  const status = { log: [] as unknown[] }
  stubs($, on, status)
  on('fs.write', () => ({ deny: 'nothing may be written while the flag is off' }))
  const answer = { messages: [SUMMARY, ...transcript(4)], tokensBefore: 82000, tokensAfter: 19000 }
  on('session.compact', () => answer)

  const result = await $.session.compact({ trigger: 'manual', messages: transcript(10) } as any)
  expect(result).toEqual(answer)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^#1 {2}\d\d:\d\d {2}manual {3}82k → 19k tokens {3}10 → 5 messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Mod {10}/ })).toBeUndefined()
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
