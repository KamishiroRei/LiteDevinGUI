"""Machine-wide SWE admission: five concurrent SWE turns, retry every 300s."""
from __future__ import annotations
import contextlib
import ctypes
import json
import os
import re
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.parse

POLL_SECONDS = 300
MAX_CONCURRENCY = 5

def is_swe_model(model):
    return isinstance(model, str) and bool(re.search(r'(^|[^a-z])swe(?:[-_\s\d]|$)', model.lower()))
# A registered subagent that stops heartbeating is treated as leaked residue:
# it stops counting after this TTL but stays on disk for `swe_subagents.py sweep`.
SUBAGENT_TTL_SECONDS = int(os.environ.get('DEVIN_SWE_SUBAGENT_TTL', '21600'))  # 6h

class CapacityCancelled(Exception):
    pass

def limit():
    return MAX_CONCURRENCY

def subagent_dir():
    return Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'CodexDevinBridge' / 'subagents'

def pid_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    kernel.CloseHandle(handle)
    return True

def subagent_entries(now=None):
    """Self-reported live subagents; they spawn no process/session row of their
    own, so only the launcher's registration makes them visible. Unreadable
    entries still count — never assume zero."""
    if now is None:
        now = time.time()
    folder = subagent_dir()
    found = []
    try:
        paths = sorted(folder.glob('*.json'))
    except OSError:
        return found
    for path in paths:
        try:
            entry = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(entry, dict):
                raise ValueError('not an object')
        except (OSError, ValueError):
            found.append({'agent_id': path.stem, 'counted': True, 'reason': 'unreadable'})
            continue
        host_pid = entry.get('host_pid')
        if host_pid and not pid_alive(host_pid):
            found.append({'agent_id': entry.get('agent_id') or path.stem,
                          'parent': entry.get('parent'), 'counted': False,
                          'reason': 'host dead'})
            continue
        heartbeat = entry.get('heartbeat_at') or entry.get('registered_at') or 0
        fresh = now - heartbeat <= SUBAGENT_TTL_SECONDS
        found.append({'agent_id': entry.get('agent_id') or path.stem,
                      'parent': entry.get('parent'), 'title': entry.get('title'),
                      'heartbeat_at': heartbeat,
                      'counted': fresh, 'reason': 'live' if fresh else 'stale'})
    return found

def command_args(command):
    if not command:
        return []
    if os.name != 'nt':
        import shlex
        return shlex.split(command)
    argc = ctypes.c_int()
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    ptr = shell.CommandLineToArgvW(command, ctypes.byref(argc))
    if not ptr:
        raise OSError(ctypes.get_last_error(), 'CommandLineToArgvW')
    try:
        return [ptr[i] for i in range(argc.value)]
    finally:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(ptr, ctypes.c_void_p))

def lite_busy_sessions(base_url, fetch=None):
    """Read every page of the already-running local host, never start a model."""
    if fetch is None:
        def fetch(url):
            # Local-only requests must not inherit HTTP_PROXY.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=5) as response:
                return json.load(response)
    cursor, seen_cursors, found = None, set(), {}
    for _ in range(1000):
        params = {'includeArchived': '1'}
        if cursor:
            params['cursor'] = cursor
        url = base_url + '/api/sessions?' + urllib.parse.urlencode(params)
        page = fetch(url)
        if not isinstance(page, dict) or not isinstance(page.get('sessions'), list):
            raise RuntimeError('Invalid Devin Lite session page')
        for session in page['sessions']:
            sid = session.get('sessionId')
            if not isinstance(sid, str) or not isinstance(session.get('_busy'), bool):
                raise RuntimeError('Missing session identity/activity from Devin Lite')
            # Cursor uses this same GUI but has a separate account and ACP.
            if sid.startswith('cursor:'):
                continue
            model = session.get('_model')
            # An explicit non-SWE model never consumes a SWE slot. Unknown
            # model identity stays conservative for SWE admission only.
            possible_swe = session.get('_sweBusy') is True or model is None or is_swe_model(model)
            found[sid] = found.get(sid, False) or (session['_busy'] and possible_swe)
        cursor = page.get('nextCursor')
        if not cursor:
            return sorted(sid for sid, busy in found.items() if busy)
        if not isinstance(cursor, str) or cursor in seen_cursors:
            raise RuntimeError('Devin Lite session pagination did not finish')
        seen_cursors.add(cursor)
    raise RuntimeError('Devin Lite session pagination exceeded safety bound')

def summarize(rows, read_lite=lite_busy_sessions):
    by_pid = {int(r['ProcessId']): r for r in rows}
    devin = {pid: r for pid, r in by_pid.items()
             if r.get('Name', 'devin.exe').lower() == 'devin.exe'}
    roots = []
    for pid, row in devin.items():
        parent_pid = int(row.get('ParentProcessId') or 0)
        if parent_pid in devin:
            continue  # A CLI frontend plus its ACP child is one invocation.
        args = command_args(row.get('CommandLine') or '')[1:]
        if args and args[0] in ('list', 'ls', 'models', 'auth', 'rm', 'export', '--help', '-h', '--version'):
            continue
        if args and args[0] == 'acp':
            parent = by_pid.get(parent_pid, {})
            parent_args = command_args(parent.get('CommandLine') or '')
            known_lite = any('/devin-lite/server.mjs' in v.replace('\\', '/').lower() for v in parent_args)
            ports = parent.get('ListenPorts') or []
            if isinstance(ports, int):
                ports = [ports]
            if not known_lite or len(ports) != 1:
                raise RuntimeError('Cannot enumerate sessions of standalone ACP PID ' + str(pid))
            base = 'http://127.0.0.1:' + str(int(ports[0]))
            try:
                busy = read_lite(base)
            except Exception as exc:
                raise RuntimeError('Cannot determine ACP session capacity: ' + str(exc)) from exc
            for sid in busy:
                roots.append({'pid': pid, 'parent_pid': parent_pid, 'session_id': sid,
                              'model': None, 'classification': 'host_busy_session'})
            continue
        model = args[args.index('--model') + 1] if '--model' in args and args.index('--model') + 1 < len(args) else None
        if model is not None and not is_swe_model(model):
            continue
        roots.append({'pid': pid, 'parent_pid': parent_pid, 'model': model,
                      'classification': 'swe' if is_swe_model(model) else 'unknown_possible_swe'})
    return {'active': len(roots), 'sessions': roots,
            'unknown_or_other': sum(r['classification'] != 'swe' for r in roots)}

def snapshot():
    if os.name != 'nt':
        raise RuntimeError('Live capacity discovery is currently implemented for Windows only')
    cmd = ('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); '
           "$ErrorActionPreference='Stop'; "
           "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='devin.exe' OR Name='node.exe'\"); "
           "$owners=@($rows | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'devin-lite[\\\\/]server.mjs' }); "
           "$ports=@(); if($owners.Count){$ports=@(Get-NetTCPConnection -State Listen)}; "
           "@($rows | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='ListenPorts';Expression={ "
           "$pidValue=$_.ProcessId; @($ports | Where-Object OwningProcess -eq $pidValue | Select-Object -ExpandProperty LocalPort -Unique) "
           '}}) | ConvertTo-Json -Compress -Depth 4')
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', cmd],
                            capture_output=True, timeout=30,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError('Cannot determine current Devin capacity: ' + result.stderr.decode('utf-8', 'replace')[-600:])
    raw = result.stdout.decode('utf-8-sig').strip()
    rows = json.loads(raw) if raw else []
    if isinstance(rows, dict):
        rows = [rows]
    state = summarize(rows)
    subs = subagent_entries()
    state['subagents'] = [s for s in subs if s['counted']]
    state['subagents_ignored'] = [s for s in subs if not s['counted']]
    state['active'] += len(state['subagents'])
    return state

@contextlib.contextmanager
def admission_lock(cancelled=lambda: False):
    # All task databases use the same short-lived lock; no slot is held while waiting.
    folder = Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'CodexDevinBridge'
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder/'swe-admission.lock', 'a+b') as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        while True:
            if cancelled():
                raise CapacityCancelled('Cancelled before capacity admission')
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (OSError, BlockingIOError):
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)

def admit(start, cancelled=lambda: False, on_status=lambda *_: None,
          scan=snapshot, clock=time.monotonic, sleep=time.sleep, ceiling=None):
    cap = limit() if ceiling is None else ceiling
    if not 1 <= cap <= MAX_CONCURRENCY:
        raise ValueError('Capacity must be in 1..5')
    while True:
        if cancelled():
            raise CapacityCancelled('Cancelled while waiting for capacity')
        with admission_lock(cancelled):
            state = scan()  # failure is never treated as zero active sessions
            state['limit'] = cap
            state['poll_seconds'] = POLL_SECONDS
            if state['active'] < cap:
                on_status('admitted', state)
                # Popen completes before releasing this cross-task lock, so the
                # next admission sees the child, even if it is still suspended.
                return start()
            on_status('waiting_capacity', state)
        until = clock() + POLL_SECONDS
        while clock() < until:
            if cancelled():
                raise CapacityCancelled('Cancelled while waiting for capacity')
            sleep(min(1.0, until - clock()))

if __name__ == '__main__':
    state = snapshot()
    cap = limit()
    state.update(limit=cap, available=max(0, cap - state['active']), poll_seconds=POLL_SECONDS)
    print(json.dumps(state, ensure_ascii=False))
