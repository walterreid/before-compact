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
| `scripts/extract_tail.mjs` | both | the original script, plus `--hook` and `--max-chars`. Every manual flag still works |
| `hooks/register.js` → `/before-compact` | on demand | a **mod**: opens a pane beside the transcript with a live context gauge, a log of this session's compactions (tokens and messages before → after, and whether each hook reported success), and a tab showing the bundle that was re-injected. Toasts when a compaction starts and finishes |

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
    #1  14:58  manual   82k → 19k tokens   143 → 7 messages
        PreCompact  ✓ saved 32 user turns (~1k tokens)
        SessionStart ✓ re-injected ~1k tokens (prepared by the PreCompact hook)

On a session that was compacted before the plugin was installed, "Compactions this session"
stays 0 (the mod only logs compactions it watched), but the line under it reports the markers
it finds in the transcript on disk, and tab 2 has a **Recover from transcript** button (`g`)
that runs `--recover` on that transcript and shows the turns before the last compaction.

The numbers come from Claude Code itself (`$.session.usage()` and `$.session.messages()`);
the ✓ marks come from a status record the script writes to `~/.claude/before-compact/` each
time a hook fires. Two ✓ marks and a drop in the numbers is what "compaction is working"
looks like. Press `2` for the exact text that went back into context. Esc closes the pane.

Mods need Claude Code v2.1.287 or later (the Desktop app bundles its own; `/status` shows
the version). The pane works in the terminal and the Desktop app's Code tab, not in the
VS Code extension. The hooks work everywhere Claude Code runs locally.

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
- The mod's PreCompact and SessionStart hooks run around the same time as the settings
  hooks, in an order the docs don't promise. The mod re-reads the status file at 1.5 s and
  6 s after compaction to cover both orders; if a row ever shows `?` for the save or
  inject, press `r`.
