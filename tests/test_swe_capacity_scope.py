"""Offline checks for the SWE-only admission count; no local service is contacted."""
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'codex-skill/devin-session-collaboration/scripts/swe_capacity.py'
spec = importlib.util.spec_from_file_location('swe_capacity', SOURCE)
swe_capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swe_capacity)


class SweCapacityScopeTest(unittest.TestCase):
    def test_lite_page_counts_swe_and_unknown_only(self):
        page = {'sessions': [
            {'sessionId': 'swe', '_busy': True, '_model': 'swe-2-high'},
            {'sessionId': 'sonnet', '_busy': True, '_model': 'claude-sonnet-5.5'},
            {'sessionId': 'opus', '_busy': True, '_model': 'claude-opus-5.5'},
            {'sessionId': 'unknown', '_busy': True, '_model': None},
            {'sessionId': 'cursor:c1', '_busy': True, '_model': None},
            {'sessionId': 'idle', '_busy': False, '_model': 'swe-2-high'},
        ]}
        self.assertEqual(swe_capacity.lite_busy_sessions('http://fake', lambda _: page),
                         ['swe', 'unknown'])

    def test_explicit_other_cli_models_do_not_consume_swe_slots(self):
        def row(pid, command):
            return {'ProcessId': pid, 'ParentProcessId': 0, 'Name': 'devin.exe',
                    'CommandLine': command}
        state = swe_capacity.summarize([
            row(11, 'devin.exe --model swe-2-high --print'),
            row(12, 'devin.exe --model claude-sonnet-5.5 --print'),
            row(13, 'devin.exe --model claude-opus-5.5 --print'),
            row(14, 'devin.exe --print'),
        ])
        self.assertEqual(state['active'], 2)
        self.assertEqual(state['unknown_or_other'], 1)


if __name__ == '__main__':
    unittest.main()
