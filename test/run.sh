#!/usr/bin/env bash
# Exercises extract_tail.mjs against a synthetic transcript: manual recover, budget,
# PreCompact write, SessionStart read-back, and the live fallback. No Claude Code needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; S="$HERE/../before-compact/scripts/extract_tail.mjs"
W="$(mktemp -d)"; export CLAUDE_PLUGIN_DATA="$W/data"
# The script writes status records under $HOME/.claude/before-compact/; keep the test out of the real home.
export HOME="$W/home"; mkdir -p "$HOME"
python3 - "$W/sess.jsonl" <<'PY'
import json,sys
ev=[]
u=lambda t: ev.append({"type":"user","message":{"role":"user","content":t}})
a=lambda t: ev.append({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":t}]}})
for i in range(1,31):
    u(f"user turn {i}"); ev.append({"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}); a(f"assistant {i} "+"x "*(400 if i==30 else 100))  # turn 30 is 800+ chars: over the 700-char assistant default
u("<system-reminder>noise</system-reminder>LAST BEFORE COMPACTION"); a("ok")
u("This session is being continued from a previous conversation. Summary."); a("continuing"); u("AFTER")
open(sys.argv[1],"w").write("".join(json.dumps(e)+"\n" for e in ev))
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
echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"PreCompact"}' | node "$S" --hook --role user | grep -q . && fail "PreCompact printed to stdout"
[ -s "$W/data/precompact-t.txt" ] || fail "PreCompact wrote no bundle"
out=$(echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user)
grep -q "prepared by the PreCompact hook" <<<"$out" || fail "SessionStart did not use the bundle"
out=$(echo '{"session_id":"other","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook)
grep -q "extracted from the transcript" <<<"$out" || fail "live fallback not taken"
[ "$(wc -c <<<"$out")" -lt 10000 ] || fail "hook output over the 10000-char cap"
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
