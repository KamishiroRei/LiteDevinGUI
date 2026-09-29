"""Reserve a SWE slot before a SWE run_subagent; release it when the child ends.

A run_subagent child has no separate process or session row. The launching
session must reserve its SWE slot here before invoking the tool so simultaneous
SWE creators cannot exceed the five-slot SWE limit. Other models do not reserve.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from swe_capacity import (admission_lock, limit, snapshot, subagent_dir,
                          subagent_entries)


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


def cmd_reserve(args):
    try:
        with admission_lock():
            state = snapshot()
            cap = limit()
            if state['active'] >= cap:
                print(json.dumps({'admitted': False, 'active': state['active'],
                                  'limit': cap, 'available': 0,
                                  'action': 'self_execute'}, ensure_ascii=False))
                return 2
            token = 'r_' + uuid.uuid4().hex[:16]
            entry = write_entry(token, args.parent, args.title, args.host_pid)
            print(json.dumps({'admitted': True, 'reservation_id': token,
                              'entry': entry, 'active_after': state['active'] + 1,
                              'limit': cap, 'available_after': cap - state['active'] - 1},
                             ensure_ascii=False))
            return 0
    except Exception as exc:
        print(json.dumps({'admitted': False, 'error': 'capacity_unavailable',
                          'detail': str(exc), 'action': 'self_execute'}, ensure_ascii=False))
        return 2


def cmd_register(args):
    with admission_lock():
        state = snapshot()
        state['limit'] = limit()
        if state['active'] >= state['limit']:
            state['admitted'] = False
            state['reason'] = 'capacity full; execute in the parent session'
            state['action'] = 'self_execute'
            print(json.dumps(state, ensure_ascii=False))
            return 2
        entry = write_entry(args.agent, args.parent, args.title, args.host_pid)
        result = {'admitted': True, 'entry': entry}
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
    p = sub.add_parser('reserve', help='reserve a slot before launching run_subagent')
    p.add_argument('--parent', required=True, help='owning session id or actor name')
    p.add_argument('--title', default=None)
    p.add_argument('--host-pid', type=int, default=None)
    p.set_defaults(func=cmd_reserve)
    p = sub.add_parser('register', help='legacy reconciliation for an already running child; do not use for new launches')
    p.add_argument('--agent', required=True, help='agent_id returned by run_subagent')
    p.add_argument('--parent', default=None, help='owning session id or actor name')
    p.add_argument('--title', default=None)
    p.add_argument('--host-pid', type=int, default=None,
                   help='pid of the devin.exe hosting the parent; entry auto-drops when it dies')
    p.set_defaults(func=cmd_register)
    p = sub.add_parser('heartbeat', help='refresh a registered subagent')
    p.add_argument('--agent', required=True, help='reservation_id from reserve')
    p.set_defaults(func=cmd_heartbeat)
    p = sub.add_parser('done', help='deregister a finished subagent')
    p.add_argument('--agent', required=True, help='reservation_id from reserve')
    p.set_defaults(func=cmd_done)
    p = sub.add_parser('list', help='show counted and ignored registrations')
    p.set_defaults(func=cmd_list)
    p = sub.add_parser('sweep', help='delete stale/dead-host registrations')
    p.set_defaults(func=cmd_sweep)
    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    raise SystemExit(main())
