# before-compact — how we work here

The plugin is `before-compact/` (manifest, hooks, mod, script, skill). The repo root holds
this file, `test/`, and nothing Claude Code loads. Loaded in place from
`~/.claude/settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS`; no copying, ever.

## Dev loop

1. Edit a file under `before-compact/`.
2. `bash test/run.sh` and `claude plugin validate --strict ./before-compact` must both pass.
3. In the running session: `/reload-plugins`, then `/before-compact`.

Terminal CLI and Desktop bundle different Claude Code versions. Mods need 2.1.287+,
`CLAUDE_CODE_PLUGIN_DIRS` needs 2.1.280+. Check with `claude --version` and `/status`.

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
- Hooks and the mod share state only through `~/.claude/before-compact/status-<session>.json`.
- `test/run.sh` sets its own `HOME` and `CLAUDE_PLUGIN_DATA`; keep it that way.
- The session-only plugin (`@inline`) shadows any same-named copy under `~/.claude/skills/`.
