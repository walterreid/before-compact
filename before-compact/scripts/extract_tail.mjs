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
//      A turn too long for what is left of the budget is not the end of the walk: it
//      becomes a one-line note in its place, and the older turns behind it still get
//      their turn. Before 0.3.2 one oversized message (an agent's hand-back of 10,545
//      characters, live) ended the walk and dropped every older turn. Since 0.3.3 the
//      budget the walk leaves unspent goes to the leads of the noted turns, newest first
//      (at least 300 characters each, or the note stays).
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
//      --side user|assistant (hook mode; default user) picks WHICH SIDE of the dialog
//      this run handles. hooks.json runs the script twice per event, once per side,
//      so the two sides are two independent hook outputs, each under its own cap:
//        user       bundle precompact-<session>.txt; writes the arc; prints the arc
//                   pointer line and, when fresh, the digest block.
//        assistant  bundle precompact-<session>-assistant.txt; no arc, no pointer
//                   line, no digest; its own factual framing. Skipped entirely when
//                   the plugin option assistant_turns is off (read from the
//                   environment Claude Code exports, CLAUDE_PLUGIN_OPTION_ASSISTANT_TURNS;
//                   absent means the default, on).
//      --min-chars N skips turns shorter than N characters (default 0). The assistant
//      hook passes 200 so one-line progress notes are left out; --assistant-max 1500
//      keeps the lead of each longer turn, and --newest-turns 2 --newest-max 4000 keep
//      the newest two whole up to 4,000 (the last report before a compaction is the one
//      most worth keeping). Both sides honour the inject_in_mod stand-down marker;
//      neither deletes it (see peekMarker).
//
//      With --role user, messages that arrive in the user's slot but were not typed by
//      the user are left out: an agent's hand-back ("Another Claude session sent a
//      message"), a cross-session message, a side-session event, a scheduled task's
//      prompt, an artifact's context block (the text typed after it is kept). See
//      stripRelayed. --role both (the arc) keeps them: it is the full record.
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

import { readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
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
  console.log('Common: --turns N | --role user|assistant|both | --assistant-max CHARS | --newest-turns N | --newest-max CHARS | --min-chars CHARS | --max-chars CHARS | --raw | --recover | --file PATH | --hook [--side user|assistant]');
  process.exit(0);
}
const HOOK        = Boolean(flag('hook', false));                    // read hook JSON from stdin
const SIDE        = String(flag('side', 'user')).toLowerCase();      // hook mode: user | assistant (which side's bundle this run is)
const TURNS       = Number(flag('turns', 60));
const ROLE        = String(flag('role', SIDE === 'assistant' ? 'assistant' : 'both')).toLowerCase(); // both | user | assistant
const ASSIST_MAX  = Number(flag('assistant-max', SIDE === 'assistant' ? 1500 : 700)); // chars per assistant turn; 0 = header only
const USER_MAX    = Number(flag('user-max', 0)) || Infinity;         // chars per user turn; 0/omitted = unlimited
const NEWEST_TURNS = Number(flag('newest-turns', 0)) || 0;                          // the newest N assistant turns get --newest-max; off unless given (hooks.json passes 2)
const NEWEST_MAX   = Number(flag('newest-max', 4000)) || 0;                          // chars for each of those (used when above --assistant-max)
const MIN_CHARS   = Number(flag('min-chars', 0)) || 0;               // skip turns shorter than this (after noise is stripped)
const MAX_CHARS   = Number(flag('max-chars', HOOK ? 9000 : 0)) || Infinity; // total budget; 0 = unlimited
if (SIDE !== 'user' && SIDE !== 'assistant') { console.error(`extract_tail: --side must be user or assistant, not "${SIDE}"`); process.exit(HOOK ? 0 : 1); }
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
// One bundle per side. The user side keeps the original name, so nothing that
// existed before the assistant side was added has moved.
function bundlePath(sessionId, side = 'user') {
  return join(dataDir(), `precompact-${sessionId || 'unknown'}${side === 'assistant' ? '-assistant' : ''}.txt`);
}
// The plugin option assistant_turns (plugin.json userConfig, boolean, default true),
// as Claude Code exports it to hook processes: CLAUDE_PLUGIN_OPTION_<KEY>, the key
// uppercased (plugins reference, "Reference a saved value"). Whether the DEFAULT is
// exported when the person never set the option, and how a boolean is spelled, the
// reference does not say; so an absent or empty variable means the default (on), and
// only an explicit false/0/off/no turns the side off.
function assistantOn() {
  const v = String(process.env.CLAUDE_PLUGIN_OPTION_ASSISTANT_TURNS ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
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
const ARC = { role: 'both', assistMax: Infinity, userMax: Infinity, minChars: 0, maxChars: Infinity, turns: Infinity, window: true };
const BUNDLE_MAX_AGE_MS = 15 * 60 * 1000; // a PreCompact bundle older than this is stale
// In hook mode the budget covers the whole printed output. The framing sentence,
// the pointer line and the stats line are fixed text around the turns; reserve
// room for them so the total stays under --max-chars.
const HOOK_RESERVE = 800;
const MIN_LEAD = 300; // the leftover pass gives a noted turn its lead only when at least this many chars of it fit

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
  return join(homedir(), '.claude', 'before-compact', `status-${sessionId || 'unknown'}.jsonl`);
}
// One JSON record per line, appended. The user-side and assistant-side hooks of one event
// run at the same moment and, with a ready bundle, finish within milliseconds of each other;
// the earlier read-modify-write of a JSON array lost one of their records in a live
// compaction (2026-10-17) and, in test/run.sh's concurrent pairs, left the file unparseable
// as often. A short append is one write call, so neither process overwrites the other.
function recordStatus(sessionId, entry) {
  try {
    const p = statusPath(sessionId);
    mkdirSync(join(p, '..'), { recursive: true });
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* status is best-effort; never fail the hook over it */ }
}

// The stand-down marker the mod writes (hooks/register.js, userConfig inject_in_mod)
// when it has itself appended the last user turns after the summary. It is written
// inside the mod's session.compact hook, before that hook returns, and Claude Code
// fires SessionStart(compact) only after the compaction result is in hand; so when
// this script runs for that compaction the marker is already on disk.
//
// Read, NOT consumed. Two SessionStart hooks read it now (one per side), and the
// hooks reference does not say in which order several hooks for one event run; a
// marker that the first reader deleted would be missed by the second, which would
// then inject. So neither side deletes a marker it honours. Which compaction a marker
// belongs to is decided the way the digest's is (readDigest): it is this
// compaction's when its `at` is at or after this side's bundle mtime (the mod writes
// it after the PreCompact hooks have written both bundles), with a little slack; an
// older one, left behind by an earlier compaction, is ignored. Where no fresh bundle
// exists (the live-fallback path) the age rule stands alone. A marker older than
// MARKER_MAX_AGE_MS is stale: ignored and removed, so one left behind by a
// compaction whose SessionStart hooks never ran cannot silence a later one.
const MARKER_MAX_AGE_MS = 2 * 60 * 1000;
const MARKER_BUNDLE_SLACK_MS = 5000;
function markerPath(sessionId) {
  return join(homedir(), '.claude', 'before-compact', `injected-${sessionId || 'unknown'}.json`);
}
function peekMarker(sessionId, bundleMtimeMs) {
  const p = markerPath(sessionId);
  let m = null;
  try { if (!existsSync(p)) return null; m = JSON.parse(readFileSync(p, 'utf8')); } catch { m = null; }
  const at = m && typeof m.at === 'string' ? Date.parse(m.at) : NaN;
  if (!(Date.now() - at <= MARKER_MAX_AGE_MS)) { try { unlinkSync(p); } catch { /* best effort */ } return null; }
  if (bundleMtimeMs != null && !(at >= bundleMtimeMs - MARKER_BUNDLE_SLACK_MS)) return null; // an earlier compaction's
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
// Messages that arrive in the user's slot but were not typed by the user, as Claude Code
// writes them (each shape counted in this machine's transcripts, 2026-10-17): an agent's
// hand-back or a relayed session message, which starts with the sentence below and ends
// with Claude Code's own explanation; a side-session event, a scheduled task's prompt and
// a cross-session message, each one whole block; an artifact's context block, followed by
// what the user typed; content marked as authored by others. On the user side they are
// not the user's voice. Returns what the user typed, or '' when nothing of theirs is left.
const RELAYED_BLOCK = /<(side-sessions-event|scheduled-task|cross-session-message|artifact-view-context)\b[^>]*>[\s\S]*?<\/\1>/g;
function stripRelayed(t) {
  if (/^(Another Claude session sent a message|<artifact-content-authored-by-others\b)/.test(t)) return '';
  return t.replace(RELAYED_BLOCK, '').trim();
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
  const minChars = o.minChars ?? MIN_CHARS;
  const newestTurns = o.newestTurns ?? NEWEST_TURNS, newestMax = o.newestMax ?? NEWEST_MAX;
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
  let noted = 0, stopped = false, assistants = 0;
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
    if (!RAW && who === 'USER' && role === 'user') txt = stripRelayed(txt);
    if (!txt) continue;
    if (!RAW && summaries.has(i)) continue;               // the injected summary, not a real turn
    if (txt.length < minChars) continue;                   // --min-chars: a progress line, not a turn worth the budget
    const full = txt.length;
    // The newest --newest-turns assistant turns are cut at --newest-max, when that is the larger.
    const cap = who === 'USER' ? userMax
      : assistants < newestTurns && isFinite(assistMax) && assistMax > 0 && newestMax > assistMax ? newestMax : assistMax;
    txt = truncate(txt, cap);
    txt = txt || '(omitted — assistant-max 0)';
    const cost = txt.length + 40;                          // + per-turn header overhead
    if (isFinite(budget) && cost > budget) {
      // Too long for what is left: a one-line note keeps its place, and the older turns
      // behind it still get their turn.
      const note = `(${full} chars, over the remaining budget, so left out here; the transcript has it whole)`;
      if (note.length + 40 > budget) { stopped = true; break; }
      budget -= note.length + 40;
      noted++;
      collected.push({ role: who, txt: note, noted: true, src: txt });
      if (who === 'ASSISTANT') assistants++;
      continue;
    }
    budget -= cost;
    collected.push({ role: who, txt });
    if (who === 'ASSISTANT') assistants++;
  }
  // The leftover pass: whatever budget the walk did not spend goes to the leads of the
  // noted turns, newest first, each cut to what fits (at least MIN_LEAD chars of it, or the
  // note stays). A long opening message keeps its first paragraphs instead of only its size,
  // and the turns kept by the walk are untouched.
  let leads = 0;
  if (isFinite(budget)) {
    for (const c of collected) {
      if (budget <= 300) break;
      if (!c.noted) continue;
      // The note's own chars come back; 300 stay unspent, because the stats and pointer
      // lines grow with the transcript's path and the walk now fills the budget routinely.
      const room = budget - 300 + c.txt.length;
      const lead = truncate(c.src, room - 100);             // 100: room for the truncation marker
      if (room - 100 < MIN_LEAD || lead.length > room) continue;
      budget = room + 300 - lead.length;                    // the 300 stay reserved once, not per lead
      c.txt = lead; c.noted = false; c.lead = true;
      noted--; leads++;
    }
  }
  collected.reverse(); // oldest -> newest

  const body = collected.map((c, n) => `\n===== ${c.role}  [${n - collected.length}] =====\n${c.txt}`).join('\n');
  // Counts and tokens are the turns kept; a note stands in for a turn, it is not one.
  const kept = collected.filter((c) => !c.noted);
  const chars = kept.reduce((s, c) => s + c.txt.length, 0);
  const users = kept.filter((c) => c.role === 'USER').length;
  const budgetBits = [
    leads ? `${leads} turn(s) too long for their place given their lead from the budget left at the end` : '',
    noted ? `${noted} turn(s) over the remaining budget left out, each with a one-line note in its place` : '',
    stopped ? `kept the newest ${kept.length}; older turns dropped` : '',
  ].filter(Boolean).join('; ');
  const stats =
    `[${kept.length} turns (${users} user / ${kept.length - users} assistant)` +
    `  ·  ~${Math.round(chars / 4)} tokens  ·  source: ${T}]` +
    (RECOVER ? `\n[recover: ${recoverNote}]` : '') +
    (isFinite(maxChars) && budgetBits ? `\n[budget: --max-chars ${maxChars}${reserve ? ` (${reserve} reserved for the framing)` : ''}: ${budgetBits}]` : '');
  return { body, stats, count: kept.length, noted, leads, tokens: Math.round(chars / 4), epoch };
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

  // Every record names its side, so the mod can tell the assistant side's records
  // from the user side's (hooks/register.js, fold). The arc, the pointer line and the
  // digest belong to the user side alone: one arc per compaction, one pointer, and a
  // digest that sits ahead of the user's turns.
  const ASSISTANT = SIDE === 'assistant';
  const p = bundlePath(hook.session_id, SIDE);
  const base = { side: SIDE, bundle: p, transcript: T };

  if (event === 'PreCompact') {
    if (ASSISTANT && !assistantOn()) {
      // The option is off: nothing saved, and the record says why.
      recordStatus(hook.session_id, { event: 'PreCompact', ...base, trigger: hook.trigger || null, written: false, turns: 0, chars: 0, tokens_est: 0, origin: 'off: the assistant_turns option is false' });
      process.exit(0);
    }
    // Tier 3: write the bundle while the transcript is still intact. Nothing to
    // print — PreCompact stdout is not shown to Claude. Beside it (user side only),
    // the arc: the same transcript with both roles and nothing cut, for the model to
    // read on demand (the SessionStart output names the file; it is never injected).
    const out = extract(T, { reserve: HOOK_RESERVE });
    const written = writeExtract(p, out) != null;
    const rec = {
      event: 'PreCompact', ...base, trigger: hook.trigger || null, written,
      turns: out.count, chars: out.body.length, tokens_est: Math.round(out.body.length / 4),
    };
    if (!ASSISTANT) {
      const arc = extract(T, ARC);
      const a = arcPath(hook.session_id, arc.epoch);
      const arcChars = writeExtract(a, arc);
      Object.assign(rec, { arc: a, arc_written: arcChars != null, arc_turns: arc.count, arc_chars: arcChars ?? 0, arc_tokens_est: arc.tokens });
    } else {
      Object.assign(rec, { min_chars: MIN_CHARS, assistant_max: isFinite(ASSIST_MAX) ? ASSIST_MAX : null, newest_turns: NEWEST_TURNS, newest_max: NEWEST_MAX });
    }
    rec.noted = out.noted;
    rec.leads = out.leads;
    recordStatus(hook.session_id, rec);
    process.exit(0);
  }

  if (event === 'SessionStart') {
    const src = { event: 'SessionStart', ...base, source: hook.source || null };
    if (ASSISTANT && !assistantOn()) {
      recordStatus(hook.session_id, { ...src, injected: false, origin: 'off: the assistant_turns option is false' });
      process.exit(0);
    }
    // Tier 2: print the bundle; Claude Code injects a SessionStart hook's stdout
    // as context. Prefer the PreCompact bundle if one is fresh for this session.
    let text = null, origin = '', bundleMtimeMs = null;
    try {
      if (existsSync(p) && Date.now() - statSync(p).mtimeMs < BUNDLE_MAX_AGE_MS) {
        text = readFileSync(p, 'utf8'); origin = 'prepared by the PreCompact hook';
        bundleMtimeMs = statSync(p).mtimeMs;
      }
    } catch { /* fall through to live extraction */ }
    // The mod already appended the turns itself (inject_in_mod): print nothing, so
    // they are not in the context twice, and say so in the status record. Both
    // sides stand down on the same marker; neither deletes it.
    const stood = peekMarker(hook.session_id, bundleMtimeMs);
    if (stood) {
      recordStatus(hook.session_id, {
        ...src, injected: false,
        origin: `stood down: the mod appended ${stood.appended} user turns after the summary`,
        mod_appended: stood.appended ?? null, mod_chars: stood.chars ?? null,
      });
      process.exit(0);
    }
    if (text === null) {
      RECOVER = true;
      const out = extract(T, { reserve: HOOK_RESERVE });
      if (!out.count) {                                    // nothing worth injecting
        recordStatus(hook.session_id, { ...src, injected: false, origin: 'nothing to inject: no turns found in the transcript' });
        process.exit(0);
      }
      text = `${out.body}\n\n${out.stats}`; origin = 'extracted from the transcript after compaction';
      // No PreCompact hook ran, so no arc either: write one for the window just
      // closed (RECOVER is on, so the window ends at the new boundary). User side
      // only; the assistant side writes no arc on any path.
      if (!ASSISTANT) {
        const arcOut = extract(T, ARC);
        writeExtract(arcPath(hook.session_id, arcOut.epoch), arcOut);
      }
    }
    // Factual framing, not an instruction: text that reads as an out-of-band command
    // can trip prompt-injection defenses and get surfaced instead of used.
    if (ASSISTANT) {
      // The assistant's own turns: one block of their own, under their own cap; the
      // user side's hook prints the user's turns, the pointer line and the digest.
      const cuts = [
        MIN_CHARS > 0 ? `turns shorter than ${MIN_CHARS} characters were left out` : '',
        !isFinite(ASSIST_MAX) || ASSIST_MAX <= 0 ? ''
          : NEWEST_TURNS > 0 && NEWEST_MAX > ASSIST_MAX
            ? `the newest ${NEWEST_TURNS} turns are cut after ${NEWEST_MAX} characters and older ones after ${ASSIST_MAX}`
            : `a turn longer than ${ASSIST_MAX} characters is cut after its first ${ASSIST_MAX}`,
      ].filter(Boolean).join(', and ');
      const framing =
        `The following are the assistant's own prior turns from this same session, from just before ` +
        `the context was compacted (${origin}). They are what the assistant concluded and reported ` +
        `at each step, which the compaction summary condensed; the user's own turns from the same ` +
        `stretch are a separate block. Oldest to newest; the [-N] index counts back from the most ` +
        `recent turn${cuts ? `; ${cuts}` : ''}.\n`;
      const output = `${framing}${text}`;
      recordStatus(hook.session_id, {
        ...src, origin, injected: true, chars: output.length, tokens_est: Math.round(output.length / 4),
        min_chars: MIN_CHARS, assistant_max: isFinite(ASSIST_MAX) ? ASSIST_MAX : null, newest_turns: NEWEST_TURNS, newest_max: NEWEST_MAX,
      });
      console.log(output);
      process.exit(0);
    }
    // The arc the PreCompact hook (or the fallback above) left beside the bundle.
    const arc = arcInfo(hook.session_id);
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
      ...src, origin, injected: true,
      chars: output.length, tokens_est: Math.round(output.length / 4),
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
  `${isFinite(USER_MAX) ? ' --user-max ' + USER_MAX : ''}${MIN_CHARS ? ' --min-chars ' + MIN_CHARS : ''}${isFinite(MAX_CHARS) ? ' --max-chars ' + MAX_CHARS : ''}${RAW ? ' --raw' : ''}` +
  `  ·  tip: --role user for the cheapest voice sample]`
);
