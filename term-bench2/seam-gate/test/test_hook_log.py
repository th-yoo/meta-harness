"""Hook-log instrumentation tests (fix: seam-validation evidence capture).

The log is OBSERVATION ONLY: these tests pin (a) that both the skip path
and the decision path append a parseable NDJSON line with the fields the
autopsy needs, and (b) that a broken log path can never change a gate
decision (the sensor law).
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import hook  # noqa: E402


class TestHookLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state")
        self.log = os.path.join(self.tmp.name, "hook-log.ndjson")

    def tearDown(self):
        self.tmp.cleanup()

    def read_log(self):
        with open(self.log) as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_decision_path_appends_parseable_entry(self):
        with mock.patch.object(hook, "LOG_PATH", self.log), \
             mock.patch.object(hook, "STATE_PATH", self.state), \
             mock.patch.object(hook, "run_validator",
                               return_value=(1, "SEAM s1 FAIL detail\nSEAM s2 PASS ok\n", "")):
            code = hook.run({"stop_hook_active": False})
        self.assertEqual(code, 2)
        entries = self.read_log()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["phase"], "decision")
        self.assertEqual(e["validator_exit"], 1)
        self.assertEqual(e["counter_before"], 0)
        self.assertEqual(e["counter_after"], 1)
        self.assertEqual(e["exit_code"], 2)
        self.assertIn("SEAM s1 FAIL detail", e["seam_lines"])
        self.assertIsInstance(e["ts"], int)

    def test_skip_path_appends_entry(self):
        with mock.patch.object(hook, "LOG_PATH", self.log), \
             mock.patch.object(hook, "STATE_PATH", self.state):
            code = hook.run({"stop_hook_active": True})
        self.assertEqual(code, 0)
        entries = self.read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["phase"], "pre_check")
        self.assertEqual(entries[0]["action"], "skip")

    def test_pass_then_fail_accumulates_lines(self):
        with mock.patch.object(hook, "LOG_PATH", self.log), \
             mock.patch.object(hook, "STATE_PATH", self.state):
            with mock.patch.object(hook, "run_validator",
                                   return_value=(0, "SEAM s1 PASS ok\n", "")):
                self.assertEqual(hook.run({"stop_hook_active": False}), 0)
            with mock.patch.object(hook, "run_validator",
                                   return_value=(1, "SEAM s1 FAIL detail\n", "")):
                self.assertEqual(hook.run({"stop_hook_active": False}), 2)
        entries = self.read_log()
        self.assertEqual([e["validator_exit"] for e in entries], [0, 1])
        self.assertEqual([e["exit_code"] for e in entries], [0, 2])

    def test_unwritable_log_never_changes_decision(self):
        bad = os.path.join(self.tmp.name, "no-such-dir", "log.ndjson")
        with mock.patch.object(hook, "LOG_PATH", bad), \
             mock.patch.object(hook, "STATE_PATH", self.state), \
             mock.patch.object(hook, "run_validator",
                               return_value=(1, "SEAM s1 FAIL detail\n", "")):
            code = hook.run({"stop_hook_active": False})
        self.assertEqual(code, 2)  # decision identical despite dead log

    def test_seam_lines_capped_at_40(self):
        stdout = "".join(f"SEAM s{i} FAIL x\n" for i in range(100))
        with mock.patch.object(hook, "LOG_PATH", self.log), \
             mock.patch.object(hook, "STATE_PATH", self.state), \
             mock.patch.object(hook, "run_validator", return_value=(1, stdout, "")):
            hook.run({"stop_hook_active": False})
        self.assertEqual(len(self.read_log()[0]["seam_lines"]), 40)


if __name__ == "__main__":
    unittest.main()
