"""Isolated bridge/Lite contract checks; no real Devin process is started."""
from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import devin_bridge as bridge
import swe_capacity


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
        kwargs["on_status"]("admitted", {"active": 0, "limit": 7})
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

    def test_archived_busy_session_counts_for_admission(self):
        seen = []

        def fetch(url):
            seen.append(url)
            return {"sessions": [{"sessionId": "archived-worker", "_busy": True, "_archived": True}]}

        self.assertEqual(swe_capacity.lite_busy_sessions("http://127.0.0.1:8317", fetch), ["archived-worker"])
        self.assertIn("includeArchived=1", seen[0])


if __name__ == "__main__":
    unittest.main()
