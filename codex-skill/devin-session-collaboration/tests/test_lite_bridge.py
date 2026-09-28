"""Isolated bridge/Lite contract checks; no real Devin process is started."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import devin_bridge as bridge
import swe_capacity
import swe_subagents


class LiteTurnTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state"
        with contextlib.redirect_stdout(io.StringIO()):
            bridge.init(argparse.Namespace(state=str(self.state), codex_thread=None,
                                            name="test", root="codex"))
        self.turn_dir = self.state / "turns" / "t-test"
        self.turn_dir.mkdir(parents=True)
        (self.turn_dir / "prompt.txt").write_text("检查 D:\\Game\\DNF\\国服115.pvf", encoding="utf-8")
        self.actor_id, self.token, self.turn_id = "a-test", "runner-test", "t-test"
        con = bridge.connect(self.state)
        try:
            t = bridge.now()
            con.execute("""INSERT INTO actors(id,name,kind,parent_id,cwd,model,status,runner_token,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (self.actor_id, "test", "devin", "codex", self.tmp.name,
                         bridge.MODEL, "running", self.token, t, t))
            con.execute("""INSERT INTO turns(id,actor_id,kind,request_file,status,created_at,
                           prompt_path,export_path,stdout_path,stderr_path)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (self.turn_id, self.actor_id, "initial", "task.txt", "running", t,
                         str(self.turn_dir / "prompt.txt"), str(self.turn_dir / "export.json"),
                         str(self.turn_dir / "stdout.txt"), str(self.turn_dir / "stderr.txt")))
            self.actor = bridge.actor(con, self.actor_id)
            self.turn = con.execute("SELECT * FROM turns WHERE id=?", (self.turn_id,)).fetchone()
        finally:
            con.close()

    @staticmethod
    def admitted(start, **kwargs):
        kwargs["on_status"]("admitted", {"active": 0, "limit": 10})
        return start()

    def test_turn_uses_one_host_and_preserves_path_prompt(self):
        calls = []
        statuses = iter([{"status": "running", "sessionId": "real-session"},
                         {"status": "deferred", "sessionId": "real-session", "retryAt": "later"},
                         {"status": "done", "sessionId": "real-session", "stopReason": "end_turn"}])

        def fake_request(method, path, payload=None, timeout=35):
            calls.append((method, path, payload))
            if path == "/api/bridge/turn/start":
                return {"sessionId": "real-session", "turnId": "bt-test", "observedModel": "swe-2-high",
                        "modelEvidence": "set-request", "busy": 1}
            return next(statuses)

        with patch.object(bridge, "admit_swe", self.admitted), patch.object(bridge, "lite_request", fake_request):
            code, sid, observed = bridge.run_lite_turn(
                self.state, self.actor_id, self.token, self.turn_id, self.actor, self.turn)
        self.assertEqual((code, sid, observed), (0, "real-session", None))
        self.assertEqual(calls[0][2]["cwd"], self.tmp.name)
        self.assertIn("D:\\Game\\DNF\\国服115.pvf", calls[0][2]["text"])
        self.assertEqual(calls[0][2]["clientTurnId"], self.turn_id)
        self.assertEqual(calls[0][2]["model"], "swe-2-high")
        self.assertEqual(calls[0][2]["modeId"], "bypass")
        self.assertEqual(len([c for c in calls if c[1] == "/api/bridge/turn/start"]), 1)
        saved = json.loads((self.turn_dir / "export.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["session_id"], sid)
        self.assertEqual(saved["model_evidence"], "set-request")
        self.assertNotIn("steps", saved)

    def test_cancel_addresses_only_its_host_turn(self):
        calls = []

        def fake_request(method, path, payload=None, timeout=35):
            calls.append((method, path, payload))
            if path == "/api/bridge/turn/start":
                return {"sessionId": "real-session", "turnId": "bt-test", "observedModel": "swe-2-high",
                        "modelEvidence": "set-request", "busy": 1}
            if path.startswith("/api/bridge/turn/status"):
                con = bridge.connect(self.state)
                con.execute("UPDATE actors SET cancel_requested=1 WHERE id=?", (self.actor_id,))
                con.close()
                return {"status": "running", "sessionId": "real-session"}
            return {"status": "cancelled", "turnId": "bt-test"}

        with patch.object(bridge, "admit_swe", self.admitted), patch.object(bridge, "lite_request", fake_request):
            with self.assertRaises(bridge.CapacityCancelled):
                bridge.run_lite_turn(self.state, self.actor_id, self.token, self.turn_id, self.actor, self.turn)
        self.assertEqual(calls[-1], ("POST", "/api/bridge/turn/cancel", {"turnId": "bt-test"}))

    def test_legacy_cli_transport_cannot_start_another_agent(self):
        with patch.dict(os.environ, {"DEVIN_BRIDGE_TRANSPORT": "cli"}):
            with patch.object(bridge.subprocess, "Popen") as spawn, patch.object(bridge, "run_lite_turn") as lite:
                with self.assertRaises(SystemExit):
                    bridge.run_turn(self.state, self.actor_id, self.token, self.turn_id)
        spawn.assert_not_called()
        lite.assert_not_called()
        con = bridge.connect(self.state)
        try:
            turn = con.execute("SELECT status,error FROM turns WHERE id=?", (self.turn_id,)).fetchone()
            self.assertEqual(turn["status"], "failed")
            self.assertIn("Only the Devin Lite host", turn["error"])
        finally:
            con.close()

    def test_legacy_cli_transport_is_rejected_before_registering_task(self):
        task = Path(self.tmp.name) / "task.txt"
        task.write_text("check", encoding="utf-8")
        with patch.dict(os.environ, {"DEVIN_BRIDGE_TRANSPORT": "cli"}):
            with patch.object(bridge.subprocess, "Popen") as spawn:
                with self.assertRaises(bridge.BridgeError):
                    bridge.make_actor(argparse.Namespace(state=str(self.state), sender="codex",
                                                         name="not-launched", cwd=self.tmp.name,
                                                         prompt_file=str(task)))
        spawn.assert_not_called()
        con = bridge.connect(self.state)
        try:
            self.assertEqual(con.execute("SELECT count(*) FROM actors WHERE kind='devin'").fetchone()[0], 1)
        finally:
            con.close()

    def test_archived_busy_session_counts_for_admission(self):
        seen = []

        def fetch(url):
            seen.append(url)
            return {"sessions": [{"sessionId": "archived-worker", "_busy": True, "_archived": True}]}

        self.assertEqual(swe_capacity.lite_busy_sessions("http://127.0.0.1:8317", fetch), ["archived-worker"])
        self.assertIn("includeArchived=1", seen[0])

    def test_start_reports_capacity_and_rejects_full_without_actor(self):
        task = Path(self.tmp.name) / "task.txt"
        task.write_text("check", encoding="utf-8")
        args = argparse.Namespace(state=str(self.state), sender="codex", name="capacity-test",
                                  cwd=self.tmp.name, prompt_file=str(task))
        with patch.object(bridge, "capacity_view", return_value={"active": 10, "limit": 10, "available": 0}):
            with self.assertRaises(bridge.BridgeCapacityFull) as caught:
                bridge.make_actor(args)
        self.assertEqual(caught.exception.action, "choose_codex_subagent")
        con = bridge.connect(self.state)
        try:
            self.assertEqual(con.execute("SELECT count(*) FROM actors WHERE kind='devin'").fetchone()[0], 1)
        finally:
            con.close()
        with patch.object(bridge, "capacity_view", return_value={"active": 9, "limit": 10, "available": 1}):
            with patch.object(bridge, "lite_request", return_value={"agentInfo": {"name": "affogato"}, "authed": False}), patch.object(bridge, "spawn_runner", return_value=123):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    bridge.make_actor(args)
        created = json.loads(output.getvalue())
        self.assertEqual(created["capacity_before"]["available"], 1)
        self.assertEqual(created["runner_pid"], 123)

    def test_fixed_ten_slot_limit(self):
        with patch.dict(os.environ, {"DEVIN_SWE_MAX_CONCURRENCY": "7"}):
            self.assertEqual(swe_capacity.limit(), 10)

    def test_start_does_not_register_when_lite_is_unavailable(self):
        task = Path(self.tmp.name) / "task.txt"
        task.write_text("check", encoding="utf-8")
        args = argparse.Namespace(state=str(self.state), sender="codex", name="offline",
                                  cwd=self.tmp.name, prompt_file=str(task))
        with patch.object(bridge, "capacity_view", return_value={"active": 0, "limit": 10, "available": 10}):
            with patch.object(bridge, "lite_request", side_effect=bridge.BridgeError("Lite unavailable")):
                with self.assertRaises(bridge.BridgeError):
                    bridge.make_actor(args)
        con = bridge.connect(self.state)
        try:
            self.assertEqual(con.execute("SELECT count(*) FROM actors WHERE kind='devin'").fetchone()[0], 1)
        finally:
            con.close()


class SubagentReservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_reserve_before_launch_and_release(self):
        args = argparse.Namespace(parent="parent-session", title="task", host_pid=None)
        with patch.dict(os.environ, {"LOCALAPPDATA": self.tmp.name}):
            with patch.object(swe_subagents, "snapshot", return_value={"active": 9}):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = swe_subagents.cmd_reserve(args)
            self.assertEqual(result, 0)
            admitted = json.loads(output.getvalue())
            self.assertEqual((admitted["active_after"], admitted["limit"], admitted["available_after"]),
                             (10, 10, 0))
            token = admitted["reservation_id"]
            self.assertTrue(swe_subagents.entry_path(token).is_file())
            with patch.object(swe_subagents, "snapshot", return_value={"active": 10}):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = swe_subagents.cmd_reserve(args)
            self.assertEqual(result, 2)
            self.assertEqual(json.loads(output.getvalue())["action"], "self_execute")
            with contextlib.redirect_stdout(io.StringIO()):
                swe_subagents.cmd_done(argparse.Namespace(agent=token))
            self.assertFalse(swe_subagents.entry_path(token).exists())


if __name__ == "__main__":
    unittest.main()
