# Live test protocol: does a restore change what the model knows?

A pre-registered test. The questions and their expected answers are written down
**before** the compaction they will be asked after, so the result cannot be chosen after
the fact. Written 2026-10-16 in the session that built this plugin, at 67% of a 1M window
(667k tokens, 682 messages, no compaction yet), with the merged mod loaded.

## What it measures, and what it cannot

Each question's answer lives in exactly one place. After compaction, where the model gets
it from says which layer did the work:

| Bin | The answer is | Reachable after compaction by |
| --- | --- | --- |
| **U** user-said | only in the user's own turns | the hook's injected bundle (user turns, ≤9,000 chars) |
| **S** assistant-said | only in the assistant's replies | the arc file, a digest, or the engine summary if it kept it |
| **D** decision with its reason | in the dialog, as a change of mind and why | same as S; this is what summaries flatten most |
| **F** in a file | CLAUDE.md or the README | anything; this is the control |

Expected pattern if the layers work as designed: **F** right every time; **U** right cold,
because the bundle put the turns back; **S** and **D** wrong or vague cold unless the
engine's summary happened to keep them, and right once the arc file is read. A **U**
question answered wrong cold means the bundle did not reach the model. An **S** question
answered right cold means the summary kept more than we assume, which is also worth knowing.

It cannot prove the restored text *caused* a correct answer; a model can answer from
general competence. That is why each bin has several questions and why **F** is there.
The model under test has this file in its tree; stage 1 relies on it honouring "from
memory only". If you want the answers sealed from it, move the answers section to a file
outside the repository before compaction.

## Procedure

1. **Before compaction:** confirm the pane shows three tabs and no error line. Note the
   gauge. Do not discuss these questions with the model again.
2. **At compaction:** let auto-compaction run, or type `/compact`. Then open
   `/before-compact` and record the row: tokens before → after, messages before → after,
   duration, the two marks (✓ / ✗ / ?), and whether an error line appeared. Press `3` and
   note the summary's size. Press `2` and note how many user turns the bundle holds.
3. **Stage 1, cold:** paste the questions below, one message, with this preface verbatim:
   *"Answer each from memory only. Do not read any file or run any tool. If you do not
   know, say so."* Grade each: right, partly, wrong, said-unknown.
4. **Stage 2, with the arc:** say *"Now read the arc file named in your context and answer
   again."* Grade again. If the model does not know what file that is, the pointer line
   did not reach it; record that as its own result.
5. **Stage 3, by hand:** for anything still wrong, run `/before-compact:recover --role both`
   and ask once more. This is the manual path and the ceiling of what the transcript holds.
6. Record the three grids. The result is the pattern across bins, not any one answer.

## Questions

**U, user-said**

- U1. Before this plugin existed, what did the user do with the extract script, and what
  did they tell the AI?
- U2. What is the user's stated position on copying other people's plugins?
- U3. What analogy did the user say they love but were not sure they had right?
- U4. Roughly what share of a 1M context did the user say they would gladly spend on the
  back-and-forth between them and the AI?
- U5. What did the user say the compaction "truncates" their 1M conversation to?

**S, assistant-said**

- S1. Why did the first token-cost measurement print the same numbers for every
  configuration, and what was wrong?
- S2. In the dry run against this session's transcript, how many user turns did the hook
  keep after the 800-character reserve was introduced, compared with before?
- S3. The arc's pointer line and the arc file's own stats line gave two different token
  figures for the same file. What were they, roughly?
- S4. Across the user's past compactions on this machine, what was the median token count
  after compaction, and the median number of entries the engine preserved?
- S5. How long did the summary take, at the median, across those past compactions?

**D, decisions with their reason**

- D1. Why was the plugin moved into a `before-compact/` subfolder instead of staying at the
  repository root?
- D2. What ordering defect did the review of the first rework branch find, and how was it
  reproduced before it was sent back?
- D3. Why was the arc changed from one file per session to one file per compaction?
- D4. The pointer line's wording was changed. From what kind of sentence to what kind, and
  why?
- D5. Why does the plugin keep the user's turns only, rather than both sides, on the
  automatic path?

**F, in a file (control)**

- F1. What are the three rules in CLAUDE.md, in one line each?
- F2. What character cap does Claude Code put on a SessionStart hook's output, and what
  budget does the plugin pass?
- F3. Where does the plugin write the stand-down marker, and when?

## Expected answers (sealed 2026-10-16)

**U1.** Copied the script into the repo's tools folder and told the AI "if you need to
remember what we were doing, run this." It sometimes did; the user judged it mostly
useful for voice, though it occasionally corrected one thing.

**U2.** Not against copying, but "I firmly believe in building on work": copy only if a
plugin does something better than the original extract and would be easier to build on
than their own work.

**U3.** Building a pizza with ingredients.

**U4.** About 5 percent.

**U5.** About 30k.

**S1.** The shell is zsh, which does not word-split an unquoted variable, so each
configuration string was passed to node as one argument; the script saw no flags and ran
its defaults every time. The only honest number in that run was the default bundle.

**S2.** 22 user turns kept, versus 26 before the reserve.

**S3.** About 16,048 from the file's byte length in the pointer line, versus about
15,365 from the body in the stats line. The fix made both use the stats line's figure.

**S4.** Median about 18k tokens after (18,261), median 5 preserved entries (blocks, not
turns), across 56 automatic compactions that all began near 971k tokens.

**S5.** About two minutes (median 122 seconds); three of 56 installed in under a second
from a precompute.

**D1.** A CLAUDE.md at the plugin root is not loaded as context and fails
`claude plugin validate --strict`; nesting let the repo root hold CLAUDE.md and `test/`
without shipping them in the plugin. `.claude/CLAUDE.md` would also have passed strict
validation; nesting was chosen for the cleaner layout.

**D2.** When the script's PreCompact status record landed after `session.compact` had
already created the row and cleared the pending entry, `fold()` opened a new pending
entry instead of attaching the record to the open row: the pane showed a stuck
"compacting now" line and a `?` PreCompact mark beside a ✓ SessionStart mark. Reproduced
with a kit test that fired the hooks in the other order, before the fix was requested.

**D3.** One file per session was extracted from the whole transcript, so at a third
compaction it held all three epochs and grew without bound; reproduced on a synthetic
three-epoch transcript. One numbered file per compaction, bounded to the turns since the
last compaction marker, keeps each file one window and keeps earlier windows readable.

**D4.** From an instruction ("read that file when the task needs…") to a statement ("…is
in <path>."), because the script's own comment says framing is kept factual: text that
reads as an out-of-band command can trip prompt-injection defenses.

**D5.** The automatic path is a SessionStart hook whose output Claude Code caps at 10,000
characters. Within that, every assistant turn displaces one of the user's; the user's
turns are the densest context per token, so they go first and the arc file carries the
rest on demand.

**F1.** Name three things you were about to leave out (too obvious, too demanding, outside
the genre). Make it defensible: verified versus inferred, end with what could make you
wrong. Every change ships with evidence from the three checks.

**F2.** 10,000 characters; the plugin passes `--max-chars 9000` for the whole output.

**F3.** `~/.claude/before-compact/injected-<session>.json`, written by the mod's
`session.compact` hook before it returns, only when the `inject_in_mod` experiment is on.

## Record

Fill in after the first run.

| Field | Value |
| --- | --- |
| Date and session | |
| Trigger (manual / auto) | |
| Pane row (tokens, messages, duration, marks) | |
| Summary size (tab 3) | |
| Bundle turns (tab 2) | |
| Stage 1 grid (U/S/D/F right-partly-wrong-unknown) | |
| Stage 2 grid | |
| Stage 3 grid | |
| Did the model know the arc file's name cold? | |

## Baseline: what a stock compaction kept, measured on a past session

Before this plugin existed, a session in another repository on this machine (the 2d
pixel room builder, 2026-10-02) was auto-compacted twice. Its transcript holds both the
summary the engine installed and the turns before it, so the two halves of the question
can be read side by side without running anything live. Figures from the script's `--probe`
and `--recover` on that transcript; the texts were read in full.

**The compaction.** Automatic, 968,471 → 20,350 tokens, 88 seconds, 6 entries preserved.
The window it summarized held 380 dialog turns (68 user, 312 assistant), about 64,000
tokens; the transcript file is many times that because of tool results.

**The engine's summary.** 20,381 characters, about 5,100 tokens, in nine numbered
sections: primary request and intent; key technical concepts; files and code sections;
errors and fixes; problem solving; **all user messages**; pending tasks; current work;
next step. It ends by naming the transcript file as the place for exact details. Two
observations that correct an assumption this project started with:

- The summarizer does not drop the dialog. Section 6 lists 28 user messages: short ones
  verbatim, long ones cut with an ellipsis where the reasoning begins. The summary keeps
  the asks and keeps the voice in fragments.
- The user's working rules survived in section 1 because they were in that project's
  `AGENTS.md`. A rule stated in dialog has no such protection, which is why this repo's
  rules live in `CLAUDE.md`.

**What the hook would have added.** The 18 user turns before the boundary, in full:
6,979 characters, about 1,500 tokens. Set beside section 6, the difference is exactly
where the ellipses fall. Four examples:

| The summary kept | The bundle restores |
| --- | --- |
| "Can't you extrapolate them?…" | the actual question: "I feel like I'm missing something about our flexibility, robustness of the architecture." |
| "…robustness and flexibility not about hardcoding…" | the intent behind the project: the room output "was built so the user could download the room + the actual image to build it without our generator script. That was the intention of the town too." |
| "it needs another story just to work from a perspective standpoint… a second story…" | the constraint that decided the design: it "might be one of those things that require more than 3 blocks of walls stacked on top of each other to look good." |
| the fragments of "Where this lands…" | the standard set for the answer: "robustness + exactness… it also needs to be useable", and "Give me a plain spoke recommendation with examples." |

Each is a why, a standard, or an intent, cut mid-sentence by the summarizer and restored
whole by the bundle. The short approvals ("Push it and start phase 1") appear in both,
which is the redundancy cost: roughly a third of the bundle repeats a line the summary
already has, for a few hundred tokens.

**What neither carries.** The assistant's side of the window, 312 turns and most of the
64,000 tokens, where the record of what was done and verified lives; the summary's
sections 4 and 5 are its compression of that. The arc file is the on-demand route to it.

**How to read this against the live test.** Expect the pattern above: the summary gives
breadth (every ask, the state of the code) and the bundle gives depth on the newest
turns (the reasoning the summary cut). A live run that shows the same shape confirms the
premise; one where the summary quotes the recent turns whole would mean the bundle is
redundant on that build and the budget should go to the assistant's side instead.

**What could make this baseline wrong.** One session, one build (October 2). The
nine-section shape and the cut points are what that summarizer produced then; the
Summary tab shows what today's produces. The brief that now ships by default asks the
summarizer to quote constraints and corrections verbatim, so a current summary may cut
less than this one did, which the live test will show.
