#!/usr/bin/env python3
"""Persistent, task-scoped collaboration for the native Devin CLI.

The bridge never owns Devin credentials.  One SQLite database represents one
collaboration task; each Devin participant has an independent runner process.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from swe_capacity import admit as admit_swe, CapacityCancelled


MODEL = "swe-2-high"
MODEL_FAMILY = "swe-2"
SCHEMA = 1
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CREATE_SUSPENDED = 0x00000004
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
HOST_PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH"
HOST_FRAME_LIMIT = 8 * 1024 * 1024
LITE_DEFAULT_URL = "http://127.0.0.1:8317"


class _IOCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_ulong),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_ulong),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_ulong),
                ("SchedulingClass", ctypes.c_ulong)]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BasicLimit),
                ("IoInfo", _IOCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


class OwnedJob:
    """Contain exactly one native CLI invocation and all inherited children."""

    def __init__(self):
        self.handle = None
        if os.name != "nt":
            return
        k = ctypes.windll.kernel32
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        k.CreateJobObjectW.restype = ctypes.c_void_p
        k.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                               ctypes.c_void_p, ctypes.c_ulong]
        k.SetInformationJobObject.restype = ctypes.c_int
        self.handle = k.CreateJobObjectW(None, None)
        if not self.handle:
            raise BridgeError(f"CreateJobObject failed: {ctypes.get_last_error()}")
        info = _ExtendedLimit()
        # The CLI/ACP tree stays owned by this job. A bridge-created peer runner
        # explicitly breaks away and then owns a separate job of its own.
        info.BasicLimitInformation.LimitFlags = 0x2000 | 0x0800
        if not k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            self.close()
            raise BridgeError(f"SetInformationJobObject failed: {ctypes.get_last_error()}")

    def assign_and_resume(self, proc: subprocess.Popen) -> None:
        if os.name != "nt":
            return
        k = ctypes.windll.kernel32
        k.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        k.AssignProcessToJobObject.restype = ctypes.c_int
        if not k.AssignProcessToJobObject(self.handle, int(proc._handle)):
            proc.kill()
            proc.wait()
            raise BridgeError(f"AssignProcessToJobObject failed: {ctypes.get_last_error()}")
        n = ctypes.windll.ntdll
        n.NtResumeProcess.argtypes = [ctypes.c_void_p]
        n.NtResumeProcess.restype = ctypes.c_long
        status = n.NtResumeProcess(int(proc._handle))
        if status != 0:
            self.terminate()
            proc.wait()
            raise BridgeError(f"NtResumeProcess failed: NTSTATUS {status:#x}")

    def terminate(self) -> None:
        if os.name == "nt" and self.handle:
            k = ctypes.windll.kernel32
            k.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            k.TerminateJobObject.restype = ctypes.c_int
            if not k.TerminateJobObject(self.handle, 1):
                raise BridgeError(f"TerminateJobObject failed: {ctypes.get_last_error()}")

    def close(self) -> None:
        if os.name == "nt" and self.handle:
            ctypes.windll.kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            ctypes.windll.kernel32.CloseHandle(self.handle)
            self.handle = None


class BridgeError(Exception):
    pass


class HostSubmissionUncertain(BridgeError):
    """The host call was written, but no conclusive response was received."""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def out(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def require_file(path: str) -> Path:
    p = Path(path).resolve(strict=True)
    if not p.is_file():
        raise BridgeError(f"Expected file: {p}")
    return p


def read_file(path: str) -> str:
    return require_file(path).read_text(encoding="utf-8-sig")


def state_dir(args: argparse.Namespace) -> Path:
    return Path(args.state).resolve()


def connect(state: Path) -> sqlite3.Connection:
    db = state / "bridge.sqlite3"
    if not db.is_file():
        raise BridgeError(f"Bridge is not initialized: {state}")
    con = sqlite3.connect(db, timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


@contextlib.contextmanager
def transaction(con: sqlite3.Connection):
    con.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        con.rollback()
        raise
    else:
        con.commit()


def row_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def actor(con: sqlite3.Connection, actor_id: str) -> sqlite3.Row:
    r = con.execute("SELECT * FROM actors WHERE id=?", (actor_id,)).fetchone()
    if r is None:
        raise BridgeError(f"Unknown participant: {actor_id}")
    return r


def message(con: sqlite3.Connection, msg_id: str) -> sqlite3.Row:
    r = con.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    if r is None:
        raise BridgeError(f"Unknown message: {msg_id}")
    return r


def init(args: argparse.Namespace) -> None:
    state = state_dir(args)
    if args.codex_thread:
        try:
            configured_thread = str(uuid.UUID(args.codex_thread))
        except ValueError as e:
            raise BridgeError(f"Codex thread must be an exact UUID: {e}") from e
    else:
        configured_thread = None
    if (state / "bridge.sqlite3").exists():
        raise BridgeError(f"Already initialized: {state}")
    state.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(state / "bridge.sqlite3", timeout=30, isolation_level=None)
    try:
        con.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE actors (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
          parent_id TEXT REFERENCES actors(id), cwd TEXT, initial_file TEXT,
          model TEXT, session_id TEXT UNIQUE, status TEXT NOT NULL,
          runner_token TEXT, runner_pid INTEGER, runner_birth REAL,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
        );
        CREATE TABLE turns (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
          kind TEXT NOT NULL, request_file TEXT NOT NULL, message_id TEXT,
          status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
          ended_at TEXT, prompt_path TEXT, export_path TEXT, stdout_path TEXT,
          stderr_path TEXT, cli_pid INTEGER, exit_code INTEGER, error TEXT,
          session_id TEXT, observed_model TEXT
        );
        CREATE INDEX turns_queue ON turns(actor_id,status,created_at);
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES actors(id),
          recipient_id TEXT NOT NULL REFERENCES actors(id), kind TEXT NOT NULL,
          body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
          offered_at TEXT, consumed_at TEXT, turn_id TEXT,
          report_id TEXT
        );
        CREATE INDEX messages_inbox ON messages(recipient_id,created_at);
        CREATE TABLE reports (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
          recipient_id TEXT NOT NULL REFERENCES actors(id), version INTEGER NOT NULL,
          summary TEXT NOT NULL, artifacts_json TEXT NOT NULL,
          created_at TEXT NOT NULL, status TEXT NOT NULL,
          UNIQUE(actor_id,version)
        );
        CREATE TABLE reviews (
          id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id),
          reviewer_id TEXT NOT NULL REFERENCES actors(id), decision TEXT NOT NULL,
          evidence TEXT NOT NULL, created_at TEXT NOT NULL,
          rework_message_id TEXT
        );
        CREATE TABLE wake_events (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id TEXT,
          ref_id TEXT, thread_id TEXT NOT NULL, message TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL,
          attempted_at TEXT, queued_at TEXT, submitted_at TEXT, received_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT
        );
        """)
        with transaction(con):
            t = now()
            con.execute("INSERT INTO meta VALUES (?,?)", ("schema", str(SCHEMA)))
            con.execute("INSERT INTO meta VALUES (?,?)", ("name", args.name))
            if configured_thread:
                con.execute("INSERT INTO meta VALUES (?,?)", ("codex_thread", configured_thread))
            con.execute("INSERT INTO actors(id,name,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                        (args.root, args.root, "external", "external", t, t))
    finally:
        con.close()
    out({"state": str(state), "root": args.root, "schema": SCHEMA})


def cli_command() -> list[str]:
    p = os.environ.get("DEVIN_BRIDGE_DEVIN") or shutil.which("devin")
    if not p:
        raise BridgeError("Native Devin CLI not found on PATH")
    path = Path(p).resolve()
    return [sys.executable, str(path)] if path.suffix.lower() == ".py" else [str(path)]


def cli_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("DEVIN_REFUSAL_FALLBACK", None)
    env.pop("DEVIN_MODEL", None)
    return env


def ensure_wake_schema(con: sqlite3.Connection) -> None:
    """Add direct-delivery metadata while preserving older queued events."""
    con.execute("""CREATE TABLE IF NOT EXISTS wake_events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id TEXT,
        ref_id TEXT, thread_id TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL,
        attempted_at TEXT, queued_at TEXT, submitted_at TEXT, received_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT)""")
    if "submitted_at" not in {r[1] for r in con.execute("PRAGMA table_info(wake_events)")}:
        try:
            con.execute("ALTER TABLE wake_events ADD COLUMN submitted_at TEXT")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise


def wake_thread(con: sqlite3.Connection) -> str | None:
    r = con.execute("SELECT value FROM meta WHERE key='codex_thread'").fetchone()
    return r[0] if r else None


def new_wake(con: sqlite3.Connection, state: Path, kind: str, actor_id: str | None,
             ref_id: str | None, content: str = "") -> str:
    thread = wake_thread(con)
    if not thread:
        raise BridgeError("Codex event route is not configured; use wake-config with an existing thread UUID")
    wid = uid("w")
    headline = {"completion": "Devin task completed", "blocked": "Devin task blocked",
                "message": "Devin collaboration message",
                "probe": "Devin bridge wake probe"}[kind]
    excerpt = content.strip()[:2000]
    if len(content.strip()) > len(excerpt):
        excerpt += "\n[Content truncated; read the bridge report/mailbox for the full text.]"
    body = (f"[{headline}] event={wid} actor={actor_id or '-'} ref={ref_id or '-'} "
            f"state={state}. Continue only the action this event requires."
            + (f"\n\n{excerpt}" if excerpt else ""))
    con.execute("""INSERT INTO wake_events(id,kind,actor_id,ref_id,thread_id,message,status,created_at)
                   VALUES (?,?,?,?,?,?,?,?)""", (wid, kind, actor_id, ref_id, thread, body,
                   "pending", now()))
    return wid


def read_host_frame(stream, *, submission_started: bool) -> dict:
    def exact(length: int) -> bytes:
        chunks = []
        while length:
            part = stream.read(length)
            if not part:
                raise EOFError("Codex host pipe closed before responding")
            chunks.append(part)
            length -= len(part)
        return b"".join(chunks)

    try:
        length = struct.unpack("<I", exact(4))[0]
        if length > HOST_FRAME_LIMIT:
            raise ValueError("Codex host response exceeds frame limit")
        response = json.loads(exact(length))
        if not isinstance(response, dict):
            raise ValueError("Codex host response is not an object")
        return response
    except (OSError, EOFError, ValueError, struct.error) as e:
        if submission_started:
            raise HostSubmissionUncertain(str(e)) from e
        raise BridgeError(str(e)) from e


def host_pipe_request(stream, request_id: int, method: str, params: dict,
                      *, submission: bool = False) -> object:
    payload = json.dumps({"id": request_id, "jsonrpc": "2.0", "method": method,
                          "params": params}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > HOST_FRAME_LIMIT:
        raise BridgeError("Codex host request exceeds frame limit")
    frame = memoryview(struct.pack("<I", len(payload)) + payload)
    try:
        while frame:
            written = stream.write(frame)
            if not written:
                raise OSError("Codex host pipe accepted no request bytes")
            frame = frame[written:]
    except OSError as e:
        if submission:
            raise HostSubmissionUncertain(str(e)) from e
        raise BridgeError(str(e)) from e
    response = read_host_frame(stream, submission_started=submission)
    if response.get("id") != request_id:
        error = f"Codex host response ID mismatch for {method}"
        if submission:
            raise HostSubmissionUncertain(error)
        raise BridgeError(error)
    if "error" in response:
        raise BridgeError(f"Codex host rejected {method}: {response['error']}")
    if "result" not in response:
        error = f"Codex host omitted result for {method}"
        if submission:
            raise HostSubmissionUncertain(error)
        raise BridgeError(error)
    return response["result"]


def send_event_to_codex_host(event: sqlite3.Row) -> None:
    pipe = os.environ.get(HOST_PIPE_ENV, "").strip()
    if not pipe:
        raise BridgeError(f"Codex host pipe is unavailable ({HOST_PIPE_ENV}); event remains pending")
    with open(pipe, "r+b", buffering=0) as stream:
        listing = host_pipe_request(stream, 1, "tools/list", {"threadStartKind": "all"})
        if not isinstance(listing, dict) or not isinstance(listing.get("tools"), list):
            raise BridgeError("Codex host returned an invalid tool catalog")
        tool = next((item for item in listing["tools"]
                     if isinstance(item, dict) and item.get("name") == "send_message_to_thread"
                     and item.get("namespace") == "codex_app"), None)
        if tool is None:
            raise BridgeError("Codex host does not expose codex_app/send_message_to_thread")
        result = host_pipe_request(stream, 2, "tools/call", {
            "arguments": {"threadId": event["thread_id"], "prompt": event["message"]},
            "callerSource": "codex",
            "callId": f"mcp-call-{event['id']}",
            "namespace": tool["namespace"],
            "threadId": event["thread_id"],
            "tool": tool["name"],
            "turnId": f"mcp-turn-{event['id']}",
        }, submission=True)
        if not isinstance(result, dict) or not isinstance(result.get("success"), bool):
            raise HostSubmissionUncertain("Codex host returned an invalid send result")
        if result["success"] is not True:
            raise BridgeError("Codex host did not accept send_message_to_thread")


def host_send(args: argparse.Namespace) -> None:
    try:
        con = connect(state_dir(args))
        ensure_wake_schema(con)
        event = con.execute("SELECT * FROM wake_events WHERE id=?", (args.event,)).fetchone()
        con.close()
        if event is None or event["status"] != "attempting":
            raise BridgeError("Host send requires one recorded attempting event")
        send_event_to_codex_host(event)
        out({"status": "accepted"})
    except HostSubmissionUncertain as e:
        out({"status": "uncertain", "error": str(e)[-800:]})
    except (BridgeError, OSError, sqlite3.Error) as e:
        out({"status": "rejected", "error": str(e)[-800:]})


def dispatch_wake(state: Path, event_id: str, allow_uncertain: bool = False) -> dict:
    with contextlib.closing(connect(state)) as con:
        ensure_wake_schema(con)
        with transaction(con):
            event = con.execute("SELECT * FROM wake_events WHERE id=?", (event_id,)).fetchone()
            if event is None:
                raise BridgeError(f"Unknown wake event: {event_id}")
            if event["status"] == "submitted":
                return {"event_id": event_id, "status": "host_accepted",
                        "submitted_at": event["submitted_at"]}
            if event["status"] == "queued":
                return {"event_id": event_id, "status": "legacy_queue_confirmed",
                        "queued_at": event["queued_at"]}
            if event["status"] == "received":
                return {"event_id": event_id, "status": "received",
                        "received_at": event["received_at"]}
            if event["status"] == "attempting" and not allow_uncertain:
                raise BridgeError("Prior host send outcome is uncertain; inspect the target chat before --allow-uncertain")
            if event["status"] not in ("pending", "attempting"):
                raise BridgeError(f"Cannot dispatch wake in status {event['status']}")
            con.execute("""UPDATE wake_events SET status='attempting',attempt_count=attempt_count+1,
                           attempted_at=?,error=NULL WHERE id=?""", (now(), event_id))
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--state", str(state),
             "__host_send", "--event", event_id],
            cwd=str(state), env=os.environ.copy(), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=25, creationflags=CREATE_NO_WINDOW)
        reply = json.loads(decode(result.stdout)) if result.returncode == 0 else None
        if not isinstance(reply, dict) or reply.get("status") not in ("accepted", "rejected", "uncertain"):
            outcome, error = "uncertain", f"Host sender did not return a valid result: {decode(result.stderr)[-800:]}"
        else:
            outcome, error = reply["status"], reply.get("error")
    except subprocess.TimeoutExpired as e:
        outcome, error = "uncertain", f"Host send timed out after {e.timeout}s"
    except (OSError, ValueError, json.JSONDecodeError) as e:
        outcome, error = "uncertain", str(e)
    con = connect(state)
    with transaction(con):
        if outcome == "rejected":
            con.execute("UPDATE wake_events SET status='pending',error=? WHERE id=?",
                        (error, event_id))
            status = "pending"
        elif outcome == "uncertain":
            con.execute("UPDATE wake_events SET error=? WHERE id=?", (error, event_id))
            status = "uncertain"
        else:
            con.execute("UPDATE wake_events SET status='submitted',submitted_at=?,error=NULL WHERE id=?",
                        (now(), event_id))
            status = "host_accepted"
    con.close()
    return {"event_id": event_id, "status": status, "error": error}


def run_capture(argv: list[str], cwd: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(argv, cwd=cwd, env=cli_env(), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, creationflags=CREATE_NO_WINDOW)


def validate_model(cli: list[str], cwd: str) -> None:
    result = run_capture(cli + ["models", "list", "--format", "json"], cwd)
    if result.returncode:
        raise BridgeError(f"Model catalog failed (exit {result.returncode}): {decode(result.stderr)[-500:]}")
    try:
        catalog = json.loads(result.stdout.decode("utf-8-sig"))
    except (UnicodeError, ValueError) as e:
        raise BridgeError(f"Cannot parse model catalog: {e}") from e
    families = [f for f in catalog.get("families", []) if f.get("family_uid") == MODEL_FAMILY]
    if len(families) != 1 or not any(v.get("model_uid") == MODEL for v in families[0].get("variants", [])):
        raise BridgeError(f"Exact model {MODEL_FAMILY}/{MODEL} is unavailable")


def decode(data: bytes) -> str:
    for codec in ("utf-8-sig", "gbk", "cp936", "latin-1"):
        try:
            return data.decode(codec)
        except UnicodeError:
            pass
    return data.decode("latin-1", errors="replace")


def proc_birth(pid: int) -> float | None:
    """Windows process creation time; protects observations from PID reuse."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return None
        except OSError:
            return None
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, ctypes.c_void_p]
    kernel.GetProcessTimes.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        created = ctypes.c_ulonglong()
        exited = ctypes.c_ulonglong()
        kernel_time = ctypes.c_ulonglong()
        user_time = ctypes.c_ulonglong()
        ok = kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                    ctypes.byref(kernel_time), ctypes.byref(user_time))
        if not ok:
            return None
        return (created.value - 116444736000000000) / 10000000
    finally:
        kernel.CloseHandle(handle)


def same_process(pid: int | None, birth: float | None) -> bool:
    if not pid or not birth:
        return False
    current = proc_birth(pid)
    return current is not None and abs(current - birth) < 0.05


def ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def bridge_instructions(state: Path, a: sqlite3.Row, wake_enabled: bool) -> str:
    p = ps_quote(sys.executable)
    script = ps_quote(str(Path(__file__).resolve()))
    st = ps_quote(str(state))
    aid = ps_quote(a["id"])
    base = f"& {p} {script} --state {st}"
    wake_instruction = (
        f"This task has an existing Codex chat event route. On your final completed report directly "
        f"to the external Codex participant, add --final once. On a true blocker, use "
        f"{base} block --from {aid} --to codex --body-file <UTF-8-blocker-file>. "
        f"For another actionable message requiring direct host submission to the original Codex chat, use "
        f"{base} send --from {aid} --to codex --body-file <UTF-8-file> --direct. "
        "Do not wake Codex for routine notes, partial reports, or child progress."
        if wake_enabled else
        "No Codex chat event route is configured. Reports and messages remain in the persistent mailbox."
    )
    return f"""Bridge collaboration context (persist this when planning work):
You are participant {a['id']} ({a['name']}); your organizer is {a['parent_id']}.
 Your session workspace is {a['cwd']}; task-specific file scope and write ownership come from the task below. The bridge state is {state}, not the session workspace.
Use this exact PowerShell command prefix: {base}
Discover peers: {base} participants
Read and mark your mailbox: {base} inbox --participant {aid} --read
Send a note: {base} send --from {aid} --to <participant-id> --body-file <UTF-8-file>
Send a request needing a new model turn: add --action to send; it queues for the recipient's original session.
 Create an independent SWE-2 High worker: {base} start --from {aid} --name <name> --cwd <stable-project-or-checkout-root> --prompt-file <UTF-8-task-file>. Keep per-task folders in the task file and bridge state; use a task folder as cwd only when it is truly its own project/checkout or the user wants a separate workspace.
When you need a peer's reply in this model turn, send a normal note and wait for that peer: {base} wait --self {aid} --actor <peer-id> --timeout 600; then mark the returned message read with inbox --read. Wait only when the reply is needed, not while independent work remains.
Report a finished result: {base} report --from {aid} --to <recipient-id> --summary-file <UTF-8-file> --artifact <path>
{wake_instruction}
Each command is independent; use quoted values for paths with spaces. An ordinary note sent to Codex is a persistent mailbox item that Codex reads separately. With the event route configured, final reports, true blockers, and explicitly marked actionable direct messages go to the original chat through the Codex host app tool. Host acceptance and actual chat receipt are distinct; a failed direct delivery stays recoverable and never falls back to codex queue. You may ask Codex for multimedia review there. Do not call another model through the Devin account to impersonate Codex.
Work autonomously to the specified effect. You may delegate, contact peers, and handle routine issues within the task authorization. Check your inbox at useful boundaries; running model turns are not interrupted by new messages.
"""


def make_actor(args: argparse.Namespace) -> None:
    state = state_dir(args)
    cwd = Path(args.cwd).resolve(strict=True)
    if not cwd.is_dir():
        raise BridgeError(f"Working directory is not a directory: {cwd}")
    prompt_file = require_file(args.prompt_file)
    con = connect(state)
    with transaction(con):
        actor(con, args.sender)
        aid, tid, t = uid("a"), uid("t"), now()
        con.execute("""INSERT INTO actors(id,name,kind,parent_id,cwd,initial_file,model,status,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (aid, args.name, "devin", args.sender, str(cwd), str(prompt_file), MODEL, "idle", t, t))
        con.execute("""INSERT INTO turns(id,actor_id,kind,request_file,status,created_at)
                       VALUES (?,?,?,?,?,?)""", (tid, aid, "initial", str(prompt_file), "queued", t))
    con.close()
    pid = spawn_runner(state, aid)
    out({"actor_id": aid, "turn_id": tid, "runner_pid": pid, "status": "queued", "model": MODEL})


def attach(args: argparse.Namespace) -> None:
    """Register an existing, independently created SWE-2 High session."""
    state = state_dir(args)
    cwd = Path(args.cwd).resolve(strict=True)
    if not cwd.is_dir():
        raise BridgeError(f"Working directory is not a directory: {cwd}")
    sid, observed = inspect_export(require_file(args.export), args.session_id)
    cli = cli_command()
    validate_model(cli, str(cwd))
    listed = run_capture(cli + ["list", "--format", "json"], str(cwd))
    if listed.returncode:
        raise BridgeError(f"Cannot list sessions in {cwd}: {decode(listed.stderr)[-500:]}")
    try:
        entries = json.loads(listed.stdout.decode("utf-8-sig"))
    except (UnicodeError, ValueError) as e:
        raise BridgeError(f"Cannot parse Devin session list: {e}") from e
    if not any(x.get("id") == sid for x in entries):
        raise BridgeError(f"Session {sid} is absent from Devin list in {cwd}")
    con = connect(state)
    with transaction(con):
        actor(con, args.sender)
        aid, t = uid("a"), now()
        con.execute("""INSERT INTO actors(id,name,kind,parent_id,cwd,initial_file,model,session_id,
                       status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (aid, args.name, "devin", args.sender, str(cwd), str(require_file(args.export)),
                     observed, sid, "held" if args.occupied else "idle", t, t))
    con.close()
    out({"actor_id": aid, "session_id": sid, "observed_model": observed,
         "state": "held" if args.occupied else "idle"})


def spawn_runner(state: Path, actor_id: str) -> int | None:
    con = connect(state)
    token = uid("runner")
    with transaction(con):
        a = actor(con, actor_id)
        if a["kind"] != "devin":
            raise BridgeError("External participant cannot run Devin")
        if a["runner_token"]:
            return None
        if not con.execute("SELECT 1 FROM turns WHERE actor_id=? AND status='queued'", (actor_id,)).fetchone():
            return None
        if a["status"] in ("failed", "interrupted", "cancelled", "held"):
            return None
        con.execute("""UPDATE actors SET runner_token=?,runner_pid=NULL,runner_birth=NULL,
                       status='launching',updated_at=? WHERE id=?""", (token, now(), actor_id))
    con.close()
    log_dir = state / "runners"
    log_dir.mkdir(exist_ok=True)
    stdout = open(log_dir / f"{actor_id}.out", "ab", buffering=0)
    stderr = open(log_dir / f"{actor_id}.err", "ab", buffering=0)
    try:
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--state", str(state),
                                 "__run", "--actor", actor_id, "--token", token],
                                cwd=str(state), env=os.environ.copy(), stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr,
                                creationflags=CREATE_NO_WINDOW |
                                (CREATE_BREAKAWAY_FROM_JOB if os.name == "nt" else 0))
    except BaseException as e:
        con = connect(state)
        with transaction(con):
            con.execute("UPDATE actors SET status='failed',runner_token=NULL,error=?,updated_at=? WHERE id=? AND runner_token=?",
                        (f"Could not start runner: {e}", now(), actor_id, token))
        con.close()
        raise
    finally:
        stdout.close()
        stderr.close()
    return proc.pid


def send(args: argparse.Namespace) -> None:
    body = read_file(args.body_file) if args.body_file else args.text
    if not body or not body.strip():
        raise BridgeError("Message body is empty")
    state = state_dir(args)
    con = connect(state)
    with transaction(con):
        actor(con, args.sender)
        dest = actor(con, args.recipient)
        if args.action and dest["kind"] != "devin":
            raise BridgeError("An external participant cannot receive a model action")
        if args.direct and args.action:
            raise BridgeError("A direct Codex message cannot also be a Devin model action")
        if args.direct and dest["kind"] != "external":
            raise BridgeError("Direct host messages require an external Codex recipient")
        if args.direct and not wake_thread(con):
            raise BridgeError("Use wake-config before sending a direct Codex message")
        mid, t = uid("m"), now()
        con.execute("""INSERT INTO messages(id,sender_id,recipient_id,kind,body,created_at)
                       VALUES (?,?,?,?,?,?)""", (mid, args.sender, args.recipient,
                       "action" if args.action else "note", body, t))
        tid = None
        if args.action:
            tid = uid("t")
            con.execute("""INSERT INTO turns(id,actor_id,kind,request_file,message_id,status,created_at)
                           VALUES (?,?,?,?,?,?,?)""", (tid, args.recipient, "message", "", mid, "queued", t))
            con.execute("UPDATE messages SET turn_id=? WHERE id=?", (tid, mid))
        wid = new_wake(con, state, "message", args.sender, mid, body) if args.direct else None
    con.close()
    pid = spawn_runner(state, args.recipient) if args.action else None
    wake = dispatch_wake(state, wid) if wid else None
    out({"message_id": mid, "state": "saved", "turn_id": tid,
         "runner_pid": pid, "wake": wake})


def enqueue_resume(args: argparse.Namespace) -> None:
    state = state_dir(args)
    path = require_file(args.prompt_file)
    con = connect(state)
    with transaction(con):
        a = actor(con, args.actor)
        if a["kind"] != "devin" or not a["session_id"]:
            raise BridgeError("Exact existing Devin session ID is required for resume")
        t, tid = now(), uid("t")
        con.execute("INSERT INTO turns(id,actor_id,kind,request_file,status,created_at) VALUES (?,?,?,?,?,?)",
                    (tid, args.actor, "resume", str(path), "queued", t))
        if a["status"] in ("failed", "cancelled", "interrupted"):
            con.execute("UPDATE actors SET status='idle',cancel_requested=0,error=NULL,updated_at=? WHERE id=?",
                        (t, args.actor))
    con.close()
    pid = spawn_runner(state, args.actor)
    out({"actor_id": args.actor, "turn_id": tid, "session_id": a["session_id"], "runner_pid": pid,
         "state": "queued"})


def inbox(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    with transaction(con):
        actor(con, args.participant)
        clauses = ["recipient_id=?"]
        params: list[str] = [args.participant]
        if args.id:
            clauses.append("id=?")
            params.append(args.id)
        elif not args.all:
            clauses.append("read_at IS NULL")
        rows = con.execute("SELECT * FROM messages WHERE " + " AND ".join(clauses) +
                           " ORDER BY created_at,id", params).fetchall()
        if args.read:
            t = now()
            for r in rows:
                con.execute("UPDATE messages SET read_at=COALESCE(read_at,?) WHERE id=?", (t, r["id"]))
            rows = [{**dict(r), "read_at": r["read_at"] or t} for r in rows]
    con.close()
    out({"messages": [dict(r) for r in rows]})


def participants(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    rows = con.execute("""SELECT id,name,kind,parent_id,cwd,model,session_id,status,created_at,updated_at,error
                          FROM actors ORDER BY created_at,id""").fetchall()
    con.close()
    out({"participants": [dict(r) for r in rows]})


def status(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    a = actor(con, args.actor)
    turns = con.execute("SELECT * FROM turns WHERE actor_id=? ORDER BY created_at,id", (args.actor,)).fetchall()
    reports = con.execute("SELECT * FROM reports WHERE actor_id=? ORDER BY version", (args.actor,)).fetchall()
    con.close()
    out({"actor": dict(a), "turns": [dict(r) for r in turns], "reports": [dict(r) for r in reports]})


def reports(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    actor(con, args.participant)
    rows = con.execute("SELECT * FROM reports WHERE recipient_id=? ORDER BY created_at,id",
                       (args.participant,)).fetchall()
    con.close()
    out({"reports": [dict(r) for r in rows]})


def report(args: argparse.Namespace) -> None:
    summary = read_file(args.summary_file)
    if not summary.strip():
        raise BridgeError("Report summary is empty")
    artifacts = [str(require_file(p)) for p in args.artifact]
    state = state_dir(args)
    con = connect(state)
    ensure_wake_schema(con)
    with transaction(con):
        actor(con, args.sender)
        recipient = actor(con, args.recipient)
        if args.final and recipient["kind"] != "external":
            raise BridgeError("A final Codex wake requires an external recipient")
        if args.final and not wake_thread(con):
            raise BridgeError("Use wake-config before submitting a final report")
        version = con.execute("SELECT COALESCE(MAX(version),0)+1 FROM reports WHERE actor_id=?",
                              (args.sender,)).fetchone()[0]
        rid, mid, t = uid("r"), uid("m"), now()
        con.execute("""INSERT INTO reports(id,actor_id,recipient_id,version,summary,artifacts_json,created_at,status)
                       VALUES (?,?,?,?,?,?,?,?)""", (rid, args.sender, args.recipient, version,
                       summary, json.dumps(artifacts, ensure_ascii=False), t, "submitted"))
        con.execute("""INSERT INTO messages(id,sender_id,recipient_id,kind,body,created_at,report_id)
                       VALUES (?,?,?,?,?,?,?)""", (mid, args.sender, args.recipient, "report",
                       f"Report {rid} version {version}:\n{summary}", t, rid))
        wid = new_wake(con, state, "completion", args.sender, rid, summary) if args.final else None
    con.close()
    wake = dispatch_wake(state, wid) if wid else None
    out({"report_id": rid, "version": version, "message_id": mid, "state": "submitted",
         "wake": wake})


def block(args: argparse.Namespace) -> None:
    body = read_file(args.body_file)
    if not body.strip():
        raise BridgeError("Blocker body is empty")
    state = state_dir(args)
    con = connect(state)
    ensure_wake_schema(con)
    with transaction(con):
        actor(con, args.sender)
        recipient = actor(con, args.recipient)
        if recipient["kind"] != "external":
            raise BridgeError("Blocker wake target must be an external participant")
        if not wake_thread(con):
            raise BridgeError("Use wake-config before reporting a blocking event")
        mid, t = uid("m"), now()
        con.execute("""INSERT INTO messages(id,sender_id,recipient_id,kind,body,created_at)
                       VALUES (?,?,?,?,?,?)""", (mid, args.sender, args.recipient,
                       "block", body, t))
        wid = new_wake(con, state, "blocked", args.sender, mid, body)
    con.close()
    out({"message_id": mid, "state": "saved", "wake": dispatch_wake(state, wid)})


def wake_config(args: argparse.Namespace) -> None:
    try:
        thread = str(uuid.UUID(args.thread))
    except ValueError as e:
        raise BridgeError(f"Codex thread must be an exact UUID: {e}") from e
    con = connect(state_dir(args))
    ensure_wake_schema(con)
    with transaction(con):
        con.execute("INSERT INTO meta(key,value) VALUES ('codex_thread',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (thread,))
    con.close()
    out({"codex_thread": thread, "state": "configured"})


def wake_status(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    ensure_wake_schema(con)
    rows = con.execute("SELECT * FROM wake_events ORDER BY created_at,id").fetchall()
    thread = wake_thread(con)
    con.close()
    out({"codex_thread": thread, "events": [dict(r) for r in rows]})


def wake_retry(args: argparse.Namespace) -> None:
    out(dispatch_wake(state_dir(args), args.event, args.allow_uncertain))


def wake_ack(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    ensure_wake_schema(con)
    with transaction(con):
        event = con.execute("SELECT * FROM wake_events WHERE id=?", (args.event,)).fetchone()
        if event is None:
            raise BridgeError(f"Unknown wake event: {args.event}")
        if event["status"] not in ("submitted", "queued", "received"):
            raise BridgeError("Only a host-accepted or legacy queue-confirmed event can be marked received")
        con.execute("UPDATE wake_events SET status='received',received_at=COALESCE(received_at,?) WHERE id=?",
                    (now(), args.event))
    con.close()
    out({"event_id": args.event, "status": "received", "thread_id": event["thread_id"]})


def wake_probe(args: argparse.Namespace) -> None:
    state = state_dir(args)
    con = connect(state)
    ensure_wake_schema(con)
    with transaction(con):
        wid = new_wake(con, state, "probe", None, args.label)
    con.close()
    out({"event_id": wid, "status": "pending", "purpose": "explicit existing-chat transport probe"})


def review(args: argparse.Namespace) -> None:
    evidence = read_file(args.evidence_file)
    if not evidence.strip():
        raise BridgeError("Review evidence is empty")
    state = state_dir(args)
    con = connect(state)
    with transaction(con):
        actor(con, args.reviewer)
        rep = con.execute("SELECT * FROM reports WHERE id=?", (args.report,)).fetchone()
        if rep is None:
            raise BridgeError(f"Unknown report: {args.report}")
        if rep["recipient_id"] != args.reviewer:
            raise BridgeError("Only the report recipient may review it")
        if rep["status"] != "submitted":
            raise BridgeError(f"Report already reviewed: {rep['status']}")
        rid, mid, t = uid("v"), None, now()
        if args.decision == "revise":
            dest = actor(con, rep["actor_id"])
            if dest["kind"] != "devin":
                raise BridgeError("Cannot queue rework for an external participant")
            mid, tid = uid("m"), uid("t")
            body = f"Rework report {rep['id']} version {rep['version']}. Review evidence and expected correction:\n{evidence}"
            con.execute("""INSERT INTO messages(id,sender_id,recipient_id,kind,body,created_at,turn_id,report_id)
                           VALUES (?,?,?,?,?,?,?,?)""", (mid, args.reviewer, rep["actor_id"],
                           "action", body, t, tid, rep["id"]))
            con.execute("""INSERT INTO turns(id,actor_id,kind,request_file,message_id,status,created_at)
                           VALUES (?,?,?,?,?,?,?)""", (tid, rep["actor_id"], "rework", "", mid, "queued", t))
        con.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?,?)",
                    (rid, rep["id"], args.reviewer, args.decision, evidence, t, mid))
        con.execute("UPDATE reports SET status=? WHERE id=?",
                    ("accepted" if args.decision == "accept" else "rework_requested", rep["id"]))
    con.close()
    pid = spawn_runner(state, rep["actor_id"]) if args.decision == "revise" else None
    out({"review_id": rid, "report_id": rep["id"], "decision": args.decision,
         "rework_message_id": mid, "runner_pid": pid})


def wait_event(args: argparse.Namespace) -> None:
    state = state_dir(args)
    limit = time.monotonic() + args.timeout
    while True:
        con = connect(state)
        actor(con, args.self_id)
        target = actor(con, args.actor)
        msgs = con.execute("""SELECT * FROM messages WHERE recipient_id=? AND sender_id=? AND read_at IS NULL
                              ORDER BY created_at,id""", (args.self_id, args.actor)).fetchall()
        reps = con.execute("SELECT * FROM reports WHERE actor_id=? AND recipient_id=? ORDER BY version DESC LIMIT 1",
                           (args.actor, args.self_id)).fetchall()
        con.close()
        new_report = reps and reps[0]["version"] > args.after_report_version
        if msgs or new_report or target["status"] in ("failed", "interrupted", "cancelled"):
            out({"actor": row_dict(target), "messages": [dict(m) for m in msgs],
                 "latest_report": row_dict(reps[0]) if reps else None})
            return
        if time.monotonic() >= limit:
            out({"timeout": True, "actor": row_dict(target),
                 "latest_report": row_dict(reps[0]) if reps else None})
            return
        time.sleep(min(1.0, limit - time.monotonic()))


def cancel(args: argparse.Namespace) -> None:
    con = connect(state_dir(args))
    with transaction(con):
        a = actor(con, args.actor)
        if a["kind"] != "devin":
            raise BridgeError("External participant has no bridge-owned process")
        if a["runner_token"]:
            con.execute("UPDATE actors SET cancel_requested=1,updated_at=? WHERE id=?", (now(), args.actor))
            state = "requested"
        else:
            con.execute("UPDATE actors SET status='cancelled',cancel_requested=1,updated_at=? WHERE id=?",
                        (now(), args.actor))
            state = "cancelled"
    con.close()
    out({"actor_id": args.actor, "cancellation": state,
         "note": "The owned runner terminates its own CLI child; this command never kills by process name."})


def activate(args: argparse.Namespace) -> None:
    """Release a held or interrupted participant after the caller checks it is idle."""
    state = state_dir(args)
    con = connect(state)
    with transaction(con):
        a = actor(con, args.actor)
        if a["kind"] != "devin" or not a["session_id"]:
            raise BridgeError("A verified existing session is required")
        if a["runner_token"]:
            raise BridgeError("Bridge runner already owns this participant")
        if a["status"] not in ("held", "failed", "interrupted", "cancelled", "idle"):
            raise BridgeError(f"Cannot activate status {a['status']}")
        con.execute("UPDATE actors SET status='idle',cancel_requested=0,error=NULL,updated_at=? WHERE id=?",
                    (now(), args.actor))
    con.close()
    pid = spawn_runner(state, args.actor)
    out({"actor_id": args.actor, "state": "idle" if pid is None else "launching",
         "runner_pid": pid})


def recover(args: argparse.Namespace) -> None:
    state = state_dir(args)
    con = connect(state)
    with transaction(con):
        a = actor(con, args.actor)
        if a["kind"] != "devin":
            raise BridgeError("External participant has no runner")
        if a["runner_token"] and same_process(a["runner_pid"], a["runner_birth"]):
            out({"actor_id": args.actor, "state": "runner_alive", "pid": a["runner_pid"]})
            return
        if a["runner_token"]:
            running = con.execute("SELECT * FROM turns WHERE actor_id=? AND status='running'",
                                  (args.actor,)).fetchall()
            restored = None
            for turn in running:
                if turn["export_path"] and Path(turn["export_path"]).is_file():
                    try:
                        exported_id, observed = inspect_export(Path(turn["export_path"]), a["session_id"])
                        if a["session_id"] is None:
                            restored = exported_id
                    except BridgeError:
                        pass
                con.execute("UPDATE turns SET status='interrupted',ended_at=?,error=? WHERE id=?",
                            (now(), "Runner ended before exit could be confirmed; inspect logs/export", turn["id"]))
            con.execute("""UPDATE actors SET status='interrupted',runner_token=NULL,runner_pid=NULL,
                           runner_birth=NULL,session_id=COALESCE(session_id,?),
                           error=?,updated_at=? WHERE id=?""",
                        (restored, "Runner lost; running turn outcome is unconfirmed", now(), args.actor))
            result = "interrupted"
        else:
            result = a["status"]
    con.close()
    out({"actor_id": args.actor, "state": result,
         "note": "An interrupted turn is never replayed automatically. Use exact-session resume after inspecting evidence."})


def inspect_export(path: Path, expected_id: str | None) -> tuple[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError) as e:
        raise BridgeError(f"Unreadable Devin export {path}: {e}") from e
    sid = data.get("session_id")
    if not isinstance(sid, str) or not sid:
        raise BridgeError(f"Export lacks session ID: {path}")
    if expected_id and sid != expected_id:
        raise BridgeError(f"Resume changed session ID: expected {expected_id}, got {sid}")
    models = [s.get("model_name") for s in data.get("steps", []) if s.get("model_name")]
    if not models or models[-1] != MODEL:
        raise BridgeError(f"Export final generated step was {models[-1] if models else '<none>'}, expected {MODEL}")
    return sid, models[-1]


def lite_base_url() -> str:
    """The collaboration bridge joins the already-running local Lite host."""
    base = os.environ.get("DEVIN_BRIDGE_LITE_URL", LITE_DEFAULT_URL).rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.path or parsed.query or parsed.fragment or not parsed.port):
        raise BridgeError("DEVIN_BRIDGE_LITE_URL must be a local HTTP host URL")
    return base


def lite_request(method: str, path: str, payload: dict | None = None, timeout: float = 35) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        lite_base_url() + path, data=body, method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", "replace")
        raise BridgeError(f"Devin Lite HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise BridgeError(f"Devin Lite unavailable or invalid response at {lite_base_url()}: {exc}") from exc
    if not isinstance(data, dict):
        raise BridgeError("Devin Lite returned a non-object response")
    return data


def run_lite_turn(state: Path, actor_id: str, token: str, turn_id: str,
                  a: sqlite3.Row, turn: sqlite3.Row) -> tuple[int, str, str | None]:
    """Run one bridge turn through Lite's single ACP owner, with no CLI peer."""
    prompt = Path(turn["prompt_path"]).read_text(encoding="utf-8")

    def capacity_cancelled() -> bool:
        check = connect(state)
        try:
            owner = actor(check, actor_id)
            return bool(owner["cancel_requested"] or owner["runner_token"] != token)
        finally:
            check.close()

    def capacity_status(stage: str, info: dict) -> None:
        details = dict(info, status=stage, checked_at=now())
        if stage == "waiting_capacity":
            details["next_check_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=300)).isoformat()
        (Path(turn["prompt_path"]).parent / "capacity.json").write_text(
            json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
        check = connect(state)
        try:
            with transaction(check):
                status = "waiting_capacity" if stage == "waiting_capacity" else "running"
                check.execute("UPDATE actors SET status=?,updated_at=? WHERE id=? AND runner_token=?",
                              (status, now(), actor_id, token))
                check.execute("UPDATE turns SET status=? WHERE id=?", (status, turn_id))
        finally:
            check.close()

    payload = {"cwd": a["cwd"], "text": prompt, "model": MODEL,
               "modeId": "bypass", "clientTurnId": turn_id}
    if a["session_id"]:
        payload["sessionId"] = a["session_id"]
    elif turn["kind"] != "initial":
        raise BridgeError("Missing exact session ID")

    # Admission and host registration occur under one cross-task lock. The
    # server must reserve the turn before returning so the next scan sees it.
    started = admit_swe(lambda: lite_request("POST", "/api/bridge/turn/start", payload),
                        cancelled=capacity_cancelled, on_status=capacity_status)
    sid, host_turn_id = started.get("sessionId"), started.get("turnId")
    if not isinstance(sid, str) or not sid or not isinstance(host_turn_id, str) or not host_turn_id:
        raise BridgeError(f"Devin Lite did not identify the started turn: {started}")
    if a["session_id"] and sid != a["session_id"]:
        raise BridgeError(f"Devin Lite changed session ID: expected {a['session_id']}, got {sid}")
    con = connect(state)
    try:
        with transaction(con):
            con.execute("UPDATE turns SET session_id=? WHERE id=?", (sid, turn_id))
            con.execute("UPDATE actors SET session_id=COALESCE(session_id,?),updated_at=? WHERE id=? AND runner_token=?",
                        (sid, now(), actor_id, token))
    finally:
        con.close()
    turn_dir = Path(turn["prompt_path"]).parent
    Path(turn["stderr_path"]).write_text("", encoding="utf-8")
    (turn_dir / "lite-turn.json").write_text(
        json.dumps({"hostTurnId": host_turn_id, "sessionId": sid,
                    "clientTurnId": turn_id, "started": started}, ensure_ascii=False, indent=2), encoding="utf-8")
    with open(turn["stdout_path"], "w", encoding="utf-8") as stdout:
        while True:
            if capacity_cancelled():
                # The host rejects session-wide cancellation when a GUI
                # interjection is sharing this session; it only drops this
                # turn's queued retry when deferred.
                try:
                    stopped = lite_request("POST", "/api/bridge/turn/cancel", {"turnId": host_turn_id})
                except BridgeError as exc:
                    raise BridgeError(f"Cannot safely cancel Lite turn {host_turn_id}; inspect Lite before recovery: {exc}") from exc
                if stopped.get("status") != "cancelled":
                    raise BridgeError(f"Lite did not confirm cancellation of {host_turn_id}: {stopped}")
                raise CapacityCancelled(f"Cancelled Lite turn {host_turn_id}")
            query = urllib.parse.urlencode({"turnId": host_turn_id, "waitMs": 20000})
            try:
                status = lite_request("GET", "/api/bridge/turn/status?" + query, timeout=30)
            except BridgeError as exc:
                raise BridgeError(f"Lite turn {host_turn_id} outcome uncertain; inspect the session before recovery: {exc}") from exc
            state_name = status.get("status") or status.get("state")
            if state_name not in ("running", "deferred", "done", "error", "cancelled"):
                raise BridgeError(f"Unexpected Devin Lite turn status: {status}")
            stdout.write(json.dumps(status, ensure_ascii=False) + "\n")
            stdout.flush()
            if state_name in ("running", "deferred"):
                continue
            if state_name == "cancelled":
                raise CapacityCancelled(f"Lite turn {host_turn_id} was cancelled")
            if state_name != "done":
                raise BridgeError(f"Devin Lite turn {host_turn_id} {state_name}: {status.get('error') or status}")
            if status.get("sessionId") not in (None, sid):
                raise BridgeError(f"Devin Lite completed a different session: {status.get('sessionId')}")
            selected_model = status.get("observedModel") or started.get("observedModel")
            if selected_model != MODEL:
                raise BridgeError(f"Devin Lite did not confirm model {MODEL}: {selected_model!r}")
            evidence = started.get("modelEvidence")
            if evidence not in ("session-config-option", "set-request"):
                raise BridgeError(f"Devin Lite did not state the model evidence level: {evidence!r}")
            export = {"source": "devin-lite-acp", "session_id": sid,
                      "host_turn_id": host_turn_id, "requested_model": MODEL,
                      "selected_model": selected_model, "model_evidence": evidence,
                      "final_status": status}
            Path(turn["export_path"]).write_text(
                json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8")
            # ACP configuration proves the selected model, while the old CLI
            # export's final generated step is unavailable on this path.
            return 0, sid, None


def runner(args: argparse.Namespace) -> None:
    try:
        runner_loop(args)
    except Exception as e:
        # A local setup failure must never strand the ownership token.
        state = state_dir(args)
        try:
            con = connect(state)
            with transaction(con):
                con.execute("""UPDATE actors SET status='failed',error=?,runner_token=NULL,
                               runner_pid=NULL,runner_birth=NULL,updated_at=?
                               WHERE id=? AND runner_token=?""",
                            (f"Runner failure: {e}", now(), args.actor, args.token))
            con.close()
        except (BridgeError, sqlite3.Error, OSError):
            pass
        raise


def runner_loop(args: argparse.Namespace) -> None:
    state = state_dir(args)
    con = connect(state)
    with transaction(con):
        a = actor(con, args.actor)
        if a["runner_token"] != args.token:
            raise BridgeError("Runner token no longer owns this participant")
        con.execute("UPDATE actors SET runner_pid=?,runner_birth=?,updated_at=? WHERE id=?",
                    (os.getpid(), proc_birth(os.getpid()), now(), args.actor))
    con.close()
    while True:
        con = connect(state)
        with transaction(con):
            a = actor(con, args.actor)
            if a["runner_token"] != args.token:
                raise BridgeError("Runner ownership changed")
            if a["cancel_requested"]:
                con.execute("""UPDATE actors SET status='cancelled',runner_token=NULL,runner_pid=NULL,
                               runner_birth=NULL,updated_at=? WHERE id=?""", (now(), args.actor))
                return
            turn = con.execute("""SELECT * FROM turns WHERE actor_id=? AND status='queued'
                                  ORDER BY created_at,id LIMIT 1""", (args.actor,)).fetchone()
            if turn is None:
                con.execute("""UPDATE actors SET status='idle',runner_token=NULL,runner_pid=NULL,
                               runner_birth=NULL,updated_at=? WHERE id=?""", (now(), args.actor))
                return
            if turn["kind"] != "initial" and not a["session_id"]:
                con.execute("UPDATE actors SET status='failed',error=?,runner_token=NULL,runner_pid=NULL,runner_birth=NULL,updated_at=? WHERE id=?",
                            ("No verified session ID for resume", now(), args.actor))
                return
            turn_dir = state / "turns" / turn["id"]
            turn_dir.mkdir(parents=True, exist_ok=True)
            prompt = turn_dir / "prompt.txt"
            export = turn_dir / "export.json"
            stdout = turn_dir / "stdout.txt"
            stderr = turn_dir / "stderr.txt"
            if turn["message_id"]:
                m = message(con, turn["message_id"])
                body = f"Incoming action message {m['id']} from {m['sender_id']}:\n{m['body']}"
                con.execute("UPDATE messages SET offered_at=COALESCE(offered_at,?) WHERE id=?",
                            (now(), m["id"]))
            else:
                body = read_file(turn["request_file"])
            prompt.write_text(bridge_instructions(state, a, bool(wake_thread(con))) +
                              "\nTask for this turn:\n" + body,
                              encoding="utf-8")
            con.execute("""UPDATE turns SET status='running',started_at=?,prompt_path=?,export_path=?,
                           stdout_path=?,stderr_path=? WHERE id=?""",
                        (now(), str(prompt), str(export), str(stdout), str(stderr), turn["id"]))
            con.execute("UPDATE actors SET status='running',updated_at=? WHERE id=?", (now(), args.actor))
        con.close()
        run_turn(state, args.actor, args.token, turn["id"])


def run_turn(state: Path, actor_id: str, token: str, turn_id: str) -> None:
    con = connect(state)
    a = actor(con, actor_id)
    turn = con.execute("SELECT * FROM turns WHERE id=?", (turn_id,)).fetchone()
    con.close()
    code = None
    sid = None
    observed = None
    failure = None
    cancelled = False
    try:
        transport = os.environ.get("DEVIN_BRIDGE_TRANSPORT", "lite").lower()
        if transport == "lite":
            code, sid, observed = run_lite_turn(state, actor_id, token, turn_id, a, turn)
        elif transport == "cli":
            cli = cli_command()
            validate_model(cli, a["cwd"])
            argv = cli + ["--model", MODEL, "--permission-mode", "dangerous",
                    "--respect-workspace-trust", "false"]
            if a["session_id"]:
                argv += ["--resume", a["session_id"]]
            elif turn["kind"] != "initial":
                raise BridgeError("Missing exact session ID")
            argv += ["--prompt-file", turn["prompt_path"], "--export", turn["export_path"], "--print"]
            job = OwnedJob()
            try:
                with open(turn["stdout_path"], "wb") as out_file, open(turn["stderr_path"], "wb") as err_file:
                    def capacity_cancelled():
                        check = connect(state)
                        try:
                            owner = actor(check, actor_id)
                            return bool(owner["cancel_requested"] or owner["runner_token"] != token)
                        finally:
                            check.close()

                    def capacity_status(stage, info):
                        details = dict(info, status=stage, checked_at=now())
                        if stage == "waiting_capacity":
                            details["next_check_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=300)).isoformat()
                        (Path(turn["prompt_path"]).parent / "capacity.json").write_text(
                            json.dumps(details, ensure_ascii=False, indent=2), encoding="utf-8")
                        check = connect(state)
                        try:
                            with transaction(check):
                                status = "waiting_capacity" if stage == "waiting_capacity" else "running"
                                check.execute("UPDATE actors SET status=?,updated_at=? WHERE id=? AND runner_token=?",
                                              (status, now(), actor_id, token))
                                check.execute("UPDATE turns SET status=? WHERE id=?", (status, turn_id))
                        finally:
                            check.close()

                    proc = admit_swe(
                        lambda: subprocess.Popen(argv, cwd=a["cwd"], env=cli_env(), stdin=subprocess.DEVNULL,
                                                 stdout=out_file, stderr=err_file,
                                                 creationflags=CREATE_NO_WINDOW | (CREATE_SUSPENDED if os.name == "nt" else 0)),
                        cancelled=capacity_cancelled, on_status=capacity_status)
                    job.assign_and_resume(proc)
                    con = connect(state)
                    with transaction(con):
                        con.execute("UPDATE turns SET cli_pid=? WHERE id=?", (proc.pid, turn_id))
                    con.close()
                    while True:
                        code = proc.poll()
                        if code is not None:
                            break
                        con = connect(state)
                        c = actor(con, actor_id)["cancel_requested"]
                        con.close()
                        if c:
                            cancelled = True
                            if os.name == "nt":
                                job.terminate()  # Exact invocation and its descendants, not global image names.
                            else:
                                proc.terminate()
                            try:
                                code = proc.wait(timeout=8)
                            except subprocess.TimeoutExpired:
                                proc.kill()
                                code = proc.wait(timeout=8)
                            break
                        time.sleep(0.5)
            finally:
                job.close()  # Also stops inherited children if runner fails or wrapper exits first.
            if Path(turn["export_path"]).is_file():
                sid, observed = inspect_export(Path(turn["export_path"]), a["session_id"])
            if not cancelled:
                if code != 0:
                    raise BridgeError(f"Devin exited {code}; inspect {turn['stderr_path']}")
                if not sid:
                    raise BridgeError(f"Devin exit 0 without a verified export: {turn['export_path']}")
        else:
            raise BridgeError("DEVIN_BRIDGE_TRANSPORT must be lite or cli")
    except CapacityCancelled:
        cancelled = True
    except BaseException as e:
        failure = str(e)
    con = connect(state)
    ensure_wake_schema(con)
    failure_wake_id = None
    with transaction(con):
        a = actor(con, actor_id)
        if a["runner_token"] != token:
            raise BridgeError("Runner lost ownership while finalizing")
        if transport == "lite":
            sid = sid or a["session_id"]
        state_name = "cancelled" if cancelled else "failed" if failure else "succeeded"
        con.execute("""UPDATE turns SET status=?,ended_at=?,exit_code=?,error=?,session_id=?,observed_model=?
                       WHERE id=?""", (state_name, now(), code, failure, sid, observed, turn_id))
        if sid and a["session_id"] is None:
            con.execute("UPDATE actors SET session_id=? WHERE id=?", (sid, actor_id))
        if state_name == "succeeded":
            if turn["message_id"]:
                con.execute("UPDATE messages SET consumed_at=COALESCE(consumed_at,?) WHERE id=?",
                            (now(), turn["message_id"]))
        else:
            con.execute("""UPDATE actors SET status=?,error=?,runner_token=NULL,runner_pid=NULL,
                           runner_birth=NULL,updated_at=? WHERE id=?""",
                        (state_name, failure, now(), actor_id))
            if failure and not cancelled and wake_thread(con):
                failure_wake_id = new_wake(
                    con, state, "blocked", actor_id, turn_id,
                    f"Devin turn failed: {turn_id}. {failure}\n"
                    "Read this turn's stderr and current artifacts before recovery. "
                    "Honor any rate-limit reset; resume only the verified existing session. "
                    "This runner has stopped and will not silently retry or change models.")
    con.close()
    if failure_wake_id:
        try:
            dispatch_wake(state, failure_wake_id)
        except Exception as notification_error:
            # The event and failed turn are already durable; transport failure must not erase them.
            print(f"Failure event {failure_wake_id} delivery error: {notification_error}", file=sys.stderr)
    if failure or cancelled:
        # Do not consume later queued turns after an uncertain CLI outcome.
        raise SystemExit(0)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state", required=True, help="Task-scoped persistent state directory")
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser("init", help="Create a collaboration task and external root participant")
    c.add_argument("--name", required=True)
    c.add_argument("--root", default="codex")
    c.add_argument("--codex-thread", help="Existing Codex chat UUID for direct messages and completion/block events")
    c.set_defaults(func=init)
    c = sub.add_parser("start", help="Asynchronously create and start a Devin participant")
    c.add_argument("--from", dest="sender", required=True)
    c.add_argument("--name", required=True)
    c.add_argument("--cwd", required=True, help="Stable project or checkout root shown as the Devin session workspace; not a per-task folder")
    c.add_argument("--prompt-file", required=True)
    c.set_defaults(func=make_actor)
    c = sub.add_parser("attach", help="Register a verified existing Devin session")
    c.add_argument("--from", dest="sender", required=True)
    c.add_argument("--name", required=True)
    c.add_argument("--cwd", required=True, help="Original cwd of the existing Devin session; do not change it to regroup history")
    c.add_argument("--session-id", required=True)
    c.add_argument("--export", required=True, help="Existing export proving exact session and model")
    c.add_argument("--occupied", action="store_true", help="Hold queued actions until activate")
    c.set_defaults(func=attach)
    c = sub.add_parser("send", help="Persist a note, queue a Devin action, or direct-message the original Codex chat")
    c.add_argument("--from", dest="sender", required=True)
    c.add_argument("--to", dest="recipient", required=True)
    g = c.add_mutually_exclusive_group(required=True)
    g.add_argument("--body-file")
    g.add_argument("--text")
    c.add_argument("--action", action="store_true")
    c.add_argument("--direct", action="store_true", help="Send an actionable note to the bound Codex chat through its host tool")
    c.set_defaults(func=send)
    c = sub.add_parser("resume", help="Queue a prompt for an exact verified session")
    c.add_argument("--actor", required=True)
    c.add_argument("--prompt-file", required=True)
    c.set_defaults(func=enqueue_resume)
    c = sub.add_parser("inbox", help="Read mailbox without triggering a model")
    c.add_argument("--participant", required=True)
    c.add_argument("--id")
    c.add_argument("--all", action="store_true")
    c.add_argument("--read", action="store_true", help="Mark selected messages as read")
    c.set_defaults(func=inbox)
    c = sub.add_parser("participants")
    c.set_defaults(func=participants)
    c = sub.add_parser("status")
    c.add_argument("--actor", required=True)
    c.set_defaults(func=status)
    c = sub.add_parser("reports")
    c.add_argument("--participant", required=True)
    c.set_defaults(func=reports)
    c = sub.add_parser("report")
    c.add_argument("--from", dest="sender", required=True)
    c.add_argument("--to", dest="recipient", required=True)
    c.add_argument("--summary-file", required=True)
    c.add_argument("--artifact", action="append", default=[])
    c.add_argument("--final", action="store_true", help="Send one completion event through the Codex host app tool")
    c.set_defaults(func=report)
    c = sub.add_parser("block", help="Persist a true blocker and send one Codex host event")
    c.add_argument("--from", dest="sender", required=True)
    c.add_argument("--to", dest="recipient", required=True)
    c.add_argument("--body-file", required=True)
    c.set_defaults(func=block)
    c = sub.add_parser("review")
    c.add_argument("--report", required=True)
    c.add_argument("--by", dest="reviewer", required=True)
    c.add_argument("--decision", choices=("accept", "revise"), required=True)
    c.add_argument("--evidence-file", required=True)
    c.set_defaults(func=review)
    c = sub.add_parser("wait", help="Wait for a peer's unread message or failure; no global slot is held")
    c.add_argument("--self", dest="self_id", required=True)
    c.add_argument("--actor", required=True)
    c.add_argument("--timeout", type=float, default=300)
    c.add_argument("--after-report-version", type=int, default=0)
    c.set_defaults(func=wait_event)
    c = sub.add_parser("cancel")
    c.add_argument("--actor", required=True)
    c.set_defaults(func=cancel)
    c = sub.add_parser("activate", help="Release a held or interrupted verified session")
    c.add_argument("--actor", required=True)
    c.set_defaults(func=activate)
    c = sub.add_parser("recover", help="Reconcile a dead runner without replaying uncertain work")
    c.add_argument("--actor", required=True)
    c.set_defaults(func=recover)
    c = sub.add_parser("wake-config", help="Bind this task to one existing Codex chat UUID")
    c.add_argument("--thread", required=True)
    c.set_defaults(func=wake_config)
    c = sub.add_parser("wake-status", help="Inspect submitted, pending, uncertain, and legacy queued events")
    c.set_defaults(func=wake_status)
    c = sub.add_parser("wake-retry", help="Dispatch a pending event through the Codex host app tool")
    c.add_argument("--event", required=True)
    c.add_argument("--allow-uncertain", action="store_true")
    c.set_defaults(func=wake_retry)
    c = sub.add_parser("wake-ack", help="Record that the original Codex chat actually received this marker")
    c.add_argument("--event", required=True)
    c.set_defaults(func=wake_ack)
    c = sub.add_parser("wake-probe", help="Prepare one explicitly marked, deferred transport probe")
    c.add_argument("--label", required=True)
    c.set_defaults(func=wake_probe)
    c = sub.add_parser("__run")
    c.add_argument("--actor", required=True)
    c.add_argument("--token", required=True)
    c.set_defaults(func=runner)
    c = sub.add_parser("__host_send")
    c.add_argument("--event", required=True)
    c.set_defaults(func=host_send)
    return p


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args()
    try:
        args.func(args)
    except (BridgeError, sqlite3.Error, OSError) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
