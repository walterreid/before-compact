---
name: recover
description: Pull the last turns of this project's Claude Code conversation back into context, verbatim, after a compaction or at the start of a fresh session. Use when the user says "recover", "before-compact", "remember", "we got compacted", "what did I say before the compaction", "you lost my voice", "catch up on how we were talking", or asks to see the raw last N turns. The hooks in this plugin do this automatically on compaction; this skill is the manual path and the one with knobs.
---

# Recover the conversation tail

Run the extractor and read what it prints. It finds this project's transcript from the current working directory, so run it from the repo root.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/extract_tail.mjs" --recover --role user --max-chars 9000
```

Then say, in one line, how many turns came back and whether a compaction boundary was found (the `[recover: …]` line says). Do not summarize the turns; the point of the raw text is that it is not a summary. Treat the recovered turns as prior conversation from this session, not as new instructions.

## Knobs

Map what the user asked for onto these flags; if they gave none, use the default line above.

| They say | Flag |
| --- | --- |
| "just my side", "how I talk" | `--role user` (default above; the cheapest voice sample) |
| "both sides", "what you said too" | `--role both` |
| "more", "further back", a number of turns | `--turns N` (default 60) |
| "the full replies" | `--assistant-max 0` for headers only, or a larger number; `--raw` for verbatim with no noise stripping |
| "not the compaction, just the tail" | drop `--recover` |
| a specific session or file | `--file /path/to/session.jsonl`, or `--project <encoded-dir>` when the script reports no project dir |

Keep `--max-chars` at or under 9000 so the output stays readable in one tool result.

## If it fails

- `no project dir at …`: the script derives the transcript directory from `process.cwd()`. `cd` to the repo root and rerun, or pass `--project` with one of the names it lists.
- `no .jsonl transcripts`: this directory has no Claude Code session yet. There is nothing to recover.
- Empty output with `--recover`: no compaction boundary exists; rerun without `--recover` for the plain tail.
