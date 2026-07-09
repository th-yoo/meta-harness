#!/usr/bin/env python3
"""
retry_provider.py — re-run a runner.py subcommand until the model provider is
healthy, backing off between attempts.

Why: when the upstream model provider is erroring (opencode emits an error event
and does no work — every run reports `turns=0`), a `run`/`ab` produces a
meaningless all-fail result. This wrapper detects that state and retries instead
of accepting the empty result.

Health signal: the provider is "down" only when opencode logged a transient
provider error AND nothing in the attempt did real work — i.e. every run failed
fast before doing anything. A run that produced turns, hit the agent timeout, or
passed all mean the provider is up (even if the task itself failed), so we stop.
This deliberately treats a *timeout* as "up" — it is a slow/stuck task, not a
provider outage, and retrying it would loop forever.

Backoff: the interval doubles each failed attempt and is capped at 10 minutes
(600 s): 30 → 60 → 120 → 240 → 480 → 600 → 600 …

Usage:
  python3 retry_provider.py [--base SEC] [--cap SEC] [--max-attempts N] -- <runner args...>

Examples:
  python3 retry_provider.py -- ab --layer account-global --candidate v1 \
      --tasks code-from-image constraints-scheduling --k 1
  python3 retry_provider.py --cap 600 -- run --task-file baseline-tasks.txt --k 1
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RUNNER = SCRIPT_DIR / "runner.py"

# Evidence the provider actually did something this attempt: real turns, a task
# that hit the agent timeout (ran but slow/stuck), or an outright pass.
REALWORK_RE = re.compile(r"turns=[1-9]\d*|opencode timed out after|reward=1")
# run_opencode logs this line each time it detects a transient provider error.
TRANSIENT_MARK = "transient provider error"


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", type=float, default=30.0,
                    help="initial backoff seconds (default 30)")
    ap.add_argument("--cap", type=float, default=600.0,
                    help="max backoff seconds; the interval attenuates up to this "
                         "cap (default 600 = 10 min)")
    ap.add_argument("--max-attempts", type=int, default=0,
                    help="give up after N provider-down attempts (0 = unlimited)")
    ap.add_argument("rest", nargs=argparse.REMAINDER,
                    help="-- then the runner.py subcommand + args")
    args = ap.parse_args()

    runner_args = args.rest
    if runner_args and runner_args[0] == "--":
        runner_args = runner_args[1:]
    if not runner_args:
        sys.exit("retry_provider: provide runner.py args after --")

    attempt = 0
    delay = args.base
    while True:
        attempt += 1
        print(f"\n=== retry_provider attempt {attempt}: python3 runner.py "
              f"{' '.join(runner_args)} ===", flush=True)

        proc = subprocess.Popen(
            [sys.executable, str(RUNNER), *runner_args],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert proc.stdout is not None
        saw_transient = False
        saw_realwork = False
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            if TRANSIENT_MARK in line:
                saw_transient = True
            if REALWORK_RE.search(line):
                saw_realwork = True
        proc.wait()

        # Down only if the provider errored on every run and nothing ran.
        provider_down = saw_transient and not saw_realwork
        if not provider_down:
            print(f"=== provider responding (real work seen / no transient outage) — "
                  f"done, exit={proc.returncode} ===", flush=True)
            sys.exit(proc.returncode)

        if args.max_attempts and attempt >= args.max_attempts:
            print(f"=== gave up: provider still down after {attempt} attempt(s) ===",
                  flush=True)
            sys.exit(2)

        print(f"=== provider down (all runs failed fast with transient errors) — "
              f"backing off {delay:.0f}s before attempt {attempt + 1} ===", flush=True)
        time.sleep(delay)
        delay = min(delay * 2, args.cap)


if __name__ == "__main__":
    main()
