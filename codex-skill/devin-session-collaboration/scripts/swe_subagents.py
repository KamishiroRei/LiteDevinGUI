"""Subagent self-registration for machine-wide Devin admission.

A run_subagent child creates no devin.exe process, no sessions.db row and no
/api/sessions entry, so the launching session must report it here for the
capacity snapshot to count it. `register` doubles as the admission gate: it
rechecks the real total inside the same global lock used by the bridge and
refuses (or with --wait polls every 300s) instead of over-admitting.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from swe_capacity import (admit, admission_lock, CapacityCancelled, limit,
                          snapshot, subagent_dir, subagent_entries,
                          POLL_SECONDS)


def entry_path(agent_id):
    safe = ''.join(c if c.isalnum() or c in '-_' else '_' for c in agent_id)
    return subagent_dir() / (safe + '.json')


def write_entry(agent_id, parent, title, host_pid):
    folder = subagent_dir()
    folder.mkdir(parents=True, exist_ok=True)
    now = time.time()
    entry = {'agent_id': agent_id, 'parent': parent, 'title': title,
             'host_pid': host_pid,
             'registered_at': now, 'heartbeat_at': now}
    path = entry_path(agent_id)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, path)
    return entry


def cmd_register(args):
    def start():
        entry = write_entry(args.agent, args.parent, args.title, args.host_pid)
        return {'admitted': True, 'entry': entry}
    if args.wait:
        def on_status(stage, info):
            print(json.dumps({'status': stage, 'active': info['active'],
                              'limit': info['limit']}, ensure_ascii=False),
                  file=sys.stderr, flush=True)
        try:
            result = admit(start, on_status=on_status)
        except CapacityCancelled:
            print(json.dumps({'admitted': False, 'reason': 'cancelled'}))
            return 3
        print(json.dumps(result, ensure_ascii=False))
        return 0
    with admission_lock():
        state = snapshot()
        state['limit'] = limit()
        if state['active'] >= state['limit']:
            state['admitted'] = False
            state['reason'] = 'capacity full; retry later or use --wait'
            print(json.dumps(state, ensure_ascii=False))
            return 2
        result = start()
        result['active_after'] = state['active'] + 1
        result['limit'] = state['limit']
        print(json.dumps(result, ensure_ascii=False))
        return 0


def cmd_heartbeat(args):
    path = entry_path(args.agent)
    try:
        entry = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        print(json.dumps({'ok': False, 'reason': 'not registered'}))
        return 1
    entry['heartbeat_at'] = time.time()
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, path)
    print(json.dumps({'ok': True, 'heartbeat_at': entry['heartbeat_at']}))
    return 0


def cmd_done(args):
    try:
        entry_path(args.agent).unlink()
    except FileNotFoundError:
        pass
    print(json.dumps({'ok': True}))
    return 0


def cmd_list(args):
    entries = subagent_entries()
    print(json.dumps({'subagents': [s for s in entries if s['counted']],
                      'ignored': [s for s in entries if not s['counted']],
                      'counted': sum(1 for s in entries if s['counted'])},
                     ensure_ascii=False))
    return 0


def cmd_sweep(args):
    # Removes only entries the snapshot already ignores (stale or dead host).
    removed = []
    for s in subagent_entries():
        if not s['counted']:
            try:
                entry_path(s['agent_id']).unlink()
                removed.append(s['agent_id'])
            except FileNotFoundError:
                pass
    print(json.dumps({'removed': removed}, ensure_ascii=False))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('register', help='admit + register a live subagent')
    p.add_argument('--agent', required=True, help='agent_id returned by run_subagent')
    p.add_argument('--parent', default=None, help='owning session id or actor name')
    p.add_argument('--title', default=None)
    p.add_argument('--host-pid', type=int, default=None,
                   help='pid of the devin.exe hosting the parent; entry auto-drops when it dies')
    p.add_argument('--wait', action='store_true',
                   help='poll capacity every 300s instead of failing when full')
    p.set_defaults(func=cmd_register)
    p = sub.add_parser('heartbeat', help='refresh a registered subagent')
    p.add_argument('--agent', required=True)
    p.set_defaults(func=cmd_heartbeat)
    p = sub.add_parser('done', help='deregister a finished subagent')
    p.add_argument('--agent', required=True)
    p.set_defaults(func=cmd_done)
    p = sub.add_parser('list', help='show counted and ignored registrations')
    p.set_defaults(func=cmd_list)
    p = sub.add_parser('sweep', help='delete stale/dead-host registrations')
    p.set_defaults(func=cmd_sweep)
    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    raise SystemExit(main())
