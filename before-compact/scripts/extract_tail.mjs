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
// recent compaction-summary marker in the transcript; the whole transcript when
// there is none), both roles, nothing cut, written beside the bundle. One file per
// compaction, never overwritten: arc-<session>-<n>.txt, n = the markers already in
// the transcript + 1, so each epoch keeps its own file. Not injected (it has no
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

// The digest the mod writes (hooks/register.js, userConfig digest_in_precompact)
// inside its classic.PreCompact hook, after this script's own PreCompact run:
// { at, model, chars, turns, text, … }. Read, not consumed (the pane's Digest tab
// reads the same file): the mod rewrites it before every compaction while the
// flag is on. Two rules decide whether it belongs to THIS compaction:
//   • fresher than DIGEST_MAX_AGE_MS (the bundle's own freshness rule);
//   • written at or after the bundle this script's PreCompact hook wrote for
//     this compaction (the mod's hook runs after this script's, so a digest of
//     this epoch has `at` ≥ the bundle's mtime; one from an earlier compaction,
//     left behind when the flag was turned off, is older than the bundle and
//     would otherwise displace a compaction's worth of user turns with the
//     wrong epoch's digest). A little slack for clock granularity. With no
//     fresh bundle (the live-fallback path) the age rule stands alone.
const DIGEST_MAX_AGE_MS = 15 * 60 * 1000;
const DIGEST_MAX_CHARS = 4000; // of the hook's budget; the turns get the rest
const DIGEST_BUNDLE_SLACK_MS = 5000;
function digestPath(sessionId) {
  return join(homedir(), '.claude', 'before-compact', `digest-${sessionId || 'unknown'}.json`);
}
// { digest, skipped }: the digest to inject, or null with why it was passed over
// ('stale', 'older than the bundle'); both null when there is no digest file.
function readDigest(sessionId, bundleMtimeMs) {
  let d = null;
  try { const p = digestPath(sessionId); if (!existsSync(p)) return { digest: null, skipped: null }; d = JSON.parse(readFileSync(p, 'utf8')); } catch { return { digest: null, skipped: null }; }
  if (!d || typeof d.at !== 'string' || typeof d.text !== 'string' || !d.text.trim()) return { digest: null, skipped: null };
  const at = Date.parse(d.at);
  if (!(Date.now() - at <= DIGEST_MAX_AGE_MS)) return { digest: null, skipped: 'stale' };
  if (bundleMtimeMs != null && !(at >= bundleMtimeMs - DIGEST_BUNDLE_SLACK_MS)) return { digest: null, skipped: 'older than the bundle' };
  return { digest: d, skipped: null };
}
// The digest's share of the output: at most DIGEST_MAX_CHARS, cut with a note.
function digestBlock(d, sessionId) {
  const t = d.text.trim();
  const body = t.length <= DIGEST_MAX_CHARS ? t : t.slice(0, DIGEST_MAX_CHARS) + `\n…[digest cut at ${DIGEST_MAX_CHARS} of ${t.length} chars; the whole is in ${digestPath(sessionId)}]`;
  const framing = `A digest of the dialog before the compaction, written by ${d.model || 'a model'} from the last ${d.turns ?? '?'} turns:`;
  return `${framing}\n${body}`;
}
// Drop the oldest turns of a bundle until it fits `budget`: the bundle is the
// per-turn sections extract() wrote, each opened by "\n===== ROLE  [-N] =====",
// followed by its stats line(s), so cutting leading sections keeps the newest
// turns, their [-N] indices and the stats. The stats then overstate the turn
// count, which the appended note says. Sizes here are UTF-8 bytes, never fewer
// than characters, so the output is under the budget whichever the cap counts.
const bytes = (t) => Buffer.byteLength(t, 'utf8');
function trimBundle(text, budget) {
  if (bytes(text) <= budget) return { text, dropped: 0 };
  const parts = text.split(/\n(?=={5} )/); // split ahead of each "===== ROLE  [-N] =====" line, so each turn keeps its header
  const note = (n) => `\n[budget: the digest took ${DIGEST_MAX_CHARS} chars; the ${n} oldest turn(s) of the bundle were dropped]`;
  let dropped = 0;
  while (parts.length > 1 && bytes(parts.join('\n')) + bytes(note(dropped + 1)) > budget) { parts.shift(); dropped++; }
  let out = parts.join('\n');
  while (bytes(out) + bytes(note(dropped)) > budget && out.length) out = out.slice(0, -1); // one turn still too long: cut it
  return { text: out + note(dropped), dropped };
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

// The transcript indices of the compaction-summary markers (the injected "This
// session is being continued…" user turns), oldest first. A cheap substring test
// first, so only candidate lines are parsed.
const MARKER_PHRASE = 'This session is being continued from a previous conversation';
function markerIndices(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(MARKER_PHRASE)) continue;
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    const t = ev && ev.message ? textOf(ev.message.content) : '';
    if (t && isCompactionSummary(t)) out.push(i);
  }
  return out;
}

// ---- the extraction, as a function so hook mode can call it ----------------
// `o` overrides the command-line knobs (the arc uses it: both roles, no limits,
// and `window`: stop at the most recent marker, so only the current window's turns
// are taken, the inverse of --recover, which takes the turns before that marker).
function extract(T, o = {}) {
  const turns = o.turns ?? TURNS, role = o.role ?? ROLE, assistMax = o.assistMax ?? ASSIST_MAX;
  const userMax = o.userMax ?? USER_MAX, maxChars = o.maxChars ?? MAX_CHARS, reserve = o.reserve ?? 0;
  const lines = readFileSync(T, 'utf8').split('\n').filter(Boolean);
  const marks = markerIndices(lines);

  // --recover: a compaction leaves a marker in the SAME transcript — the injected
  // "This session is being continued…" summary. Recover the turns immediately
  // BEFORE the most recent one. Falls back to the plain tail if none is found —
  // which, at PreCompact time or if the transcript lags, IS the pre-compaction tail.
  let startIdx = lines.length - 1;
  let recoverNote = '';
  if (RECOVER) {
    const mark = marks.length ? marks[marks.length - 1] : -1;
    if (mark >= 0) { startIdx = mark - 1; recoverNote = `recovered the turns BEFORE the last compaction (transcript event ${mark} of ${lines.length})`; }
    else recoverNote = 'no compaction boundary found in the transcript — showing the normal tail';
  }
  // `window`: the floor is the newest marker at or below the start (exclusive), and
  // the epoch number counts the markers below it plus one. At PreCompact time that
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
    if (!RAW && isCompactionSummary(txt)) continue;       // the injected summary, not a real turn
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
    let text = null, origin = '', bundleMtimeMs = null;
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
        bundleMtimeMs = statSync(p).mtimeMs;
      }
    } catch { /* fall through to live extraction */ }
    if (text === null) {
      RECOVER = true;
      const out = extract(T, { reserve: HOOK_RESERVE });
      if (!out.count) process.exit(0);                     // nothing worth injecting
      text = `${out.body}\n\n${out.stats}`; origin = 'extracted from the transcript after compaction';
      // No PreCompact hook ran, so no arc either: write one for the window just
      // closed (RECOVER is on, so the window ends at the new summary's marker).
      const arcOut = extract(T, ARC);
      writeExtract(arcPath(hook.session_id, arcOut.epoch), arcOut);
    }
    // The arc the PreCompact hook (or the fallback above) left beside the bundle.
    const arc = arcInfo(hook.session_id);
    // Factual framing, not an instruction: text that reads as an out-of-band command
    // can trip prompt-injection defenses and get surfaced instead of used.
    const turnsFraming =
      `The following are verbatim prior turns from this same session, from just before ` +
      `the context was compacted (${origin}). They preserve the user's voice and the ` +
      `exact last steps that the compaction summary flattened. Oldest to newest; the ` +
      `[-N] index counts back from the most recent turn.\n`;
    const pointer = pointerLine(arc);
    // The digest experiment: a fresh digest goes first, under its own factual line,
    // and the whole output stays under the budget: the digest gets at most
    // DIGEST_MAX_CHARS, the turns the rest (the bundle was cut for the full budget
    // at PreCompact time, before the digest existed), oldest turns dropped first.
    // With no digest the output is exactly what it was.
    const { digest, skipped: digestSkipped } = readDigest(hook.session_id, bundleMtimeMs);
    let head = '', dropped = 0;
    if (digest) {
      head = digestBlock(digest, hook.session_id) + '\n\n';
      if (isFinite(MAX_CHARS)) {
        const room = Math.max(0, MAX_CHARS - bytes(head) - bytes(turnsFraming) - bytes(pointer));
        ({ text, dropped } = trimBundle(text, room));
      }
    }
    const output = `${head}${turnsFraming}${pointer}${text}`;
    recordStatus(hook.session_id, {
      event: 'SessionStart', source: hook.source || null, origin, injected: true,
      chars: output.length, tokens_est: Math.round(output.length / 4), bundle: p, transcript: T,
      arc: arc ? arc.path : null, arc_turns: arc ? arc.turns : null, arc_chars: arc ? arc.chars : null, arc_tokens_est: arc ? arc.tokens : null,
      digest_chars: digest ? head.length : 0, digest_model: digest ? digest.model || null : null,
      digest_turns: digest ? digest.turns ?? null : null, digest_dropped_turns: dropped, digest_skipped: digestSkipped,
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
