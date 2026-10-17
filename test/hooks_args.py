"""Exit 0 when both assistant-side entries in hooks.json pass exactly the given args.

Usage: python3 hooks_args.py <hooks.json> <arg> [<arg> ...]
The script path (the first arg in hooks.json) is left out of the comparison.
"""
import json
import sys

hooks = json.load(open(sys.argv[1]))["hooks"]
want = sys.argv[2:]
got = [
    entry["args"][1:]
    for event in ("PreCompact", "SessionStart")
    for matcher in hooks[event]
    for entry in matcher["hooks"]
    if "assistant" in entry["args"]
]
if len(got) != 2 or any(g != want for g in got):
    print("hooks.json:", got)
    print("run.sh AS: ", want)
    sys.exit(1)
