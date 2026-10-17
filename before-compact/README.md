# before-compact

Keeps your last turns, verbatim, across a Claude Code compaction.

After a compaction the model keeps the facts and loses the feel: how you talk, how each
decision actually got made. The summary flattens that. The raw last turns don't.

## What the plugin does

| Component | When | What |
| --- | --- | --- |
| `hooks/hooks.json` → `PreCompact` | before auto or manual compaction | writes your last turns (user role, ≤9000 chars) to `$CLAUDE_PLUGIN_DATA/precompact-<session>.txt` while the transcript is intact, and beside it the **arc**, `arc-<session>-<n>.txt`: the current window (the turns since the last compaction), both roles, assistant turns untruncated, noise stripped, no budget; one file per compaction |
| `hooks/hooks.json` → `SessionStart (compact)` | right after compaction | prints that bundle (or, if none is fresh, extracts it live from the transcript); Claude Code adds the output to Claude's context. One factual line after the framing states where the newest arc file is, with its turn count and tokens, so the model can read it when a task needs what was done, not only what was said. The arc itself is never injected |
| `skills/recover` → `/before-compact:recover` | on demand | the manual path, with knobs (`--turns`, `--role`, `--raw`, `--file`) |
| `scripts/extract_tail.mjs` | both | the original script, plus `--hook`, `--max-chars` and `--probe`. Every manual flag still works. With `inject_in_mod` on it also honours the mod's stand-down marker (below) |
| `hooks/register.js` → `session.compact` | every compaction | a **mod** hook: after the engine has compacted, records `tokensBefore` → `tokensAfter`, the message counts before → after, the trigger, the agent, the instructions the summarizer was given, how long the summary took, and the summary itself. With `summary_instructions` set, appends that text to the instructions on the way down (see *The knob*). With `inject_in_mod` on, returns the result with your last user turns appended after the summary (see *The experiment*) |
| `hooks/register.js` → `classic.PreCompact`, `classic.SessionStart` | around each compaction | the same mod, reading the status record the script writes inside those hooks' `next(e)`: the two ✓ marks |
| `hooks/register.js` → `/before-compact` | on demand | the same mod's pane: a live context gauge, the compaction log above, a tab showing the bundle that was re-injected, and a **Summary** tab showing the summary the engine installed with the token counts and the arc's size above it. Toasts when a compaction starts and finishes |
| `types/index.d.ts` | load time | declares the two `$.state` values (the log, with each row's summary text and arc size, and the entry in flight) so the pane survives a reload of the mod; named by `types` in `plugin.json` |

The two hooks are tiers 2 and 3 from the script's own header. Tier 1 (a "Compaction
Recovery" clause in AGENTS.md that tells the agent to run `--recover`) is no longer needed
once the plugin is installed, but it does no harm.

## The pane

Type `/before-compact`. The pane shows:

    1: Monitor   2: Last bundle   3: Summary   r: Refresh

    Context now
    ▕████████████░░░░░░░░░░░░░░░░░░▏ 41%  82k / 200k tokens
    143 messages in context · live, refreshes every 2 s

    Compactions this session: 1
    #1  14:58  manual   82k → 19k tokens   143 → 7 messages   2.3 s
        instructions: keep the plan
        PreCompact  ✓ saved 32 user turns (~1k tokens)
        SessionStart ✓ re-injected ~1k tokens (prepared by the PreCompact hook)

On a session that was compacted before the plugin was installed, "Compactions this session"
stays 0 (the mod only logs compactions it watched), but the line under it reports the markers
it finds in the transcript on disk, and tab 2 has a **Recover from transcript** button (`g`)
that runs `--recover` on that transcript and shows the turns before the last compaction.

The row's numbers are the engine's own: the `session.compact` event's result carries
`tokensBefore` and `tokensAfter`, and its message lists give the counts before and after;
`2.3 s` is how long the summary took. The gauge at the top is `$.session.usage()`, polled
every 2 s. The ✓ marks come from a status record the script writes to
`~/.claude/before-compact/` inside each settings hook; a `?` means no record arrived (press
`r`). Two ✓ marks and a drop in the numbers is what "compaction is working" looks like.
Press `2` for the exact text that went back into context. Esc closes the pane.

Press `3` for the **Summary** tab: the summary the engine installed, verbatim (the first
message of the `session.compact` result, capped at 9,500 characters for the pane), under
one line with the token counts before and after, the summary's own size, and the size of
the arc file on disk:

    #1  82k → 19k tokens   summary 2k chars (~512 tokens)   arc on disk 44k chars (~11k tokens, 62 turns)
    arc: /Users/you/.claude/plugins/data/before-compact-inline/arc-<session>-1.txt
    instructions given to the summarizer: keep the plan

That is the comparison the tab is for: what the summary kept (its text and size) against
what it cost (the before and after counts) and what it replaced (the arc). The summary
text is kept in `$.state` with the row, so a reload keeps it; the tab shows the newest
compaction the mod watched.

The log lives in `$.state`, so saving `register.js` or `/reload-plugins` keeps it; `/clear`,
`/resume` and `/branch` reset it, as they reset every mod's state. A subagent's own
compaction gets a row tagged `agent <id>` with no ✓ marks: the settings hooks do not run
for it. A precompute (the engine summarising ahead of time) and a compaction a hook vetoed
leave no row.

Mods need Claude Code v2.1.287 or later (the Desktop app bundles its own; `/status` shows
the version). The pane works in the terminal and the Desktop app's Code tab, not in the
VS Code extension. The hooks work everywhere Claude Code runs locally.

## The knob: `summary_instructions`

Off by default (empty). A string in `/config` → *before-compact* → *summary_instructions*,
or `pluginConfigs` in `~/.claude/settings.json`.

When it is non-empty, the mod's `session.compact` hook passes the event down with the
knob's text appended to the instructions the summarizer is given: what you typed after
`/compact` stays first, the knob's text follows on its own line, and with nothing typed
the knob's text is the whole instruction. Nothing else about the event changes, and the
result comes back as the engine made it. With the knob empty the event goes down untouched.

**What is documented and what is measured.** Claude Code's types for `session.compact`
say that `next({ ...e, instructions })` changes what the summarizer is told. That is the
whole basis for the knob: the text reaches the summarizer. How much the summarizer
*honours* it is documented to exist, not measured, here or anywhere we know of; the kit
proves only that the engine's side receives the combined text (`claude plugin test`, the
two `summary_instructions` tests). **The Summary tab is how to measure it:** set the knob
to something a summary would not do on its own (for example `End the summary with the
line "KNOB: honoured".`), run `/compact`, press `3`, and read the summary the engine
installed. A visible difference between that summary and one made with the knob empty
is the measurement; the pane's numbers above the text say what it cost.

The pane's rows show the instructions as the summarizer received them (yours plus the
knob's), not only what you typed.

## The experiment: `inject_in_mod`

Off by default. Leave it off unless you want to test it.

The two settings hooks re-inject your turns as *text*: the SessionStart hook prints them and
Claude Code adds the output to the context as hook output. Claude Code's `session.compact`
event offers another way. Its result is the conversation after compaction, as a list of
messages, and a hook may hand back a list of its own; a message that still carries the
engine's `handle` "stands as the engine has it", whole. So the mod can append the last N
*user messages* of the old transcript, unchanged, after the summary, and skip the text
copy.

With the flag on (`/config` → *before-compact* → *inject_in_mod*, or `pluginConfigs` in
`~/.claude/settings.json`), the mod's `session.compact` hook:

1. awaits the compaction as usual (`next(e)`), then picks the last `inject_turns` user
   messages of `e.messages` that say something (harness noise and tool-result-only turns
   are skipped, like the script does), newest first under `inject_max_chars`;
2. writes `~/.claude/before-compact/injected-<session>.json` (when, how many, how long) and
   **waits for the write**;
3. returns the result with one built framing message and those messages, handles intact,
   appended after the summary and the messages the engine kept.

The SessionStart settings hook then **stands down**: the script reads the marker, deletes
it, prints nothing, and writes a status record saying so (the pane shows `SessionStart –
stood down` and a `Mod ✓ appended N user turns` line).

**The race this guards against.** The mod and the script share no memory, and both would
otherwise put the same turns back. The script runs in the SessionStart(compact) settings
hook, which Claude Code fires after it has installed the compaction, which it can only do
once the `session.compact` hooks have returned the result. The mod writes the marker before
it returns, so the marker is on disk before the script can run. Two residual cases are
handled on the script's side: a marker older than two minutes is ignored and removed (a
compaction whose SessionStart hook never ran must not silence the next one), and the
marker is consumed on read (one marker, one stand-down). One case is not: if Claude Code
rejects the hook's returned list (for example, a message of the wrong shape) the original
result stands, the marker is already written, and the script stands down for a compaction
that got nothing appended. The pane's row would then show `Mod ✓` beside the script's
`stood down` with nothing actually in context. The mod only appends messages the engine
handed it, so the shape should always be right, but this is the failure to watch for.

**What is verified and what is not.** `claude plugin test` proves the returned list (the
summary, the kept messages, one framing message, then the last N user messages with their
handles), the marker, the pane row, and that with the flag off the result is returned
untouched. `test/run.sh` proves the script stands down on a fresh marker and ignores a
stale one. **Whether the engine keeps appended handled messages in the next request to the
model is unverified in the kit: it needs a live `/compact` with the flag on.** The check
is the one in *Try it* below: after `/compact`, ask Claude what you said right before the
compaction. If it quotes you, the appended messages reached the model; if it does not, or
`/context` shows no growth, they were dropped. The pane cannot tell the two apart.

## Install

Needs Node 18+ on `PATH`. The plugin is the `before-compact/` folder of this repo; the repo
root holds the tests and the dev notes.

For every session, in the terminal and the Desktop app, point Claude Code at the folder from
`~/.claude/settings.json` (needs Claude Code 2.1.280 or later; the pane needs 2.1.287):

    "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/before-compact/before-compact" }

It loads in place, so an edit in the repo is live after `/reload-plugins`. For one terminal
session only:

    claude --plugin-dir /absolute/path/to/before-compact/before-compact

Check it loaded by typing `/before-compact`: the pane opens. In the terminal, `/plugin` also
lists `before-compact` on its **Installed** tab with `1 mod active · before-compact` under the
tabs. In the Desktop app `/plugin` opens the app's plugin browser, which does not list a
plugin loaded from a path; type `/plugin list` as text instead, or run `claude plugin list`
from a shell, which shows it under **Session-only plugins** when `CLAUDE_CODE_PLUGIN_DIRS` is
set. A new session picks up the setting; a running one needs `/reload-plugins`.

## Try it

In a session with some history, open `/before-compact`, then run `/compact`. Two spinners
should show, "Saving the last turns before compaction" and, after the summary, "Restoring
your voice from before compaction", and the pane should gain one row with the engine's
numbers, a duration, and two ✓ marks, with no `(last error: …)` line. Then ask Claude what
you said right before the compaction; it should quote you.

Or skip compaction: `/before-compact:recover` runs the extractor by hand.

## Testing

Three automated layers, all standalone: no session, no sign-in, no network.

| Run | From | What it proves | Needs |
| --- | --- | --- | --- |
| `bash test/run.sh` | the repo root | the script: `--recover`, the budget, both hooks, the status record, the arc (written, longer than the bundle, bounded to the current window across three epochs, numbered per compaction, named by a factual pointer line with the stats line's own turn and token figures, the 9,000-char total), the stand-down marker fresh and stale, `--raw` verbatim | `node`, `python3` |
| `claude plugin test` | this folder | the mod, through simulated compactions with a stub mods API: the row's numbers from `session.compact`, both hook orders, precompute, veto, subagent rows, the Summary tab (text, numbers, arc size, the 9,500-char cut), the knob set and empty (what the engine's side receives), the experiment on and off, the error line | Claude Code 2.1.287 or later |
| `claude plugin validate --strict .` | anywhere | the manifest, and a static list of every event the mod hooks and every API call it makes | any version |

Then the live layer, the only one that proves the conversation actually changed. Nothing
automated can trigger a real compaction (`claude plugin eval` cannot either), so this is the
"Try it" check above, done in a new session after an install or an edit to the mod. It is
what proves the two readings the kit takes on trust: that the settings hooks finish inside
the mod's `classic.*` hooks' `next(e)` (both ✓ marks, no `?`), and that a live engine fires
`session.compact` into this mod (the row's numbers). With `inject_in_mod` on, it is also the
only check that the appended messages reached the model. The live check per piece: the arc
pointer line visible in context after `/compact` (ask Claude what file holds the full
back-and-forth); the Summary tab showing the real summary; and, with `summary_instructions`
set to something a summary would not do by itself, a visible difference on the Summary tab.

After a compaction, any session can look: `/before-compact` shows the rows for compactions
the mod watched, and tab 2's `g` button recovers the turns before an earlier one from the
transcript. `/before-compact:recover` works in any session, compacted or not, and
`node scripts/extract_tail.mjs --recover` works from any project directory with no session
at all.

## What it runs and changes

**It sends nothing anywhere.** Neither the hooks nor the mod makes a network request.

**What it runs:** `node` on its own `scripts/extract_tail.mjs`, twice per compaction from
the settings hooks, and from the mod with `--probe` (at session start, on Refresh, and
after a compaction) and with `--recover` (the button on tab 2). Nothing else.

**What it reads:**

- The transcript Claude Code names in the hook input, and from the mod the newest
  `.jsonl` under `~/.claude/projects/<this directory>/`, to pull your last turns.
- Its own files under `~/.claude/before-compact/` and `$CLAUDE_PLUGIN_DATA`.
- The environment variable `HOME`, to find those. No credentials, no other variables.
- From Claude Code: the context usage, the message count, the session id, the cwd, and,
  inside the `session.compact` event, the messages being compacted and the result.

**What it writes:**

- `$CLAUDE_PLUGIN_DATA/precompact-<session id>.txt`: your last user turns, at most 9,000
  characters, written before each compaction and read back after it.
- `$CLAUDE_PLUGIN_DATA/arc-<session id>-<n>.txt`: the back-and-forth of the window the
  compaction is about to summarize, that is, the turns after the most recent
  compaction-summary marker in the transcript (the whole transcript before the first
  compaction); both roles, assistant turns untruncated, harness noise stripped, no
  character budget. One file per compaction, never overwritten: `n` is the number of
  compaction markers already in the transcript plus one, so the first compaction writes
  `-1.txt`, the second `-2.txt`, each holding its own epoch. Written before each compaction
  beside the bundle (and by the SessionStart fallback when no bundle is fresh, for the
  window the new summary closed). Read by nothing automatically: the SessionStart output
  states the newest one's path, turn count and token figure, and the model reads the file
  only if it decides the task needs it. Its turn count, size and token figure (the ones
  on the file's own stats line) are in the status record, so the pane can show them.
- `~/.claude/before-compact/status-<session id>.json`: one small record per hook run
  (times, counts, paths), at most 50 entries. The mod reads it; nothing else does.
- `~/.claude/before-compact/injected-<session id>.json`, only with the `inject_in_mod`
  experiment on: a one-line marker the mod writes and the script deletes on read.
- Nothing else: no settings, no instructions files, nothing under the project.

**What reaches Claude:** the SessionStart hook's stdout after a compaction, which is the
bundle above with a one-sentence factual framing and one factual line that states where
the newest arc file is, with its turn count and token figure. That is the whole point of the plugin
and, with the defaults, the only way it touches the conversation. With the `inject_in_mod`
experiment on, the mod instead hands the engine your last user messages, unchanged, after
the summary, and the hook prints nothing (see *The experiment*). With `summary_instructions`
set, the summarizer is given that text in addition to yours (see *The knob*); the
conversation itself gets nothing extra. Nothing else is ever added.

**How it hooks into Claude Code** (from `claude plugin validate --strict`, with its `via` notes dropped):

    ./register.js hooks: config.set{key=/(^|\.)(inject_(in_mod|turns|max_chars)|summary_instructions)$/},
      session.start, command.run{command=before-compact}, session.compact,
      classic.PreCompact, classic.SessionStart{source=compact},
      ui.render{component=Pane, requestId=before-compact}
    ./register.js calls: $.clock.every, $.command.register, $.env.get, $.fs.exists,
      $.fs.list, $.fs.read, $.fs.stat, $.fs.write, $.process.run, $.session.cwd,
      $.session.id, $.session.messages, $.session.usage, $.state.get, $.state.set,
      $.ui.invalidate, $.ui.log, $.ui.open, $.ui.resolve, $.ui.toast
    ./register.js env reads: HOME
    ./register.js state writes: before-compact.compactions, before-compact.pending
    ./register.js state reads: before-compact.compactions, before-compact.pending

`$.fs.write` is the experiment's marker file and nothing else. The validator also notes that
where an organization manages Claude Code, `session.compact`, `classic.PreCompact` and
`classic.SessionStart` do not run in a plugin a person installs; the settings hooks still do.

It never approves, blocks, or alters a tool call or a prompt. It alters a compaction only
when you ask it to: `summary_instructions` adds your text to the summarizer's instructions,
and `inject_in_mod` appends your own messages after the summary. Both are off by default.

**To remove what it leaves behind,** delete `~/.claude/before-compact/` and the plugin's
data directory (`~/.claude/plugins/data/before-compact-inline/` when loaded from a path),
which holds the bundles and the arcs. The arcs are the only files that accumulate: one
per compaction, each the size of one window.

## Known limits

- The SessionStart output is capped by Claude Code at 10,000 characters; over that it is
  written to a file and replaced with a 2,000-character preview. The hooks pass
  `--max-chars 9000` for the whole output: the script reserves 800 characters of that for
  the framing sentence, the arc pointer line and the stats line, and drops the oldest turns
  first to keep the rest of the turns under what is left. `test/run.sh` checks the total.
- The arc has no budget, but it is bounded to one window: the turns since the last
  compaction. On a session that compacts often each arc stays the size of one epoch; the
  files accumulate under `$CLAUDE_PLUGIN_DATA` (one per compaction) until you delete them.
- The window's boundary is the compaction-summary marker Claude Code writes into the
  transcript (the "This session is being continued…" user turn), the same marker
  `--recover` and `--probe` use. A user or assistant turn that quotes that phrase would
  count as a boundary too.
- The PreCompact bundle is considered fresh for 15 minutes. After that SessionStart extracts
  live from the transcript instead, using the compaction-summary marker to find the seam.
- `$CLAUDE_PLUGIN_DATA` falls back to the OS temp dir when unset (for example when the
  script is run by hand), so bundles may not survive a reboot. The live path does not need them.
- No automated check can trigger a real compaction, `claude plugin eval` included. See
  *Testing* for what the three automated layers prove and what only a live `/compact` can.
- The mod reads the script's status record right after its own `classic.PreCompact` and
  `classic.SessionStart` hooks have passed the event on with `next(e)`, on the reading
  that the settings hooks run inside that `next`. There are no timers. If that reading
  is wrong for your build, a row shows `?` for the save or the inject; press `r`.
