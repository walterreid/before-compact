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
| **S** assistant-said | only in the assistant's replies, deeper in the window | the arc file, a digest, or the engine summary if it kept it |
| **A** assistant-said-restored | only in the assistant's last few replies before the compaction | the second hook's injected bundle (assistant turns, ≤9,000 chars, each cut at 1,500, those under 200 chars dropped), added 2026-10-16 |
| **D** decision with its reason | in the dialog, as a change of mind and why | same as S; this is what summaries flatten most |
| **F** in a file | CLAUDE.md or the README | anything; this is the control |

Expected pattern if the layers work as designed: **F** right every time; **U** right cold,
because the bundle put the turns back; **A** right cold too, because the second bundle put
the assistant's last turns back, and the pair **U** right / **A** wrong is the signature of
only one of the two hook outputs reaching the model; **S** and **D** wrong or vague cold
unless the engine's summary happened to keep them, and right once the arc file is read. A
**U** question answered wrong cold means the bundle did not reach the model. An **S**
question answered right cold means the summary kept more than we assume, which is also
worth knowing. **A** and **S** differ only in where the answer sits: within the last
9,000 characters of the assistant's turns, or further back. On a session that compacts
late, an **A** answer can age into an **S** answer before the compaction comes; record how
many assistant turns before the boundary each **A** answer sat (the `[-N]` index in the
second block) so the grade can be read against the bundle's reach.

Bin **A** has two questions drawn from the assistant's own recent answers in the session
that asked for the second injection, as that session relayed them when it briefed this
change. Stage 1 is the only stage that measures the second block: the arc (stage 2) and
`--recover --role both` (stage 3) hold the same answers, so a wrong-then-right **A** says
the block did not arrive and a right-cold **A** says it did (or the summary kept it; the
Summary tab, pressed before stage 1, settles which). Two more things a live run should
record for **A**: whether the model, asked which of the two blocks of prior turns came first
in its context, names an order (the hooks reference says Claude receives all the values and
does not say in which order), and whether `/context` shows the two blocks' sizes adding up
with no combined cap applied.

It cannot prove the restored text *caused* a correct answer; a model can answer from
general competence. That is why each bin has several questions and why **F** is there.
The model under test has this file in its tree; stage 1 relies on it honouring "from
memory only". If you want the answers sealed from it, move the answers section to a file
outside the repository before compaction.

## Procedure

1. **Before compaction:** confirm the pane shows four tabs and no error line. Note the
   gauge. Do not discuss these questions with the model again.
2. **At compaction:** let auto-compaction run, or type `/compact`. Then open
   `/before-compact` and record the row: tokens before → after, messages before → after,
   duration, the three marks (✓ / ✗ / ? / –; the third is the assistant side's second
   `SessionStart` line), and whether an error line appeared. Press `3` and note the
   summary's size. Press `2` and note how many user turns the bundle holds. Note the
   assistant line's token figure: it is the size of the second block as printed, not proof
   that the model received it.
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

**A, assistant-said-restored** (the assistant's own recent answers; added 2026-10-16)

- A1. When the assistant measured its own side of the dialog against the 9,000-character
  budget, how many full assistant turns fit, and how many fit when each turn was cut at
  1,200 characters and at 700?
- A2. In that measurement, what range of lengths did the assistant's turns span, and what
  did the assistant say the long ones have in common?

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

**A1.** 7 full turns (about 1,800 tokens); 11 turns cut at 1,200 characters; 17 cut at
700. (Sealed 2026-10-16 from the brief the measuring session gave the session that built
the second injection; the measurement itself was made in the measuring session's own
recent turns, which is what makes it an **A** answer there.)

**A2.** From one-line progress notes to about 4,800 characters; the long ones lead with
the conclusion. (Same source and date as A1.)

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
| Assistant line (tokens; ✓ / ✗ / ? / –) | |
| Stage 1 grid (U/S/A/D/F right-partly-wrong-unknown) | |
| Stage 2 grid | |
| Stage 3 grid | |
| Did the model know the arc file's name cold? | |
| Did the model quote both blocks' framings, and in which order did it say they came? | |
| Did `/context` show both blocks, with no combined cap? | |

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

## Blind comparison: the summary alone against the summary plus the hooks (2026-10-17)

**The question.** Does a fresh agent that gets the engine's summary plus the two hook
blocks interrogate that summary better, and plan next steps that would need less redoing,
than one that gets the summary alone? Put another way: do the missing details lead to
backtracking, and does it matter? This is a separate test from the staged protocol above;
it does not fill the record table.

**Design.**
- Three real compactions: this repository's own session (plugin 0.3.0/0.3.1 blocks), a
  2d-pixel-room-builder session (0.3.2 blocks), and a clockwork-reels session (0.3.1 blocks,
  which still had the bug that kept only 2 of the user's turns). Each condition used the
  summary and the blocks those sessions actually received, not regenerated ones.
- Six readers, one per session and condition, each limited by its instructions to a single
  file: summary only, or summary plus the two blocks. Same task for both: treat the summary
  as a report and list the claims to rely on, what could make it wrong, hidden assumptions,
  missed implications, what to check or ask before continuing, and a confidence score.
- Three blind judges, one per session. Each got the summary, the two reports under random
  labels X and Y, and the window file (the full dialog of the window the summary covers,
  both sides, untruncated, without tool outputs) as ground truth. They counted catches
  (real gaps or errors in the summary the window confirms), false alarms, errors, important
  misses, next steps that would go wrong, and checks the window shows were unnecessary,
  then gave a verdict and its size. The key was applied only after all three had finished.
- The raw summaries, window files and reports hold dialog from other projects, so they
  were kept local and are not in this repository.

**Predictions, written before any reader ran.**
1. The hooks reader catches more real gaps in at least 2 of 3 sessions; slight to moderate.
2. The clearest wins are stale items and the user's exact constraints.
3. The summary-only reader raises more false alarms.
4. Clockwork-reels shows the smallest difference, because of its 2-turn user block.
5. Confound: the hooks reader's report may be longer; judges were told to score substance.

**Results, unblinded.** Counts are hooks / summary only.

| Session | Verdict | Catches | False alarms | Errors | Missed | Steps that go wrong | Unnecessary checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before-compact | hooks, slight | 7 / 3 | 1 / 3 | 1 / 0 | 3 / 5 | 0 / 0 | 2 / 2 |
| 2d-pixel-room-builder | hooks, moderate | 5 / 2 | 2 / 4 | 0 / 1 | 3 / 5 | 0 / 1 | 0 / 1 |
| clockwork-reels | hooks, moderate | 4 / 2 | 1 / 2 | 1 / 0 | 3 / 5 | 0 / 0 | 2 / 1 |
| **Total** | **3 of 3 for hooks** | **16 / 7** | **4 / 9** | **2 / 1** | **9 / 15** | **0 / 1** | **4 / 4** |

| Prediction | Held? |
| --- | --- |
| 1. More catches in at least 2 of 3 | Yes, 3 of 3, slight once and moderate twice |
| 2. Clearest wins are stale items and exact words | Yes |
| 3. More false alarms without the hooks | Yes, 9 against 4 |
| 4. Clockwork-reels shows the smallest difference | No: moderate despite the bug. The assistant block carried it. The smallest was before-compact. |
| 5. Length confound | Not visible in the judges' reasoning |

**What the difference was made of.** Without the hooks, readers would have:
- asked the user again what "worked" meant, though the last turn before the compaction
  had defined it with a six-item checklist;
- asked whether the compaction was the live test, and whether a submission was already
  under review, both settled in the window;
- treated a settled design question as an open gate, and raised a test-hash tension the
  window had already explained;
- read the user's "fix bugs 1 to 4 first" as "wait for playtesting", where the hooks reader
  read "first" as a queue of the user's own changes;
- accepted a constraint the summary attributed to the wrong decision.

Unnecessary re-checks were equal, 4 and 4. So the blocks did not save tool work in this
test. They saved conversation: questions that would cost the user's turns, and next steps
aimed the wrong way.

**The min-chars finding.** One of the hooks readers' two errors came from reading an
absence in the blocks as an absence in fact. In the before-compact session, the assistant
turn "Push done and confirmed." was shorter than 200 characters, so `--min-chars 200` left
it out of the assistant block, and the reader concluded the push was unconfirmed. Short
assistant turns are often exactly the state changes ("done", "pushed"), so the filter
deserves another look. Nothing has been changed yet. The other error, in clockwork-reels,
confused the golden hashes with the test gates; nothing ties it to the blocks.

**Caveats.**
- Three sessions, each judged once, by a model of the same family as the readers.
- The blinding was imperfect: the hooks readers cite turns as "[-3]" and so on, which shows
  which one had the extra material. Judges were told not to reward that.
- In the before-compact session both readers also saw this repository's git status and
  instruction file, and both used them to call the summary stale. That inflates both of
  their scores there, but not one side over the other.
- The readers planned; they did not work. Fewer wrong steps in a plan is evidence about
  backtracking, not a measurement of it.
- The plugin's author designed the test. That is why the predictions were written first,
  and why the one that failed is reported.

**What would change the conclusion.** A repeat on new compactions with a second, different
judge per session; or the same session compacted twice, with and without the plugin, and
the real next hour of work compared.
