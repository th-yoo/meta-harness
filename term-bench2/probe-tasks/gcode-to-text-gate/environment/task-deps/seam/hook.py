#!/usr/bin/env python3
# GENERATED COPY — source of truth: term-bench2/seam-gate/ — edit there and re-run sync-task-copies.sh
"""Seam-gate Claude Code Stop hook (Task 4).

Wires the seam-gate validator (validator.py) into Claude Code's Stop hook
contract: reads the hook payload from stdin as JSON, runs the validator
against the staged spec, and blocks the stop (exit 2, with the failing
seams' `SEAM <id> FAIL ...` lines on stderr -- stderr reaches the model per
the Stop-hook contract) up to a fixed block budget. Once the budget is
exhausted it allows the stop unconditionally (with a one-line notice on
stdout) so a stuck gate can never wedge a session forever.

Deployment: staged at /app/.seam/hook.py by the task's environment/Dockerfile
(COPY task-deps/seam/ /app/.seam/), invoked by .claude/settings.json's Stop
hook as `python3 /app/.seam/hook.py`.

Fail-open contract (this file's own, layered on top of validator.py's --
see that module's docstring for the rationale this mirrors): a broken hook
must never be indistinguishable from an unresponsive session. `main()`'s
single top-level try/except forces exit 0 on ANY internal exception here --
unparseable/empty stdin, a state-file directory that doesn't exist, a
validator subprocess that can't be spawned, times out, or raises for any
other reason. None of that is allowed to escape as a hook crash that blocks
the agent from ever stopping.

Decision core (`pre_check` / `post_validator_decision`) is pure -- no I/O,
no subprocess, no stdin/stdout/stderr -- so test_hook.py can exercise the
required behaviors (stop_hook_active short-circuit, budget exhaustion,
reset-on-pass, fail-open on exception) without a container or a real
validator subprocess. `run()` is the thin I/O shell around them.
"""

import json
import subprocess
import sys

STATE_PATH = "/app/.seam/state"
SPEC_PATH = "/app/.seam/spec.json"
VALIDATOR_PATH = "/app/.seam/validator.py"
ROOT = "/app"
# Task 7 item 4: the task's own input file, passed to validator.py's
# --source so any source_crosscheck seam can cross-check artifact rows
# against it. Staged by the task's environment/Dockerfile (COPY
# text.gcode.gz + gunzip -> /app/text.gcode) -- this path is unchanged by
# Task 7 (paths this hook already used, like SPEC_PATH/VALIDATOR_PATH/ROOT
# above, are untouched; this is a new constant, not a migration).
SOURCE_PATH = "/app/text.gcode"
BUDGET = 2
VALIDATOR_TIMEOUT_SEC = 60


# --------------------------------------------------------------------------
# Pure decision core -- no I/O in either function below.
# --------------------------------------------------------------------------

def pre_check(payload, counter, budget=BUDGET):
    """Decide, before touching the validator, whether to even run it.

    Returns a 3-tuple (action, exit_code, notice):
      ("skip", 0, None)                -- stop_hook_active guard (silent)
      ("skip", 0, "<budget notice>\\n") -- block budget exhausted, allow
      ("run", None, None)              -- under budget, go run the validator
    """
    if payload.get("stop_hook_active"):
        return ("skip", 0, None)
    if counter >= budget:
        return (
            "skip",
            0,
            f"[seam-gate] block budget exhausted ({counter}/{budget}) -- allowing stop\n",
        )
    return ("run", None, None)


def post_validator_decision(validator_exit_code, validator_stdout, counter):
    """Decide the outcome once the validator subprocess has actually run.

    Three cases, by validator_exit_code (fix-round finding, final-review.md
    C1 -- this used to treat "any nonzero" as a block; narrowed here to only
    validator.py's own documented exit-1 predicate-fail):

      == 0  -- every seam passed, OR validator.py hit its own internal-error
               fail-open path (both look identical to callers: exit 0) --
               reset the counter, allow the stop.
      == 1  -- validator.py's OWN documented predicate-fail exit code (at
               least one seam FAIL, per its module docstring's 0/1
               contract) -- increment the counter, block the stop, and
               surface the validator's own `SEAM <id> FAIL ...` lines on
               stderr (the simpler of the two options the brief allows:
               printing the validator's own FAIL lines rather than
               re-deriving each seam's `onFail` text from spec.json).
      anything else -- a signal-killed validator subprocess (e.g. -9/139), a
               Python startup failure before it even reaches its own
               try/except (e.g. exit 2 on a bad invocation, or an
               uncaught-import traceback -- see validator.py's own C1 fix
               for why that specific case can no longer happen, but this
               path stays defensive regardless), or any other code outside
               the documented 0/1 contract: this is validator-INTERNAL
               breakage, not a predicate result. Fail OPEN (allow the stop,
               exit 0), leave the counter UNCHANGED (neither reset nor
               incremented -- it's not a genuine pass, and must not count
               toward the block budget either), and surface a one-line
               notice on stdout so the anomaly stays visible without
               blocking on it. This is exactly Global Constraint 1
               ("fail-open absolute"): only validator.py's own documented
               exit-1 predicate-fail may ever block the stop.
    """
    if validator_exit_code == 0:
        return {"exit_code": 0, "new_counter": 0, "stderr": None, "notice": None}
    if validator_exit_code == 1:
        fail_lines = [
            line
            for line in validator_stdout.splitlines()
            if line.startswith("SEAM ") and " FAIL " in line
        ]
        if not fail_lines:
            fail_lines = [
                "[seam-gate] validator exited 1 with no parsed SEAM FAIL lines"
            ]
        return {
            "exit_code": 2,
            "new_counter": counter + 1,
            "stderr": "\n".join(fail_lines) + "\n",
            "notice": None,
        }
    return {
        "exit_code": 0,
        "new_counter": counter,
        "stderr": None,
        "notice": (
            f"[seam-gate] validator exited {validator_exit_code} (outside the "
            "documented 0/1 contract) -- treating as gate-internal breakage, "
            "allowing the stop without blocking\n"
        ),
    }


# --------------------------------------------------------------------------
# I/O shell around the decision core.
# --------------------------------------------------------------------------

def read_counter(state_path):
    """Reads the integer block counter from state_path. Missing file,
    unreadable file, or non-integer content all read as 0 -- a fresh/absent
    state file must never itself be a reason to block."""
    try:
        with open(state_path) as f:
            text = f.read().strip()
        return int(text) if text else 0
    except (OSError, ValueError):
        return 0


def write_counter(state_path, value):
    with open(state_path, "w") as f:
        f.write(str(value))


def run_validator(spec_path=SPEC_PATH, validator_path=VALIDATOR_PATH, root=ROOT,
                   source_path=SOURCE_PATH, timeout=VALIDATOR_TIMEOUT_SEC):
    """Shell out to the real validator.py CLI. May raise (FileNotFoundError,
    subprocess.TimeoutExpired, PermissionError, ...) -- callers must let
    that propagate to main()'s fail-open handler, not swallow it here.

    Always passes --source (Task 7 item 4): harmless for a spec with no
    source_crosscheck seam, and required for one that has it -- validator.py
    itself fails that seam's predicate cleanly (not an internal error) if
    the path is missing or wrong, so there's no fail-open reason to make
    this conditional on the spec's content.
    """
    proc = subprocess.run(
        [
            sys.executable, validator_path,
            "--spec", spec_path,
            "--root", root,
            "--source", source_path,
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def run(payload, state_path=None):
    """Full decision + I/O flow for one Stop-hook invocation. Returns the
    process exit code. May raise -- main() is the fail-open boundary.

    state_path defaults to the *current* value of the module-level
    STATE_PATH constant, looked up at call time rather than bound as a
    literal default -- this is deliberate, not stylistic: it's what lets
    tests do `mock.patch.object(hook, "STATE_PATH", tmp_path)` and have it
    actually take effect (a bound default `state_path=STATE_PATH` captures
    the value at function-definition/import time and is immune to patching
    the module attribute afterward)."""
    if state_path is None:
        state_path = STATE_PATH
    counter = read_counter(state_path)
    action, exit_code, notice = pre_check(payload, counter)
    if action == "skip":
        if notice:
            sys.stdout.write(notice)
        return exit_code

    v_exit_code, v_stdout, _v_stderr = run_validator()
    decision = post_validator_decision(v_exit_code, v_stdout, counter)
    write_counter(state_path, decision["new_counter"])
    if decision["stderr"]:
        sys.stderr.write(decision["stderr"])
    if decision.get("notice"):
        sys.stdout.write(decision["notice"])
    return decision["exit_code"]


def main():
    """Top-level entry point -- the fail-open boundary. ANY exception raised
    anywhere above (bad JSON on stdin, state-file I/O errors, a validator
    subprocess that can't be spawned or times out, an unexpected bug in this
    file itself) lands here and returns 0. Deliberately no diagnostic output
    on this path: a broken gate must be indistinguishable from no gate at
    all, not from a blocked stop."""
    try:
        payload = json.load(sys.stdin)
        return run(payload)
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
