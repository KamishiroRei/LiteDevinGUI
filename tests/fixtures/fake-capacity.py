import json, os, sys, time

DIR = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(DIR, 'fake-state.json'), encoding='utf-8') as f:
    state = json.load(f)
# Log every capacity probe so the harness can measure poll cadence
# (a busy-loop bug shows up as ~1s spacing between entries).
with open(os.path.join(DIR, 'cap-log.jsonl'), 'a', encoding='utf-8') as f:
    f.write(json.dumps({'at': time.time() * 1000}) + '\n')
cap = state.get('capacity')
if cap is None:
    print('capacity unavailable', file=sys.stderr)
    sys.exit(1)
print(json.dumps(cap))
