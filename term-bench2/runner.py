#!/usr/bin/env python3
"""
runner.py — Terminal-Bench 2 harness runner for meta-harness evolution.

Commands:
  prep   [--apply]          Print (or run) one-time host setup: mkdir + apt union install.
  run    [options]          Run tasks through OpenCode, score, record in store.
  oracle [--tasks T [T…]]   Validate pipeline using solution/solve.sh (no LLM tokens).

Examples:
  python3 runner.py prep
  python3 runner.py prep --apply
  python3 runner.py oracle --tasks openssl-selfsigned-cert
  python3 runner.py run --tasks adaptive-rejection-sampler --model claude-sonnet-4-6
  python3 runner.py run --all --model claude-sonnet-4-6 --variant high --k 1
"""

from __future__ import annotations

import argparse
import json
import os
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

# Real host dirs used as bind-mounts (matching TB2 container layout)
HOST_APP = Path("/app")
HOST_TESTS = Path("/tests")
HOST_LOGS = Path("/logs/verifier")

# Manifest of all 59 target tasks
MANIFEST_PATH = SCRIPT_DIR / "manifest.json"
TASKS_DIR = SCRIPT_DIR / "tasks"
PATCHES_DIR = SCRIPT_DIR / "patches"
APT_PACKAGES_TXT = SCRIPT_DIR / "apt-packages.txt"

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
) -> subprocess.CompletedProcess:
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
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
    """Read /logs/verifier/reward.txt → 0 or 1."""
    try:
        txt = HOST_LOGS.joinpath("reward.txt").read_text().strip()
        return int(txt) if txt in ("0", "1") else 0
    except Exception:
        return 0


def clean_dir(d: Path) -> None:
    """Remove and recreate a directory."""
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)


# ── prep command ───────────────────────────────────────────────────────────


def cmd_prep(args: argparse.Namespace) -> None:
    """Print (or execute) one-time host setup commands."""
    apt_pkgs = sorted(APT_PACKAGES_TXT.read_text().splitlines()) if APT_PACKAGES_TXT.exists() else []
    apt_line = "sudo apt-get install -y \\\n  " + " \\\n  ".join(apt_pkgs) if apt_pkgs else "# (no apt packages)"

    user = os.environ.get("USER", os.environ.get("LOGNAME", "$(whoami)"))
    commands = [
        f"sudo mkdir -p {HOST_APP} {HOST_TESTS} {HOST_LOGS}",
        f"sudo chown -R {user} {HOST_APP} {HOST_TESTS} /logs",
        apt_line,
    ]

    if args.apply:
        log("Running host setup (requires sudo)...")
        # dirs + chown
        subprocess.run(
            ["sudo", "mkdir", "-p", str(HOST_APP), str(HOST_TESTS), str(HOST_LOGS)],
            check=True,
        )
        subprocess.run(
            ["sudo", "chown", "-R", f"{user}", str(HOST_APP), str(HOST_TESTS), "/logs"],
            check=True,
        )
        # apt
        if apt_pkgs:
            subprocess.run(
                ["sudo", "apt-get", "install", "-y"] + apt_pkgs,
                check=True,
            )
        log("Host setup complete.")
    else:
        print("# One-time host setup — run with --apply to execute:")
        print()
        for c in commands:
            print(c)
        print()
        print("# Then re-run: python3 runner.py prep --apply")


# ── harness assembly ───────────────────────────────────────────────────────


def assemble_agents_md(layers: str, meta_root: Path) -> str:
    """
    Build AGENTS.md content from the active global store layers.
    layers: 'global' | 'account' | 'project' | 'none'
    """
    # Import here to keep startup fast
    from bench_store import (
        account_global_root,
        project_global_root,
        read_active_system,
        read_active_tools,
    )

    parts: list[str] = []

    def maybe_add(root: Path, label: str) -> None:
        sys_txt = read_active_system(root)
        tools_txt = read_active_tools(root)
        if sys_txt:
            parts.append(f"## {label} guidance\n\n{sys_txt}")
        if tools_txt:
            parts.append(f"## {label} tool usage\n\n{tools_txt}")

    if layers in ("global", "account"):
        maybe_add(account_global_root(), "General coding")
    if layers in ("global", "project"):
        maybe_add(project_global_root(meta_root), "Project")

    return "\n\n---\n\n".join(parts)


# ── per-task setup ─────────────────────────────────────────────────────────


def setup_task(task: str, tb_root: Path) -> None:
    """Run setup_deps.sh with SKIP_APT=1 and WORKDIR=/app."""
    setup_script = TASKS_DIR / task / "setup_deps.sh"
    if not setup_script.exists():
        die(f"No setup_deps.sh for task {task!r} — did you run gen_setup_deps.py?")
    env = {
        "TB_ROOT": str(tb_root),
        "WORKDIR": str(HOST_APP),
        "SKIP_APT": "1",
    }
    log(f"  setup_deps.sh ({task})...")
    run_cmd(["bash", str(setup_script)], env=env)


# ── OpenCode invocation ────────────────────────────────────────────────────


def run_opencode(
    task: str,
    tb_root: Path,
    model: str,
    variant: Optional[str],
    agent_timeout: float,
    harness_md: str,
) -> tuple[int, dict]:
    """
    Write AGENTS.md, run opencode, return (turnCount, toolUsage).
    """
    instruction_path = tb_root / task / "instruction.md"
    if not instruction_path.exists():
        die(f"instruction.md not found: {instruction_path}")
    instruction = instruction_path.read_text()

    # Write harness into workspace
    if harness_md:
        HOST_APP.joinpath("AGENTS.md").write_text(harness_md)

    # Build opencode command
    cmd = [
        "opencode", "run",
        "--dir", str(HOST_APP),
        "--auto",
        "--model", model,
    ]
    if variant:
        cmd += ["--variant", variant]

    # Pass instruction via stdin or as arg (opencode run accepts a prompt string)
    cmd.append(instruction)

    log(f"  opencode run (timeout={agent_timeout:.0f}s)...")
    start = time.monotonic()
    try:
        result = run_cmd(
            cmd,
            cwd=HOST_APP,
            timeout=agent_timeout,
            capture=True,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log(f"  opencode timed out after {agent_timeout:.0f}s")
        return 0, {}
    elapsed = time.monotonic() - start

    # Parse output for turn count and tool usage (best-effort JSON events)
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
            tool = event.get("name", "unknown")
            tool_usage.setdefault(tool, {"calls": 0, "errors": 0})
            tool_usage[tool]["calls"] += 1
        elif evt_type == "tool_result":
            if event.get("is_error"):
                tool = event.get("tool_name", "unknown")
                tool_usage.setdefault(tool, {"calls": 0, "errors": 0})
                tool_usage[tool]["errors"] += 1
        elif evt_type == "message_stop":
            turn_count += 1

    log(f"  opencode done in {elapsed:.1f}s, turns={turn_count}")
    return turn_count, tool_usage


# ── verifier ───────────────────────────────────────────────────────────────


def copy_tests(task: str, tb_root: Path) -> None:
    """Copy test files into /tests, preferring patches/ overrides."""
    clean_dir(HOST_TESTS)
    # Base: tb_root/<task>/tests/
    src = tb_root / task / "tests"
    if src.is_dir():
        for f in src.iterdir():
            shutil.copy2(f, HOST_TESTS / f.name)
    # Overlay: patches/<task>/
    patch_src = PATCHES_DIR / task
    if patch_src.is_dir():
        for f in patch_src.iterdir():
            shutil.copy2(f, HOST_TESTS / f.name)
            log(f"  patch applied: {f.name}")


def run_verifier(verifier_timeout: float) -> int:
    """Run /tests/test.sh and return reward (0 or 1)."""
    clean_dir(HOST_LOGS)
    test_sh = HOST_TESTS / "test.sh"
    if not test_sh.exists():
        log("  WARNING: no test.sh found")
        return 0
    log(f"  verifier (timeout={verifier_timeout:.0f}s)...")
    try:
        run_cmd(
            ["bash", str(test_sh)],
            cwd=HOST_TESTS,
            timeout=verifier_timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log(f"  verifier timed out after {verifier_timeout:.0f}s")
    return read_reward()


# ── store recording ────────────────────────────────────────────────────────


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
) -> None:
    if no_store:
        return

    from bench_store import (
        account_global_root,
        active_version,
        project_global_root,
        record_session,
    )

    record = {
        "sessionID": session_id,
        "passed": passed,
        "note": "",
        "turnCount": turn_count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": task,
        "model": model,
        "variant": variant or "",
        "toolUsage": tool_usage,
    }

    roots = []
    if layers in ("global", "account"):
        roots.append(account_global_root())
    if layers in ("global", "project"):
        roots.append(project_global_root(meta_root))

    for root in roots:
        ver = active_version(root)
        score = record_session(root, ver, record)
        log(f"  store {root.name} {ver}: nPass={score['nPass']} nFail={score['nFail']}")


# ── run command ────────────────────────────────────────────────────────────


def cmd_run(args: argparse.Namespace) -> None:
    tb_root = Path(args.tb_root).expanduser().resolve()
    if not tb_root.exists():
        die(f"TB_ROOT not found: {tb_root}")

    meta_root = META_ROOT

    # Task selection
    if args.all:
        tasks = all_task_names()
    elif args.tasks:
        tasks = args.tasks
    else:
        die("Specify --tasks TASK [TASK...] or --all")

    manifest = load_manifest()
    for t in tasks:
        if t not in manifest:
            die(f"Unknown task: {t!r}. Check manifest.json.")

    model = args.model
    variant = args.variant or ""
    k = args.k
    layers = args.layers

    log(f"Running {len(tasks)} task(s) × k={k}, model={model}" + (f"+{variant}" if variant else ""))
    log(f"TB_ROOT={tb_root}  META_ROOT={meta_root}")

    # Pre-assemble harness (same for all tasks in this run)
    if args.no_harness:
        harness_md = ""
    else:
        harness_md = assemble_agents_md(layers, meta_root)
        if harness_md:
            log(f"Harness assembled ({len(harness_md)} chars)")
        else:
            log("No active harness content found — running without AGENTS.md")

    results: list[dict] = []

    for task in tasks:
        log(f"\n=== Task: {task} ===")
        task_toml = tb_root / task / "task.toml"
        agent_timeout = read_toml_value(task_toml, "agent", "timeout_sec") or 900.0
        verifier_timeout = read_toml_value(task_toml, "verifier", "timeout_sec") or 300.0

        for ki in range(k):
            if k > 1:
                log(f"  -- run {ki+1}/{k} --")

            session_id = f"bench-{task}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
            task_start = time.monotonic()

            # 1. Clean workspace
            clean_dir(HOST_APP)
            clean_dir(HOST_TESTS)
            clean_dir(HOST_LOGS)

            # 2. Setup task environment
            try:
                setup_task(task, tb_root)
            except subprocess.CalledProcessError as e:
                log(f"  setup_deps.sh failed (exit {e.returncode}), skipping task")
                results.append({"task": task, "reward": 0, "elapsed": 0.0, "error": "setup_failed"})
                continue

            # 3. Run OpenCode
            turn_count, tool_usage = run_opencode(
                task, tb_root, model, variant or None, agent_timeout, harness_md
            )

            # 4. Copy tests (with patches)
            copy_tests(task, tb_root)

            # 5. Run verifier
            reward = run_verifier(verifier_timeout)

            elapsed = time.monotonic() - task_start
            passed = reward == 1
            log(f"  reward={reward}  elapsed={elapsed:.1f}s")

            # 6. Record to store
            record_to_stores(
                task, session_id, passed, turn_count, tool_usage,
                model, variant, layers, meta_root, args.no_store,
            )

            results.append({
                "task": task,
                "k": ki + 1,
                "reward": reward,
                "elapsed": elapsed,
                "session_id": session_id,
            })

    # Summary table
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

    log(f"Oracle validation: {len(tasks)} task(s)")
    results: list[dict] = []

    for task in tasks:
        log(f"\n=== Oracle: {task} ===")
        task_toml = tb_root / task / "task.toml"
        verifier_timeout = read_toml_value(task_toml, "verifier", "timeout_sec") or 300.0

        task_start = time.monotonic()

        # Clean
        clean_dir(HOST_APP)
        clean_dir(HOST_TESTS)
        clean_dir(HOST_LOGS)

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
                    cwd=HOST_APP,
                    timeout=agent_timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                log(f"  solve.sh timed out")

        # Copy tests
        copy_tests(task, tb_root)

        # Verify
        reward = run_verifier(verifier_timeout)
        elapsed = time.monotonic() - task_start
        status = "PASS" if reward == 1 else "FAIL"
        log(f"  [{status}] reward={reward}  elapsed={elapsed:.1f}s")
        results.append({"task": task, "reward": reward, "elapsed": elapsed})

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
            print("WARNING: some tasks failed oracle — check setup_deps.sh, patches, or test.sh")


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
    p_prep = sub.add_parser("prep", help="One-time host setup (mkdir + apt)")
    p_prep.add_argument(
        "--apply", action="store_true",
        help="Actually run the setup commands (requires sudo). Default: dry-run.",
    )

    # run
    p_run = sub.add_parser("run", help="Run tasks through OpenCode")
    p_run.add_argument("--tasks", nargs="+", metavar="TASK", help="Task name(s)")
    p_run.add_argument("--all", action="store_true", help="Run all 59 target tasks")
    p_run.add_argument("--model", default="claude-sonnet-4-6", help="Model ID")
    p_run.add_argument("--variant", default="", help="Model variant (e.g. high, low)")
    p_run.add_argument("--k", type=int, default=1, help="Runs per task (for pass@k)")
    p_run.add_argument(
        "--layers", default="global",
        choices=["global", "account", "project", "none"],
        help="Which global store layers to inject as AGENTS.md. "
             "global=both, account=account-global only, project=project-global only, none=no harness.",
    )
    p_run.add_argument("--no-store", action="store_true", help="Do not write to harness store")
    p_run.add_argument("--no-harness", action="store_true", help="Do not write AGENTS.md")

    # oracle
    p_oracle = sub.add_parser("oracle", help="Validate pipeline with solution/solve.sh")
    p_oracle.add_argument("--tasks", nargs="+", metavar="TASK", help="Task(s) to validate (default: all)")

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
    elif args.command == "oracle":
        cmd_oracle(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
