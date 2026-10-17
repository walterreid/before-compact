# before-compact — how we work here

The plugin is `before-compact/` (manifest, hooks, mod, script, skill). The repo root holds
this file, `test/`, and nothing Claude Code loads. Loaded in place from
`~/.claude/settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS`; no copying, ever.

## Dev loop

1. Edit a file under `before-compact/`.
2. Three checks must pass: `bash test/run.sh` (repo root), `claude plugin validate --strict
   ./before-compact`, and `claude plugin test` (from `before-compact/`).
3. In a running session `/reload-plugins`, then `/before-compact`. After a mod change, the
   live check is a new session: `/before-compact`, `/compact`, one row with two ✓ marks.

Terminal CLI and Desktop bundle different Claude Code versions. Mods and `claude plugin
test` need 2.1.287+, `CLAUDE_CODE_PLUGIN_DIRS` needs 2.1.280+. Check with `claude --version`
and `/status`. If the terminal CLI is older, run the kit tests with the Desktop's binary
(under `~/Library/Application Support/Claude/claude-code/<version>/…/claude`) or update it.

## Three rules, every non-trivial answer

1. **Name what you were about to leave out.** Before answering, list three things the user
   might want that you were going to skip: one too obvious, one too demanding, one outside
   the question's genre. Say whether each belongs, and why.
2. **Make it defensible.** Interrogate your assumptions, evidence, and conclusions; keep
   only what survives. Mark *verified* (ran, read, tested) separately from *inferred*.
   Never present a docs recollection as checked: fetch code.claude.com or say "from memory".
   End with what could still make you wrong.
3. **Every change ships with evidence.** Paste what `test/run.sh` and `claude plugin validate`
   printed. If you touched `hooks/register.js`, say what you could and could not exercise
   without a live session (stub the mods API or extend `test/run.sh`; `claude plugin test`
   is available for `.test.ts` files).

## Bugs reported from the pane

Reproduce first, against `test/run.sh` or a stub of the mods API. Then fix, show the diff,
and name the one check in the running pane that proves it. If you cannot reproduce, say so
and ask for the pane's `(last error: …)` line. Do not guess.

## Facts about the plugin that are easy to get wrong

- The mod's `/before-compact` command is not namespaced; the skill is `/before-compact:recover`.
- The script and the mod share no memory. They meet through two files under
  `~/.claude/before-compact/`: `status-<session>.jsonl` (the ✓ marks, one line per hook run,
  append-only: two hooks of one event write at the same moment) and, with the
  `inject_in_mod` experiment on, `injected-<session>.json` (the stand-down marker).
- Live on Desktop 2.1.299 (2026-10-17), the SessionStart(compact) settings hooks ran inside
  the mod's `session.compact` `next(e)`: the ✓ marks reached the mod before the engine's
  numbers. The fold and the `session.compact` hook handle both orders; keep it that way.
- The row's numbers come from the `session.compact` event, not from polling; the compaction
  log lives in `$.state` (declared in `types/index.d.ts`) and survives a reload.
- The kit cannot prove that settings hooks finish inside the `classic.*` hooks' `next(e)`,
  nor that appended messages survive into the next request. Say so whenever it matters.
- `test/run.sh` sets its own `HOME` and `CLAUDE_PLUGIN_DATA`; keep it that way.
- The session-only plugin (`@inline`) shadows any same-named copy under `~/.claude/skills/`.
- `inject_in_mod` stays off by default until a live `/compact` has proven it.
