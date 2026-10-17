"""Write the transcript the 0.3.4 checks in run.sh read.

Usage: python3 make_fixtures_034.py <finals.jsonl>

Each assistant content block is its own entry, as Claude Code writes them, so a text
followed by a tool call in the same reply is two entries. Oldest first:

  turn 1  a long reply (300 chars) that ends the turn                    kept
  turn 2  "Push done and confirmed." (24 chars) that ends the turn        kept since 0.3.4
  turn 3  "Reading the files now." then a tool call, a tool result, and
          a long reply that ends the turn                                 short note dropped,
                                                                          long reply kept
  turn 4  "Checking one more thing." followed in the same reply by a
          tool call (one entry), then a short "All green." ending it      first dropped,
                                                                          "All green." kept
  turn 5  a side-session event, answered "No response requested."       dropped
"""
import json
import sys

out = sys.argv[1]
events = []


def user(text):
    events.append({"type": "user", "message": {"role": "user", "content": text}})


def text(t):
    events.append({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}})


def tool(n):
    events.append({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": f"t{n}", "name": "Bash", "input": {"command": "true"}}]}})
    events.append({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": f"t{n}", "content": "ok"}]}})


user("first question")
text("LONG-FINAL-1 " + "a " * 144)
user("Push main to origin now.")
text("Push done and confirmed.")
user("do the review")
text("Reading the files now.")
tool(1)
text("LONG-FINAL-3 " + "b " * 144)
user("one more")
events.append({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "text", "text": "Checking one more thing."},
    {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "true"}}]}})
events.append({"type": "user", "message": {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]}})
text("All green.")
user("<side-sessions-event>None of the sessions is working now.</side-sessions-event>")
text("No response requested.")

with open(out, "w") as f:
    for e in events:
        f.write(json.dumps(e) + "\n")
