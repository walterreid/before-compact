"""Write the two transcripts the 0.3.2 checks in run.sh read.

Usage: python3 make_fixtures_032.py <relay.jsonl> <newest.jsonl>

relay.jsonl, user side. Newest first, against the 8,200 characters a hook has after its
framing reserve: the user's own turn C; a 12,000-char paste of the user's (over the budget,
so a one-line note); an artifact context block with text typed after it (the block goes,
the text stays); a side-session event, a scheduled task's prompt and a cross-session message
(each a whole block, so the turn goes); an agent's hand-back of about 10,000 chars (goes
whole); then the user's own turns B and A. Before 0.3.2 the hand-back ended the walk and A,
B and the typed text were never reached.

newest.jsonl, assistant side: five assistant turns of 3,000 chars each, oldest first, each
starting with its own tag (ATURN1 to ATURN5) and ending with END-n. With --newest-turns 2
--newest-max 4000 the newest two (5 and 4) come back whole, turn 3 is cut at 1,500.
"""
import json
import sys

relay_path, newest_path = sys.argv[1], sys.argv[2]


def write(path, events):
    with open(path, "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def assistant(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


relay = [
    user("OLDEST own turn A"), assistant("reply a"),
    user("own turn B"), assistant("reply b"),
    user('Another Claude session sent a message: <agent-message from="x1">'
         + "R" * 10000
         + '</agent-message>\nThat "other Claude session" is an agent.'),
    assistant("reply c"),
    user('<cross-session-message from="local_1">relayed note</cross-session-message>'),
    user('<scheduled-task name="daily">scheduled prompt</scheduled-task>'),
    user("<side-sessions-event>None of the sessions is working now.</side-sessions-event>"),
    user('<artifact-view-context artifact="a1">context block</artifact-view-context>Typed after the context'),
    assistant("reply d"),
    user("P" * 12000), assistant("reply e"),
    user("NEWEST own turn C"), assistant("reply f"),
]
write(relay_path, relay)

newest = []
for n in range(1, 6):
    newest.append(user(f"question {n}"))
    body = f"ATURN{n} " + "x " * 1490
    newest.append(assistant(body[:2990] + f" END-{n}"))
write(newest_path, newest)
