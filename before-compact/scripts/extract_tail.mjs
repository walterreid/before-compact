#!/usr/bin/env node
// extract_tail.mjs — pull the tail of THIS project's Claude Code conversation
// into a compact, paste-ready "before-compact" for a fresh or just-compacted session.
//
// WHY: after a compaction, the model keeps the facts but loses the *feel* — how
// you actually talk and how each decision got made. An agent summary flattens
// that; the raw last-N turns keep your voice. This extracts those turns cheaply.
//
// TWO WAYS TO RUN IT
//
//   1. By hand (unchanged from the standalone script):
//        node scripts/extract_tail.mjs                 # last 60 turns, this project, newest session
//        node scripts/extract_tail.mjs --recover       # the turns right BEFORE the last compaction
//        node scripts/extract_tail.mjs --recover --role user
//        node scripts/extract_tail.mjs --turns 120 | --role user | --assistant-max 0 | --raw
//        node scripts/extract_tail.mjs --file /path/to/session.jsonl
//        node scripts/extract_tail.mjs --max-chars 9000   # total budget; drops oldest turns first
//
//   2. As a Claude Code hook (--hook): reads the hook's JSON from stdin.
//        PreCompact    → writes the recovery bundle to a file BEFORE the window is
//                        rewritten (Tier 3: prepared, not reconstructed). Prints nothing.
//                        Beside it, writes the ARC for the current window (the turns
//                        since the last compaction): both roles, assistant turns
//                        untruncated, noise stripped, no budget; one numbered file per
//                        compaction. Never injected; the SessionStart output states
//                        where the newest one is, so the model can read it when a task
//                        needs what was done, not only what was said.
//        SessionStart  → prints the bundle to stdout. Claude Code adds a SessionStart
//        (compact)       hook's plain stdout to Claude's context, so recovery needs no
//                        agent memory (Tier 2). Uses the PreCompact file if one is fresh,
//                        otherwise extracts live from transcript_path.
//      In hook mode the transcript comes from the hook input, so the encoded-cwd
//      discovery below is never used. Default budget in hook mode is 9000 chars for
//      the whole output (framing, pointer line, turns, stats), under Claude Code's
//      10,000-char cap on injected hook output.
//
// WHERE THE CONVERSATION LIVES (manual mode only):
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, where <encoded-cwd> is
//   the absolute working directory with every "/" and " " turned into "-". This
//   script derives that from process.cwd() and picks the MOST-RECENTLY-MODIFIED
//   .jsonl. Override with --file <path> or --project <encoded-dir-name>.
//
// It prints oldest -> newest with a per-turn [-N] index counting back from the
// latest, and ends with a stats line (turn counts + estimated token cost +
// resolved source path).

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---- tiny flag parser ("--name value", or "--name" alone => true) ----------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
if (flag('help', false)) {
  console.log('extract_tail.mjs — see the comment header of this file for full usage.');
  console.log('Common: --turns N | --role user|assistant|both | --assistant-max CHARS | --max-chars CHARS | --raw | --recover | --file PATH | --hook');
  process.exit(0);
}
const HOOK        = Boolean(flag('hook', false));                    // read hook JSON from stdin
const TURNS       = Number(flag('turns', 60));
const ROLE        = String(flag('role', 'both')).toLowerCase();      // both | user | assistant
const ASSIST_MAX  = Number(flag('assistant-max', 700));              // chars per assistant turn; 0 = header only
const USER_MAX    = Number(flag('user-max', 0)) || Infinity;         // chars per user turn; 0/omitted = unlimited
const MAX_CHARS   = Number(flag('max-chars', HOOK ? 9000 : 0)) || Infinity; // total budget; 0 = unlimited
const RAW         = Boolean(flag('raw', false));                     // verbatim: no truncation, no noise-stripping
let   RECOVER     = Boolean(flag('recover', false));                 // recover the turns before the last compaction
const FILE_OVR    = flag('file', null);
const PROJECT_OVR = flag('project', null);

// ---- hook input ------------------------------------------------------------
// Claude Code sends the event as JSON on stdin: session_id, transcript_path, cwd,
// hook_event_name, and for SessionStart a `source` (startup|resume|clear|compact|fork).
let hook = null;
if (HOOK) {
  try { hook = JSON.parse(readFileSync(0, 'utf8')); }
  catch (e) { console.error(`extract_tail: --hook but stdin was not JSON (${e.message})`); process.exit(0); }
}

// Where the PreCompact bundle is parked between the two hook events. Claude Code
// exports CLAUDE_PLUGIN_DATA for plugin hooks; fall back to the OS temp dir.
// Absolute, because the SessionStart output names the arc's path for the model.
function dataDir() {
  return resolve(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'before-compact'));
}
function bundlePath(sessionId) {
  return join(dataDir(), `precompact-${sessionId || 'unknown'}.txt`);
}
// The arc: the back-and-forth of the CURRENT WINDOW (the turns after the most
// recent compaction boundary in the transcript; the whole transcript when there
// is none), both roles, nothing cut, written beside the bundle. One file per
// compaction, never overwritten: arc-<session>-<n>.txt, n = the boundaries already
// in the transcript + 1, so each epoch keeps its own file. Not injected (it has no
// budget); the SessionStart output names the newest one.
function arcPath(sessionId, n) {
  return join(dataDir(), `arc-${sessionId || 'unknown'}-${n}.txt`);
}
const ARC = { role: 'both', assistMax: Infinity, userMax: Infinity, maxChars: Infinity, turns: Infinity, window: true };
const BUNDLE_MAX_AGE_MS = 15 * 60 * 1000; // a PreCompact bundle older than this is stale
// In hook mode the budget covers the whole printed output. The framing sentence,
// the pointer line and the stats line are fixed text around the turns; reserve
// room for them so the total stays under --max-chars.
const HOOK_RESERVE = 800;

// Write one extraction to a file, with its stats line last. Returns the number of
// characters written, or null if it failed.
function writeExtract(p, out) {
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    const text = `${out.body}\n\n${out.stats}\n`;
    writeFileSync(p, text);
    return text.length;
  } catch (e) { console.error(`extract_tail: could not write ${p} (${e.message})`); return null; }
}
// The newest arc on disk for this session (highest n), as { path, chars, tokens,
// turns }: turns and tokens come from the file's own stats line, so the file has one
// token figure and the pointer line and the status record both carry it; chars is
// the file's length. null when there is no fresh arc for this session.
function arcInfo(sessionId) {
  try {
    const dir = dataDir();
    const re = new RegExp(`^arc-${(sessionId || 'unknown').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.txt$`);
    let best = null, bestN = 0;
    for (const f of readdirSync(dir)) {
      const m = re.exec(f);
      if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = join(dir, f); }
    }
    if (!best || Date.now() - statSync(best).mtimeMs >= BUNDLE_MAX_AGE_MS) return null;
    return { path: best, ...statsOf(readFileSync(best, 'utf8')) };
  } catch { return null; }
}
// The figures an extraction's own stats line states: { chars, turns, tokens }.
function statsOf(text) {
  const m = /\[(\d+) turns \([^)]*\) {2}· {2}~(\d+) tokens/.exec(text.slice(-1000));
  return { chars: text.length, turns: m ? Number(m[1]) : null, tokens: m ? Number(m[2]) : Math.round(text.length / 4) };
}
// A statement, not an instruction: text that reads as an out-of-band command can
// trip prompt-injection defenses and get surfaced instead of used.
function pointerLine(arc) {
  if (!arc) return '';
  return `The full back-and-forth of this window before the compaction, both sides with the assistant's turns` +
    ` untruncated (${arc.turns ?? '?'} turns, ~${arc.tokens} tokens), is in ${arc.path}.\n`;
}

// A small status record per hook event, read by the plugin's pane (hooks/register.js)
// so the user can SEE that recovery ran. Lives under ~/.claude/before-compact/, a path
// both the script and the mod can compute without sharing environment.
function statusPath(sessionId) {
  return join(homedir(), '.claude', 'before-compact', `status-${sessionId || 'unknown'}.json`);
}
function recordStatus(sessionId, entry) {
  try {
    const p = statusPath(sessionId);
    mkdirSync(join(p, '..'), { recursive: true });
    let log = [];
    try { log = JSON.parse(readFileSync(p, 'utf8')); if (!Array.isArray(log)) log = []; } catch { /* new */ }
    log.push({ at: new Date().toISOString(), ...entry });
    writeFileSync(p, JSON.stringify(log.slice(-50), null, 1));
  } catch { /* status is best-effort; never fail the hook over it */ }
}

// The stand-down marker the mod writes (hooks/register.js, userConfig inject_in_mod)
// when it has itself appended the last user turns after the summary. It is written
// inside the mod's session.compact hook, before that hook returns, and Claude Code
// fires SessionStart(compact) only after the compaction result is in hand; so when
// this script runs for that compaction the marker is already on disk. Consumed on
// read, and ignored when older than MARKER_MAX_AGE_MS, so a marker left behind by a
// compaction whose SessionStart hook never ran cannot silence the next one.
const MARKER_MAX_AGE_MS = 2 * 60 * 1000;
function markerPath(sessionId) {
  return join(homedir(), '.claude', 'before-compact', `injected-${sessionId || 'unknown'}.json`);
}
function takeMarker(sessionId) {
  const p = markerPath(sessionId);
  let m = null;
  try { if (!existsSync(p)) return null; m = JSON.parse(readFileSync(p, 'utf8')); } catch { m = null; }
  try { unlinkSync(p); } catch { /* best effort */ }
  if (!m || typeof m.at !== 'string' || !(Date.now() - Date.parse(m.at) <= MARKER_MAX_AGE_MS)) return null;
  return m;
}

// ---- locate the transcript -------------------------------------------------
const projectsRoot = () => join(homedir(), '.claude', 'projects');
const encodedCwd = () => process.cwd().replace(/[/ ]/g, '-');

function pickTranscript() {
  if (hook && typeof hook.transcript_path === 'string') return hook.transcript_path;
  if (typeof FILE_OVR === 'string') return FILE_OVR;
  const dirName = typeof PROJECT_OVR === 'string' ? PROJECT_OVR : encodedCwd();
  const dir = join(projectsRoot(), dirName);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    let avail = [];
    try { avail = readdirSync(projectsRoot()); } catch { /* none */ }
    console.error(`extract_tail: no project dir at ${dir}`);
    if (avail.length) console.error(`Available projects (pass one as --project):\n  ${avail.join('\n  ')}`);
    process.exit(1);
  }
  if (!files.length) { console.error(`extract_tail: no .jsonl transcripts in ${dir}`); process.exit(1); }
  // newest by mtime == the session most recently written to
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}

// ---- text extraction + noise handling --------------------------------------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}
// Harness-injected blocks are not the human/assistant voice — drop them unless --raw.
function stripNoise(t) {
  if (RAW) return t.trim();
  return t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, '')
    .replace(/<command-[\s\S]*?<\/command-[^>]*>/g, '')
    .trim();
}
// The opening phrase of the summary message Claude Code installs after a
// compaction. Only a fallback now (see findBoundaries): the boundary entry is the
// primary marker, and in a transcript that has one a turn quoting this phrase is
// an ordinary turn.
const MARKER_PHRASE = 'This session is being continued from a previous conversation';
const isCompactionSummary = (t) => t.includes(MARKER_PHRASE);

function truncate(t, max) {
  if (RAW || !isFinite(max)) return t;   // --raw is verbatim; otherwise 0/omitted = unlimited
  if (max <= 0) return '';               // caller renders a header only
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n  …[+${t.length - max} chars truncated — rerun with --raw or a larger --*-max to see all]`;
}

// The compaction boundaries of a transcript, oldest first, each as
//   { index, summaryIndex, source, at, trigger, preTokens, postTokens, durationMs, preserved }
//
// PRIMARY: the entry Claude Code writes immediately before each summary message:
//   {"type":"system","subtype":"compact_boundary","compactMetadata":{trigger,
//    preTokens, postTokens, durationMs, cumulativeDroppedTokens, preservedMessages:
//    {anchorUuid, uuids, allUuids}, preservedSegment}, ...}
// (seen on this machine in every transcript Claude Code compacted). The summary
// message is the FIRST `user` entry after it: usually the next line, but a few
// `attachment` entries can sit in between (11 of 58 boundaries here had three).
// `index` is the boundary entry; `summaryIndex` is that summary message, so
// extract() can skip it without a text test.
//
// FALLBACK, only when a transcript has no such entry (written by an older Claude
// Code): the user message that opens with MARKER_PHRASE. Then index = summaryIndex
// and the engine's numbers are null. A turn that merely quotes the phrase counts
// as a boundary only on this path.
//
// A cheap substring test first, so only candidate lines are parsed.
const BOUNDARY_TAG = '"compact_boundary"';
function findBoundaries(lines) {
  const parse = (i) => { try { return JSON.parse(lines[i]); } catch { return null; } };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(BOUNDARY_TAG)) continue;
    const ev = parse(i);
    if (!ev || ev.type !== 'system' || ev.subtype !== 'compact_boundary') continue;
    let summaryIndex = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 50); j++) {
      const n = parse(j);
      if (n && n.type === 'user') { summaryIndex = j; break; }
    }
    const m = ev.compactMetadata || {};
    const uuids = m.preservedMessages && Array.isArray(m.preservedMessages.uuids) ? m.preservedMessages.uuids : null;
    out.push({
      index: i, summaryIndex, source: 'compact_boundary', at: ev.timestamp || null,
      trigger: m.trigger ?? null, preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null,
      durationMs: m.durationMs ?? null, preserved: uuids ? uuids.length : null,
    });
  }
  if (out.length) return out;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(MARKER_PHRASE)) continue;
    const ev = parse(i);
    if (!ev || ev.type !== 'user' || !ev.message) continue;
    const t = textOf(ev.message.content);
    if (t && isCompactionSummary(t)) {
      out.push({ index: i, summaryIndex: i, source: 'phrase', at: ev.timestamp || null, summary_chars: t.length,
        trigger: null, preTokens: null, postTokens: null, durationMs: null, preserved: null });
    }
  }
  return out;
}
// The transcript indices of the boundaries, oldest first.
const markerIndices = (lines) => findBoundaries(lines).map((b) => b.index);

// ---- the extraction, as a function so hook mode can call it ----------------
// `o` overrides the command-line knobs (the arc uses it: both roles, no limits,
// and `window`: stop at the most recent boundary, so only the current window's
// turns are taken, the inverse of --recover, which takes the turns before it).
function extract(T, o = {}) {
  const turns = o.turns ?? TURNS, role = o.role ?? ROLE, assistMax = o.assistMax ?? ASSIST_MAX;
  const userMax = o.userMax ?? USER_MAX, maxChars = o.maxChars ?? MAX_CHARS, reserve = o.reserve ?? 0;
  const lines = readFileSync(T, 'utf8').split('\n').filter(Boolean);
  const bounds = findBoundaries(lines);
  const marks = bounds.map((b) => b.index);
  // The summary messages themselves: not real turns, never part of an extraction.
  const summaries = new Set(bounds.map((b) => b.summaryIndex).filter((i) => i != null));

  // --recover: a compaction leaves a boundary in the SAME transcript (the
  // compact_boundary entry, or on an older transcript the injected "This session
  // is being continued…" summary). Recover the turns immediately BEFORE the most
  // recent one. Falls back to the plain tail if none is found — which, at
  // PreCompact time or if the transcript lags, IS the pre-compaction tail.
  let startIdx = lines.length - 1;
  let recoverNote = '';
  if (RECOVER) {
    const mark = marks.length ? marks[marks.length - 1] : -1;
    if (mark >= 0) { startIdx = mark - 1; recoverNote = `recovered the turns BEFORE the last compaction (transcript event ${mark} of ${lines.length})`; }
    else recoverNote = 'no compaction boundary found in the transcript — showing the normal tail';
  }
  // `window`: the floor is the newest boundary at or below the start (exclusive), and
  // the epoch number counts the boundaries below it plus one. At PreCompact time that
  // is "all the markers + 1"; on the SessionStart fallback, where the new summary
  // is already in the transcript, it is the window just closed.
  let floor = -1, epoch = 1;
  if (o.window) {
    const below = marks.filter((i) => i <= startIdx);
    if (below.length) floor = below[below.length - 1];
    epoch = below.length + 1;
  }

  // Walk backward from the end, newest first, so the budget keeps the most recent turns.
  const collected = [];
  let budget = isFinite(maxChars) ? Math.max(200, maxChars - reserve) : maxChars;
  let dropped = 0;
  for (let i = startIdx; i > floor && collected.length < turns; i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const who = ev.type === 'user' ? 'USER' : ev.type === 'assistant' ? 'ASSISTANT' : null;
    if (!who) continue;
    if (role !== 'both' && role !== who.toLowerCase()) continue;
    const msg = ev.message;
    if (!msg) continue;
    const content = msg.content;
    // skip pure tool-result / tool-use turns (no human-readable text in them)
    if (Array.isArray(content) && content.length &&
        content.every((b) => b && (b.type === 'tool_result' || b.type === 'tool_use'))) continue;
    let txt = stripNoise(textOf(content));
    if (!txt) continue;
    if (!RAW && summaries.has(i)) continue;               // the injected summary, not a real turn
    txt = truncate(txt, who === 'USER' ? userMax : assistMax);
    txt = txt || '(omitted — assistant-max 0)';
    const cost = txt.length + 40;                          // + per-turn header overhead
    if (isFinite(budget) && cost > budget) { dropped++; if (collected.length) break; continue; }
    budget -= cost;
    collected.push({ role: who, txt });
  }
  collected.reverse(); // oldest -> newest

  const body = collected.map((c, n) => `\n===== ${c.role}  [${n - collected.length}] =====\n${c.txt}`).join('\n');
  const chars = collected.reduce((s, c) => s + c.txt.length, 0);
  const users = collected.filter((c) => c.role === 'USER').length;
  const stats =
    `[${collected.length} turns (${users} user / ${collected.length - users} assistant)` +
    `  ·  ~${Math.round(chars / 4)} tokens  ·  source: ${T}]` +
    (RECOVER ? `\n[recover: ${recoverNote}]` : '') +
    (isFinite(maxChars) && dropped ? `\n[budget: --max-chars ${maxChars}${reserve ? ` (${reserve} reserved for the framing)` : ''} kept the newest ${collected.length}; older turns dropped]` : '');
  return { body, stats, count: collected.length, tokens: Math.round(chars / 4), epoch };
}

// ---- probe mode: what does the transcript say about past compactions? ------
// Prints one JSON object. Used by the plugin's pane on a resumed session, where
// compactions happened before any hook was watching, and on a Claude Code that
// does not fire session.compact into the mod: the boundary entries carry the
// engine's own numbers, so `markers[]` has, per boundary, trigger, preTokens,
// postTokens, durationMs and preserved (the count of preservedMessages.uuids);
// `boundary_source` says whether they came from compact_boundary entries or from
// the phrase fallback (then those fields are null).
if (flag('probe', false)) {
  const T = pickTranscript();
  const lines = readFileSync(T, 'utf8').split('\n').filter(Boolean);
  let users = 0, assistants = 0;
  for (let i = 0; i < lines.length; i++) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev.type === 'user') users++; else if (ev.type === 'assistant') assistants++;
  }
  const bounds = findBoundaries(lines);
  const markers = bounds.map((b) => {
    let summary_chars = b.summary_chars ?? null;
    if (summary_chars == null && b.summaryIndex != null) {
      try { summary_chars = textOf(JSON.parse(lines[b.summaryIndex]).message.content).length; } catch { /* leave null */ }
    }
    return { index: b.index, summary_index: b.summaryIndex, at: b.at, source: b.source, summary_chars,
      trigger: b.trigger, preTokens: b.preTokens, postTokens: b.postTokens, durationMs: b.durationMs, preserved: b.preserved };
  });
  console.log(JSON.stringify({
    transcript: T, events: lines.length, user_events: users, assistant_events: assistants,
    compactions: markers.length, boundary_source: bounds.length ? bounds[0].source : null, markers: markers.slice(-10),
  }));
  process.exit(0);
}

// ---- hook mode -------------------------------------------------------------
if (HOOK) {
  const event = hook.hook_event_name;
  const T = pickTranscript();

  if (event === 'PreCompact') {
    // Tier 3: write the bundle while the transcript is still intact. Nothing to
    // print — PreCompact stdout is not shown to Claude. Beside it, the arc: the
    // same transcript with both roles and nothing cut, for the model to read on
    // demand (the SessionStart output names the file; it is never injected).
    const out = extract(T, { reserve: HOOK_RESERVE });
    const p = bundlePath(hook.session_id);
    const written = writeExtract(p, out) != null;
    const arc = extract(T, ARC);
    const a = arcPath(hook.session_id, arc.epoch);
    const arcChars = writeExtract(a, arc);
    recordStatus(hook.session_id, {
      event: 'PreCompact', trigger: hook.trigger || null, written, bundle: p,
      turns: out.count, chars: out.body.length, tokens_est: Math.round(out.body.length / 4),
      arc: a, arc_written: arcChars != null, arc_turns: arc.count,
      arc_chars: arcChars ?? 0, arc_tokens_est: arc.tokens,
      transcript: T,
    });
    process.exit(0);
  }

  if (event === 'SessionStart') {
    // Tier 2: print the bundle; Claude Code injects a SessionStart hook's stdout
    // as context. Prefer the PreCompact bundle if one is fresh for this session.
    let text = null, origin = '';
    const p = bundlePath(hook.session_id);
    // The mod already appended the turns itself (inject_in_mod): print nothing, so
    // they are not in the context twice, and say so in the status record.
    const stood = takeMarker(hook.session_id);
    if (stood) {
      recordStatus(hook.session_id, {
        event: 'SessionStart', source: hook.source || null, injected: false,
        origin: `stood down: the mod appended ${stood.appended} user turns after the summary`,
        mod_appended: stood.appended ?? null, mod_chars: stood.chars ?? null, bundle: p, transcript: T,
      });
      process.exit(0);
    }
    try {
      if (existsSync(p) && Date.now() - statSync(p).mtimeMs < BUNDLE_MAX_AGE_MS) {
        text = readFileSync(p, 'utf8'); origin = 'prepared by the PreCompact hook';
      }
    } catch { /* fall through to live extraction */ }
    if (text === null) {
      RECOVER = true;
      const out = extract(T, { reserve: HOOK_RESERVE });
      if (!out.count) process.exit(0);                     // nothing worth injecting
      text = `${out.body}\n\n${out.stats}`; origin = 'extracted from the transcript after compaction';
      // No PreCompact hook ran, so no arc either: write one for the window just
      // closed (RECOVER is on, so the window ends at the new boundary).
      const arcOut = extract(T, ARC);
      writeExtract(arcPath(hook.session_id, arcOut.epoch), arcOut);
    }
    // The arc the PreCompact hook (or the fallback above) left beside the bundle.
    const arc = arcInfo(hook.session_id);
    // Factual framing, not an instruction: text that reads as an out-of-band command
    // can trip prompt-injection defenses and get surfaced instead of used.
    const output =
      `The following are verbatim prior turns from this same session, from just before ` +
      `the context was compacted (${origin}). They preserve the user's voice and the ` +
      `exact last steps that the compaction summary flattened. Oldest to newest; the ` +
      `[-N] index counts back from the most recent turn.\n${pointerLine(arc)}${text}`;
    recordStatus(hook.session_id, {
      event: 'SessionStart', source: hook.source || null, origin, injected: true,
      chars: output.length, tokens_est: Math.round(output.length / 4), bundle: p, transcript: T,
      arc: arc ? arc.path : null, arc_turns: arc ? arc.turns : null, arc_chars: arc ? arc.chars : null, arc_tokens_est: arc ? arc.tokens : null,
    });
    console.log(output);
    process.exit(0);
  }

  console.error(`extract_tail: --hook called for unhandled event ${event}`);
  process.exit(0);
}

// ---- manual mode -----------------------------------------------------------
const T = pickTranscript();
const out = extract(T);
console.log(out.body);
console.log(`\n\n${out.stats}`);
console.log(
  `[knobs: --turns ${TURNS} --role ${ROLE} --assistant-max ${ASSIST_MAX}` +
  `${isFinite(USER_MAX) ? ' --user-max ' + USER_MAX : ''}${isFinite(MAX_CHARS) ? ' --max-chars ' + MAX_CHARS : ''}${RAW ? ' --raw' : ''}` +
  `  ·  tip: --role user for the cheapest voice sample]`
);
