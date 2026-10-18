# Privacy policy: before-compact

Effective 2026-10-18. Applies to the before-compact plugin for Claude Code, by Walter Reid
(walterreid@gmail.com).

## The short version
before-compact runs on your own machine. It reads your current Claude Code session's
conversation so it can put your last turns back after a compaction. It writes what it reads
to files on your machine. It sends nothing to the author or to any service of its own, and
it has no analytics or telemetry.

## What it reads
- The current session's transcript. Claude Code hands each hook the path of the session's
  transcript file. The plugin reads it before and after a compaction to take your last turns
  and the assistant's, and to count compaction markers for the pane.
- The compaction itself. The pane reads the summary Claude Code installs and the token counts
  before and after, to show them on its Summary tab.
- Its own settings, the options you set for it in /config.
It reads only the session it runs in. It does not read Claude's memory, other sessions, or
files you have uploaded.

## What it stores, and where
Everything stays on your machine:
- The plugin's data folder (~/.claude/plugins/data/ followed by the plugin's id): the last
  turns saved before each compaction, and one file per compaction holding that window's
  back-and-forth.
- ~/.claude/before-compact/: one-line status records per hook run (times, counts, paths); a
  stand-down marker only with inject_in_mod on; the digest only with digest_in_precompact on.
These files can contain anything said in the conversation, including personal information.

## What it sends, and where
- Nothing to the author, and nothing to any service of the plugin's own.
- The saved turns go back into the same Claude Code session they came from, and Claude Code
  sends them to Claude with the rest of that conversation, under the terms that already
  cover your use of Claude.
- One opt-in exception: with digest_in_precompact on (off unless you turn it on), the plugin
  asks Claude, through Claude Code's own model call, to write a digest of the last part of
  the conversation before a compaction. That is a separate request to Claude, under the same
  terms.

## How long it keeps data
Until you delete it. Saved turns are replaced at each compaction; window files accumulate,
one per compaction. To remove everything, delete ~/.claude/before-compact/ and the plugin's
data folder. Uninstalling the plugin through Claude Code also removes its data folder, unless
you choose to keep it.

## Children
Not intended for anyone under 18.

## Changes
Changes are made in this file; its history is public at
https://github.com/walterreid/before-compact.

## Contact
Walter Reid, walterreid@gmail.com, or https://github.com/walterreid/before-compact/issues.
