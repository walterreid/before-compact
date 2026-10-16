#!/usr/bin/env bash
# Exercises extract_tail.mjs against a synthetic transcript: manual recover, budget,
# PreCompact write, SessionStart read-back, and the live fallback. No Claude Code needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; S="$HERE/../scripts/extract_tail.mjs"
W="$(mktemp -d)"; export CLAUDE_PLUGIN_DATA="$W/data"
python3 - "$W/sess.jsonl" <<'PY'
import json,sys
ev=[]
u=lambda t: ev.append({"type":"user","message":{"role":"user","content":t}})
a=lambda t: ev.append({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":t}]}})
for i in range(1,31):
    u(f"user turn {i}"); ev.append({"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}); a(f"assistant {i} "+"x "*100)
u("<system-reminder>noise</system-reminder>LAST BEFORE COMPACTION"); a("ok")
u("This session is being continued from a previous conversation. Summary."); a("continuing"); u("AFTER")
open(sys.argv[1],"w").write("".join(json.dumps(e)+"\n" for e in ev))
PY
fail(){ echo "FAIL: $1"; exit 1; }
out=$(node "$S" --file "$W/sess.jsonl" --recover --role user --turns 3)
grep -q "LAST BEFORE COMPACTION" <<<"$out" || fail "recover did not return the last pre-compaction user turn"
grep -q "AFTER" <<<"$out" && fail "recover leaked a post-compaction turn"
grep -q "system-reminder" <<<"$out" && fail "noise was not stripped"
out=$(node "$S" --file "$W/sess.jsonl" --max-chars 300)
grep -q "budget:" <<<"$out" || fail "budget line missing"
echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"PreCompact"}' | node "$S" --hook --role user | grep -q . && fail "PreCompact printed to stdout"
[ -s "$W/data/precompact-t.txt" ] || fail "PreCompact wrote no bundle"
out=$(echo '{"session_id":"t","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook --role user)
grep -q "prepared by the PreCompact hook" <<<"$out" || fail "SessionStart did not use the bundle"
out=$(echo '{"session_id":"other","transcript_path":"'"$W/sess.jsonl"'","hook_event_name":"SessionStart","source":"compact"}' | node "$S" --hook)
grep -q "extracted from the transcript" <<<"$out" || fail "live fallback not taken"
[ "$(wc -c <<<"$out")" -lt 10000 ] || fail "hook output over the 10000-char cap"
echo "all checks passed"
