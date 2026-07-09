#!/usr/bin/env python3
"""
runner.py — Terminal-Bench 2 harness runner for meta-harness evolution.

Commands:
  prep   [--apply]          Print (or run) one-time host setup: mkdir + apt union install.
  run    [options]          Run tasks through OpenCode, score, record in store.
  ab     [options]          A/B a candidate vs active for one layer; writes ab-verdict.json.
  oracle [--tasks T [T…]]   Validate pipeline using solution/solve.sh (no LLM tokens).

Examples:
  python3 runner.py prep
  python3 runner.py prep --apply
  python3 runner.py oracle --tasks openssl-selfsigned-cert
  python3 runner.py run --tasks adaptive-rejection-sampler --model claude-sonnet-4-6
  python3 runner.py run --all --model claude-sonnet-4-6 --variant high --k 1
  python3 runner.py run --agent mh-build --pin account-global=v4 --tasks dna-insert
  python3 runner.py ab --layer account-global --candidate v4 --task-file baseline-tasks.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ── Paths ──────────────────────────────────────────────────────────────────

# This script lives in <meta_root>/term-bench2/runner.py
SCRIPT_DIR = Path(__file__).resolve().parent
META_ROOT = SCRIPT_DIR.parent
TB_ROOT_DEFAULT = META_ROOT.parent / "terminal-bench-2"
SPLITS_PATH_DEFAULT = SCRIPT_DIR / "splits.json"

# TB2 task scripts hardcode /app, /tests, /logs/verifier.
# We never touch the real filesystem root. Instead every subprocess runs inside
# a private mount namespace (unshare --user --mount --map-root-user) where
# ~/bench/{app,tests,logs} are bind-mounted onto /app, /tests, /logs.
# The host filesystem sees none of these paths.
BENCH_PREFIX = Path.home() / "bench"
REAL_APP   = BENCH_PREFIX / "app"
REAL_TESTS = BENCH_PREFIX / "tests"
REAL_LOGS  = BENCH_PREFIX / "logs" / "verifier"
# Backing dir for /tmp — a real dir under $HOME (same mount as /app) rather
# than a tmpfs, so os.rename() between /app and /tmp is not cross-device.
REAL_TMP   = BENCH_PREFIX / "tmp"
# Shim bin dir prepended to PATH: provides `python` → python3 (TB2 tasks
# assume `python` exists, but Ubuntu 24.04 only ships python3).
BENCH_BIN  = BENCH_PREFIX / "bin"
# Writable copy of /usr/local so reference scripts that install there
# (e.g. sqlite-with-gcov: ln -s … /usr/local/bin/sqlite3) succeed unprivileged.
BENCH_USRLOCAL = BENCH_PREFIX / "usrlocal"


def ensure_usrlocal() -> None:
    """One-time writable copy of /usr/local → ~/bench/usrlocal (idempotent)."""
    if BENCH_USRLOCAL.exists():
        return
    src = Path("/usr/local")
    if src.exists():
        shutil.copytree(src, BENCH_USRLOCAL, symlinks=True, ignore_dangling_symlinks=True)
    else:
        BENCH_USRLOCAL.mkdir(parents=True, exist_ok=True)


def ensure_bench_bin() -> None:
    """
    Populate ~/bench/bin (prepended to sandbox PATH) with compatibility shims:

      python   → python3           (Ubuntu 24.04 ships only python3)
      sudo     → exec "$@"         (sandbox runs unprivileged; drop sudo)
      apt-get  → no-op success     (packages are pre-installed on the host;
      apt        the TB2 container runs these as root — emulate success so
                 reference solve.sh / test.sh under `set -e` don't abort)

    If a task genuinely needs a missing package, the shim only defers the
    failure to the point of actual use (honest failure at test time).
    """
    BENCH_BIN.mkdir(parents=True, exist_ok=True)

    # python → python3 symlink
    py = BENCH_BIN / "python"
    if not py.exists():
        py3 = shutil.which("python3") or "/usr/bin/python3"
        try:
            py.symlink_to(py3)
        except FileExistsError:
            pass

    # sudo shim: run the command without privilege elevation
    sudo = BENCH_BIN / "sudo"
    sudo.write_text(
        "#!/bin/bash\n"
        '# meta-harness shim: drop sudo, exec remaining args directly\n'
        'while [[ "$1" == -* ]]; do shift; done\n'
        'exec "$@"\n'
    )
    sudo.chmod(0o755)

    # apt-get / apt shim: no-op success (assume packages already present)
    apt_shim = (
        "#!/bin/bash\n"
        '# meta-harness shim: emulate apt success (packages pre-installed)\n'
        'exit 0\n'
    )
    for name in ("apt-get", "apt"):
        p = BENCH_BIN / name
        p.write_text(apt_shim)
        p.chmod(0o755)

# These are the paths as seen *inside* the namespace (what scripts expect)
HOST_APP  = Path("/app")
HOST_TESTS = Path("/tests")
HOST_LOGS  = Path("/logs/verifier")

# Manifest of all 59 target tasks
MANIFEST_PATH = SCRIPT_DIR / "manifest.json"
TASKS_DIR = SCRIPT_DIR / "tasks"
PATCHES_DIR = SCRIPT_DIR / "patches"
APT_PACKAGES_TXT = SCRIPT_DIR / "apt-packages.txt"

# Tracks which packages were newly installed by prep --apply (for --uninstall)
PREP_INSTALLED_TXT = SCRIPT_DIR / ".prep-installed.txt"

# Extra apt packages required by reference solve.sh / test.sh at run time.
# The sandbox's apt shim no-ops `apt install`, so these must be pre-installed.
# Merged into the install set by `prep` on top of apt-packages.txt.
# (Also declared in gen_setup_deps.py so apt-packages.txt stays in sync.)
EXTRA_APT = [
    "tesseract-ocr",      # gcode-to-text, financial-document-processor (OCR)
    "libtesseract-dev",   # gcode-to-text
    "python3-opencv",     # gcode-to-text (cv2)
    "tclsh",              # tcl-based tasks
    "python3-venv",       # venv creation
    "fossil",             # fossil-scm tasks
    "apache2-utils",      # htpasswd etc.
    "make",               # build tasks
]

# Legacy host-side placeholder dirs from the old --bind / / approach.
# No longer created (the sandbox now uses a tmpfs root), but prep
# --clean-mountpoints removes them if they linger from an earlier setup.
BWRAP_MOUNT_POINTS = [
    "/app", "/tests", "/logs",
    "/data", "/protected", "/workspace",
]

# ── Task list ──────────────────────────────────────────────────────────────


def load_manifest() -> dict:
    try:
        return json.loads(MANIFEST_PATH.read_text())
    except Exception as e:
        die(f"Cannot read manifest: {e}")


def all_task_names() -> list[str]:
    return sorted(load_manifest().keys())


# ── Helpers ────────────────────────────────────────────────────────────────


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def run_cmd(
    cmd: list[str],
    *,
    cwd: Optional[Path] = None,
    env: Optional[dict] = None,
    timeout: Optional[float] = None,
    capture: bool = False,
    check: bool = True,
    ns: bool = False,
    extra_mounts: Optional[dict[str, Path]] = None,
    chdir: str = "/app",
) -> subprocess.CompletedProcess:
    """Run a command, optionally inside the bwrap sandbox.

    When ns=True, chdir sets the working directory *inside* the sandbox
    (default /app). cwd is only used when ns=False.
    """
    # PIP_BREAK_SYSTEM_PACKAGES mirrors the TB2 container where pip runs as
    # root without PEP-668 restrictions. Without it, solve.sh `pip install`
    # calls fail with 'externally-managed-environment'.
    merged_env = {"PIP_BREAK_SYSTEM_PACKAGES": "1", **os.environ, **(env or {})}
    if ns:
        ensure_usrlocal()
    # NOTE: per-task PYTHONUSERBASE isolation was tried but reverted — it hid the
    # shared ~/.local packages that some reference solutions rely on (e.g.
    # largest-eigenval needs numpy>=2.2 which pip can't upgrade over the debian
    # system numpy). Tasks share ~/.local; cross-task pollution is tolerated
    # (it did not cause failures across the 37-task oracle baseline).
    # Prepend the shim bin (python → python3) to PATH.
    ensure_bench_bin()
    merged_env["PATH"] = f"{BENCH_BIN}:{merged_env.get('PATH', '')}"
    actual_cmd = ns_wrap(cmd, extra_mounts, chdir=chdir) if ns else cmd
    return subprocess.run(
        actual_cmd,
        cwd=str(cwd) if (cwd and not ns) else None,
        env=merged_env,
        timeout=timeout,
        capture_output=capture,
        text=capture,
        check=check,
    )


def read_toml_value(toml_path: Path, section: str, key: str) -> Optional[float]:
    """Minimal TOML reader for [section] key = value (floats/ints only)."""
    if not toml_path.exists():
        return None
    text = toml_path.read_text()
    in_section = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(f"[{section}]"):
            in_section = True
            continue
        if line.startswith("[") and in_section:
            in_section = False
        if in_section and line.startswith(f"{key}"):
            m = re.match(rf"{re.escape(key)}\s*=\s*([\d.]+)", line)
            if m:
                return float(m.group(1))
    return None


def read_reward() -> int:
    """Read ~/bench/logs/verifier/reward.txt → 0 or 1."""
    try:
        txt = REAL_LOGS.joinpath("reward.txt").read_text().strip()
        return int(txt) if txt in ("0", "1") else 0
    except Exception:
        return 0


def _real(ns_path: Path) -> Path:
    """Translate a namespace path (/app, /tests, /logs/…) to its real ~/bench/… counterpart."""
    s = str(ns_path)
    if s == "/app" or s.startswith("/app/"):
        return BENCH_PREFIX / "app" / s[len("/app/"):]
    if s == "/tests" or s.startswith("/tests/"):
        return BENCH_PREFIX / "tests" / s[len("/tests/"):]
    if s == "/logs" or s.startswith("/logs/"):
        return BENCH_PREFIX / "logs" / s[len("/logs/"):]
    return ns_path  # not a namespace path — pass through


def clean_dir(ns_path: Path) -> None:
    """Wipe and recreate a bench directory (operates on ~/bench/… not /app/…)."""
    real = _real(ns_path)
    real.mkdir(parents=True, exist_ok=True)
    for child in real.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)


def clean_tmp() -> None:
    """Reset ~/bench/tmp (the backing dir for the sandbox's /tmp symlink)."""
    if REAL_TMP.exists():
        shutil.rmtree(REAL_TMP, ignore_errors=True)
    REAL_TMP.mkdir(parents=True, exist_ok=True)
    try:
        REAL_TMP.chmod(0o1777)   # world-writable + sticky, like a real /tmp
    except OSError:
        pass


def ns_wrap(
    cmd: list[str],
    extra_mounts: Optional[dict[str, Path]] = None,
    chdir: str = "/app",
) -> list[str]:
    """
    Wrap a command using bwrap (bubblewrap) in a sandbox whose root is a
    fresh tmpfs. Real system dirs (/usr, /etc, /home, …) are bind-mounted on
    top; ~/bench/{app,tests,logs} are bound onto /app, /tests, /logs.

    Because / is a writable tmpfs, task scripts and tests can freely create
    arbitrary top-level paths (e.g. /jail, /protected, /workspace) with no
    host-side placeholder dirs and no sudo. All changes to / are discarded
    when the sandbox exits — only ~/bench/ (bound) persists.

    chdir: working directory inside the sandbox (default /app). TB2 tasks run
    solve.sh / test.sh with cwd=/app.

    extra_mounts: {'/sandbox/path': real_host_path} for task-specific paths
    that must PERSIST to ~/bench/extras/<task> (bound), rather than living in
    the discarded tmpfs. Used for setup-created assets the verifier reads back.
    """
    bwrap_args = [
        "bwrap",
        # CAP_SYS_CHROOT: some tests chroot into a jail to verify a static
        # binary has no external deps (e.g. path-tracing). Granted only within
        # the sandbox's user namespace — no host privilege.
        "--cap-add", "CAP_SYS_CHROOT",
        "--tmpfs", "/",                       # writable, discarded root
        "--ro-bind", "/usr", "/usr",
        "--bind", str(BENCH_USRLOCAL), "/usr/local",  # writable /usr/local (copy)
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/sbin", "/sbin",
        "--ro-bind", "/etc", "/etc",
        "--bind", str(Path.home()), str(Path.home()),   # $HOME (uv cache, ~/.local/bin)
        "--bind", "/var", "/var",                  # texlive, dpkg db, many tools read here
        "--ro-bind-try", "/opt", "/opt",
        "--ro-bind-try", "/snap", "/snap",
        "--ro-bind-try", "/sys", "/sys",
        "--bind-try", "/run", "/run",
        "--ro-bind-try", "/mnt/wsl", "/mnt/wsl",   # WSL: /etc/resolv.conf → /mnt/wsl/… (DNS)
        "--proc", "/proc",
        "--dev", "/dev",
        # /app /tests /logs /tmp are SYMLINKS into the single already-bound
        # $HOME mount (not separate bind mounts). This keeps them all on one
        # filesystem so cross-path os.rename() works (e.g. path-tracing-reverse
        # renames /app/mystery → /tmp/mystery, which would be EXDEV across
        # separate mounts). They still persist via ~/bench/… across the
        # setup/solve/test bwrap invocations.
        "--symlink", str(REAL_APP),   "/app",
        "--symlink", str(REAL_TESTS), "/tests",
        "--symlink", str(BENCH_PREFIX / "logs"), "/logs",
        "--symlink", str(REAL_TMP),   "/tmp",
        "--chdir", chdir,
    ]
    for ns_path, real_path in (extra_mounts or {}).items():
        real_path.mkdir(parents=True, exist_ok=True)
        # Symlink extras into the $HOME mount too (same filesystem as /app),
        # so renames between /app and e.g. /protected also work.
        bwrap_args += ["--symlink", str(real_path), ns_path]

    bwrap_args += ["--"] + cmd
    return bwrap_args


# ── prep command ───────────────────────────────────────────────────────────


def _installed_packages() -> set[str]:
    """Return the set of currently-installed dpkg packages."""
    result = subprocess.run(
        ["dpkg-query", "-W", "-f", "${Package}\n"],
        capture_output=True, text=True,
    )
    return set(result.stdout.splitlines())


def cmd_prep(args: argparse.Namespace) -> None:
    """Print (or execute) one-time host setup / uninstall commands."""
    _union = set(APT_PACKAGES_TXT.read_text().splitlines()) if APT_PACKAGES_TXT.exists() else set()
    _union.update(EXTRA_APT)
    apt_pkgs = sorted(p for p in _union if p.strip())

    # ── clean-mountpoints mode ────────────────────────────────────────────
    if getattr(args, "clean_mountpoints", False):
        existing = [p for p in BWRAP_MOUNT_POINTS if Path(p).exists()]
        if not existing:
            print("No bwrap mount-point placeholders found — nothing to remove.")
            return
        if args.apply:
            log(f"Removing {len(existing)} mount-point placeholder(s)...")
            subprocess.run(["sudo", "rm", "-rf"] + existing, check=True)
            log("Done: " + " ".join(existing))
        else:
            print("# Bwrap mount-point placeholders that would be removed:")
            print()
            print("sudo rm -rf " + " ".join(existing))
            print()
            print("# Run: python3 runner.py prep --clean-mountpoints --apply")
        return

    # ── uninstall mode ────────────────────────────────────────────────────
    if args.uninstall:
        if not PREP_INSTALLED_TXT.exists():
            die(
                f"{PREP_INSTALLED_TXT} not found.\n"
                "prep --apply was either never run or run before tracking was added.\n"
                "Run 'prep --apply' once to record what was newly installed, then --uninstall."
            )
        to_remove = sorted(set(PREP_INSTALLED_TXT.read_text().splitlines()))
        if not to_remove:
            print("Nothing to uninstall (prep installed no new packages).")
            return
        cmd = ["sudo", "apt-get", "remove", "--purge", "-y"] + to_remove
        if args.apply:
            log(f"Removing {len(to_remove)} package(s) installed by prep...")
            subprocess.run(cmd, check=True, env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
            subprocess.run(["sudo", "apt-get", "autoremove", "-y"], check=True,
                           env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
            PREP_INSTALLED_TXT.unlink(missing_ok=True)
            log("Uninstall complete.")
        else:
            print("# Packages that would be removed (installed by prep --apply):")
            print()
            print(" ".join(to_remove))
            print()
            print(f"# Run: python3 runner.py prep --uninstall --apply")
        return

    # ── install mode ──────────────────────────────────────────────────────
    apt_line = "sudo apt-get install -y \\\n  " + " \\\n  ".join(apt_pkgs) if apt_pkgs else "# (no apt packages)"
    user = os.environ.get("USER", os.environ.get("LOGNAME", "$(whoami)"))
    commands = [
        f"# User-owned backing dirs (all actual data lives here — no sudo, no root pollution):",
        f"mkdir -p {REAL_APP} {REAL_TESTS} {REAL_LOGS}",
        apt_line,
    ]

    if args.apply:
        log("Running host setup...")

        # Snapshot dpkg state BEFORE install so we can capture everything that
        # gets added (the requested packages AND their pulled-in dependencies).
        before_install = _installed_packages()
        wanted_new = [p for p in apt_pkgs if p not in before_install]
        log(f"  {len(wanted_new)} requested new / {len(apt_pkgs) - len(wanted_new)} already present")

        # Create user-owned bench dirs (all actual data lives here).
        # The sandbox uses a tmpfs root, so NO /app /tests /logs placeholders
        # are needed on the host and NO sudo is required for directories.
        REAL_APP.mkdir(parents=True, exist_ok=True)
        REAL_TESTS.mkdir(parents=True, exist_ok=True)
        REAL_LOGS.mkdir(parents=True, exist_ok=True)
        ensure_bench_bin()
        log(f"  Created {REAL_APP}, {REAL_TESTS}, {REAL_LOGS}, {BENCH_BIN}")

        # apt — noninteractive to avoid debconf prompts (postfix, mailman3, etc.)
        if apt_pkgs:
            subprocess.run(
                ["sudo", "apt-get", "install", "-y"] + apt_pkgs,
                check=True,
                env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"},
            )

        # Diff dpkg state AFTER install → all newly-added packages (incl. deps).
        after_install = _installed_packages()
        newly_installed = after_install - before_install

        # Merge into the tracking file (never overwrite), so packages from an
        # earlier prep --apply run are preserved for a later --uninstall.
        previously_tracked: set[str] = set()
        if PREP_INSTALLED_TXT.exists():
            previously_tracked = {
                ln.strip() for ln in PREP_INSTALLED_TXT.read_text().splitlines() if ln.strip()
            }
        merged = sorted(previously_tracked | newly_installed)
        PREP_INSTALLED_TXT.write_text("\n".join(merged) + ("\n" if merged else ""))
        if newly_installed:
            log(f"  Recorded {len(newly_installed)} newly-installed package(s) "
                f"(incl. deps); {len(merged)} total tracked → {PREP_INSTALLED_TXT.name}")
        else:
            log(f"  No new packages this run; {len(merged)} still tracked for --uninstall.")

        log("Host setup complete.")
    else:
        # Dry-run: show what would be installed vs what's already present
        already_installed = _installed_packages()
        new_pkgs = [p for p in apt_pkgs if p not in already_installed]
        existing = [p for p in apt_pkgs if p in already_installed]

        print("# One-time host setup — run with --apply to execute:")
        print("# (no root/sudo needed for dirs; sudo only for apt packages)")
        print()
        for c in commands:
            print(c)
        print()
        print(f"# Of {len(apt_pkgs)} packages: {len(new_pkgs)} new, {len(existing)} already installed.")
        if new_pkgs:
            print(f"# New packages: {' '.join(new_pkgs)}")
        print("# Note: --apply sets DEBIAN_FRONTEND=noninteractive to avoid debconf prompts.")
        print("# To undo apt packages: python3 runner.py prep --uninstall [--apply]")


# ── harness assembly ───────────────────────────────────────────────────────


LAYER_CHOICES = ("account-global", "project-global", "account-role", "project-role")

# (system_heading, tools_heading) per layer; {agent} is filled for role layers.
# The two global layers keep their historical headings so default output is
# byte-identical to the pre-role version.
_LAYER_LABELS = {
    "account-global": ("General coding guidance", "General coding tool usage"),
    "project-global": ("Project guidance", "Project tool usage"),
    "account-role":   ("Role guidance ({agent})", "Role tool usage ({agent})"),
    "project-role":   ("Project role guidance ({agent})", "Project role tool usage ({agent})"),
}


def layer_store_roots(layers: str, agent: str, meta_root: Path) -> list[tuple[str, Path]]:
    """Ordered [(layer_name, store_root)] in Option Y order:
    account-global -> project-global -> account-role -> project-role.
    `layers` gates the account/project side; a non-empty `agent` adds role rows."""
    from bench_store import (
        account_global_root, project_global_root,
        account_role_root, project_role_root,
    )
    inc_account = layers in ("global", "account")
    inc_project = layers in ("global", "project")
    roots: list[tuple[str, Path]] = []
    if inc_account:
        roots.append(("account-global", account_global_root()))
    if inc_project:
        roots.append(("project-global", project_global_root(meta_root)))
    if agent:
        if inc_account:
            roots.append(("account-role", account_role_root(agent)))
        if inc_project:
            roots.append(("project-role", project_role_root(meta_root, agent)))
    return roots


def parse_pins(pin_args: list[str], layers: str, agent: str, meta_root: Path) -> dict[str, str]:
    """Parse repeated --pin LAYER=vN into {layer_name: version}. die() on any error."""
    from bench_store import candidate_exists, list_versions
    if not pin_args:
        return {}
    if layers == "none":
        die("--pin cannot be combined with --layers none")
    valid = dict(layer_store_roots(layers, agent, meta_root))
    pins: dict[str, str] = {}
    for spec in pin_args:
        if "=" not in spec:
            die(f"--pin must be LAYER=vN, got {spec!r}")
        name, _, ver = spec.partition("=")
        name, ver = name.strip(), ver.strip()
        if name not in LAYER_CHOICES:
            die(f"--pin: unknown layer {name!r} (choices: {', '.join(LAYER_CHOICES)})")
        if not re.fullmatch(r"v\d+", ver):
            die(f"--pin {name}: version must look like vN, got {ver!r}")
        if name in pins:
            die(f"--pin: layer {name!r} pinned twice")
        if name in ("account-role", "project-role") and not agent:
            die(f"--pin {name} requires --agent")
        if name not in valid:
            die(f"--pin {name}: layer not included by --layers {layers}"
                + ("" if agent else " (role layers need --agent)"))
        root = valid[name]
        if not candidate_exists(root, ver):
            have = ", ".join(list_versions(root)) or "none"
            die(f"--pin {name}={ver}: no such candidate under {root} (have: {have})")
        pins[name] = ver
    return pins


def assemble_agents_md(layers: str, meta_root: Path, agent: str = "",
                       pins: Optional[dict] = None) -> str:
    """
    Build AGENTS.md content from the store layers (Option Y order).
    layers: 'global' | 'account' | 'project' | 'none'
    agent : if set, also compose the account-role/project-role layers for it.
    pins  : {layer_name: vN} — read that candidate instead of the active version.
    With agent="" and pins empty, output is identical to the two-global-layer form.
    """
    from bench_store import (
        read_active_system, read_active_tools,
        read_candidate_system, read_candidate_tools,
    )
    pins = pins or {}
    parts: list[str] = []

    for name, root in layer_store_roots(layers, agent, meta_root):
        ver = pins.get(name)
        if ver:
            sys_txt = read_candidate_system(root, ver)
            tools_txt = read_candidate_tools(root, ver)
        else:
            sys_txt = read_active_system(root)
            tools_txt = read_active_tools(root)
        sys_head, tools_head = _LAYER_LABELS[name]
        if sys_txt:
            parts.append(f"## {sys_head.format(agent=agent)}\n\n{sys_txt}")
        if tools_txt:
            parts.append(f"## {tools_head.format(agent=agent)}\n\n{tools_txt}")

    return "\n\n---\n\n".join(parts)


# ── per-task setup + cleanup ────────────────────────────────────────────────

_manifest_cache: dict = {}


def _manifest() -> dict:
    global _manifest_cache
    if not _manifest_cache:
        _manifest_cache = load_manifest()
    return _manifest_cache


def cleanup_task_extras(task: str) -> None:
    """Wipe ~/bench/extras/<task>/ — the user-owned backing store for this
    task's out-of-/app namespace mounts (/protected, /workspace, /data, etc.)."""
    extras_root = BENCH_PREFIX / "extras" / task
    if extras_root.exists():
        shutil.rmtree(extras_root)
        log(f"  cleanup: wiped {extras_root}")


# Top-level sandbox paths already provided by ns_wrap's base mounts/symlinks.
# Task "extra" paths that collide with these are skipped (the base handles
# them: e.g. /tmp is symlinked to ~/bench/tmp and persists within a task).
_BASE_MANAGED_PATHS = {
    "/app", "/tests", "/logs", "/tmp",
    "/usr", "/etc", "/var", "/home", "/run", "/opt", "/sys",
    "/proc", "/dev", "/snap", "/mnt", "/bin", "/lib", "/lib64", "/sbin",
}


def task_extra_mounts(task: str) -> dict[str, Path]:
    """
    Build {ns_path: real_path} for paths that setup_deps.sh writes outside
    the base-managed dirs (e.g. /protected, /workspace, /data, /root).
    These are hosted under ~/bench/extras/<task>/ and symlinked into the
    sandbox so the host filesystem is never touched. Paths already provided
    by the base sandbox (e.g. /tmp) are skipped to avoid symlink collisions.
    """
    meta = _manifest().get(task, {})
    top_paths: list[str] = meta.get("extra_cleanup_paths", [])
    extras: dict[str, Path] = {}
    for ns_path in top_paths:
        if ns_path.rstrip("/") in _BASE_MANAGED_PATHS:
            continue  # handled by base mounts/symlinks
        real = BENCH_PREFIX / "extras" / task / ns_path.lstrip("/")
        extras[ns_path] = real
    return extras


def setup_task(task: str, tb_root: Path) -> None:
    """Run setup_deps.sh INSIDE the bwrap sandbox with WORKDIR=/app.

    Running in the sandbox means /app, /protected, /root, etc. all resolve
    exactly as in the TB2 container, so setup steps that write to absolute
    paths (e.g. a log generator writing /app/logs) work correctly.
    - /app, /tests, /logs are bound to ~/bench/… (persist across steps)
    - extra task paths (/protected, /root, …) are bound to ~/bench/extras/<task>
    - sudo/apt shims handle the reference scripts' privilege assumptions
    EXTRAS_ROOT is left empty: destinations are the real sandbox paths, which
    are bound to persist.
    """
    setup_script = TASKS_DIR / task / "setup_deps.sh"
    if not setup_script.exists():
        die(f"No setup_deps.sh for task {task!r} — did you run gen_setup_deps.py?")

    # Pre-create real backing dirs for extra mount paths (so binds have a source)
    for ns_path, real_path in task_extra_mounts(task).items():
        real_path.mkdir(parents=True, exist_ok=True)

    env = {
        "TB_ROOT": str(tb_root),
        "WORKDIR": "/app",       # sandbox path, bound to ~/bench/app
        "EXTRAS_ROOT": "",       # write to real /protected etc (bound to persist)
        "SKIP_APT": "1",
    }
    log(f"  setup_deps.sh ({task})...")
    run_cmd(
        ["bash", str(setup_script)],
        env=env,
        ns=True,
        chdir="/app",
        extra_mounts=task_extra_mounts(task),
    )


# ── OpenCode invocation ────────────────────────────────────────────────────


def normalize_events(ndjson_text: str, max_events: int = 400) -> list[dict]:
    """opencode `run --format json` NDJSON → compact TrajEvents for the proposer.
    Shapes (shared with harness-store.ts TrajEvent):
      {"t":"tool", tool, args<=300, output<=800, error}
      {"t":"text", text<=800}   {"t":"error", text<=800}
    step_finish and unparseable lines are dropped; capped at max_events."""
    events: list[dict] = []
    for line in ndjson_text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type", "")
        if t == "tool_use":
            part = ev.get("part", {}) or {}
            state = part.get("state", {}) or {}
            tool = part.get("tool", "unknown")
            raw_args = state.get("input", part.get("input", ""))
            args = raw_args if isinstance(raw_args, str) else json.dumps(raw_args, default=str)
            raw_out = state.get("output", "")
            out = raw_out if isinstance(raw_out, str) else json.dumps(raw_out, default=str)
            status = state.get("status", "")
            exit_code = (state.get("metadata") or {}).get("exit", 0)
            err = status == "error" or bool(exit_code and exit_code != 0)
            events.append({"t": "tool", "tool": tool, "args": args[:300],
                           "output": out[:800], "error": err})
        elif t == "text":
            txt = ev.get("text") or (ev.get("part") or {}).get("text") or ""
            if isinstance(txt, str) and txt.strip():
                events.append({"t": "text", "text": txt[:800]})
        elif t == "error":
            err = ev.get("error") or {}
            if isinstance(err, dict):
                msg = (err.get("data") or {}).get("message") or err.get("name") or json.dumps(err, default=str)
            else:
                msg = str(err)
            events.append({"t": "error", "text": str(msg)[:800]})
        if len(events) >= max_events:
            break
    return events


def run_opencode(
    task: str,
    tb_root: Path,
    model: str,
    variant: Optional[str],
    agent_timeout: float,
    harness_md: str,
) -> tuple[int, dict, list[dict]]:
    """
    Write AGENTS.md, run opencode, return (turnCount, toolUsage, trajEvents).
    """
    instruction_path = tb_root / task / "instruction.md"
    if not instruction_path.exists():
        die(f"instruction.md not found: {instruction_path}")
    instruction = instruction_path.read_text()

    # Write harness into workspace (real path, before namespace launch)
    if harness_md:
        REAL_APP.joinpath("AGENTS.md").write_text(harness_md)

    # Build opencode command
    # --format json  → one JSON event per line (NDJSON)
    # --auto         → approve all tool permissions
    # NOTE: do NOT use --pure — it strips the provider/auth config, so the
    # configured Anthropic model (anthropic/claude-sonnet-4-6) fails to resolve
    # (ProviderModelNotFoundError). The meta-harness plugin is inert for the
    # default `build` agent (it only injects/scores for mh-* agents), so leaving
    # plugins enabled does not interfere with the benchmark.
    cmd = [
        "opencode", "run",
        "--dir", str(HOST_APP),
        "--auto",
        "--format", "json",
        "--model", model,
    ]
    if variant:
        cmd += ["--variant", variant]

    # Pass instruction as positional arg (opencode run [message..])
    cmd.append(instruction)

    # Retry on transient provider errors (e.g. Anthropic "Overloaded" /
    # "Unexpected server error") that abort the run before any real work.
    MAX_ATTEMPTS = 4
    TRANSIENT_RE = re.compile(
        r"overloaded|unexpected server error|rate.?limit|429|503|"
        r"timeout|connection|temporarily unavailable|apicallerror",
        re.IGNORECASE,
    )
    result = None
    elapsed = 0.0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        log(f"  opencode run (timeout={agent_timeout:.0f}s, attempt {attempt}/{MAX_ATTEMPTS})...")
        start = time.monotonic()
        try:
            result = run_cmd(
                cmd,
                cwd=REAL_APP,   # real path; opencode sees /app via --dir inside ns
                timeout=agent_timeout,
                capture=True,
                check=False,
                ns=True,
                extra_mounts=task_extra_mounts(task),
            )
        except subprocess.TimeoutExpired:
            log(f"  opencode timed out after {agent_timeout:.0f}s")
            return 0, {}, []
        elapsed = time.monotonic() - start

        out = result.stdout or ""
        # Detect a transient error run: an {"type":"error"} event AND no
        # assistant/tool activity (step_finish/text/tool_use).
        had_error_event = '"type":"error"' in out
        had_activity = ('"type":"step_finish"' in out or '"type":"tool_use"' in out)
        transient = (
            (had_error_event and not had_activity)
            or (result.returncode != 0 and not had_activity and TRANSIENT_RE.search(out))
        )
        if transient and attempt < MAX_ATTEMPTS:
            backoff = min(30, 5 * attempt)
            log(f"  transient provider error — retrying in {backoff}s")
            time.sleep(backoff)
            continue
        break

    # Parse NDJSON output for turn count and tool usage.
    # Real event schema (from opencode run --format json):
    #   {"type":"tool_use",  "part":{"tool":"bash","state":{"status":"completed"|"error",
    #                                 "metadata":{"exit":N}}, ...}}
    #   {"type":"step_finish","part":{"reason":"stop"|"tool-calls", ...}}
    # turn_count = number of step_finish events with reason=="stop"
    # tool errors = tool_use events where state.status=="error" OR metadata.exit != 0
    # Only count execution tools (bash, task) for errors to avoid false positives.
    EXECUTION_TOOLS = {"bash", "task"}

    turn_count = 0
    tool_usage: dict[str, dict] = {}

    output = result.stdout or ""
    for line in output.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        evt_type = event.get("type", "")

        if evt_type == "tool_use":
            part = event.get("part", {})
            tool = part.get("tool", "unknown")
            state = part.get("state", {})
            tool_usage.setdefault(tool, {"calls": 0, "errors": 0})
            tool_usage[tool]["calls"] += 1
            # Error: explicit error status or non-zero exit (execution tools only)
            if tool in EXECUTION_TOOLS:
                status = state.get("status", "")
                exit_code = (state.get("metadata") or {}).get("exit", 0)
                if status == "error" or (exit_code and exit_code != 0):
                    tool_usage[tool]["errors"] += 1

        elif evt_type == "step_finish":
            part = event.get("part", {})
            if part.get("reason") == "stop":
                turn_count += 1

    if turn_count == 0 and os.environ.get("MH_DEBUG"):
        dbg = Path("/tmp") / f"mh_oc_{task}.txt"
        dbg.write_text(
            f"exit={result.returncode if result else 'none'}\n"
            f"--- STDOUT ---\n{(result.stdout if result else '')[:4000]}\n"
            f"--- STDERR ---\n{(result.stderr if result else '')[:4000]}\n"
        )
        log(f"  [debug] dumped opencode output → {dbg}")

    events = normalize_events(output)
    log(f"  opencode done in {elapsed:.1f}s, turns={turn_count}")
    return turn_count, tool_usage, events


# ── verifier ───────────────────────────────────────────────────────────────


def _copy_test_entry(f: Path, dst_dir: Path) -> None:
    """Copy one tests/ entry into dst_dir.

    Handles subdirectories (some tasks ship dirs under tests/) and skips
    pytest bytecode junk (__pycache__, *.pyc) that a prior verifier run may
    have compiled into the source tree — copying those dirs with copy2 raises
    IsADirectoryError.
    """
    if f.name == "__pycache__" or f.suffix == ".pyc":
        return
    dst = dst_dir / f.name
    if f.is_dir():
        shutil.copytree(
            f, dst, dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
    else:
        shutil.copy2(f, dst)


def copy_tests(task: str, tb_root: Path) -> None:
    """Copy test files into ~/bench/tests (visible as /tests inside namespace)."""
    clean_dir(HOST_TESTS)  # clears REAL_TESTS via _real()
    real_tests = REAL_TESTS
    # Base: tb_root/<task>/tests/
    src = tb_root / task / "tests"
    if src.is_dir():
        for f in src.iterdir():
            _copy_test_entry(f, real_tests)
    # Overlay: patches/<task>/
    patch_src = PATCHES_DIR / task
    if patch_src.is_dir():
        for f in patch_src.iterdir():
            _copy_test_entry(f, real_tests)
            log(f"  patch applied: {f.name}")


def run_verifier(verifier_timeout: float, task: str = "") -> int:
    """Run test.sh inside the mount namespace, return reward (0 or 1)."""
    clean_dir(HOST_LOGS)   # clears REAL_LOGS via _real()
    test_sh = REAL_TESTS / "test.sh"
    if not test_sh.exists():
        log("  WARNING: no test.sh found")
        return 0
    log(f"  verifier (timeout={verifier_timeout:.0f}s)...")
    try:
        run_cmd(
            ["bash", "/tests/test.sh"],   # namespace path
            timeout=verifier_timeout,
            check=False,
            ns=True,
            chdir="/app",                # TB2 runs verifier from workspace
            extra_mounts=task_extra_mounts(task) if task else None,
        )
    except subprocess.TimeoutExpired:
        log(f"  verifier timed out after {verifier_timeout:.0f}s")
    return read_reward()


# ── store recording ────────────────────────────────────────────────────────


# ── run provenance (env block for confound control) ────────────────────────

_ENV_CACHE: dict = {}


def _opencode_version() -> str:
    if "oc" not in _ENV_CACHE:
        try:
            out = subprocess.run(["opencode", "--version"], capture_output=True,
                                 text=True, timeout=10)
            _ENV_CACHE["oc"] = ((out.stdout or out.stderr).strip().splitlines() or ["unknown"])[0][:40]
        except Exception:
            _ENV_CACHE["oc"] = "unknown"
    return _ENV_CACHE["oc"]


def _plugin_sha() -> str:
    if "sha" not in _ENV_CACHE:
        try:
            out = subprocess.run(["git", "-C", str(META_ROOT), "rev-parse", "--short", "HEAD"],
                                 capture_output=True, text=True, timeout=10)
            _ENV_CACHE["sha"] = out.stdout.strip() or "unknown"
        except Exception:
            _ENV_CACHE["sha"] = "unknown"
    return _ENV_CACHE["sha"]


def harness_hash(harness_md: str) -> str:
    """sha256 (first 16 hex) of the exact injected AGENTS.md bytes — pins record
    which candidate, this records what was actually composed and served."""
    return hashlib.sha256(harness_md.encode("utf-8")).hexdigest()[:16]


def env_block(harness_md: str, max_agent_timeout: float, model: str) -> dict:
    """Confound-control provenance: the config that, per the infra-noise study,
    swings outcomes independently of the harness rule under test."""
    return {
        "opencodeVersion": _opencode_version(),
        "pluginSha": _plugin_sha(),
        "harnessHash": harness_hash(harness_md),
        "maxAgentTimeout": max_agent_timeout or 0,
        "provider": model.split("/")[0] if "/" in model else "unknown",
    }


def _session_record(task: str, session_id: str, passed: bool, turn_count: int,
                    tool_usage: dict, model: str, variant: str,
                    env: Optional[dict] = None) -> dict:
    """Build a SessionRecord (matches harness-store.ts SessionRecord shape)."""
    return {
        "sessionID": session_id,
        "passed": passed,
        "note": f"bench:{task}",
        "turnCount": turn_count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": task,
        "model": model,
        "variant": variant or "",
        "toolUsage": tool_usage,
        "env": env or {},
    }


def record_to_stores(
    task: str,
    session_id: str,
    passed: bool,
    turn_count: int,
    tool_usage: dict,
    model: str,
    variant: str,
    layers: str,
    meta_root: Path,
    no_store: bool,
    agent: str = "",
    pins: Optional[dict] = None,
    env: Optional[dict] = None,
    events: Optional[list] = None,
    save_all_traj: bool = False,
) -> None:
    if no_store:
        return
    # Hygiene: a 0-turn run is a timeout / transient opencode failure, not a
    # verdict on the harness — never let it pollute the candidate score.json.
    if turn_count == 0:
        log("  skip store record: 0 agent turns (timeout/transient opencode failure)")
        return

    from bench_store import active_version, record_session, write_trajectory, prune_trajectories

    pins = pins or {}
    record = _session_record(task, session_id, passed, turn_count, tool_usage,
                             model, variant, env)
    save_traj = events and (not passed or save_all_traj)

    for name, root in layer_store_roots(layers, agent, meta_root):
        ver = pins.get(name) or active_version(root)
        score = record_session(root, ver, record)
        if save_traj:
            write_trajectory(root, ver, session_id, events)
            prune_trajectories(root, ver)
        log(f"  store {name} {ver}: nPass={score['nPass']} nFail={score['nFail']}")


# ── run command ────────────────────────────────────────────────────────────


def _harness_meta(layers: str, meta_root: Path, agent: str = "",
                  pins: Optional[dict] = None) -> dict:
    """Snapshot which store versions are active/pinned, for results provenance."""
    from bench_store import (
        account_global_root, active_version, project_global_root,
        account_role_root, project_role_root,
    )
    pins = pins or {}
    ag = account_global_root()
    pg = project_global_root(meta_root)
    meta = {
        "layers": layers,
        "account_active": active_version(ag) if ag.exists() else "none",
        "project_active": active_version(pg) if pg.exists() else "none",
        "agent": agent or "",
        "pins": pins,
    }
    if agent:
        ar = account_role_root(agent)
        pr = project_role_root(meta_root, agent)
        meta["account_role_active"] = active_version(ar) if ar.exists() else "none"
        meta["project_role_active"] = active_version(pr) if pr.exists() else "none"
    return meta


def _write_results(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
    log(f"Results written → {path}")


def _write_json_atomic(path: Path, data: dict) -> None:
    """Write JSON via temp file + rename so a concurrent reader never sees a
    torn file (the ab-verdict is read cross-process by the opencode plugin)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def _agg_totals(task_agg: dict) -> tuple[int, int]:
    """Return (n_pass, n_total) over tasks that have results (pass@k = any reward==1)."""
    n_total = 0
    n_pass = 0
    for agg in task_agg.values():
        rewards = agg.get("rewards", [])
        if not rewards:
            continue
        n_total += 1
        if max(rewards) == 1:
            n_pass += 1
    return n_pass, n_total


def select_tasks(args: argparse.Namespace) -> list[str]:
    """Resolve --all / --task-file / --tasks into a manifest-validated task list."""
    if getattr(args, "all", False):
        tasks = all_task_names()
    elif getattr(args, "task_file", None):
        tasks = [ln.strip() for ln in Path(args.task_file).read_text().splitlines()
                 if ln.strip() and not ln.startswith("#")]
    elif getattr(args, "tasks", None):
        tasks = args.tasks
    else:
        die("Specify --tasks TASK [TASK...], --task-file PATH, or --all")
    manifest = load_manifest()
    for t in tasks:
        if t not in manifest:
            die(f"Unknown task: {t!r}. Check manifest.json.")
    return tasks


def task_timeouts(task: str, tb_root: Path, max_agent_timeout: float) -> tuple[float, float]:
    """(agent_timeout, verifier_timeout) from task.toml, with optional agent cap."""
    task_toml = tb_root / task / "task.toml"
    agent_timeout = read_toml_value(task_toml, "agent", "timeout_sec") or 900.0
    if max_agent_timeout and agent_timeout > max_agent_timeout:
        log(f"  capping agent timeout {agent_timeout:.0f}s → {max_agent_timeout:.0f}s")
        agent_timeout = float(max_agent_timeout)
    verifier_timeout = read_toml_value(task_toml, "verifier", "timeout_sec") or 300.0
    return agent_timeout, verifier_timeout


def run_task_once(task: str, tb_root: Path, model: str, variant: str,
                  harness_md: str, agent_timeout: float, verifier_timeout: float) -> dict:
    """One clean-room execution: clean → setup → opencode → copy_tests → verify.
    No store/results side effects. Returns:
      {session_id, reward, elapsed, turns, tool_usage, events,
       error: '' | 'setup_failed' | 'agent_no_output'}
    """
    session_id = f"bench-{task}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    task_start = time.monotonic()

    # 1. Clean workspace (standard dirs + /tmp + task-specific extras)
    clean_dir(HOST_APP)
    clean_dir(HOST_TESTS)
    clean_dir(HOST_LOGS)
    clean_tmp()
    cleanup_task_extras(task)

    # 2. Setup task environment
    try:
        setup_task(task, tb_root)
    except subprocess.CalledProcessError as e:
        log(f"  setup_deps.sh failed (exit {e.returncode}), skipping task")
        return {"session_id": session_id, "reward": 0,
                "elapsed": round(time.monotonic() - task_start, 1),
                "turns": 0, "tool_usage": {}, "events": [], "error": "setup_failed"}

    # 3. Run OpenCode
    turn_count, tool_usage, events = run_opencode(
        task, tb_root, model, variant or None, agent_timeout, harness_md
    )
    # 4. Copy tests (with patches)
    copy_tests(task, tb_root)
    # 5. Run verifier
    reward = run_verifier(verifier_timeout, task)
    elapsed = time.monotonic() - task_start
    log(f"  reward={reward}  elapsed={elapsed:.1f}s")
    return {"session_id": session_id, "reward": reward, "elapsed": elapsed,
            "turns": turn_count, "tool_usage": tool_usage, "events": events,
            "error": "agent_no_output" if turn_count == 0 else ""}


def cmd_run(args: argparse.Namespace) -> None:
    tb_root = Path(args.tb_root).expanduser().resolve()
    if not tb_root.exists():
        die(f"TB_ROOT not found: {tb_root}")

    meta_root = META_ROOT

    tasks = select_tasks(args)

    model = args.model
    variant = args.variant or ""
    k = args.k
    layers = args.layers
    agent = args.agent or ""

    # Pins (validated eagerly; die on any error before any task runs)
    if args.pin and (args.no_harness or layers == "none"):
        die("--pin cannot be combined with --no-harness / --layers none")
    pins = parse_pins(args.pin, layers, agent, meta_root)

    # --results-file implies --no-store (keep candidate store clean)
    results_file: Optional[Path] = Path(args.results_file) if args.results_file else None
    label: str = args.label or (results_file.stem if results_file else "run")
    no_store = args.no_store or (results_file is not None)

    log(f"Running {len(tasks)} task(s) × k={k}, model={model}" + (f"+{variant}" if variant else ""))
    log(f"TB_ROOT={tb_root}  META_ROOT={meta_root}")
    if agent:
        log(f"Agent role layers: {agent}")
    if pins:
        log(f"Pinned: {', '.join(f'{n}={v}' for n, v in pins.items())}")
    if results_file:
        log(f"Results file: {results_file}  (store writes disabled)")

    # Pre-assemble harness (same for all tasks in this run)
    if args.no_harness or layers == "none":
        harness_md = ""
    else:
        harness_md = assemble_agents_md(layers, meta_root, agent, pins)
        if harness_md:
            log(f"Harness assembled ({len(harness_md)} chars)")
        else:
            log("No active harness content found — running without AGENTS.md")

    # Snapshot harness provenance before any runs
    harness_meta = (_harness_meta(layers, meta_root, agent, pins)
                    if layers != "none" else {"layers": "none"})
    run_env = env_block(harness_md, args.max_agent_timeout, model)

    results: list[dict] = []
    # Per-task aggregated results for results file: {task: {rewards:[], elapsed:[], turns:[]}}
    task_agg: dict[str, dict] = {}

    # --resume: carry over already-completed tasks from an existing results file
    # so a restarted baseline doesn't re-run them.
    done_tasks: set[str] = set()
    if args.resume and results_file and results_file.exists():
        try:
            prev = json.loads(results_file.read_text())
            for t, agg in prev.get("tasks", {}).items():
                if agg.get("rewards"):
                    task_agg[t] = agg
                    done_tasks.add(t)
            if done_tasks:
                log(f"Resuming: {len(done_tasks)} task(s) already done, will skip them")
        except Exception as e:
            log(f"  --resume: could not read prior results ({e}); starting fresh")

    run_start_ts = datetime.now(timezone.utc).isoformat()

    for task in tasks:
        if task in done_tasks:
            log(f"\n=== Task: {task} (skipped — already done) ===")
            continue
        log(f"\n=== Task: {task} ===")
        agent_timeout, verifier_timeout = task_timeouts(task, tb_root, args.max_agent_timeout)

        task_agg[task] = {"rewards": [], "elapsed": [], "turns": [], "errors": []}

        for ki in range(k):
            if k > 1:
                log(f"  -- run {ki+1}/{k} --")

            res = run_task_once(task, tb_root, model, variant, harness_md,
                                agent_timeout, verifier_timeout)

            if res["error"] == "setup_failed":
                results.append({"task": task, "k": ki + 1, "reward": 0,
                                "elapsed": 0.0, "error": "setup_failed"})
                task_agg[task]["rewards"].append(0)
                task_agg[task]["elapsed"].append(0.0)
                task_agg[task]["turns"].append(0)
                task_agg[task]["errors"].append("setup_failed")
                continue

            reward = res["reward"]
            elapsed = res["elapsed"]
            turn_count = res["turns"]
            passed = reward == 1

            # Record to candidate store (skipped when results_file / --no-store)
            record_to_stores(
                task, res["session_id"], passed, turn_count, res["tool_usage"],
                model, variant, layers, meta_root, no_store, agent, pins, run_env,
                res.get("events"), args.save_all_traj,
            )

            results.append({
                "task": task,
                "k": ki + 1,
                "reward": reward,
                "elapsed": elapsed,
                "session_id": res["session_id"],
            })
            task_agg[task]["rewards"].append(reward)
            task_agg[task]["elapsed"].append(round(elapsed, 1))
            task_agg[task]["turns"].append(turn_count)

            # Persist incremental results after each task (resumability)
            if results_file:
                np, nt = _agg_totals(task_agg)
                _write_results(results_file, {
                    "label": label,
                    "model": model,
                    "variant": variant,
                    "harness": harness_meta,
                    "k": k,
                    "timestamp": run_start_ts,
                    "n_pass": np,
                    "n_total": nt,
                    "pass_rate": round(np / nt, 4) if nt else 0.0,
                    "tasks": task_agg,
                    "status": "in_progress",
                })

    # Final summary table
    print("\n" + "=" * 60)
    print(f"{'Task':<40} {'K':>2}  {'Reward':>6}  {'Elapsed':>8}")
    print("-" * 60)
    total_pass = 0
    total_runs = 0
    for r in results:
        name = r["task"][:39]
        ki = r.get("k", 1)
        rew = r["reward"]
        elapsed = r.get("elapsed", 0.0)
        total_pass += rew
        total_runs += 1
        print(f"{name:<40} {ki:>2}  {rew:>6}  {elapsed:>7.1f}s")
    print("=" * 60)
    if total_runs:
        pct = 100.0 * total_pass / total_runs
        print(f"pass@{k}: {total_pass}/{total_runs}  ({pct:.1f}%)")

    # Write final results file (totals from task_agg so resumed tasks count)
    if results_file:
        np, nt = _agg_totals(task_agg)
        _write_results(results_file, {
            "label": label,
            "model": model,
            "variant": variant,
            "harness": harness_meta,
            "k": k,
            "timestamp": run_start_ts,
            "n_pass": np,
            "n_total": nt,
            "pass_rate": round(np / nt, 4) if nt else 0.0,
            "tasks": task_agg,
            "status": "complete",
        })
        log(f"FINAL: {np}/{nt} passed ({100.0*np/nt:.1f}%)" if nt else "FINAL: no tasks")


# ── oracle command ─────────────────────────────────────────────────────────


def cmd_oracle(args: argparse.Namespace) -> None:
    """
    Run tasks using their solution/solve.sh to validate the pipeline
    without spending LLM tokens. Expected reward: 1 for all tasks.
    """
    tb_root = Path(args.tb_root).expanduser().resolve()
    if not tb_root.exists():
        die(f"TB_ROOT not found: {tb_root}")

    tasks = args.tasks if args.tasks else all_task_names()
    results_file: Optional[Path] = Path(args.results_file) if args.results_file else None

    log(f"Oracle validation: {len(tasks)} task(s)")
    if results_file:
        log(f"Results file: {results_file}")

    results: list[dict] = []
    run_start_ts = datetime.now(timezone.utc).isoformat()

    for task in tasks:
        log(f"\n=== Oracle: {task} ===")
        task_toml = tb_root / task / "task.toml"
        verifier_timeout = read_toml_value(task_toml, "verifier", "timeout_sec") or 300.0

        task_start = time.monotonic()

        # Clean (standard dirs + /tmp + task-specific extras)
        clean_dir(HOST_APP)
        clean_dir(HOST_TESTS)
        clean_dir(HOST_LOGS)
        clean_tmp()
        cleanup_task_extras(task)

        # Setup
        try:
            setup_task(task, tb_root)
        except subprocess.CalledProcessError as e:
            log(f"  setup_deps.sh failed (exit {e.returncode})")
            results.append({"task": task, "reward": 0, "elapsed": 0.0, "error": "setup_failed"})
            continue

        # Run solution
        solve_sh = tb_root / task / "solution" / "solve.sh"
        if not solve_sh.exists():
            log(f"  WARNING: no solution/solve.sh — skipping agent step")
        else:
            agent_timeout = read_toml_value(task_toml, "agent", "timeout_sec") or 900.0
            log(f"  Running solution/solve.sh (timeout={agent_timeout:.0f}s)...")
            try:
                run_cmd(
                    ["bash", str(solve_sh)],
                    cwd=REAL_APP,
                    timeout=agent_timeout,
                    check=False,
                    ns=True,
                    extra_mounts=task_extra_mounts(task),
                )
            except subprocess.TimeoutExpired:
                log(f"  solve.sh timed out")

        # Copy tests
        copy_tests(task, tb_root)

        # Verify
        reward = run_verifier(verifier_timeout, task)
        elapsed = time.monotonic() - task_start
        status = "PASS" if reward == 1 else "FAIL"
        log(f"  [{status}] reward={reward}  elapsed={elapsed:.1f}s")
        results.append({"task": task, "reward": reward, "elapsed": round(elapsed, 1)})

        # Incremental write
        if results_file:
            n_pass_so_far = sum(r["reward"] for r in results)
            _write_results(results_file, {
                "label": "oracle",
                "timestamp": run_start_ts,
                "n_pass": n_pass_so_far,
                "n_total": len(results),
                "pass_rate": round(n_pass_so_far / len(results), 4),
                "tasks": {r["task"]: {"reward": r["reward"], "elapsed": r.get("elapsed", 0.0),
                                      "error": r.get("error", "")}
                          for r in results},
                "status": "in_progress",
            })

    # Summary
    print("\n" + "=" * 60)
    print(f"{'Task':<40}  {'Result':>6}  {'Elapsed':>8}")
    print("-" * 60)
    total_pass = 0
    for r in results:
        name = r["task"][:39]
        rew = r["reward"]
        elapsed = r.get("elapsed", 0.0)
        total_pass += rew
        status = "PASS" if rew == 1 else "FAIL"
        print(f"{name:<40}  {status:>6}  {elapsed:>7.1f}s")
    print("=" * 60)
    n = len(results)
    if n:
        pct = 100.0 * total_pass / n
        print(f"Oracle pass rate: {total_pass}/{n}  ({pct:.1f}%)")
        if total_pass < n:
            failing = [r["task"] for r in results if r["reward"] == 0]
            print(f"Failing tasks ({len(failing)}): {', '.join(failing)}")

    # Final results file
    if results_file:
        _write_results(results_file, {
            "label": "oracle",
            "timestamp": run_start_ts,
            "n_pass": total_pass,
            "n_total": n,
            "pass_rate": round(total_pass / n, 4) if n else 0.0,
            "tasks": {r["task"]: {"reward": r["reward"], "elapsed": r.get("elapsed", 0.0),
                                  "error": r.get("error", "")}
                      for r in results},
            "status": "complete",
        })


# ── held-out split ─────────────────────────────────────────────────────────


def load_active_split(splits_path: Path) -> tuple[list[str], list[str], dict]:
    """Return (held_in, held_out, split_meta) from splits.json.
    held_out = folds[activeFold]; held_in = all other folds concatenated."""
    data = json.loads(splits_path.read_text())
    folds = data["folds"]
    active = int(data.get("activeFold", 0))
    held_out = list(folds[active])
    held_in = [t for i, f in enumerate(folds) if i != active for t in f]
    meta = {"file": splits_path.name, "activeFold": active,
            "heldIn": held_in, "heldOut": held_out}
    return held_in, held_out, meta


def cmd_split(args: argparse.Namespace) -> None:
    from bench_store import append_meta_metric
    splits_path = Path(args.split_file) if args.split_file else SPLITS_PATH_DEFAULT
    if args.split_cmd == "make":
        source = SCRIPT_DIR / args.source
        tasks = [ln.strip() for ln in source.read_text().splitlines()
                 if ln.strip() and not ln.startswith("#")]
        if not tasks:
            die(f"split make: no tasks in {source}")
        shuffled = tasks[:]
        random.Random(args.seed).shuffle(shuffled)
        k = args.folds
        folds = [shuffled[i::k] for i in range(k)]   # round-robin over a shuffled list → balanced
        data = {"schemaVersion": 1, "seed": args.seed, "source": source.name,
                "folds": folds, "activeFold": 0, "rotatedAt": None}
        _write_json_atomic(splits_path, data)
        log(f"split: wrote {splits_path} — {len(tasks)} tasks, {k} folds "
            f"(sizes {[len(f) for f in folds]})")
    elif args.split_cmd == "rotate":
        if not splits_path.exists():
            die(f"split rotate: {splits_path} not found — run 'split make' first")
        data = json.loads(splits_path.read_text())
        n = len(data["folds"])
        data["activeFold"] = (int(data.get("activeFold", 0)) + 1) % n
        data["rotatedAt"] = datetime.now(timezone.utc).isoformat()
        _write_json_atomic(splits_path, data)
        append_meta_metric({"event": "rotate", "splitFold": data["activeFold"],
                            "ts": data["rotatedAt"]})
        log(f"split: rotated → activeFold={data['activeFold']} of {n}")
    else:  # show
        if not splits_path.exists():
            die(f"split show: {splits_path} not found — run 'split make' first")
        data = json.loads(splits_path.read_text())
        held_in, held_out, meta = load_active_split(splits_path)
        print(f"splits: {splits_path}  seed={data.get('seed')}  folds={len(data['folds'])}  "
              f"activeFold={meta['activeFold']}  sizes={[len(f) for f in data['folds']]}")
        print(f"  held-out ({len(held_out)}): {', '.join(held_out)}")
        print(f"  held-in  ({len(held_in)}): {', '.join(held_in)}")


# ── ab command ─────────────────────────────────────────────────────────────


def cmd_ab(args: argparse.Namespace) -> None:
    """Statistically-gated A/B of a candidate vs the active version of ONE layer.

    Arm A = all-active composition, arm B = same but the target layer pinned to
    the candidate; interleaved per run-pair to neutralise drift. By default the
    task set is the checked-in held-in/held-out split (splits.json): held-in is
    scored first with a futility early-kill; the held-out fold is run only if the
    candidate survives, and its arm-B sessions are NEVER written to score.json
    (the proposer must never see them). The decision (accept|reject|inconclusive)
    comes from ab_stats.decide over paired McNemar + a held-out no-regression
    guard. Writes candidates/<vN>/ab-verdict.json — the contract /mh-activate reads.
    """
    from bench_store import (
        active_version, append_meta_metric, candidate_exists, candidate_path,
        list_versions, record_session, write_trajectory, prune_trajectories,
    )
    from ab_stats import (
        DecisionConfig, paired_run_stats, futility_stop, decide,
        bootstrap_task_ci, mcnemar_exact_one_sided,
    )
    tb_root = Path(args.tb_root).expanduser().resolve()
    if not tb_root.exists():
        die(f"TB_ROOT not found: {tb_root}")
    meta_root = META_ROOT

    layer = args.layer
    candidate = args.candidate
    agent = args.agent or ""
    layers = args.layers
    model = args.model
    variant = args.variant or ""
    k = args.k
    no_store = args.no_store

    if not re.fullmatch(r"v\d+", candidate):
        die(f"--candidate must look like vN, got {candidate!r}")
    if layer in ("account-role", "project-role") and not agent:
        die(f"--layer {layer} requires --agent")

    roots = dict(layer_store_roots(layers, agent, meta_root))
    if layer not in roots:
        die(f"--layer {layer} not included by --layers {layers}"
            + ("" if agent else " (role layers need --agent)"))
    layer_root = roots[layer]

    if not candidate_exists(layer_root, candidate):
        have = ", ".join(list_versions(layer_root)) or "none"
        die(f"no such candidate {candidate} under {layer_root} (have: {have})")

    baseline = active_version(layer_root)
    if baseline == candidate:
        die(f"candidate {candidate} is already the active version — nothing to compare")

    # ── Task selection: split (default) vs legacy explicit ──────────────────
    explicit = bool(args.tasks or args.task_file or args.all)
    if explicit:
        held_in_tasks = select_tasks(args)
        held_out_tasks: list[str] = []
        split_meta = None
        active_fold = -1
        log("ab: LEGACY mode (explicit tasks) — no held-out split; a verdict can be "
            "reject/inconclusive only, never accept")
    else:
        splits_path = Path(args.split_file) if args.split_file else SPLITS_PATH_DEFAULT
        if not splits_path.exists():
            die(f"no split at {splits_path} — run 'runner.py split make', or pass "
                "--tasks/--task-file/--all for legacy mode")
        held_in_tasks, held_out_tasks, split_meta = load_active_split(splits_path)
        active_fold = split_meta["activeFold"]
        manifest = load_manifest()
        for t in held_in_tasks + held_out_tasks:
            if t not in manifest:
                die(f"split task {t!r} not in manifest.json")

    # Compose both arms once (they differ in exactly one layer by construction)
    harness_a = assemble_agents_md(layers, meta_root, agent, pins={})
    harness_b = assemble_agents_md(layers, meta_root, agent, pins={layer: candidate})
    env_b = env_block(harness_b, args.max_agent_timeout, model)

    cfg = DecisionConfig(alpha=args.alpha, nonregress_margin=args.nonregress_margin)
    early_stop = not args.no_early_stop
    min_tasks = args.min_tasks_before_stop

    verdict_path = candidate_path(layer_root, candidate, "ab-verdict.json")
    partial_path = candidate_path(layer_root, candidate, "ab-verdict.partial.json")

    run_ident = {"layer": layer, "candidate": candidate, "baseline": baseline,
                 "model": model, "k": k, "activeFold": active_fold}

    log(f"A/B: {layer} {candidate} vs active {baseline}  "
        f"held-in={len(held_in_tasks)} held-out={len(held_out_tasks)}  k={k}  "
        f"fold={active_fold}")
    if agent:
        log(f"Agent role layers: {agent}")

    task_results: dict[str, dict] = {}
    early_stopped = False

    if args.resume and partial_path.exists():
        try:
            prev = json.loads(partial_path.read_text())
        except Exception:
            prev = {}
        for kk, v in run_ident.items():
            if prev.get(kk) != v:
                die(f"--resume: prior partial {kk}={prev.get(kk)!r} != {v!r}; "
                    "delete the partial to restart")
        early_stopped = bool(prev.get("earlyStopped", False))
        for t, tr in prev.get("taskResults", {}).items():
            if tr.get("error") == "setup_failed":
                task_results[t] = tr
            elif len(tr.get("candidate", [])) >= k and len(tr.get("active", [])) >= k:
                task_results[t] = tr
        if task_results:
            log(f"Resuming ab: {len(task_results)} task(s) already complete"
                + (" (early-stopped)" if early_stopped else ""))

    run_start_ts = datetime.now(timezone.utc).isoformat()

    def _stats(phase: str):
        sub = {t: tr for t, tr in task_results.items() if tr.get("phase") == phase}
        return paired_run_stats(sub)

    def _stats_block(ps) -> dict:
        return {"nTasks": ps.n_tasks, "nPairs": ps.n_pairs, "b": ps.b, "c": ps.c,
                "delta": round(ps.delta, 4),
                "mcnemarP": round(mcnemar_exact_one_sided(ps.b, ps.c), 4),
                "bootCI90": list(bootstrap_task_ci(list(ps.task_deltas.values())))}

    def _verdict_dict(status: str) -> dict:
        hi = _stats("held-in")
        ho = _stats("held-out") if held_out_tasks else None
        decision, reasons = decide(hi, ho, cfg)
        if early_stopped and decision != "reject":
            decision = "reject"
            reasons.append("early-stopped on futility")
        winner = {"accept": "candidate", "reject": "active", "inconclusive": "tie"}[decision]
        included = {t: tr for t, tr in task_results.items() if not tr.get("error")}
        n_all = len(included)
        cand_pass = sum(1 for tr in included.values() if tr["candidate"] and max(tr["candidate"]) == 1)
        act_pass = sum(1 for tr in included.values() if tr["active"] and max(tr["active"]) == 1)
        d = {
            "schemaVersion": 2,
            "layer": layer, "candidate": candidate, "baseline": baseline,
            "decision": decision, "winner": winner, "reasons": reasons,
            "candidateRate": round(cand_pass / n_all, 4) if n_all else 0.0,
            "activeRate": round(act_pass / n_all, 4) if n_all else 0.0,
            "nTasks": n_all, "k": k,
            "heldIn": _stats_block(hi),
            "heldOut": _stats_block(ho) if ho else None,
            "earlyStopped": early_stopped,
            "split": split_meta,
            "env": env_b,
            "taskResults": task_results,
            "model": model, "variant": variant, "timestamp": run_start_ts,
        }
        if status:
            d["status"] = status
        return d

    def _run_phase(phase: str, task_list: list[str], record_arm_b: bool) -> None:
        nonlocal early_stopped
        for task in task_list:
            if early_stopped:
                break
            if task in task_results:
                log(f"\n=== ab {task} [{phase}] (skipped — already done) ===")
                continue
            log(f"\n=== ab {task} [{phase}]: {candidate} vs active {baseline} ===")
            at, vt = task_timeouts(task, tb_root, args.max_agent_timeout)
            tr: dict = {"candidate": [], "active": [], "phase": phase}
            for ki in range(k):
                if k > 1:
                    log(f"  -- pair {ki+1}/{k} --")
                log("  [arm A: active]")
                res_a = run_task_once(task, tb_root, model, variant, harness_a, at, vt)
                log("  [arm B: candidate]")
                res_b = run_task_once(task, tb_root, model, variant, harness_b, at, vt)
                if res_a["error"] == "setup_failed" or res_b["error"] == "setup_failed":
                    tr["error"] = "setup_failed"
                    log("  setup_failed — task excluded from rates")
                    break
                tr["active"].append(res_a["reward"])
                tr["candidate"].append(res_b["reward"])
                # Record ONLY arm B, and ONLY for held-in (held-out stays invisible
                # to the proposer — evaluator outside the loop).
                if record_arm_b and not no_store and res_b["turns"] > 0:
                    rec = _session_record(task, res_b["session_id"], res_b["reward"] == 1,
                                          res_b["turns"], res_b["tool_usage"], model, variant, env_b)
                    score = record_session(layer_root, candidate, rec)
                    if res_b.get("events") and (res_b["reward"] != 1 or args.save_all_traj):
                        write_trajectory(layer_root, candidate, res_b["session_id"], res_b["events"])
                        prune_trajectories(layer_root, candidate)
                    log(f"  store {layer} {candidate}: nPass={score['nPass']} nFail={score['nFail']}")
            task_results[task] = tr
            _write_json_atomic(partial_path, _verdict_dict("in_progress"))

            if phase == "held-in" and early_stop:
                hi = _stats("held-in")
                if futility_stop(hi.b, hi.c, hi.n_tasks, min_tasks=min_tasks):
                    early_stopped = True
                    log(f"  FUTILITY: candidate behind (b={hi.b} c={hi.c}) after "
                        f"{hi.n_tasks} held-in tasks — early stop")

    _run_phase("held-in", held_in_tasks, record_arm_b=True)
    if not early_stopped:
        _run_phase("held-out", held_out_tasks, record_arm_b=False)

    final = _verdict_dict("")   # final file never carries a status key
    _write_json_atomic(verdict_path, final)
    append_meta_metric({
        "event": "ab", "layer": layer, "candidate": candidate, "baseline": baseline,
        "decision": final["decision"], "heldInDelta": final["heldIn"]["delta"],
        "heldInP": final["heldIn"]["mcnemarP"], "nPairs": final["heldIn"]["nPairs"],
        "heldOutDelta": (final["heldOut"] or {}).get("delta"),
        "splitFold": (split_meta or {}).get("activeFold"),
        "earlyStopped": final["earlyStopped"], "model": model,
    })
    partial_path.unlink(missing_ok=True)

    # Summary
    print("\n" + "=" * 74)
    print(f"{'Task':<30} {'phase':>9} {'candidate':>12} {'active':>10}  {'verdict':>7}")
    print("-" * 74)
    for t, tr in task_results.items():
        ph = tr.get("phase", "?")
        if tr.get("error") == "setup_failed":
            print(f"{t[:29]:<30} {ph:>9} {'—':>12} {'—':>10}  {'skip':>7}")
            continue
        cp = max(tr["candidate"]); ap = max(tr["active"])
        v = "cand" if cp > ap else ("active" if cp < ap else "tie")
        print(f"{t[:29]:<30} {ph:>9} {str(tr['candidate']):>12} {str(tr['active']):>10}  {v:>7}")
    print("=" * 74)
    hi = final["heldIn"]; ho = final["heldOut"]
    print(f"DECISION: {final['decision'].upper()}   (winner={final['winner']})")
    print(f"  held-in : delta={hi['delta']:+.3f} McNemar p={hi['mcnemarP']} "
          f"CI90={hi['bootCI90']} (n={hi['nPairs']} pairs, b={hi['b']} c={hi['c']})")
    if ho:
        print(f"  held-out: delta={ho['delta']:+.3f} McNemar p={ho['mcnemarP']} "
              f"CI90={ho['bootCI90']} (n={ho['nPairs']} pairs)")
    for r in final["reasons"]:
        print(f"  · {r}")
    log(f"Verdict written → {verdict_path}")

    if args.results_file:
        _write_json_atomic(Path(args.results_file), final)


# ── CLI ────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--tb-root",
        default=str(TB_ROOT_DEFAULT),
        help=f"Path to terminal-bench-2 checkout (default: {TB_ROOT_DEFAULT})",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # prep
    p_prep = sub.add_parser(
        "prep",
        help="One-time host setup (mkdir + apt) or uninstall of newly-added packages",
    )
    p_prep.add_argument(
        "--apply", action="store_true",
        help="Actually run the commands (requires sudo). Default: dry-run.",
    )
    p_prep.add_argument(
        "--uninstall", action="store_true",
        help="Remove only the packages that prep --apply newly installed "
             "(uses .prep-installed.txt). Dry-run unless --apply is also given.",
    )
    p_prep.add_argument(
        "--clean-mountpoints", action="store_true",
        help="Remove the empty bwrap mount-point placeholder dirs "
             "(/app /tests /logs /data /protected /workspace). "
             "Dry-run unless --apply is also given.",
    )

    # run
    p_run = sub.add_parser("run", help="Run tasks through OpenCode")
    p_run.add_argument("--tasks", nargs="+", metavar="TASK", help="Task name(s)")
    p_run.add_argument("--task-file", metavar="PATH",
                       help="File with one task name per line (e.g. baseline-tasks.txt)")
    p_run.add_argument("--all", action="store_true", help="Run all 59 target tasks")
    p_run.add_argument("--model", default="anthropic/claude-sonnet-4-6",
                       help="Model ID (provider-prefixed, e.g. anthropic/claude-sonnet-4-6; "
                            "a bare name may fail provider resolution under oauth)")
    p_run.add_argument("--variant", default="", help="Model variant (e.g. high, low)")
    p_run.add_argument("--k", type=int, default=1, help="Runs per task (for pass@k)")
    p_run.add_argument(
        "--layers", default="global",
        choices=["global", "account", "project", "none"],
        help="Which global store layers to inject as AGENTS.md. "
             "global=both, account=account-global only, project=project-global only, none=no harness.",
    )
    p_run.add_argument("--no-store", action="store_true", help="Do not write to harness store")
    p_run.add_argument("--save-all-traj", action="store_true",
                       help="Persist trajectories for PASSING runs too (default: failures only)")
    p_run.add_argument("--no-harness", action="store_true", help="Do not write AGENTS.md")
    p_run.add_argument(
        "--results-file", metavar="PATH",
        help="Write per-task results to this JSON file (implies --no-store). "
             "Updated after each task for resumability. "
             "Example: results/baseline-v3.json",
    )
    p_run.add_argument(
        "--label", metavar="NAME",
        help="Label for this run in the results file (default: stem of --results-file or 'run')",
    )
    p_run.add_argument(
        "--max-agent-timeout", type=float, metavar="SEC", default=0,
        help="Cap each task's agent timeout at SEC seconds (0 = use task.toml "
             "value). Bounds total runtime; e.g. 600 caps hour-long tasks to 10 min.",
    )
    p_run.add_argument(
        "--resume", action="store_true",
        help="Skip tasks already present (with results) in --results-file, "
             "carrying their prior results forward. For restarting long runs.",
    )
    p_run.add_argument(
        "--agent", default="", metavar="NAME",
        help="Also compose/record the account-role + project-role layers for "
             "this agent (e.g. mh-build).",
    )
    p_run.add_argument(
        "--pin", action="append", default=[], metavar="LAYER=vN",
        help="Pin a store layer to a candidate version instead of active "
             "(repeatable). LAYER: account-global|project-global|account-role|"
             "project-role. Pinned-layer scores record into that candidate's "
             "score.json.",
    )

    # ab
    p_ab = sub.add_parser("ab", help="A/B a candidate vs active for one layer")
    p_ab.add_argument("--layer", required=True, choices=list(LAYER_CHOICES),
                      help="Which layer's candidate to test")
    p_ab.add_argument("--candidate", required=True, metavar="vN",
                      help="Candidate version to compare against the active version")
    p_ab.add_argument("--tasks", nargs="+", metavar="TASK",
                      help="Explicit task(s) — LEGACY mode (no held-out split; never accepts)")
    p_ab.add_argument("--task-file", metavar="PATH",
                      help="File with one task name per line — LEGACY mode")
    p_ab.add_argument("--all", action="store_true", help="All target tasks — LEGACY mode")
    p_ab.add_argument("--split-file", metavar="PATH",
                      help="splits.json path (default: term-bench2/splits.json). "
                           "Ignored when --tasks/--task-file/--all is given.")
    p_ab.add_argument("--model", default="anthropic/claude-sonnet-4-6",
                      help="Model ID (provider-prefixed; a bare name may fail "
                           "provider resolution under oauth)")
    p_ab.add_argument("--variant", default="", help="Model variant (e.g. high, low)")
    p_ab.add_argument("--k", type=int, default=2,
                      help="Run-pairs (A+B) per task (default 2 — the inferential unit)")
    p_ab.add_argument("--layers", default="global", choices=["global", "account", "project"],
                      help="Which side layers to compose (ab needs a composition; no 'none')")
    p_ab.add_argument("--agent", default="", metavar="NAME",
                      help="Role agent (required for account-role/project-role layers)")
    p_ab.add_argument("--alpha", type=float, default=0.05,
                      help="Held-in McNemar significance threshold for acceptance")
    p_ab.add_argument("--nonregress-margin", type=float, default=0.05,
                      help="Tolerated held-out point drop before it counts as a regression")
    p_ab.add_argument("--min-tasks-before-stop", type=int, default=12,
                      help="Held-in tasks completed before futility early-kill can trigger")
    p_ab.add_argument("--no-early-stop", action="store_true",
                      help="Disable the futility early-kill (run every task)")
    p_ab.add_argument("--max-agent-timeout", type=float, metavar="SEC", default=0,
                      help="Cap each task's agent timeout at SEC seconds")
    p_ab.add_argument("--resume", action="store_true",
                      help="Resume from ab-verdict.partial.json (completed tasks skipped)")
    p_ab.add_argument("--no-store", action="store_true",
                      help="Do not write held-in arm-B scores into the candidate's score.json "
                           "(the verdict file is always written)")
    p_ab.add_argument("--save-all-traj", action="store_true",
                      help="Persist trajectories for PASSING held-in runs too (default: failures only)")
    p_ab.add_argument("--results-file", metavar="PATH",
                      help="Also write the final verdict JSON here (does NOT disable store)")

    # split
    p_split = sub.add_parser("split", help="Manage the held-in/held-out task split (splits.json)")
    p_split.add_argument("split_cmd", choices=["make", "rotate", "show"])
    p_split.add_argument("--seed", type=int, default=42, help="shuffle seed for 'make'")
    p_split.add_argument("--folds", type=int, default=4, help="number of folds for 'make'")
    p_split.add_argument("--source", default="baseline-tasks.txt",
                         help="task list file in term-bench2/ (for 'make')")
    p_split.add_argument("--split-file", metavar="PATH",
                         help="splits.json path (default: term-bench2/splits.json)")

    # oracle
    p_oracle = sub.add_parser("oracle", help="Validate pipeline with solution/solve.sh")
    p_oracle.add_argument("--tasks", nargs="+", metavar="TASK", help="Task(s) to validate (default: all)")
    p_oracle.add_argument(
        "--results-file", metavar="PATH",
        help="Write oracle results to this JSON file (updated after each task).",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    # Propagate tb-root into sub-commands that need it
    if not hasattr(args, "tb_root"):
        args.tb_root = str(TB_ROOT_DEFAULT)

    if args.command == "prep":
        cmd_prep(args)
    elif args.command == "run":
        cmd_run(args)
    elif args.command == "ab":
        cmd_ab(args)
    elif args.command == "split":
        cmd_split(args)
    elif args.command == "oracle":
        cmd_oracle(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
