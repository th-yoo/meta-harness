"""Tests for term-bench2/seam-gate/hook.py (plain unittest, no pytest).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'

Covers the four behaviors the Task-4 controller ruling calls out explicitly:
stop_hook_active short-circuit, budget exhaustion, reset-on-pass, and
fail-open on internal exception -- all exercised without a container or a
real validator subprocess (mocked out), per ruling #9. The container smoke
script (smoke-container.sh) covers the real subprocess + real validator +
real filesystem end-to-end path this file deliberately does not.
"""

import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock

# hook.py lives one directory up from this test file. unittest discover does
# not automatically put that directory on sys.path.
_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import hook  # noqa: E402


# --------------------------------------------------------------------------
# pre_check -- pure, no I/O
# --------------------------------------------------------------------------

class TestPreCheck(unittest.TestCase):
    def test_stop_hook_active_short_circuits_silently(self):
        action, code, notice = hook.pre_check({"stop_hook_active": True}, counter=0)
        self.assertEqual(action, "skip")
        self.assertEqual(code, 0)
        self.assertIsNone(notice)

    def test_stop_hook_active_wins_even_over_budget(self):
        # stop_hook_active must short-circuit before the budget check runs,
        # regardless of how exhausted the counter already is.
        action, code, notice = hook.pre_check({"stop_hook_active": True}, counter=99)
        self.assertEqual(action, "skip")
        self.assertEqual(code, 0)

    def test_budget_exhausted_allows_with_notice(self):
        action, code, notice = hook.pre_check({}, counter=2, budget=2)
        self.assertEqual(action, "skip")
        self.assertEqual(code, 0)
        self.assertIsNotNone(notice)
        self.assertIn("budget", notice.lower())

    def test_budget_exhausted_over_limit_also_allows(self):
        action, code, notice = hook.pre_check({}, counter=5, budget=2)
        self.assertEqual(action, "skip")
        self.assertEqual(code, 0)

    def test_under_budget_runs_validator(self):
        action, code, notice = hook.pre_check({}, counter=1, budget=2)
        self.assertEqual(action, "run")
        self.assertIsNone(code)
        self.assertIsNone(notice)

    def test_zero_counter_runs_validator(self):
        action, code, notice = hook.pre_check({}, counter=0, budget=2)
        self.assertEqual(action, "run")

    def test_falsy_stop_hook_active_does_not_short_circuit(self):
        action, code, notice = hook.pre_check({"stop_hook_active": False}, counter=0)
        self.assertEqual(action, "run")


# --------------------------------------------------------------------------
# post_validator_decision -- pure, no I/O
# --------------------------------------------------------------------------

class TestPostValidatorDecision(unittest.TestCase):
    def test_pass_resets_counter_and_allows(self):
        decision = hook.post_validator_decision(0, "SEAM s1 PASS ok\nSEAM s2 PASS ok\n", counter=1)
        self.assertEqual(decision["exit_code"], 0)
        self.assertEqual(decision["new_counter"], 0)
        self.assertIsNone(decision["stderr"])

    def test_pass_resets_counter_even_from_zero(self):
        decision = hook.post_validator_decision(0, "SEAM s1 PASS ok\n", counter=0)
        self.assertEqual(decision["new_counter"], 0)

    def test_fail_increments_counter_and_blocks(self):
        stdout = "SEAM s1 PASS ok\nSEAM s4 FAIL bad cluster count\n"
        decision = hook.post_validator_decision(1, stdout, counter=0)
        self.assertEqual(decision["exit_code"], 2)
        self.assertEqual(decision["new_counter"], 1)

    def test_fail_surfaces_only_fail_lines_with_seam_id(self):
        stdout = "SEAM s1 PASS ok\nSEAM s4 FAIL bad cluster count\nSEAM s5 FAIL low spread\n"
        decision = hook.post_validator_decision(1, stdout, counter=0)
        self.assertIn("s4", decision["stderr"])
        self.assertIn("s5", decision["stderr"])
        self.assertNotIn("SEAM s1 PASS", decision["stderr"])

    def test_fail_counter_accumulates(self):
        decision = hook.post_validator_decision(1, "SEAM s1 FAIL x\n", counter=1)
        self.assertEqual(decision["new_counter"], 2)

    def test_fail_with_unparseable_stdout_still_blocks(self):
        decision = hook.post_validator_decision(1, "garbage, no SEAM lines here", counter=0)
        self.assertEqual(decision["exit_code"], 2)
        self.assertEqual(decision["new_counter"], 1)
        self.assertTrue(decision["stderr"])


# --------------------------------------------------------------------------
# run() -- the I/O shell, with run_validator mocked out (no real subprocess)
# --------------------------------------------------------------------------

class TestRun(unittest.TestCase):
    def _state_path(self, tmpdir, initial=None):
        path = os.path.join(tmpdir, "state")
        if initial is not None:
            with open(path, "w") as f:
                f.write(str(initial))
        return path

    def test_reset_on_pass_writes_zero_to_state_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = self._state_path(tmp, initial=1)
            with mock.patch.object(hook, "run_validator", return_value=(0, "SEAM s1 PASS ok\n", "")):
                code = hook.run({}, state_path=state_path)
            self.assertEqual(code, 0)
            with open(state_path) as f:
                self.assertEqual(f.read().strip(), "0")

    def test_fail_writes_incremented_counter_to_state_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = self._state_path(tmp, initial=0)
            with mock.patch.object(hook, "run_validator", return_value=(1, "SEAM s4 FAIL bad\n", "")):
                code = hook.run({}, state_path=state_path)
            self.assertEqual(code, 2)
            with open(state_path) as f:
                self.assertEqual(f.read().strip(), "1")

    def test_missing_state_file_reads_as_zero_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "does-not-exist-yet")
            with mock.patch.object(hook, "run_validator", return_value=(1, "SEAM s1 FAIL bad\n", "")):
                code = hook.run({}, state_path=state_path)
            self.assertEqual(code, 2)  # not the budget-exhausted allow path
            with open(state_path) as f:
                self.assertEqual(f.read().strip(), "1")

    def test_budget_exhausted_skips_validator_entirely(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = self._state_path(tmp, initial=2)
            with mock.patch.object(hook, "run_validator") as mocked:
                code = hook.run({}, state_path=state_path)
            mocked.assert_not_called()
            self.assertEqual(code, 0)

    def test_stop_hook_active_skips_validator_and_state_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = self._state_path(tmp, initial=1)
            with mock.patch.object(hook, "run_validator") as mocked:
                code = hook.run({"stop_hook_active": True}, state_path=state_path)
            mocked.assert_not_called()
            self.assertEqual(code, 0)
            # counter must be left untouched (still "1"), not reset/written.
            with open(state_path) as f:
                self.assertEqual(f.read().strip(), "1")

    def test_validator_subprocess_error_propagates_out_of_run(self):
        # run() itself does NOT fail-open -- that's main()'s job. Verifies
        # the propagation contract main() relies on.
        with tempfile.TemporaryDirectory() as tmp:
            state_path = self._state_path(tmp, initial=0)
            with mock.patch.object(hook, "run_validator", side_effect=FileNotFoundError("no validator")):
                with self.assertRaises(FileNotFoundError):
                    hook.run({}, state_path=state_path)


# --------------------------------------------------------------------------
# main() -- the fail-open boundary
# --------------------------------------------------------------------------

class TestMainFailOpen(unittest.TestCase):
    def test_main_fails_open_on_unparseable_stdin(self):
        with mock.patch.object(sys, "stdin", io.StringIO("not valid json")):
            self.assertEqual(hook.main(), 0)

    def test_main_fails_open_on_empty_stdin(self):
        with mock.patch.object(sys, "stdin", io.StringIO("")):
            self.assertEqual(hook.main(), 0)

    def test_main_fails_open_on_internal_exception_in_run(self):
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({}))), \
                mock.patch.object(hook, "run", side_effect=RuntimeError("boom")):
            self.assertEqual(hook.main(), 0)

    def test_main_fails_open_when_validator_subprocess_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state")
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({}))), \
                    mock.patch.object(hook, "STATE_PATH", state_path), \
                    mock.patch.object(hook, "run_validator", side_effect=FileNotFoundError("no validator")):
                self.assertEqual(hook.main(), 0)

    def test_main_fails_open_when_validator_times_out(self):
        import subprocess as _subprocess
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state")
            timeout_exc = _subprocess.TimeoutExpired(cmd=["python3", "validator.py"], timeout=60)
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({}))), \
                    mock.patch.object(hook, "STATE_PATH", state_path), \
                    mock.patch.object(hook, "run_validator", side_effect=timeout_exc):
                self.assertEqual(hook.main(), 0)

    def test_main_happy_path_pass_returns_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state")
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({}))), \
                    mock.patch.object(hook, "STATE_PATH", state_path), \
                    mock.patch.object(hook, "run_validator", return_value=(0, "SEAM s1 PASS ok\n", "")):
                self.assertEqual(hook.main(), 0)

    def test_main_happy_path_fail_returns_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state")
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({}))), \
                    mock.patch.object(hook, "STATE_PATH", state_path), \
                    mock.patch.object(hook, "run_validator", return_value=(1, "SEAM s4 FAIL bad\n", "")):
                self.assertEqual(hook.main(), 2)


if __name__ == "__main__":
    unittest.main()
