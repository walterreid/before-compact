#!/usr/bin/env bash
# Exercises extract_tail.mjs against a synthetic transcript: manual recover, budget,
# PreCompact write, SessionStart read-back, and the live fallback. No Claude Code needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; S="$HERE/../before-compact/scripts/extract_tail.mjs"
W="$(mktemp -d)"; export CLAUDE_PLUGIN_DATA="$W/data"
# The script writes status records under $HOME/.claude/before-compact/; keep the test out of the real home.
export HOME="$W/home"; mkdir -p "$HOME"
# sess.jsonl: 30 exchanges, then a compaction-summary marker, then two post-compaction turns.
# pre.jsonl: the same transcript as it stood BEFORE that compaction (no marker): what a
# PreCompact hook sees. three.jsonl: three epochs (EPOCH1..3) split by two markers.
python3 - "$W/sess.jsonl" "$W/pre.jsonl" "$W/three.jsonl" <<'PY'
import json,sys
ev=[]
u=lambda t: ev.append({"type":"user","message":{"role":"user","content":t}})
a=lambda t: ev.append({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":t}]}})
for i in range(1,31):
    u(f"user turn {i}"); ev.append({"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}); a(f"assistant {i} "+"x "*(400 if i==30 else 100))  # turn 30 is 800+ chars: over the 700-char assistant default
u("<system-reminder>noise</system-reminder>LAST BEFORE COMPACTION"); a("ok")
open(sys.argv[2],"w").write("".join(json.dumps(e)+"\n" for e in ev))
u("This session is being continued from a previous conversation. Summary."); a("continuing"); u("AFTER")
open(sys.argv[1],"w").write("".join(json.dumps(e)+"\n" for e in ev))
ev=[]
for n in (1,2,3):
    if n>1: u(f"This session is being continued from a previous conversation. Summary {n-1}.")
    for i in range(1,6): u(f"EPOCH{n} user {i}"); a(f"EPOCH{n} assistant {i}")
open(sys.argv[3],"w").write("".join(json.dumps(e)+"\n" for e in ev))
PY
fail(){ echo "FAIL: $1"; exit 1; }
out=$(node "$S" --file "$W/sess.jsonl" --recover --role user --turns 3)
grep -q "LAST BEFORE COMPACTION" <<<"$out" || fail "recover did not return the last pre-compaction user turn"
grep -q "AFTER" <<<"$out" && fail "recover leaked a post-compaction turn"
grep -q "system-reminder" <<<"$out" && fail "noise was not stripped"
# --raw means verbatim: no per-turn truncation. The default does truncate turn 30, so the check is meaningful.
out=$(node "$S" --file "$W/sess.jsonl" --role assistant --turns 5)
grep -q "chars truncated" <<<"$out" || fail "the 700-char assistant default no longer truncates (test transcript too short?)"
out=$(node "$S" --file "$W/sess.jsonl" --role assistant --turns 5 --raw)
grep -q "chars truncated" <<<"$out" && fail "--raw truncated an assistant turn"
out=$(node "$S" --file "$W/sess.jsonl" --max-chars 300)
grep -q "budget:" <<<"$out" || fail "budget line missing"
echo '{"session_id":"t","transcript_path":"'"$W/pre.jsonl"'","hook_event_name":"PreCompact"}' | node "$S" --hook --role user --max-chars 9000 | grep -q . && fail "PreCompact printed to stdout"
[ -s "$W/data/precompact-t.txt" ] || fail "PreCompact wrote no bundle"
# The arc beside the bundle: both roles, assistant turns untruncated, noise stripped, no budget.
# No marker in pre.jsonl, so this is the first compaction: arc-t-1.txt holds the whole transcript.
ARC="$W/data/arc-t-1.txt"
[ -s "$ARC" ] || fail "PreCompact wrote no arc (expected $ARC)"
grep -q "LAST BEFORE COMPACTION" "$ARC" || fail "the arc is missing the newest user turn"
[ "$(wc -c <"$ARC")" -gt "$(wc -c <"$W/data/precompact-t.txt")" ] || fail "the arc is not longer than the bundle"
grep -q "===== ASSISTANT" "$ARC" || fail "the arc has no assistant turns"
grep -q "chars truncated" "$ARC" && fail "the arc truncated an assistant turn"
grep -q "system-reminder" "$ARC" && fail "the arc kept harness noise"
grep -q "budget:" "$ARC" && fail "the arc applied a character budget"
grep -q '"arc_chars": [1-9]' "$HOME/.claude/before-compact/status-t.json" || fail "the arc's size is not in the PreCompact status record"
out=$(echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user --max-chars 9000)
grep -q "prepared by the PreCompact hook" <<<"$out" || fail "SessionStart did not use the bundle"
# The pointer line: names the arc's absolute path, its turn count and its own token figure,
# right after the framing, as a statement.
arc_turns=$(sed -n 's/^\[\([0-9]*\) turns .*/\1/p' "$ARC" | tail -1)
arc_tokens=$(sed -n 's/^\[[0-9]* turns .*~\([0-9]*\) tokens.*/\1/p' "$ARC" | tail -1)
[ -n "$arc_turns" ] && [ -n "$arc_tokens" ] || fail "no stats line at the end of the arc"
grep -q "($arc_turns turns, ~$arc_tokens tokens), is in $ARC\.$" <<<"$out" || fail "the pointer line does not name the arc with the stats line's turn and token figures"
[ "$(sed -n 2p <<<"$out" | grep -c "$ARC")" = 1 ] || fail "the pointer line is not the line after the framing sentence"
grep -qi "read that file\|read it when" <<<"$out" && fail "the pointer line is an instruction, not a statement"
grep -q "\"arc_tokens_est\": $arc_tokens" "$HOME/.claude/before-compact/status-t.json" || fail "the status record's arc_tokens_est is not the stats line's figure"
[ "$(wc -c <<<"$out")" -lt 9000 ] || fail "hook output over the 9000-char budget"
# The live fallback: sess.jsonl already holds the new summary's marker, so the arc is the
# window that marker closed (epoch 1), and nothing after the marker leaks into it.
out=$(echo '{"session_id":"other","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --max-chars 9000)
grep -q "extracted from the transcript" <<<"$out" || fail "live fallback not taken"
grep -q "budget:" <<<"$out" || fail "the live fallback with both roles did not hit the budget (test transcript too short?)"
[ "$(wc -c <<<"$out")" -lt 9000 ] || fail "hook output over the 9000-char budget on the live fallback"
grep -q "is in $W/data/arc-other-1.txt\.$" <<<"$out" || fail "the live fallback wrote no arc for the closed window or did not point at it"
grep -q "LAST BEFORE COMPACTION" "$W/data/arc-other-1.txt" || fail "the fallback's arc is missing the last turn before the marker"
grep -q "AFTER" "$W/data/arc-other-1.txt" && fail "the fallback's arc leaked a turn from after the marker"
# Three epochs: at the third compaction the arc is epoch 3 only, in its own numbered file.
echo '{"session_id":"three","transcript_path":"'"$W/three.jsonl"'","hook_event_name":"PreCompact"}' | node "$S" --hook --role user --max-chars 9000
A3="$W/data/arc-three-3.txt"
[ -s "$A3" ] || fail "the third compaction did not write arc-three-3.txt"
[ -e "$W/data/arc-three-1.txt" ] && fail "arc-three-1.txt exists: only the compaction that runs writes its own file"
[ -e "$W/data/arc-three-2.txt" ] && fail "arc-three-2.txt exists: only the compaction that runs writes its own file"
grep -q "EPOCH3 user 5" "$A3" && grep -q "EPOCH3 assistant 1" "$A3" || fail "the arc is missing EPOCH3 turns"
grep -q "EPOCH1\|EPOCH2" "$A3" && fail "the arc holds turns from an earlier window"
grep -q "Summary 2" "$A3" && fail "the arc kept the marker turn itself"
grep -q "^\[10 turns (5 user / 5 assistant)" "$A3" || fail "the arc's stats line does not say 10 turns"
out=$(echo '{"session_id":"three","transcript_path":"'"$W/three.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user --max-chars 9000)
grep -q "(10 turns, ~[0-9]* tokens), is in $A3\.$" <<<"$out" || fail "the pointer does not name arc-three-3.txt"
grep -qi "read that file" <<<"$out" && fail "the pointer line is imperative"
[ -s "$HOME/.claude/before-compact/status-t.json" ] || fail "status record not written under the test HOME"
# inject_in_mod: a fresh stand-down marker from the mod makes SessionStart print nothing and record why.
M="$HOME/.claude/before-compact/injected-t.json"
printf '{"at":"%s","trigger":"manual","appended":5,"chars":1200}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$M"
out=$(echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user)
[ -z "$out" ] || fail "SessionStart injected although the mod's marker said it had appended the turns"
[ -e "$M" ] && fail "the stand-down marker was not consumed"
grep -q '"mod_appended": 5' "$HOME/.claude/before-compact/status-t.json" || fail "the stand-down was not recorded in the status file"
# A stale marker (older than 2 minutes) is ignored and removed: the script injects as usual.
printf '{"at":"2020-01-01T00:00:00Z","trigger":"manual","appended":5,"chars":1200}' > "$M"
out=$(echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user)
grep -q "prepared by the PreCompact hook" <<<"$out" || fail "a stale marker suppressed the injection"
[ -e "$M" ] && fail "the stale marker was not removed"
echo "all checks passed"
