// before-compact — compaction monitor pane
//
// A Claude Code mod (runs inside Claude Code's process). It draws a pane that
// shows, at a glance, that compaction recovery is working:
//
//   • a live context gauge (tokens / window / percent), refreshed every 2 s
//   • a log of this session's compactions, each with the token and message counts
//     BEFORE and AFTER (from the session.compact event itself), how long the
//     summary took, what triggered it, and whether the two settings hooks in this
//     plugin (PreCompact → save, SessionStart → re-inject) reported success
//   • a second tab showing the actual bundle that was re-injected
//   • a third tab showing the summary the engine installed, with the token counts
//     before and after and the size of the arc file on disk beside them, so a
//     person can compare what the summary kept against what it cost
//
// Where each number comes from:
//   session.compact        the event the engine fires around a compaction. After
//                          `await next(e)` the result carries tokensBefore /
//                          tokensAfter, and e.messages / result.messages give the
//                          message counts. No polling, no timers.
//   classic.PreCompact     only for the ✓ mark: the settings hook (the script) runs
//   classic.SessionStart   inside this hook's next(e) and writes a status record to
//                          ~/.claude/before-compact/status-<session>.json; the hook
//                          reads that file once next(e) has resolved.
//
// The compaction log lives in $.state (see ../types/index.d.ts), so a reload of
// this module keeps it. The pane's tab, the live gauge and the last error are
// module variables: cheap to lose.
//
// The experiment (userConfig inject_in_mod, off by default): instead of the
// SessionStart settings hook printing the last turns as text, the session.compact
// hook appends the last N user messages of the old transcript, with the engine's
// own handles, after the summary, and writes a marker file that tells the script
// to stand down. Whether the engine keeps those appended messages in the next
// request is NOT verified here; see the README.
//
// The second experiment (userConfig digest_in_precompact, off by default): in
// classic.PreCompact, before the engine summarizes, send the dialog (user and
// assistant text only, newest turns first under 60,000 chars) to a small model and
// write its digest to ~/.claude/before-compact/digest-<session>.json. The script
// prints it ahead of the user turns at SessionStart(compact). One model call per
// compaction, billed to the user's usage; any failure writes nothing and sets the
// pane's last error, so the compaction is never blocked. The digest is itself a
// summary: whether it keeps what the engine's summary drops is unmeasured until
// the README's comparison protocol has been run.
//
// Open it with /before-compact. Esc closes it.

import { atom, read, update } from 'claude-code'

const PANE = 'before-compact'
const STATUS_DIR = '.claude/before-compact' // relative to $HOME

// ---- userConfig ------------------------------------------------------------
// register(on, options) seeds these from the manifest's userConfig (defaults
// filled in); the config.set hook below keeps them current when the person flips
// a row in /config, so no reload is needed for the change to apply.
const DEFAULTS = { summary_instructions: '', inject_in_mod: false, inject_turns: 8, inject_max_chars: 9000, digest_in_precompact: false, digest_model: 'haiku', digest_max_tokens: 1500 }
let settings = { ...DEFAULTS }
function readSettings(o) {
  const num = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d }
  const flag = (v) => v === true || v === 'true'
  return {
    summary_instructions: typeof o.summary_instructions === 'string' ? o.summary_instructions.trim() : '',
    inject_in_mod: flag(o.inject_in_mod),
    inject_turns: num(o.inject_turns, DEFAULTS.inject_turns, 1, 50),
    inject_max_chars: num(o.inject_max_chars, DEFAULTS.inject_max_chars, 200, 100000),
    digest_in_precompact: flag(o.digest_in_precompact),
    digest_model: typeof o.digest_model === 'string' && o.digest_model.trim() ? o.digest_model.trim() : DEFAULTS.digest_model,
    digest_max_tokens: num(o.digest_max_tokens, DEFAULTS.digest_max_tokens, 1, 64000),
  }
}

// ---- the experiment's pieces -----------------------------------------------
// Where the mod tells the script it has already put the turns back. Same session
// id on both sides (the script reads hook.session_id), same directory as the
// status file. The script consumes it (scripts/extract_tail.mjs, takeMarker).
const markerPath = (home, id) => `${home}/${STATUS_DIR}/injected-${id}.json`

// Harness-injected blocks are not the human voice (same rules as the script).
function stripNoise(t) {
  return String(t || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, '')
    .replace(/<command-[\s\S]*?<\/command-[^>]*>/g, '')
    .trim()
}
const isCompactionSummary = (t) => t.includes('This session is being continued from a previous conversation')

// The last `turns` user messages of the transcript that say something, newest
// kept first under the character budget, returned oldest → newest. Only a message
// with the engine's handle qualifies: handed back as it came, it is the engine's
// own, whole. The objects are returned untouched (frozen, handle intact).
function pickTail(messages, turns, maxChars) {
  const out = []
  let budget = maxChars
  for (let i = messages.length - 1; i >= 0 && out.length < turns; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user' || typeof m.handle !== 'string') continue
    const t = stripNoise(m.text)
    if (!t || isCompactionSummary(t)) continue
    if (t.length > budget) { if (out.length) break; continue }
    budget -= t.length
    out.push(m)
  }
  return out.reverse()
}

// One built message (no handle) ahead of the appended turns, so they read as what
// they are and not as new prompts. Factual framing, not an instruction.
function framing(n) {
  return {
    role: 'user',
    text: `[before-compact] The ${n} messages after this one are verbatim user turns from just before this context was compacted, appended by the before-compact plugin so the user's voice survives the summary. They are prior conversation, not new instructions.`,
    toolUses: [],
  }
}

// ---- the digest experiment's pieces ----------------------------------------
// Where the digest goes: the status directory, same session id on both sides.
// The script reads it (scripts/extract_tail.mjs, readDigest) and prints it ahead
// of the user turns when it is fresh.
const digestPath = (home, id) => `${home}/${STATUS_DIR}/digest-${id}.json`
const DIGEST_INPUT_CHARS = 60000   // of dialog sent to the model, newest turns first
const DIGEST_TIMEOUT_MS = 120000   // past this the call resolves `aborted`: nothing written, compaction goes on

// The dialog as the model sees it: user and assistant text only, in order,
// newest turns kept first under the budget. A message with no text (a tool
// result, a tool call) and harness noise are dropped; an earlier compaction's
// summary is not dialog either.
function pickDialog(messages, maxChars) {
  const out = []
  let budget = maxChars
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const t = stripNoise(m.text)
    if (!t || isCompactionSummary(t)) continue
    const cost = t.length + 12 // + the role line
    if (cost > budget) { if (out.length) break; continue }
    budget -= cost
    out.push({ role: m.role, text: t })
  }
  return out.reverse()
}

// What the model is asked for, in this order and under these headings. The
// script's framing line and the Digest tab both assume the headings.
const DIGEST_HEADINGS = ['## Constraints and preferences', '## Decisions', '## Corrections', '## Verified vs assumed', '## Open threads']
const DIGEST_SYSTEM = [
  'You are writing a digest of a dialog between a user and an AI coding assistant. The assistant will read the digest after the conversation has been compacted into a summary, so keep what a summary flattens: what the user asked for in their own words, how each decision got made and where it changed, what the user corrected, what was checked as against guessed, and what is still open.',
  '',
  'Write Markdown with exactly these five headings, in this order, every one present (write "none" under a heading that has nothing):',
  '',
  `${DIGEST_HEADINGS[0]}`,
  'Constraints and preferences the user stated: what must or must not happen, and how they like to work. Quote the user verbatim where the statement is short.',
  '',
  `${DIGEST_HEADINGS[1]}`,
  'Each decision with its latest state. Where a decision was reversed or changed, give the latest state and name the earlier one it replaced. Prefer the latest state of each decision over earlier ones.',
  '',
  `${DIGEST_HEADINGS[2]}`,
  'Where the user corrected the assistant: what was wrong and what the user said instead.',
  '',
  `${DIGEST_HEADINGS[3]}`,
  'What was verified (run, read, tested, with the result) as against what was assumed or inferred and never checked.',
  '',
  `${DIGEST_HEADINGS[4]}`,
  'Questions asked and not answered, work started and not finished, things deferred.',
  '',
  'Rules: quote the user rather than paraphrase whenever the wording matters. Name files, flags, commands and values as they were written. Do not add advice, praise or commentary, and do not repeat the assistant\'s explanations. Omit nothing the user stated as a constraint or a correction.',
].join('\n')

// One completion, one file. Returns the row's digest field, or null with
// lastError set when nothing was written: no dialog, no answer, a refused
// request, a failed write. Nothing here throws past the try.
async function writeDigest($, trigger) {
  const t0 = Date.now()
  try {
    const messages = await $.session.messages()
    const turns = pickDialog(Array.isArray(messages) ? messages : [], DIGEST_INPUT_CHARS)
    if (!turns.length) { lastError = 'digest: no dialog to digest'; return null }
    const prompt = 'The dialog, oldest to newest:\n\n' + turns.map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${t.text}`).join('\n\n')
    const r = await $.model.complete({ model: settings.digest_model, system: DIGEST_SYSTEM, prompt, maxTokens: settings.digest_max_tokens, timeoutMs: DIGEST_TIMEOUT_MS })
    if (!r || !r.isAnswered || typeof r.text !== 'string' || !r.text.trim()) {
      lastError = `digest: no answer (${r && r.reason ? r.reason + (r.status ? ' ' + r.status : '') : 'empty reply'})`
      return null
    }
    const text = r.text.trim()
    const home = await $.env.get('HOME')
    const id = await $.session.id()
    const record = {
      at: new Date().toISOString(), trigger: trigger || null, model: settings.digest_model,
      chars: text.length, turns: turns.length, inputChars: prompt.length, durationMs: Date.now() - t0,
      usage: r.usage || null, text,
    }
    await $.fs.write(digestPath(home, id), JSON.stringify(record))
    digest = record
    return { model: record.model, chars: record.chars, turns: record.turns, durationMs: record.durationMs }
  } catch (e) { lastError = 'digest: ' + msg(e); return null }
}

// ---- $.state: survives a reload of this module ----------------------------
const compactions = atom({ plugin: 'before-compact', key: 'compactions' }, [])
const pending = atom({ plugin: 'before-compact', key: 'pending' }, null)

// ---- module state (lost on reload; fine for a monitor) ---------------------
let tab = 'monitor'            // 'monitor' | 'bundle' | 'summary'
let usage = null               // { tokens, window, percent } from $.session.usage(), for the gauge
let messageCount = null        // length of $.session.messages(), for the gauge
let bundleText = ''            // the last bundle, for the second tab
let digest = null              // the last digest record ({ at, model, chars, turns, text, … }), for the Digest tab
let lastError = ''
let transcript = null          // { path, compactions, events, markers } from --probe, or null
let transcriptPath = null      // the .jsonl findTranscript picked, even when --probe failed
let recovering = false         // the "Recover from transcript" button is running

// The one line of a failed process's stderr worth showing: node prints a loader
// preamble ("node:internal/... throw err; ^") before the "Error: ..." line, so the
// first N chars are noise. Prefer the Error line, else the last non-empty line.
function errLine(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const err = lines.find((l) => /^\w*Error\b/.test(l))
  return (err || lines[lines.length - 1] || '').slice(0, 200)
}
function msg(e) { return e && e.message ? e.message : String(e) }

// Find this session's transcript the way the script does, but from the mod's
// side: ~/.claude/projects/<cwd with / and space → ->/<newest>.jsonl
async function findTranscript($) {
  try {
    const home = await $.env.get('HOME')
    const cwd = await $.session.cwd()
    const dir = `${home}/.claude/projects/${String(cwd).replace(/[/ ]/g, '-')}`
    if (!(await $.fs.exists(dir))) return null
    const entries = (await $.fs.list(dir)).filter((f) => f.name.endsWith('.jsonl'))
    let best = null, bestTime = -1
    for (const f of entries) {
      const st = await $.fs.stat(`${dir}/${f.name}`)
      const t = Number(st && (st.mtimeMs ?? st.mtime ?? 0))
      if (t > bestTime) { bestTime = t; best = `${dir}/${f.name}` }
    }
    return best
  } catch (e) { lastError = 'transcript: ' + msg(e); return null }
}

async function scriptPath($) {
  const root = typeof $.plugin.root === 'function' ? await $.plugin.root() : $.plugin.root
  return `${root}/scripts/extract_tail.mjs`
}

async function probeTranscript($) {
  try {
    const path = await findTranscript($)
    transcriptPath = path
    if (!path) { transcript = null; return }
    const r = await $.process.run(['node', await scriptPath($), '--probe', '--file', path])
    if (r.exitCode !== 0) { transcript = null; lastError = 'probe: ' + errLine(r.stderr); return }
    transcript = JSON.parse(r.stdout)
  } catch (e) { lastError = 'probe: ' + msg(e) }
}

// Run --recover on the transcript and put the result in the bundle tab. This is
// the on-demand path for a session whose compactions predate the plugin.
async function recoverFromTranscript($) {
  recovering = true
  $.ui.invalidate('ui.render')
  try {
    const path = transcript ? transcript.transcript : await findTranscript($)
    if (!path) { bundleText = ''; lastError = 'recover: no transcript found for this directory'; return }
    const r = await $.process.run(['node', await scriptPath($), '--recover', '--role', 'user', '--max-chars', '9000', '--file', path])
    const out = (r.stdout || '').trim()
    bundleText = out.length > 9500 ? out.slice(0, 9500) + '\n…[truncated for the pane]' : out
    if (r.exitCode !== 0 && !out) lastError = 'recover: ' + errLine(r.stderr)
  } catch (e) { lastError = 'recover: ' + msg(e) }
  finally { recovering = false; $.ui.invalidate('ui.render') }
}

// ---- helpers ---------------------------------------------------------------
function fmtK(n) {
  if (n == null || !isFinite(n)) return '?'
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}
function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date()
  return d.toTimeString().slice(0, 5)
}
function fmtSecs(ms) {
  return ms == null ? '?' : (ms / 1000).toFixed(1) + ' s'
}
function gauge(percent, width) {
  const w = Math.max(10, width)
  const p = Math.max(0, Math.min(100, percent ?? 0))
  const filled = Math.round((p / 100) * w)
  return '▕' + '█'.repeat(filled) + '░'.repeat(w - filled) + '▏'
}
function gaugeColor(percent) {
  if (percent == null) return undefined
  if (percent >= 85) return 'red'
  if (percent >= 65) return 'yellow'
  return 'green'
}

// The live gauge only. The before/after numbers in the log no longer come from
// here: they are what the session.compact result reports.
async function refreshLive($) {
  try {
    const u = await $.session.usage()
    usage = u && u.context ? u.context : null
  } catch (e) { usage = null; lastError = 'usage: ' + msg(e) }
  try {
    const m = await $.session.messages()
    messageCount = Array.isArray(m) ? m.length : null
  } catch (e) { messageCount = null; lastError = 'messages: ' + msg(e) }
}

async function readStatus($) {
  // The script writes ~/.claude/before-compact/status-<session_id>.json
  try {
    const home = await $.env.get('HOME')
    const id = await $.session.id()
    const p = `${home}/${STATUS_DIR}/status-${id}.json`
    if (!(await $.fs.exists(p))) return []
    const raw = await $.fs.read(p)
    const log = JSON.parse(raw)
    return Array.isArray(log) ? log : []
  } catch (e) { lastError = 'status: ' + msg(e); return [] }
}

async function loadBundle($, path) {
  try {
    if (!path || !(await $.fs.exists(path))) { bundleText = ''; return }
    const t = await $.fs.read(path)
    bundleText = t.length > 9500 ? t.slice(0, 9500) + '\n…[truncated for the pane]' : t
  } catch (e) { bundleText = ''; lastError = 'bundle: ' + msg(e) }
}

// A full row with every field present (null = not known), so the pane and the
// tests see one shape whichever hook filled it in.
function row(fields) {
  return {
    id: null, startedAt: null, trigger: null, agentId: null, instructions: null, durationMs: null,
    beforeTokens: null, afterTokens: null, beforeMessages: null, afterMessages: null,
    preAt: null, saved: null, savedTurns: null, savedTokens: null, bundle: null,
    postAt: null, injected: null, injectedTokens: null, origin: null,
    modAppended: null, modChars: null,
    summary: null, arc: null, arcTurns: null, arcChars: null, arcTokens: null,
    digest: null,
    ...fields,
    ...(fields.id ? {} : { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }),
  }
}

// Fold the script's status records into the log. Pure: takes the current list
// and pending entry, returns the new ones. Each record is matched by its `at`,
// so re-reading the file never duplicates a compaction.
//   PreCompact record     → completes the pending entry's ✓; if session.compact has
//                           already turned that entry into a row (the record landed
//                           late), completes the newest row without a ✓; else opens
//                           a pending entry
//   SessionStart record   → completes the newest row that has no ✓ yet
// The arc fields of a status record, when it has them (PreCompact always; a
// SessionStart record when the fallback path wrote the arc).
function arcOf(rec) {
  return rec.arc_chars != null ? { arc: rec.arc ?? null, arcTurns: rec.arc_turns ?? null, arcChars: rec.arc_chars, arcTokens: rec.arc_tokens_est ?? null } : {}
}
// The newest main-conversation row whose `field` is still unknown, or -1.
function newestOpen(list, field) {
  for (let k = list.length - 1; k >= 0; k--) if (list[k][field] == null && list[k].agentId == null) return k
  return -1
}
function fold(log, list, pend) {
  for (const rec of log) {
    const key = rec.at
    if (list.some((c) => c.preAt === key || c.postAt === key)) continue
    if (pend && (pend.preAt === key || pend.postAt === key)) continue
    if (rec.event === 'PreCompact') {
      const fields = { preAt: key, saved: Boolean(rec.written), savedTurns: rec.turns ?? null, savedTokens: rec.tokens_est ?? null, bundle: rec.bundle ?? null, ...arcOf(rec) }
      const i = pend && pend.preAt == null ? -1 : newestOpen(list, 'preAt')
      if (pend && pend.preAt == null) {
        pend = { ...pend, ...fields, trigger: pend.trigger || rec.trigger || null }
      } else if (i >= 0) {
        list = list.map((c, k) => (k === i ? { ...c, ...fields, trigger: c.trigger || rec.trigger || null, bundle: c.bundle || fields.bundle } : c))
      } else {
        if (pend) list = [...list, row(pend)]
        pend = { startedAt: key, trigger: rec.trigger || null, ...fields }
      }
    } else if (rec.event === 'SessionStart' && rec.source === 'compact') {
      const done = { postAt: key, injected: rec.injected !== false, injectedTokens: rec.tokens_est ?? null, origin: rec.origin ?? null, ...arcOf(rec) }
      // The mod's own row already says what it appended; the script's record only
      // confirms it (a stood-down record carries the count it read from the marker).
      if (rec.mod_appended != null) Object.assign(done, { modAppended: rec.mod_appended, modChars: rec.mod_chars ?? null })
      const i = newestOpen(list, 'postAt')
      if (i >= 0) {
        list = list.map((c, k) => (k === i ? { ...c, ...done, bundle: c.bundle || rec.bundle || null } : c))
      } else if (pend) {
        list = [...list, row({ ...pend, ...done, bundle: pend.bundle || rec.bundle || null })]
        pend = null
      } else {
        list = [...list, row({ startedAt: key, bundle: rec.bundle ?? null, ...done })]
      }
    }
  }
  return { list, pend }
}

// Read the status file and fold it into $.state. Writes only when something changed,
// so the pane is not redrawn for nothing.
async function syncStatus($) {
  const log = await readStatus($)
  const list = await read($, compactions)
  const pend = await read($, pending)
  const next = fold(log, list, pend)
  if (JSON.stringify(next.list) !== JSON.stringify(list)) await update($, compactions, () => next.list)
  if (JSON.stringify(next.pend) !== JSON.stringify(pend)) await update($, pending, () => next.pend)
}

export function register(on, options) {
  settings = readSettings(options || {})

  // A row flipped in /config: keep the module's copy current. (A change may also
  // reload the module, in which case register seeds the same value again.)
  on('config.set', { key: /(^|\.)(inject_(in_mod|turns|max_chars)|summary_instructions|digest_(in_precompact|model|max_tokens))$/ }, async ($, e, next) => {
    const r = await next(e)
    if (r && r.deny === undefined) settings = readSettings({ ...settings, [String(e.key).replace(/^.*\./, '')]: r.value })
    return r
  }).catch(async ($, e, next) => next(e))

  // ---- session start: register the command, start the live gauge ---------
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'before-compact', description: 'Open the compaction monitor pane', immediate: true })
    } catch (err) { lastError = 'register: ' + msg(err) }
    await refreshLive($)
    await syncStatus($)
    await probeTranscript($)
    $.clock.every(2000, async () => {
      await refreshLive($)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // ---- /before-compact opens the pane ----------------------------------------
  on('command.run', { command: 'before-compact' }, async ($) => {
    await refreshLive($)
    await syncStatus($)
    await $.ui.open({ id: PANE, title: 'Before Compact', focus: true, closeOnEscape: true, columns: 60 })
    return {}
  })

  // ---- the compaction itself ---------------------------------------------
  // next(e) is the whole compaction: the PreCompact settings hooks, the summary,
  // and the engine's token counts. Nothing is recorded for a precompute (its
  // result is parked, not installed) or for a compaction a hook vetoed.
  //
  // The knob (userConfig summary_instructions, empty by default): when set, the
  // event goes down with the knob's text appended to the instructions, on its
  // own line after whatever was typed after /compact, so the person's own text
  // is kept. The types say next({ ...e, instructions }) changes what the
  // summarizer is told; how much it honours that is not measured here. The
  // Summary tab shows what came back.
  on('session.compact', async ($, e, next) => {
    const t0 = Date.now()
    const input = settings.summary_instructions
      ? { ...e, instructions: [e.instructions, settings.summary_instructions].filter(Boolean).join('\n') }
      : e
    const result = await next(input)
    if (e.trigger === 'precompute') return result
    if (result.skip !== undefined) {
      // Vetoed: nothing was installed, so drop the entry PreCompact may have opened.
      await update($, pending, () => null)
      return result
    }
    // The first message of the result is the summary the engine installed
    // (from a hook that answered with its own list, whatever it put first).
    const first = result.messages[0]
    const summaryText = first && typeof first.text === 'string' ? first.text : ''
    const numbers = {
      trigger: e.trigger, agentId: e.agentId ?? null, instructions: input.instructions ?? null,
      durationMs: Date.now() - t0,
      beforeTokens: result.tokensBefore ?? null, afterTokens: result.tokensAfter ?? null,
      beforeMessages: e.messages.length, afterMessages: result.messages.length,
      summary: summaryText ? (summaryText.length > 9500 ? summaryText.slice(0, 9500) + '\n…[truncated for the pane]' : summaryText) : null,
    }
    if (e.agentId != null) {
      // A subagent's own transcript: no settings hooks fire for it, so it gets a
      // row of its own and never touches the main conversation's pending entry.
      await update($, compactions, (l) => [...l, row({ startedAt: new Date(t0).toISOString(), ...numbers })])
      return result
    }

    // The experiment: hand the engine the last user turns ourselves.
    let out = result
    let mod = {}
    if (settings.inject_in_mod) {
      const tail = pickTail(e.messages, settings.inject_turns, settings.inject_max_chars)
      if (tail.length) {
        const chars = tail.reduce((s, m) => s + m.text.length, 0)
        // The marker has to be on disk before this hook returns: Claude Code fires
        // SessionStart(compact), where the script would print its own copy, only
        // after it has this result. If the write fails, the .catch below returns the
        // untouched result and the script injects as usual.
        const home = await $.env.get('HOME')
        const id = await $.session.id()
        await $.fs.write(markerPath(home, id), JSON.stringify({ at: new Date().toISOString(), trigger: e.trigger, appended: tail.length, chars }))
        out = { ...result, messages: [...result.messages, framing(tail.length), ...tail] }
        mod = { modAppended: tail.length, modChars: chars, afterMessages: out.messages.length }
      }
    }

    const pend = await read($, pending)
    const entry = row({ startedAt: new Date(t0).toISOString(), ...(pend || {}), ...numbers, ...mod })
    await update($, compactions, (l) => [...l, entry])
    await update($, pending, () => null)
    return out
  }).catch(async ($, e, next) => {
    // The hook threw or timed out. Record it where the pane shows it and let the
    // compaction stand: next(e) runs it if it has not run, or returns its result.
    lastError = `session.compact hook ${next.error.kind}: ${next.error.message || ''}`.trim()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // ---- the two settings hooks' ✓ marks --------------------------------------
  // Before: open the pending entry and, once the settings hooks have run inside
  // next(e), pick up the script's PreCompact record.
  on('classic.PreCompact', async ($, e, next) => {
    await update($, pending, () => ({ startedAt: new Date().toISOString(), trigger: e.trigger || null }))
    $.ui.toast('Compaction starting — saving your last turns')
    const r = await next(e)
    await syncStatus($)
    // The digest experiment: the file has to be on disk before this hook
    // returns, because the engine summarizes next and the script reads the file
    // at SessionStart(compact). The model call's time does not count against
    // this hook's budget; a failure leaves the row's digest null and the error
    // in the pane, and the compaction goes on.
    if (settings.digest_in_precompact) {
      $.ui.toast(`Writing a digest of the dialog (${settings.digest_model})…`)
      const d = await writeDigest($, e.trigger)
      await update($, pending, (p) => (p ? { ...p, digest: d || { model: settings.digest_model, chars: null, turns: null, durationMs: null, error: lastError } } : p))
      $.ui.invalidate('ui.render')
    }
    return r
  }).catch(async ($, e, next) => {
    lastError = `PreCompact hook ${next.error.kind}: ${next.error.message || ''}`.trim()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // After: the script prints the bundle and writes its record inside next(e);
  // then read the record, show the result, load the bundle for tab 2.
  on('classic.SessionStart', { source: ['compact'] }, async ($, e, next) => {
    const r = await next(e)
    const before = await read($, compactions)
    await syncStatus($)
    const list = await read($, compactions)
    const last = list[list.length - 1]
    const was = before[before.length - 1]
    if (last && last.postAt != null && !(was && was.postAt === last.postAt)) {
      await loadBundle($, last.bundle)
      await probeTranscript($)
      const t = last.injected
        ? `Restored ${fmtK(last.injectedTokens)} tokens of your voice`
        : last.modAppended != null
          ? `Compaction done — the mod appended ${last.modAppended} of your turns after the summary`
          : 'Compaction done — nothing was re-injected'
      $.ui.toast(t)
      $.ui.log(`compaction: ${fmtK(last.beforeTokens)} → ${fmtK(last.afterTokens)} tokens, ${last.beforeMessages ?? '?'} → ${last.afterMessages ?? '?'} messages in ${fmtSecs(last.durationMs)}; ${last.injected ? 'bundle re-injected' : last.modAppended != null ? `mod appended ${last.modAppended} turns` : 'no bundle'}`)
    }
    $.ui.invalidate('ui.render')
    return r
  }).catch(async ($, e, next) => {
    lastError = `SessionStart hook ${next.error.kind}: ${next.error.message || ''}`.trim()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // ---- draw the pane -------------------------------------------------------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const width = Math.max(30, (e.props && e.props.bodyColumns) || 60)
    const list = await read($, compactions)
    const pend = await read($, pending)

    const tabButton = (name, label, hotkey) =>
      Button({ key: 'tab-' + name, label, hotkey, plain: true, dimColor: tab !== name, onPress: () => { tab = name; redraw() } })

    const header = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: [
        tabButton('monitor', 'Monitor', '1'),
        tabButton('bundle', 'Last bundle', '2'),
        tabButton('summary', 'Summary', '3'),
        Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: async () => { await refreshLive($); await syncStatus($); await probeTranscript($); const l = (await read($, compactions)); const last = l[l.length - 1]; if (last) await loadBundle($, last.bundle); redraw() } }),
      ],
    })

    let body
    if (tab === 'summary') {
      // The newest compaction the mod watched, with the summary the engine installed.
      const c = list[list.length - 1]
      if (!c) {
        body = [Text({ dimColor: true, children: ['No compaction watched yet this session. The next one (run /compact to try it) puts its summary here.'] })]
      } else {
        const n = list.length
        const sumChars = c.summary ? c.summary.length : 0
        body = [
          Text({ bold: true, children: [`#${n}  ${fmtK(c.beforeTokens)} → ${fmtK(c.afterTokens)} tokens   summary ${fmtK(sumChars)} chars (~${fmtK(Math.round(sumChars / 4))} tokens)   arc on disk ${c.arcChars != null ? `${fmtK(c.arcChars)} chars (~${fmtK(c.arcTokens ?? Math.round(c.arcChars / 4))} tokens, ${c.arcTurns ?? '?'} turns)` : 'no record (press r)'}`] }),
          Text({ dimColor: true, children: [c.arc ? `arc: ${c.arc}` : 'arc: not written for this compaction'] }),
          ...(c.instructions ? [Text({ dimColor: true, wrap: 'wrap', children: [`instructions given to the summarizer: ${c.instructions}`] })] : []),
          Text({ children: [' '] }),
          Text({ dimColor: true, children: ['The summary the engine installed (the first message after compaction), verbatim:'] }),
          Text({ children: [' '] }),
          c.summary
            ? Text({ wrap: 'wrap', children: [c.summary] })
            : Text({ dimColor: true, children: ['(the result\'s first message had no text)'] }),
        ]
      }
    } else if (tab === 'bundle') {
      const recoverButton = Button({ key: 'recover', label: recovering ? 'Recovering…' : 'Recover from transcript', hotkey: 'g', onPress: () => { if (!recovering) recoverFromTranscript($) } })
      body = bundleText
        ? [Text({ dimColor: true, children: ['The last turns before the most recent compaction, as the hook put them back (or as --recover reads them from the transcript):'] }),
           Text({ children: [' '] }),
           Text({ wrap: 'wrap', children: [bundleText] }),
           Text({ children: [' '] }),
           recoverButton]
        : [Text({ dimColor: true, children: ['No saved bundle for this session yet. One is written by the next compaction (run /compact to try it).'] }),
           Text({ dimColor: true, children: [transcript && transcript.compactions
             ? `The transcript already holds ${transcript.compactions} compaction marker(s) from before this plugin was watching. Press g to read the turns before the last one.`
             : 'If this session was compacted before the plugin was installed, press g to read the turns before that compaction from the transcript.'] }),
           Text({ children: [' '] }),
           recoverButton]
    } else {
      const pct = usage ? usage.percent : null
      const live = [
        Text({ bold: true, children: ['Context now'] }),
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ color: gaugeColor(pct), children: [gauge(pct, Math.min(30, width - 28))] }),
            Text({ children: [pct == null ? 'usage unavailable' : `${Math.round(pct)}%  ${fmtK(usage.tokens)} / ${fmtK(usage.window)} tokens`] }),
          ],
        }),
        Text({ dimColor: true, children: [`${messageCount == null ? '?' : messageCount} messages in context · live, refreshes every 2 s`] }),
        Text({ children: [' '] }),
      ]

      const rows = []
      if (pend) {
        rows.push(Text({ color: 'yellow', children: [`● compacting now (${pend.trigger || '?'}) — started ${fmtTime(pend.startedAt)}`] }))
        rows.push(Text({ dimColor: true, children: [`  PreCompact save: ${pend.saved ? `✓ ${pend.savedTurns} turns, ~${fmtK(pend.savedTokens)} tokens` : 'waiting for the hook…'}`] }))
      }
      list.slice().reverse().forEach((c, i) => {
        const n = list.length - i
        const who = c.agentId ? `agent ${c.agentId}  ` : ''
        rows.push(Text({ bold: true, children: [`#${n}  ${fmtTime(c.postAt || c.startedAt)}  ${who}${c.trigger || '?'}   ${fmtK(c.beforeTokens)} → ${fmtK(c.afterTokens)} tokens   ${c.beforeMessages ?? '?'} → ${c.afterMessages ?? '?'} messages   ${fmtSecs(c.durationMs)}`] }))
        if (c.instructions) rows.push(Text({ dimColor: true, wrap: 'wrap', children: [`    instructions: ${c.instructions}`] }))
        if (c.agentId) {
          rows.push(Text({ dimColor: true, children: ['    a subagent\'s own compaction: the settings hooks do not run for it'] }))
          return
        }
        rows.push(Text({ color: c.saved ? 'green' : c.saved === false ? 'red' : 'yellow', children: [`    PreCompact  ${c.saved ? '✓' : c.saved === false ? '✗' : '?'} ${c.saved ? `saved ${c.savedTurns} user turns (~${fmtK(c.savedTokens)} tokens)` : c.saved === false ? 'bundle not written' : 'no status record (press r)'}`] }))
        rows.push(Text({ color: c.injected ? 'green' : c.injected === false ? (c.modAppended != null ? 'green' : 'red') : 'yellow', children: [`    SessionStart ${c.injected ? '✓' : c.injected === false ? (c.modAppended != null ? '–' : '✗') : '?'} ${c.injected ? `re-injected ~${fmtK(c.injectedTokens)} tokens (${c.origin || ''})` : c.injected === false ? (c.modAppended != null ? `stood down (${c.origin || ''})` : 'nothing injected') : 'no status record (press r)'}`] }))
        if (c.modAppended != null) rows.push(Text({ color: c.injected ? 'yellow' : 'green', children: [`    Mod          ✓ appended ${c.modAppended} user turns (~${fmtK(c.modChars)} chars) after the summary${c.injected ? ' — and the script injected too: the stand-down marker was missed' : ''}`] }))
      })
      if (!pend && !list.length) {
        rows.push(Text({ dimColor: true, children: ['No compactions yet this session.'] }))
        rows.push(Text({ dimColor: true, children: ['Run /compact to see the two hooks fire, or wait for auto-compact.'] }))
      }

      const history = transcript
        ? Text({ dimColor: true, children: [`Transcript on disk: ${transcript.compactions} compaction marker(s) in ${transcript.events} events${transcript.compactions > list.length ? ' (earlier than this plugin was watching; see tab 2)' : ''}`] })
        : transcriptPath
          ? Text({ dimColor: true, children: ['Transcript on disk: found, but --probe failed (see last error below)'] })
          : Text({ dimColor: true, children: ['Transcript on disk: not found for this directory'] })
      body = [
        ...live,
        Text({ bold: true, children: [`Compactions this session: ${list.length}`] }),
        history,
        ...rows,
        Text({ children: [' '] }),
        Text({ dimColor: true, children: ['How to read it: tokens/messages drop at compaction (the engine\'s own counts); the two ✓ marks mean your last turns were saved before and put back after.'] }),
      ]
    }

    if (lastError) body.push(Text({ dimColor: true, children: [`(last error: ${lastError})`] }))

    return Box({ flexDirection: 'column', children: [header, Text({ children: [' '] }), ...body] })
  })
}
