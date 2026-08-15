# Shared helpers for relation probes (concurrency fix, 2026-08-15).
#
# Two live-diagnosed defects in the original relations:
#  1. Markers lived at FIXED paths in the machine-global temp dir
#     (tempfile.gettempdir()/mh_mr_*.txt) — two concurrent executions of the
#     same relation (a second test suite, the repo gate's tiered check, a
#     parallel bench run) cross-talked through them: the other process's
#     oracle run made a degraded artifact look compliant (false ACCEPT) and
#     the other process's cleanup deleted a marker mid-check (false ALARM).
#     Markers now live under APPDIR — the per-invocation isolated dir every
#     relation already requires.
#  2. Fixed sleeps (wait_sec=N) then a single check — load-sensitive. Now:
#     poll the observable condition with a deadline (condition-based
#     waiting); passes settle as soon as the condition holds.
import os
import time

APPDIR = os.environ["APPDIR"]


def marker(name: str) -> str:
    return os.path.join(APPDIR, name)


def wait_for(path: str, deadline_sec: float = 10.0, contains: str | None = None) -> bool:
    """Poll until `path` exists (and optionally contains `contains`)."""
    deadline = time.monotonic() + deadline_sec
    while time.monotonic() < deadline:
        if os.path.exists(path):
            if contains is None:
                return True
            try:
                if contains in open(path).read():
                    return True
            except OSError:
                pass
        time.sleep(0.1)
    return False
