# before-compact

Keeps your voice across a Claude Code compaction.

After a compaction the model keeps the facts and loses the feel: how you talk, how each
decision actually got made. The summary flattens that. The raw last turns don't.

## What the plugin does

| Component | When | What |
| --- | --- | --- |
| `hooks/hooks.json` → `PreCompact` | before auto or manual compaction | writes your last turns (user role, ≤9000 chars) to `$CLAUDE_PLUGIN_DATA/precompact-<session>.txt` while the transcript is intact |
| `hooks/hooks.json` → `SessionStart (compact)` | right after compaction | prints that bundle (or, if none is fresh, extracts it live from the transcript); Claude Code adds the output to Claude's context |
| `skills/recover` → `/before-compact:recover` | on demand | the manual path, with knobs (`--turns`, `--role`, `--raw`, `--file`) |
| `scripts/extract_tail.mjs` | both | the original script, plus `--hook`, `--max-chars` and `--probe`. Every manual flag still works. With `inject_in_mod` on it also honours the mod's stand-down marker (below) |
| `hooks/register.js` → `session.compact` | every compaction | a **mod** hook: after the engine has compacted, records `tokensBefore` → `tokensAfter`, the message counts before → after, the trigger, the agent, the `/compact` instructions and how long the summary took. With `inject_in_mod` on, returns the result with your last user turns appended after the summary (see *The experiment*) |
| `hooks/register.js` → `classic.PreCompact`, `classic.SessionStart` | around each compaction | the same mod, reading the status record the script writes inside those hooks' `next(e)`: the two ✓ marks |
| `hooks/register.js` → `/before-compact` | on demand | the same mod's pane: a live context gauge, the compaction log above, and a tab showing the bundle that was re-injected. Toasts when a compaction starts and finishes |
| `types/index.d.ts` | load time | declares the two `$.state` values (the log and the entry in flight) so the pane survives a reload of the mod; named by `types` in `plugin.json` |

The two hooks are tiers 2 and 3 from the script's own header. Tier 1 (a "Compaction
Recovery" clause in AGENTS.md that tells the agent to run `--recover`) is no longer needed
once the plugin is installed, but it does no harm.

## The pane

Type `/before-compact`. The pane shows:

    1: Monitor   2: Last bundle   r: Refresh

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

The log lives in `$.state`, so saving `register.js` or `/reload-plugins` keeps it; `/clear`,
`/resume` and `/branch` reset it, as they reset every mod's state. A subagent's own
compaction gets a row tagged `agent <id>` with no ✓ marks: the settings hooks do not run
for it. A precompute (the engine summarising ahead of time) and a compaction a hook vetoed
leave no row.

Mods need Claude Code v2.1.287 or later (the Desktop app bundles its own; `/status` shows
the version). The pane works in the terminal and the Desktop app's Code tab, not in the
VS Code extension. The hooks work everywhere Claude Code runs locally.

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

Check it loaded with `/plugin` (the **Installed** tab lists `before-compact`, and the line under
the tabs says `1 mod active · before-compact`) or, from the shell, `claude plugin list`, which
shows it under **Session-only plugins** when `CLAUDE_CODE_PLUGIN_DIRS` is set.

## Try it

In a session with some history, run `/compact`. Two things should happen: a spinner
"Saving the last turns before compaction", then after the summary a spinner "Restoring
your voice from before compaction". Ask Claude what you said right before the compaction;
it should quote you.

Or skip compaction: `/before-compact:recover` runs the extractor by hand.

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
- From Claude Code: the context usage, the message count, the session id, and the cwd.

**What it writes:**

- `$CLAUDE_PLUGIN_DATA/precompact-<session id>.txt`: your last user turns, at most 9,000
  characters, written before each compaction and read back after it.
- `~/.claude/before-compact/status-<session id>.json`: one small record per hook run
  (times, counts, paths), at most 50 entries. The mod reads it; nothing else does.
- `~/.claude/before-compact/injected-<session id>.json`, only with the `inject_in_mod`
  experiment on: a one-line marker the mod writes and the script deletes on read.
- Nothing else: no settings, no instructions files, nothing under the project.

**What reaches Claude:** the SessionStart hook's stdout after a compaction, which is the
bundle above with a one-sentence factual framing. That is the whole point of the plugin
and the only way it touches the conversation. The mod never writes to context.

**How it hooks into Claude Code** (from `claude plugin validate --strict`, with its `via` notes dropped):

    ./register.js hooks: session.start, command.run{command=before-compact},
      classic.PreCompact, classic.SessionStart{source=compact},
      ui.render{component=Pane, requestId=before-compact}
    ./register.js calls: $.clock.after, $.clock.every, $.command.register, $.env.get,
      $.fs.exists, $.fs.list, $.fs.read, $.fs.stat, $.process.run, $.session.cwd,
      $.session.id, $.session.messages, $.session.usage, $.ui.invalidate, $.ui.log,
      $.ui.open, $.ui.resolve, $.ui.toast
    ./register.js env reads: HOME

It never approves, blocks, or alters a tool call, a prompt, or a compaction.

**To remove what it leaves behind,** delete `~/.claude/before-compact/` and the plugin's
data directory (`~/.claude/plugins/data/before-compact-inline/` when loaded from a path).

## Known limits

- The SessionStart output is capped by Claude Code at 10,000 characters; over that it is
  written to a file and replaced with a 2,000-character preview. The hooks pass
  `--max-chars 9000` and drop the oldest turns first to stay under it.
- The PreCompact bundle is considered fresh for 15 minutes. After that SessionStart extracts
  live from the transcript instead, using the compaction-summary marker to find the seam.
- `$CLAUDE_PLUGIN_DATA` falls back to the OS temp dir when unset (for example when the
  script is run by hand), so bundles may not survive a reboot. The live path does not need them.
- No eval suite is shipped: `claude plugin eval` cannot trigger a compaction inside a run.
  The test is the "Try it" section above. The script itself is exercised by `test/run.sh`
  at the repo root, and `tests/register.test.ts` drives the mod through a simulated
  compaction with a stub mods API (`claude plugin test`, run from this folder). Neither is a
  live session. `claude plugin validate --strict .` reads the mod and lists the events and
  API calls it uses; run it before the first session.
- The mod reads the script's status record right after its own `classic.PreCompact` and
  `classic.SessionStart` hooks have passed the event on with `next(e)`, on the reading
  that the settings hooks run inside that `next`. There are no timers. If that reading
  is wrong for your build, a row shows `?` for the save or the inject; press `r`.
