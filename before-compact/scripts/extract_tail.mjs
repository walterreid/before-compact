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
//        SessionStart  → prints the bundle to stdout. Claude Code adds a SessionStart
//        (compact)       hook's plain stdout to Claude's context, so recovery needs no
//                        agent memory (Tier 2). Uses the PreCompact file if one is fresh,
//                        otherwise extracts live from transcript_path.
//      In hook mode the transcript comes from the hook input, so the encoded-cwd
//      discovery below is never used. Default budget in hook mode is 9000 chars,
//      under Claude Code's 10,000-char cap on injected hook output.
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
import { join } from 'node:path';

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
function bundlePath(sessionId) {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'before-compact');
  return join(base, `precompact-${sessionId || 'unknown'}.txt`);
}
const BUNDLE_MAX_AGE_MS = 15 * 60 * 1000; // a PreCompact bundle older than this is stale

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
const isCompactionSummary = (t) =>
  t.includes('This session is being continued from a previous conversation');

function truncate(t, max) {
  if (RAW || !isFinite(max)) return t;   // --raw is verbatim; otherwise 0/omitted = unlimited
  if (max <= 0) return '';               // caller renders a header only
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n  …[+${t.length - max} chars truncated — rerun with --raw or a larger --*-max to see all]`;
}

// ---- the extraction, as a function so hook mode can call it ----------------
function extract(T) {
  const lines = readFileSync(T, 'utf8').split('\n').filter(Boolean);

  // --recover: a compaction leaves a marker in the SAME transcript — the injected
  // "This session is being continued…" summary. Recover the turns immediately
  // BEFORE the most recent one. Falls back to the plain tail if none is found —
  // which, at PreCompact time or if the transcript lags, IS the pre-compaction tail.
  let startIdx = lines.length - 1;
  let recoverNote = '';
  if (RECOVER) {
    let mark = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
      const t = ev && ev.message ? textOf(ev.message.content) : '';
      if (t && isCompactionSummary(t)) { mark = i; break; }
    }
    if (mark >= 0) { startIdx = mark - 1; recoverNote = `recovered the turns BEFORE the last compaction (transcript event ${mark} of ${lines.length})`; }
    else recoverNote = 'no compaction boundary found in the transcript — showing the normal tail';
  }

  // Walk backward from the end, newest first, so the budget keeps the most recent turns.
  const collected = [];
  let budget = MAX_CHARS;
  let dropped = 0;
  for (let i = startIdx; i >= 0 && collected.length < TURNS; i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const role = ev.type === 'user' ? 'USER' : ev.type === 'assistant' ? 'ASSISTANT' : null;
    if (!role) continue;
    if (ROLE !== 'both' && ROLE !== role.toLowerCase()) continue;
    const msg = ev.message;
    if (!msg) continue;
    const content = msg.content;
    // skip pure tool-result / tool-use turns (no human-readable text in them)
    if (Array.isArray(content) && content.length &&
        content.every((b) => b && (b.type === 'tool_result' || b.type === 'tool_use'))) continue;
    let txt = stripNoise(textOf(content));
    if (!txt) continue;
    if (!RAW && isCompactionSummary(txt)) continue;       // the injected summary, not a real turn
    txt = truncate(txt, role === 'USER' ? USER_MAX : ASSIST_MAX);
    txt = txt || '(omitted — assistant-max 0)';
    const cost = txt.length + 40;                          // + per-turn header overhead
    if (isFinite(budget) && cost > budget) { dropped++; if (collected.length) break; continue; }
    budget -= cost;
    collected.push({ role, txt });
  }
  collected.reverse(); // oldest -> newest

  const body = collected.map((c, n) => `\n===== ${c.role}  [${n - collected.length}] =====\n${c.txt}`).join('\n');
  const chars = collected.reduce((s, c) => s + c.txt.length, 0);
  const users = collected.filter((c) => c.role === 'USER').length;
  const stats =
    `[${collected.length} turns (${users} user / ${collected.length - users} assistant)` +
    `  ·  ~${Math.round(chars / 4)} tokens  ·  source: ${T}]` +
    (RECOVER ? `\n[recover: ${recoverNote}]` : '') +
    (isFinite(MAX_CHARS) && dropped ? `\n[budget: --max-chars ${MAX_CHARS} kept the newest ${collected.length}; older turns dropped]` : '');
  return { body, stats, count: collected.length };
}

// ---- probe mode: what does the transcript say about past compactions? ------
// Prints one JSON object. Used by the plugin's pane on a resumed session, where
// compactions happened before any hook was watching.
if (flag('probe', false)) {
  const T = pickTranscript();
  const lines = readFileSync(T, 'utf8').split('\n').filter(Boolean);
  const markers = [];
  let users = 0, assistants = 0;
  for (let i = 0; i < lines.length; i++) {
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev.type === 'user') users++; else if (ev.type === 'assistant') assistants++;
    const t = ev && ev.message ? textOf(ev.message.content) : '';
    if (t && isCompactionSummary(t)) markers.push({ index: i, at: ev.timestamp || null, summary_chars: t.length });
  }
  console.log(JSON.stringify({ transcript: T, events: lines.length, user_events: users, assistant_events: assistants, compactions: markers.length, markers: markers.slice(-10) }));
  process.exit(0);
}

// ---- hook mode -------------------------------------------------------------
if (HOOK) {
  const event = hook.hook_event_name;
  const T = pickTranscript();

  if (event === 'PreCompact') {
    // Tier 3: write the bundle while the transcript is still intact. Nothing to
    // print — PreCompact stdout is not shown to Claude.
    const out = extract(T);
    let written = false, p = bundlePath(hook.session_id);
    try {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, `${out.body}\n\n${out.stats}\n`);
      written = true;
    } catch (e) { console.error(`extract_tail: could not write PreCompact bundle (${e.message})`); }
    recordStatus(hook.session_id, {
      event: 'PreCompact', trigger: hook.trigger || null, written, bundle: p,
      turns: out.count, chars: out.body.length, tokens_est: Math.round(out.body.length / 4),
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
      const out = extract(T);
      if (!out.count) process.exit(0);                     // nothing worth injecting
      text = `${out.body}\n\n${out.stats}`; origin = 'extracted from the transcript after compaction';
    }
    // Factual framing, not an instruction: text that reads as an out-of-band command
    // can trip prompt-injection defenses and get surfaced instead of used.
    recordStatus(hook.session_id, {
      event: 'SessionStart', source: hook.source || null, origin, injected: true,
      chars: text.length, tokens_est: Math.round(text.length / 4), bundle: p, transcript: T,
    });
    console.log(
      `The following are verbatim prior turns from this same session, from just before ` +
      `the context was compacted (${origin}). They preserve the user's voice and the ` +
      `exact last steps that the compaction summary flattened. Oldest to newest; the ` +
      `[-N] index counts back from the most recent turn.\n${text}`
    );
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
