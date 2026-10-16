// before-compact — compaction monitor pane
//
// A Claude Code mod (runs inside Claude Code's process). It draws a pane that
// shows, at a glance, that compaction recovery is working:
//
//   • a live context gauge (tokens / window / percent), refreshed every 2 s
//   • a log of this session's compactions, each with the context size and
//     message count BEFORE and AFTER, and whether the two settings hooks in this
//     plugin (PreCompact → save, SessionStart → re-inject) reported success
//   • a second tab showing the actual bundle that was re-injected
//
// The settings hooks (scripts/extract_tail.mjs --hook) do the saving and
// re-injecting; they also write a status record to ~/.claude/before-compact/.
// This mod reads that record. It never writes to Claude's context itself.
//
// Open it with /before-compact. Esc closes it.

const PANE = 'before-compact'
const STATUS_DIR = '.claude/before-compact' // relative to $HOME

// ---- module state (lost on reload; that's fine, it's a monitor) ------------
let tab = 'monitor'            // 'monitor' | 'bundle'
let usage = null               // { tokens, window, percent } from $.session.usage()
let messageCount = null        // length of $.session.messages()
let compactions = []           // one entry per compaction this session, newest last
let pending = null             // the compaction in flight: PreCompact seen, SessionStart not yet
let bundleText = ''            // the last bundle, for the second tab
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
  } catch (e) { lastError = 'transcript: ' + (e && e.message ? e.message : e); return null }
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
  } catch (e) { lastError = 'probe: ' + (e && e.message ? e.message : e) }
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
  } catch (e) { lastError = 'recover: ' + (e && e.message ? e.message : e) }
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

async function refreshLive($) {
  try {
    const u = await $.session.usage()
    usage = u && u.context ? u.context : null
  } catch (e) { usage = null; lastError = 'usage: ' + (e && e.message ? e.message : e) }
  try {
    const m = await $.session.messages()
    messageCount = Array.isArray(m) ? m.length : null
  } catch (e) { messageCount = null; lastError = 'messages: ' + (e && e.message ? e.message : e) }
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
  } catch (e) { lastError = 'status: ' + (e && e.message ? e.message : e); return [] }
}

async function loadBundle($, path) {
  try {
    if (!path || !(await $.fs.exists(path))) { bundleText = ''; return }
    const t = await $.fs.read(path)
    bundleText = t.length > 9500 ? t.slice(0, 9500) + '\n…[truncated for the pane]' : t
  } catch (e) { bundleText = ''; lastError = 'bundle: ' + (e && e.message ? e.message : e) }
}

// Fold the script's status records into the in-memory compaction log. Each
// compaction is a PreCompact record followed by a SessionStart(compact) record.
function applyStatus(log) {
  for (const rec of log) {
    const key = rec.at
    if (compactions.some((c) => c.preAt === key || c.postAt === key)) continue
    if (pending && (pending.preAt === key || pending.postAt === key)) continue
    if (rec.event === 'PreCompact') {
      const fields = { preAt: key, trigger: rec.trigger, saved: rec.written, savedTurns: rec.turns, savedTokens: rec.tokens_est, bundle: rec.bundle }
      if (pending && pending.preAt == null) {
        // The mod's classic.PreCompact hook already opened this entry with the
        // before-numbers; the script's record completes it.
        Object.assign(pending, fields)
      } else {
        if (pending) compactions.push(pending)
        pending = { startedAt: key, ...fields }
      }
    } else if (rec.event === 'SessionStart' && rec.source === 'compact') {
      const done = { postAt: key, injected: true, injectedTokens: rec.tokens_est, origin: rec.origin }
      const last = compactions[compactions.length - 1]
      if (pending) {
        Object.assign(pending, done, { bundle: pending.bundle || rec.bundle })
        compactions.push(pending)
        pending = null
      } else if (last && last.postAt == null) {
        Object.assign(last, done, { bundle: last.bundle || rec.bundle })
      } else {
        compactions.push({ preAt: null, startedAt: key, bundle: rec.bundle, ...done })
      }
    }
  }
}

export function register(on) {
  // ---- session start: register the command, start the live refresh --------
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'before-compact', description: 'Open the compaction monitor pane', immediate: true })
    } catch (err) { lastError = 'register: ' + (err && err.message ? err.message : err) }
    await refreshLive($)
    applyStatus(await readStatus($))
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
    applyStatus(await readStatus($))
    await $.ui.open({ id: PANE, title: 'Before Compact', focus: true, closeOnEscape: true, columns: 60 })
    return {}
  })

  // ---- the two sides of a compaction ---------------------------------------
  // Before: snapshot the context so the log can show what compaction removed.
  on('classic.PreCompact', async ($, e, next) => {
    await refreshLive($)
    pending = {
      preAt: null, // filled when the script's status record arrives
      trigger: e.trigger || null,
      beforeTokens: usage ? usage.tokens : null,
      beforePercent: usage ? usage.percent : null,
      beforeMessages: messageCount,
      startedAt: new Date().toISOString(),
    }
    $.ui.toast('Compaction starting — saving your last turns')
    $.ui.invalidate('ui.render')
    return next(e)
  }).catch(async ($, e, next) => {
    // The hook threw or timed out. Record it where the pane shows it, and pass the
    // event on so the settings hooks still run (or return their result if next was
    // already called). The snapshot is lost; nothing else is.
    lastError = `PreCompact hook ${next.error.kind}: ${next.error.message || ''}`.trim()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // After: snapshot again, pick up the script's status, show the result.
  on('classic.SessionStart', { source: ['compact'] }, async ($, e, next) => {
    // The settings hooks and this hook run around the same time; give the script a
    // moment to write its status before reading it, then once more to be sure.
    const settle = async () => {
      try {
        await refreshLive($)
        applyStatus(await readStatus($))
        const last = compactions[compactions.length - 1]
        if (last && last.afterTokens == null) {
          last.afterTokens = usage ? usage.tokens : null
          last.afterPercent = usage ? usage.percent : null
          last.afterMessages = messageCount
          await loadBundle($, last.bundle)
          await probeTranscript($)
          const t = last.injected ? `Restored ${fmtK(last.injectedTokens)} tokens of your voice` : 'Compaction done — nothing was re-injected'
          $.ui.toast(t)
          $.ui.log(`compaction: ${fmtK(last.beforeTokens)} → ${fmtK(last.afterTokens)} tokens, ${last.beforeMessages ?? '?'} → ${last.afterMessages ?? '?'} messages; ${last.injected ? 'bundle re-injected' : 'no bundle'}`)
        }
      } catch (err) {
        // A timer callback is outside the hook, so .catch below can't see it.
        lastError = 'settle: ' + (err && err.message ? err.message : err)
      }
      $.ui.invalidate('ui.render')
    }
    $.clock.after(1500, settle)
    $.clock.after(6000, settle)
    return next(e)
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

    const tabButton = (name, label, hotkey) =>
      Button({ key: 'tab-' + name, label, hotkey, plain: true, dimColor: tab !== name, onPress: () => { tab = name; redraw() } })

    const header = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: [
        tabButton('monitor', 'Monitor', '1'),
        tabButton('bundle', 'Last bundle', '2'),
        Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: async () => { await refreshLive($); applyStatus(await readStatus($)); await probeTranscript($); const l = compactions[compactions.length - 1]; if (l) await loadBundle($, l.bundle); redraw() } }),
      ],
    })

    let body
    if (tab === 'bundle') {
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
      if (pending) {
        rows.push(Text({ color: 'yellow', children: [`● compacting now (${pending.trigger || '?'}) — before: ${fmtK(pending.beforeTokens)} tokens, ${pending.beforeMessages ?? '?'} messages`] }))
        rows.push(Text({ dimColor: true, children: [`  PreCompact save: ${pending.saved ? `✓ ${pending.savedTurns} turns, ~${fmtK(pending.savedTokens)} tokens` : 'waiting for the hook…'}`] }))
      }
      const list = compactions.slice().reverse()
      list.forEach((c, i) => {
        const n = compactions.length - i
        rows.push(Text({ bold: true, children: [`#${n}  ${fmtTime(c.postAt || c.startedAt)}  ${c.trigger || '?'}   ${fmtK(c.beforeTokens)} → ${fmtK(c.afterTokens)} tokens   ${c.beforeMessages ?? '?'} → ${c.afterMessages ?? '?'} messages`] }))
        rows.push(Text({ color: c.saved ? 'green' : 'red', children: [`    PreCompact  ${c.saved ? '✓' : '✗'} ${c.saved ? `saved ${c.savedTurns} user turns (~${fmtK(c.savedTokens)} tokens)` : 'bundle not written'}`] }))
        rows.push(Text({ color: c.injected ? 'green' : 'red', children: [`    SessionStart ${c.injected ? '✓' : '✗'} ${c.injected ? `re-injected ~${fmtK(c.injectedTokens)} tokens (${c.origin || ''})` : 'nothing injected'}`] }))
      })
      if (!pending && !compactions.length) {
        rows.push(Text({ dimColor: true, children: ['No compactions yet this session.'] }))
        rows.push(Text({ dimColor: true, children: ['Run /compact to see the two hooks fire, or wait for auto-compact.'] }))
      }

      const history = transcript
        ? Text({ dimColor: true, children: [`Transcript on disk: ${transcript.compactions} compaction marker(s) in ${transcript.events} events${transcript.compactions > compactions.length ? ' (earlier than this plugin was watching; see tab 2)' : ''}`] })
        : transcriptPath
          ? Text({ dimColor: true, children: ['Transcript on disk: found, but --probe failed (see last error below)'] })
          : Text({ dimColor: true, children: ['Transcript on disk: not found for this directory'] })
      body = [
        ...live,
        Text({ bold: true, children: [`Compactions this session: ${compactions.length}`] }),
        history,
        ...rows,
        Text({ children: [' '] }),
        Text({ dimColor: true, children: ['How to read it: tokens/messages drop at compaction; the two ✓ marks mean your last turns were saved before and put back after.'] }),
      ]
    }

    if (lastError) body.push(Text({ dimColor: true, children: [`(last error: ${lastError})`] }))

    return Box({ flexDirection: 'column', children: [header, Text({ children: [' '] }), ...body] })
  })
}
