# before-compact

Keeps your last turns, verbatim, across a Claude Code compaction.

After a compaction the model keeps the facts and loses the feel: how you talk, how each
decision actually got made. The summary flattens that. The raw last turns don't.

## What the plugin does

| Component | When | What |
| --- | --- | --- |
| `hooks/hooks.json` → `PreCompact`, first entry | before auto or manual compaction | writes your last turns (user role, ≤9000 chars; messages relayed into your slot, such as an agent's hand-back, left out; a turn too long for what is left of the budget replaced by a one-line note, so older turns still fit, and the budget left at the end spent on those turns' leads, newest first) to `$CLAUDE_PLUGIN_DATA/precompact-<session>.txt` while the transcript is intact, and beside it the **arc**, `arc-<session>-<n>.txt`: the current window (the turns since the last compaction), both roles, assistant turns untruncated, noise stripped, no budget; one file per compaction |
| `hooks/hooks.json` → `PreCompact`, second entry | the same moment | the same script with `--side assistant`: writes the assistant's last turns (assistant role, turns under 200 characters skipped, the newest two cut after 4,000 and older ones after 1,500, ≤9000 chars) to `precompact-<session>-assistant.txt`. No arc. Skipped when `assistant_turns` is off (see *The assistant's turns*) |
| `hooks/hooks.json` → `SessionStart (compact)`, first entry | right after compaction | prints the user bundle (or, if none is fresh, extracts it live from the transcript); Claude Code adds the output to Claude's context. One factual line after the framing states where the newest arc file is, with its turn count and tokens, so the model can read it when a task needs what was done, not only what was said. The arc itself is never injected |
| `hooks/hooks.json` → `SessionStart (compact)`, second entry | the same moment | prints the assistant bundle (or extracts it live) as a block of its own, under its own factual framing, with no pointer line and no digest: a second hook output, under its own 10,000-character cap. Skipped when `assistant_turns` is off |
| `skills/recover` → `/before-compact:recover` | on demand | the manual path, with knobs (`--turns`, `--role`, `--raw`, `--file`) |
| `scripts/extract_tail.mjs` | both | the original script, plus `--hook`, `--side`, `--min-chars`, `--max-chars` and `--probe`. Every manual flag still works. Compaction boundaries are the transcript's `compact_boundary` entries (the phrase match is a fallback for older transcripts); `--probe` reports each boundary's engine numbers. With `inject_in_mod` on both sides also honour the mod's stand-down marker (below) |
| `hooks/register.js` → `session.compact` | every compaction | a **mod** hook: after the engine has compacted, records `tokensBefore` → `tokensAfter`, the message counts before → after, the trigger, the agent, the instructions the summarizer was given, how long the summary took, and the summary itself. On the way down, appends the `summary_instructions` text (by default the plugin's brief for the summarizer) to the instructions, after anything you typed (see *The brief*). With `inject_in_mod` on, returns the result with your last user turns appended after the summary (see *The experiment*) |
| `hooks/register.js` → `classic.PreCompact`, `classic.SessionStart` | around each compaction | the same mod, reading the status records the script writes inside those hooks' `next(e)`, one per side: the ✓ marks, and the row's second `SessionStart` line for the assistant's turns. With `digest_in_precompact` on, `classic.PreCompact` also asks a model for a digest of the dialog and writes it to disk before the engine summarizes (see *Digest*) |
| `hooks/brief.js` | every compaction | the default text of `summary_instructions`, the plugin's brief for the summarizer (see *The brief*) |
| `hooks/register.js` → `/before-compact` | on demand | the same mod's pane: a live context gauge, the compaction log above, a tab showing the bundle that was re-injected, a **Summary** tab showing the summary the engine installed with the token counts and the arc's size above it, and a **Digest** tab beside it for the `digest_in_precompact` experiment. Toasts when a compaction starts and finishes |
| `types/index.d.ts` | load time | declares the two `$.state` values (the log, with each row's summary text and arc size, and the entry in flight) so the pane survives a reload of the mod; named by `types` in `plugin.json` |

The two hooks are tiers 2 and 3 from the script's own header. Tier 1 (a "Compaction
Recovery" clause in AGENTS.md that tells the agent to run `--recover`) is no longer needed
once the plugin is installed, but it does no harm.

## The pane

Type `/before-compact`. The pane shows:

    1: Monitor   2: Last bundle   3: Summary   4: Digest   r: Refresh

    Context now
    ▕████████████░░░░░░░░░░░░░░░░░░▏ 41%  82k / 200k tokens
    143 messages in context · live, refreshes every 2 s

    Compactions this session: 1
    #1  14:58  manual   82k → 19k tokens   143 → 7 messages   2.3 s
        instructions: keep the plan
        PreCompact  ✓ saved 32 user turns (~1k tokens)
        SessionStart ✓ re-injected ~1k tokens (prepared by the PreCompact hook)
        SessionStart ✓ re-injected ~2k tokens of the assistant's turns (prepared by the PreCompact hook)

The second `SessionStart` line is the assistant side's hook (see *The assistant's turns*):
`–` when it stood down or `assistant_turns` is off, `✗` when it printed nothing for another
reason, `?` when no record arrived. The user line above it is the same as before.

On a session that was compacted before the plugin was installed, "Compactions this session"
stays 0 (the mod only logs compactions it watched), but the line under it reports the markers
it finds in the transcript on disk, and tab 2 has a **Recover from transcript** button (`g`)
that runs `--recover` on that transcript and shows the turns before the last compaction.
Under that line, one more gives the newest boundary's own numbers, read by `--probe` from
the transcript's `compact_boundary` entry:

    Transcript on disk: 1 compaction marker(s) in 5079 events
      newest boundary: 966k → 26k tokens, 7 messages preserved (auto, 103.2 s; the engine's own numbers, from the transcript)

These are the figures Claude Code itself recorded when it compacted (`preTokens`,
`postTokens`, the count of preserved messages, the trigger and the summary's duration), so a
session on a Claude Code that runs the mod but never fires `session.compact` into it still
gets real numbers, not `?`. An older transcript with only the phrase marker gets a line
saying there are no engine numbers for it.

The row's numbers are the engine's own: the `session.compact` event's result carries
`tokensBefore` and `tokensAfter`, and its message lists give the counts before and after;
`2.3 s` is how long the summary took. The gauge at the top is `$.session.usage()`, polled
every 2 s. The ✓ marks come from a status record the script writes to
`~/.claude/before-compact/` inside each settings hook; a `?` means no record arrived (press
`r`). Three ✓ marks and a drop in the numbers is what "compaction is working" looks like.
Press `2` for the exact text of your turns that went back into context, `3` for the summary the engine
installed, `4` for the digest the `digest_in_precompact` experiment wrote. Esc closes the pane.

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

## The brief: `summary_instructions`

A string in `/config` → *before-compact* → *summary_instructions*, or `pluginConfigs` in
`~/.claude/settings.json`. Its default is this plugin's brief for the summarizer, one
paragraph of plain prose (the text is in [`hooks/brief.js`](hooks/brief.js); `plugin.json`
carries the same text as the knob's default, and `test/run.sh` fails if the two differ):

> In the summary, keep the user's stated constraints and corrections, quoted verbatim where
> they are short and otherwise close to their wording. Record each decision with its latest
> state; where a decision was reversed or changed, say so and give the reason, and prefer
> the latest state over any earlier one. Keep what was verified by running, reading or
> testing separate from what was assumed or inferred, and label each. List the open
> threads: questions not yet answered, work started but not finished, and anything the
> user said they would come back to.

That is what a summary flattens and this plugin exists to keep. The idea of a standing
brief for the summarizer comes from [Better Compact](https://github.com/koenvdheide/prep-compact)
(MIT), which appends a constant brief to every compaction; the text here is this plugin's
own, and it differs on one point: Better Compact's brief tells the summarizer to drop
exploratory dead ends, and this one does not, because how a decision was reached is part
of what the user wants kept.

When the knob is non-empty, the mod's `session.compact` hook passes the event down with the
knob's text appended to the instructions the summarizer is given: what you typed after
`/compact` stays first, the knob's text follows on its own line, and with nothing typed
the knob's text is the whole instruction. Nothing else about the event changes, and the
result comes back as the engine made it. Replace the text with your own to change the
brief; clear it to send the summarizer nothing extra, and the event goes down untouched.

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

The pane's rows show what you typed after `/compact` in full and the knob's text as a size
(`instructions: keep the plan + summary_instructions (554 chars; tab 3 shows it)`); the
Summary tab shows the whole text the summarizer received.

## The assistant's turns: `assistant_turns`

On by default. A boolean in `/config` → *before-compact* → *assistant_turns*, or
`pluginConfigs` in `~/.claude/settings.json`.

**Why.** The baseline in [`test/live-protocol.md`](../test/live-protocol.md) found that
neither the engine's summary nor the user bundle carries the assistant's side of the
window: the summary compresses it into two sections, and the bundle is the user's turns
only, because within one 10,000-character hook output every assistant turn displaces one of
the user's. The arc file holds the assistant's turns, but only on demand. A second hook
output gets round the displacement: the hooks reference says the cap is measured per
string, "each string on its own, even when several hooks run for the same event", and that
"when several hooks return additionalContext for the same event, Claude receives all of the
values". So the assistant's turns go back as a block of their own, under their own cap,
without taking a character from yours.

**What it does.** `hooks/hooks.json` has two entries per event. The second runs the same
script with `--side assistant --role assistant --assistant-max 1500 --newest-turns 2
--newest-max 4000 --min-chars 200 --max-chars 9000`:

- `PreCompact` writes `$CLAUDE_PLUGIN_DATA/precompact-<session>-assistant.txt`: the
  assistant's last turns, newest first under 9,000 characters: the newest two cut after
  4,000 characters, older ones after their first 1,500 (the long ones lead with the
  conclusion, so the lead survives), turns under 200 characters left out (one-line progress
  notes). No arc: the user side's entry
  writes the one arc per compaction.
- `SessionStart (compact)` prints that bundle under its own factual framing (*The following
  are the assistant's own prior turns from this same session, from just before the context
  was compacted…*), with no arc pointer line and no digest block (the user side's hook
  prints both), and writes a status record with `side: "assistant"`. The same 15-minute
  freshness rule and the same live fallback as the user side; the fallback writes no arc.
- Both sides honour the `inject_in_mod` stand-down marker (see *The experiment*).

Measured on the session that asked for this, against the 9,000-character budget: 7 full
assistant turns (about 1,800 tokens), or 11 cut at 1,200 characters, or 17 cut at 700.
Assistant turns there ran from one-line progress notes to about 4,800 characters. 1,500 and
200 are the defaults in `hooks.json`; both are flags, so edit the entry to tune them.

The newest two get 4,000 since 0.3.2. In the first live compactions, a flat 1,500 cut the
last report before the compaction mid-sentence, the turn most worth keeping whole. Measured
on two real windows against the same 8,200 characters:

| Setting | Window 1: kept, cut | Window 2: kept, cut |
| --- | --- | --- |
| Every turn up to 1,500 | 7, 3 cut | 9, 2 cut, the newest among them |
| Every turn up to 4,000 | 3, none cut | 4, none cut |
| Newest 2 up to 4,000, the rest 1,500 (the default) | 5, 2 cut | 9, 1 cut, the newest whole |

The budget is the same in every row (about 2,000 tokens); the rows trade breadth for whole
turns. `--newest-turns 0` restores the flat cap.

**Off.** The script reads the option from `CLAUDE_PLUGIN_OPTION_ASSISTANT_TURNS`, the
variable the plugins reference says Claude Code exports to hook processes for every option
(the key uppercased). With it `false` the two assistant-side hooks write nothing, print
nothing, and record `injected: false` with the reason; the pane's second line shows `–`.
The reference does not say whether the default is exported when you never set the option,
or how a boolean is spelled, so the script treats an absent or empty variable as the
default, on, and only an explicit `false`, `0`, `off` or `no` as off.

**What is verified and what is not.** `test/run.sh` proves the second bundle is written
with no second arc, that the assistant output starts with its framing, holds assistant turns
and no user turn, no pointer line and no digest even when a fresh digest exists, skips the
turns under 200 characters, stays under 9,000 characters, falls back to the transcript, and
that with the option off nothing is printed and the record says why. `claude plugin test`
proves the pane draws both lines from both records. **What a live `/compact` still has to
prove: that both hook outputs reach the model, each under its own cap with no combined cap
applied, and in which order.** The Summary tab cannot show that (it shows the engine's
summary, not what the hooks added); asking the model can. After `/compact`, ask Claude what
the first and last lines of the blocks of prior turns in its context say, and whether the
block of the assistant's own turns comes before or after yours. If it quotes both framings,
both outputs reached it; the order it reports is the order for that build; if it quotes only
one, the cap or the merge is not what the reference describes. Nothing in the pane can tell
these cases apart: the two ✓ marks say the hooks ran and printed, not what the model received.

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

The SessionStart settings hooks then **stand down**, both sides: each reads the marker,
prints nothing, and writes a status record saying so (the pane shows `SessionStart – stood
down`, `SessionStart – assistant's turns stood down` and a `Mod ✓ appended N user turns`
line). Neither deletes the marker.

**The race this guards against.** The mod and the script share no memory, and both would
otherwise put the same turns back. The script runs in the SessionStart(compact) settings
hooks, which Claude Code fires after it has installed the compaction, which it can only do
once the `session.compact` hooks have returned the result. The mod writes the marker before
it returns, so the marker is on disk before the script can run. Which compaction a marker
belongs to is decided the way the digest's is: it is this compaction's when its time is at
or after the mtime of this side's bundle (the mod writes it after the PreCompact hooks have
written both bundles), with five seconds of slack; a marker older than the bundle was left
by an earlier compaction and is ignored. The marker is read, not consumed: two hooks read
it now, one per side, and the hooks reference does not say in which order several hooks for
one event run, so a marker the first reader deleted would be missed by the second, which
would then inject. A marker older than two minutes is stale: ignored and removed, so one
left by a compaction whose SessionStart hooks never ran cannot silence a later one. One case is not handled: if Claude Code
rejects the hook's returned list (for example, a message of the wrong shape) the original
result stands, the marker is already written, and the script stands down for a compaction
that got nothing appended. The pane's row would then show `Mod ✓` beside the script's
`stood down` with nothing actually in context. The mod only appends messages the engine
handed it, so the shape should always be right, but this is the failure to watch for.

**What is verified and what is not.** `claude plugin test` proves the returned list (the
summary, the kept messages, one framing message, then the last N user messages with their
handles), the marker, the pane row, and that with the flag off the result is returned
untouched. `test/run.sh` proves both sides of the script stand down on a fresh marker
without deleting it, ignore one older than this compaction's bundles, and remove a stale
one. **Whether the engine keeps appended handled messages in the next request to the
model is unverified in the kit: it needs a live `/compact` with the flag on.** The check
is the one in *Try it* below: after `/compact`, ask Claude what you said right before the
compaction. If it quotes you, the appended messages reached the model; if it does not, or
`/context` shows no growth, they were dropped. The pane cannot tell the two apart.

## Digest

The second experiment: `digest_in_precompact`, off by default, with `digest_model` (default
`haiku`) and `digest_max_tokens` (default 1500). Leave it off unless you are running the
comparison below.

**What it is for.** The engine's summary keeps the facts and flattens how the dialog went:
the constraints you stated, the corrections you made, a decision and its reversal, what was
checked as against guessed, what is still open. The verbatim turns keep your voice but only
the last few thousand characters of it. The digest tries for the middle: a second summary,
written to a fixed shape that asks for exactly those things.

**What it does.** With the flag on, the mod's `classic.PreCompact` hook, after the settings
hook has saved the bundle, reads `$.session.messages()`, keeps user and assistant text only
(tool calls, tool results and harness noise dropped the way the script's `stripNoise` does;
an earlier compaction's summary skipped), takes the newest turns under 60,000 characters,
and calls `$.model.complete` with a system prompt that asks for a digest under five headings
in this order: *Constraints and preferences* (quoted verbatim where short), *Decisions*
(latest state first, naming any reversal), *Corrections*, *Verified vs assumed*, *Open
threads*. The prompt says to prefer the latest state of each decision and to quote you
rather than paraphrase where the wording matters. The reply is written to
`~/.claude/before-compact/digest-<session>.json` (`{ at, model, chars, turns, text, … }`)
before the hook returns, so it is on disk before the engine summarizes. After the compaction
the SessionStart hook prints it first, under one factual line (*A digest of the dialog before
the compaction, written by haiku from the last N turns:*), then your turns; the digest gets
at most 4,000 of the 9,000-character budget and the turns the rest, oldest dropped first. A
digest older than 15 minutes is ignored, and so is one older than the bundle the script's
own PreCompact hook wrote for this compaction: the mod's hook runs after the script's, so a
digest of this compaction is newer than the bundle, and one left behind by an earlier
compaction (the flag turned off since) is not and must not displace this compaction's turns
with the wrong epoch's digest. The status record says why one was skipped
(`digest_skipped`: `stale`, `older than the bundle`, or null). Any failure (no answer, a
refused request, a failed write) writes nothing, shows in the pane as `Digest ✗` and as the
last error, and the compaction goes on. The call is made with `timeoutMs: 120000`, which
the 2.1.299 API declarations (the file the plugin-authoring skill writes for this build)
list on the request as "how long the whole call may take before it resolves `aborted`";
the 2.1.277 declarations do not list it, and whether a live call honours it is unverified.
If the field is ignored, the hook's own limits are what bound the call.

**What it costs.** One model call per compaction, billed to your usage: up to ~15k tokens
in (the 60,000 characters of dialog) and `digest_max_tokens` out, through Claude Code's own
client. The model call's time does not count against the hook's budget, but it does add to
how long the compaction takes. The row's duration most likely includes it: the digest runs
inside `classic.PreCompact`, which this mod reads as running inside `session.compact`'s
`next(e)`, the span the duration measures. That is unmeasured; the Digest line's own time is
the call alone.

**Read this before trusting it.**

- The digest is also a summary. It is written by a model from the same dialog, and it
  inherits the tangent problem: a long detour late in the session is as likely to fill
  the digest as it is to fill the engine's summary, and the fixed headings do not stop that.
- Its correctness is unmeasured until the protocol below has been run. The kit proves the
  call is made with the right prompt and the file is written; it says nothing about whether
  a real model's digest is true to the dialog.
- It is one more copy of the conversation on disk, under `~/.claude/before-compact/`,
  beside the bundle. Delete the directory to remove it.

**The comparison protocol.** This is how to find out whether the digest earns its cost.
Run the live protocol in `test/live-protocol.md` with the flag **off** first: the digest takes
up to 4,000 of the 9,000 characters that would otherwise carry your turns, so a run with it
on measures a different injection, not the same one plus a digest.

1. In a session with real history, turn `digest_in_precompact` on, run `/compact`, and
   open `/before-compact`. Read tab 3 (the engine's summary) and tab 4 (the digest) side by
   side. Note what each holds that the other does not: a constraint, a reversal, a
   correction, an open thread.
2. Write down five questions whose answers are in the arc of the session before the
   compaction and not in the last few turns: a constraint you stated early, a decision that
   was reversed, something you corrected, something that was verified rather than assumed,
   something left open.
3. Ask Claude each of the five, in that compacted session, and record which it answered
   correctly. Then repeat the session's shape with the flag off (or `/resume` a copy
   compacted without it) and ask the same five. The digest is worth its cost when the
   first count is reliably higher; the Summary tab is the control.

Until someone has done that, the honest description of the digest is: a second summary with
a better prompt, unmeasured.

## Install

Needs Node 18+ on `PATH`. The plugin is the `before-compact/` folder of this repo; the repo
root holds the tests, the dev notes, and a marketplace file that lists the plugin.

From the marketplace, in a Claude Code session (2.1.275 or later):

    /plugin install before-compact --marketplace walterreid/before-compact

or in two steps, `/plugin marketplace add walterreid/before-compact` then
`/plugin install before-compact@walterreid-plugins`. That installs a copy; to develop
against this repo instead, load it in place:

For every session, in the terminal and the Desktop app, point Claude Code at the folder from
`~/.claude/settings.json` (needs Claude Code 2.1.280 or later; the pane needs 2.1.287). Do not
do both: a session-only plugin shadows an installed one of the same name.

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

In a session with some history, open `/before-compact`, then run `/compact`. Four spinners
should show, "Saving the last turns before compaction" and "Saving the assistant's last
turns before compaction", then after the summary "Restoring your voice from before
compaction" and "Restoring the assistant's turns from before compaction", and the pane
should gain one row with the engine's numbers, a duration, and three ✓ marks, with no
`(last error: …)` line. Then ask Claude what you said right before the compaction; it should
quote you. Then ask what it itself concluded in its last answer before the compaction; if it
quotes that too, the second block reached it.

Or skip compaction: `/before-compact:recover` runs the extractor by hand.

## Testing

Three automated layers, all standalone: no session, no sign-in, no network.

| Run | From | What it proves | Needs |
| --- | --- | --- | --- |
| `bash test/run.sh` | the repo root | the script: `--recover`, the budget, both hooks, the status record, the arc (written, longer than the bundle, bounded to the current window across three epochs, numbered per compaction, named by a factual pointer line with the stats line's own turn and token figures, the 9,000-char total), the stand-down marker fresh (both sides stand down, neither deletes it), older than the bundles (ignored) and stale (removed), `--raw` verbatim, the digest printed first and cut to 4,000 with the whole output under 9,000, a stale digest ignored, no digest leaving the output unchanged, the boundary: a `compact_boundary` entry is what `--recover`, the arc numbering and `--probe` use (with its `compactMetadata` numbers), a turn quoting the phrase beside it is an ordinary turn, and a phrase-only transcript still works; and the assistant side: the second bundle with no second arc, its framing, assistant turns and no user turn, no pointer line and no digest beside a fresh one, `--min-chars 200` dropping a short turn, `--assistant-max` live, under 9,000 chars, the live fallback, `assistant_turns=false` printing nothing with a recorded reason | `node`, `python3` |
| `claude plugin test` | this folder | the mod, through simulated compactions with a stub mods API: the row's numbers from `session.compact`, both hook orders, precompute, veto, subagent rows, the Summary tab (text, numbers, arc size, the 9,500-char cut), the brief at its default, the knob set to your own text and cleared (what the engine's side receives, and the rows), both experiments on and off (the digest's model call with the five headings in order, its file, its tab, a refused call), the newest-boundary line from a stubbed `--probe` (numbers, and the no-numbers case), the error line, and the assistant side's records drawing the row's second `SessionStart` line in its ✓, ?, – and ✗ states with the user line unchanged | Claude Code 2.1.287 or later |
| `claude plugin validate --strict .` | anywhere | the manifest, and a static list of every event the mod hooks and every API call it makes | any version |

The same three run in GitHub Actions on every push to `main` and every pull request
([`.github/workflows/validate.yml`](../.github/workflows/validate.yml)): `ubuntu-latest`,
Node 22, `npm install -g @anthropic-ai/claude-code`, then validate, `test/run.sh`, and
`claude plugin test`. The kit test step needs a Claude Code of 2.1.287 or later, which is
what `npm install -g` gives (the latest release). If the installed version is older, there
is no `plugin test` subcommand: the CLI exits non-zero with an unknown-command error and
the job fails at that step, while validate and `test/run.sh` have already passed. (That is
the documented floor. On this machine the step also ran on a 2.1.286 build; it was not
tried on anything older.)

Then the live layer, the only one that proves the conversation actually changed. Nothing
automated can trigger a real compaction (`claude plugin eval` cannot either), so this is the
"Try it" check above, done in a new session after an install or an edit to the mod. It is
what proves the two readings the kit takes on trust: that the settings hooks finish inside
the mod's `classic.*` hooks' `next(e)` (both ✓ marks, no `?`), and that a live engine fires
`session.compact` into this mod (the row's numbers). With `inject_in_mod` on, it is also the
only check that the appended messages reached the model; and it is the only check that the
two hook outputs, yours and the assistant's, both reach the model, each under its own cap,
and in which order (see *The assistant's turns* for the question to ask). The live check per piece: the arc
pointer line visible in context after `/compact` (ask Claude what file holds the full
back-and-forth); the Summary tab showing the real summary; and, for the brief, a Summary tab
whose `instructions given to the summarizer:` line shows the brief and whose summary visibly
keeps what it asks for (a constraint quoted, a reversed decision with its reason, an open thread).

After a compaction, any session can look: `/before-compact` shows the rows for compactions
the mod watched, and tab 2's `g` button recovers the turns before an earlier one from the
transcript. `/before-compact:recover` works in any session, compacted or not, and
`node scripts/extract_tail.mjs --recover` works from any project directory with no session
at all.

## What it runs and changes

**It sends nothing anywhere of its own.** Neither the hooks nor the mod makes a network
request. The one exception is opt-in: with `digest_in_precompact` on, the mod sends the last
60,000 characters of the dialog to a model through Claude Code's own client, the same place
the conversation already goes, once per compaction (see *Digest*).

**What it runs:** `node` on its own `scripts/extract_tail.mjs`, four times per compaction
from the settings hooks (two entries per event: your turns, then the assistant's), and from
the mod with `--probe` (at session start, on Refresh, and after a compaction) and with
`--recover` (the button on tab 2). Nothing else.

**What it reads:**

- The transcript Claude Code names in the hook input, and from the mod the newest
  `.jsonl` under `~/.claude/projects/<this directory>/`, to pull your last turns.
- Its own files under `~/.claude/before-compact/` and `$CLAUDE_PLUGIN_DATA`, the digest
  file included.
- The environment variables `HOME`, to find those, and `CLAUDE_PLUGIN_OPTION_ASSISTANT_TURNS`,
  the `assistant_turns` option as Claude Code exports it to hook processes. No credentials,
  no other variables.
- From Claude Code: the context usage, the message count, the session id, the cwd, and,
  inside the `session.compact` event, the messages being compacted and the result. With
  `digest_in_precompact` on, the messages' text too, to send to the model.

**What it writes:**

- `$CLAUDE_PLUGIN_DATA/precompact-<session id>.txt`: your last user turns, at most 9,000
  characters, written before each compaction and read back after it. Messages that arrive in
  your slot without your typing them (an agent's hand-back, a cross-session message, a
  side-session event, a scheduled task's prompt, an artifact's context block) are left out;
  the arc keeps them.
- `$CLAUDE_PLUGIN_DATA/precompact-<session id>-assistant.txt`: the assistant's last turns,
  at most 9,000 characters, turns under 200 characters skipped, the newest two cut after
  4,000 characters and older ones after 1,500, written and read back the same way by the second hook of each event. Not written
  when `assistant_turns` is off.
- `$CLAUDE_PLUGIN_DATA/arc-<session id>-<n>.txt`: the back-and-forth of the window the
  compaction is about to summarize, that is, the turns after the most recent
  compaction boundary in the transcript (the whole transcript before the first
  compaction); both roles, assistant turns untruncated, harness noise stripped, no
  character budget. One file per compaction, never overwritten: `n` is the number of
  compaction boundaries already in the transcript plus one, so the first compaction writes
  `-1.txt`, the second `-2.txt`, each holding its own epoch. Written before each compaction
  beside the bundle (and by the SessionStart fallback when no bundle is fresh, for the
  window the new summary closed). Read by nothing automatically: the SessionStart output
  states the newest one's path, turn count and token figure, and the model reads the file
  only if it decides the task needs it. Its turn count, size and token figure (the ones
  on the file's own stats line) are in the status record, so the pane can show them.
- `~/.claude/before-compact/status-<session id>.jsonl`: one small record per hook run
  (times, counts, paths; `side` says which side wrote it), one JSON line each, appended
  and never rewritten, so the two hooks of one event cannot lose each other's record. The
  mod reads it; nothing else does.
- `~/.claude/before-compact/injected-<session id>.json`, only with the `inject_in_mod`
  experiment on: a one-line marker the mod writes before each compaction and both sides of
  the script read; the script deletes it only once it is older than two minutes.
- `~/.claude/before-compact/digest-<session id>.json`, only with the `digest_in_precompact`
  experiment on: the model's digest of the dialog, rewritten before each compaction. One
  more copy of the conversation on disk; nothing deletes it but you.
- Nothing else: no settings, no instructions files, nothing under the project.

**What reaches Claude:** two blocks after a compaction, the stdout of the two SessionStart
hooks. The first is your bundle with a one-sentence factual framing and one factual line
that states where the newest arc file is, with its turn count and token figure. The second
is the assistant's bundle under its own factual framing, nothing else. Each is its own hook
output under its own cap: the hooks reference measures the 10,000-character limit on "each
string on its own, even when several hooks run for the same event", and says that "when
several hooks return additionalContext for the same event, Claude receives all of the
values"; it does not say in which order, and a live `/compact` is the only check that both
arrive (see *The assistant's turns*). That is the whole point of the plugin and, with the
defaults, the only way it touches the conversation. With `assistant_turns` off the second
block is not printed. With the `inject_in_mod` experiment on, the mod instead hands the
engine your last user messages, unchanged, after the summary, and both hooks print nothing
(see *The experiment*). The summarizer is given the
`summary_instructions` text in addition to yours, by default the plugin's brief (see *The
brief*); the conversation itself gets nothing extra from that. With the `digest_in_precompact`
experiment on, the hook prints the digest ahead of the bundle, under its own factual line
(see *Digest*). Nothing else is ever added.

**How it hooks into Claude Code** (from `claude plugin validate --strict`, with its `via` notes dropped):

    ./register.js hooks: config.set{key=/"(^|\\.)(inject_(in_mod|turns|max_chars)|summary_instructions|digest_(in_precompact|model|max_tokens))$"/},
      session.start, command.run{command=before-compact}, session.compact,
      classic.PreCompact, classic.SessionStart{source=compact},
      ui.render{component=Pane, requestId=before-compact}
    ./register.js calls: $.clock.every, $.command.register, $.env.get, $.fs.exists,
      $.fs.list, $.fs.read, $.fs.stat, $.fs.write, $.model.complete, $.process.run,
      $.session.cwd, $.session.id, $.session.messages, $.session.usage, $.state.get,
      $.state.set, $.ui.invalidate, $.ui.log, $.ui.open, $.ui.resolve, $.ui.toast
    ./register.js env reads: HOME
    ./register.js state writes: before-compact.compactions, before-compact.pending
    ./register.js state reads: before-compact.compactions, before-compact.pending

`$.fs.write` is the two experiments' files (the marker, the digest) and nothing else;
`$.model.complete` is the digest experiment's one call, made only with its flag on. The validator also notes that
where an organization manages Claude Code, `session.compact`, `classic.PreCompact` and
`classic.SessionStart` do not run in a plugin a person installs; the settings hooks still do.

It never approves, blocks, or alters a tool call or a prompt. It alters a compaction in one
way by default, by adding the `summary_instructions` brief to the summarizer's instructions
(clear the knob to stop that), and in one more only when you ask: `inject_in_mod` appends
your own messages after the summary, and is off by default.

**To remove what it leaves behind,** delete `~/.claude/before-compact/` and the plugin's
data directory (`~/.claude/plugins/data/before-compact-inline/` when loaded from a path),
which holds the bundles and the arcs. The arcs are the only files that accumulate: one
per compaction, each the size of one window.

## Known limits

- Each SessionStart hook's output is capped by Claude Code at 10,000 characters; over that
  it is written to a file and replaced with a 2,000-character preview. Both hooks pass
  `--max-chars 9000` for their whole output: the script reserves 800 characters of that for
  the framing sentence, the arc pointer line and the stats line, and drops the oldest turns
  first to keep the rest of the turns under what is left. `test/run.sh` checks both totals.
  The cap is documented per string, so the two outputs do not share one budget; whether a
  live build applies any combined limit, and in which order the two blocks reach the model,
  is not documented and not yet measured here.
- The arc has no budget, but it is bounded to one window: the turns since the last
  compaction. On a session that compacts often each arc stays the size of one epoch; the
  files accumulate under `$CLAUDE_PLUGIN_DATA` (one per compaction) until you delete them.
- The window's boundary is the `compact_boundary` entry Claude Code writes into the
  transcript right before each summary message (type `system`, subtype `compact_boundary`,
  carrying the engine's own `preTokens`, `postTokens`, `durationMs`, trigger and the list
  of preserved messages). `--recover`, `--probe` and the arc numbering all use it, and
  `--probe` reports those numbers per boundary. A transcript with no such entry (one an
  older Claude Code wrote) falls back to the summary's opening phrase, "This session is
  being continued…", and only there would a user or assistant turn quoting that phrase
  count as a boundary; where a boundary entry exists, a quoting turn is an ordinary turn.
  A transcript that has both kinds (compacted before and after an upgrade) uses the
  entries alone, so its older, phrase-only compactions are not counted.
- The PreCompact bundle is considered fresh for 15 minutes. After that SessionStart extracts
  live from the transcript instead, using the newest compaction boundary to find the seam.
- `$CLAUDE_PLUGIN_DATA` falls back to the OS temp dir when unset (for example when the
  script is run by hand), so bundles may not survive a reboot. The live path does not need them.
- No automated check can trigger a real compaction, `claude plugin eval` included. See
  *Testing* for what the three automated layers prove and what only a live `/compact` can.
- The mod reads the script's status record right after its own `classic.PreCompact` and
  `classic.SessionStart` hooks have passed the event on with `next(e)`, on the reading
  that the settings hooks run inside that `next`. There are no timers. If that reading
  is wrong for your build, a row shows `?` for the save or the inject; press `r`.
