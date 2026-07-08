#!/usr/bin/env python3
"""
gen_setup_deps.py

Translates each Terminal-Bench 2 task's environment/Dockerfile into a
setup_deps.sh script, plus aggregated outputs for batch installation.

Usage:
    python3 gen_setup_deps.py [--tb-root PATH] [--out-root PATH]

Defaults:
    --tb-root   ~/z2/terminal-bench-2
    --out-root  ~/z2/meta-harness/term-bench2

Outputs:
    <out-root>/tasks/<task>/setup_deps.sh   (×59 targeted tasks)
    <out-root>/setup_base.sh               common tooling
    <out-root>/apt-packages.txt            union apt deps (pins stripped)
    <out-root>/manifest.json               per-task metadata
    <out-root>/report.md                   unhandled RUN lines + apt diff
"""

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

# ── Task set: 66 non-heavy, minus 6 torch and 1 cobol = 59 ─────────────────

EXCLUDED_TASKS = {
    # torch (too big)
    "pytorch-model-cli",
    "torch-pipeline-parallelism",
    "torch-tensor-parallelism",
    "hf-model-inference",
    "pytorch-model-recovery",
    "sam-cell-seg",
    # cobol
    "cobol-modernization",
    # heavy compile/clone/download (deferred to next milestone)
    "bn-fit-modify",
    "break-filter-js-from-html",
    "build-pov-ray",
    "caffe-cifar-10",
    "chess-best-move",
    "crack-7z-hash",
    "custom-memory-heap-crash",
    "fix-code-vulnerability",
    "fix-ocaml-gc",
    "gpt2-codegolf",
    "install-windows-3.11",
    "make-doom-for-mips",
    "make-mips-interpreter",
    "modernize-scientific-stack",
    "mteb-leaderboard",
    "mteb-retrieve",
    "qemu-alpine-ssh",
    "qemu-startup",
    "query-optimize",
    "schemelike-metacircular-eval",
    "train-fasttext",
    "vulnerable-secret",
    "winning-avg-corewars",
}

# ── Noise words to skip when parsing apt-get install lines ──────────────────

APT_NOISE = {
    "apt", "get", "install", "update", "upgrade", "y", "q", "f",
    "rm", "rf", "var", "lib", "lists", "apt-get",
    "no-install-recommends", "no-install-suggests",
    "debian-frontend", "noninteractive",
    "true", "false", "clean", "autoremove",
    "source", "the", "and", "to", "e", "x",
    "amd64", "http", "https", "com", "org", "io",
    "run", "env", "export",
}

# Packages handled differently or already present / provided by Playwright
SKIP_APT_PACKAGES = {
    "chromium",           # provided by Playwright
    "chromium-driver",    # provided by Playwright
    "sudo",               # already available
}

# Ubuntu 24.04 package renames: map old name → new name
APT_RENAME = {
    "libgl1-mesa-glx": "libgl1",       # renamed in 24.04
    "libglib2.0-0":    "libglib2.0-0t64",  # renamed in 24.04
}

# ── Dockerfile parser ────────────────────────────────────────────────────────

def read_dockerfile(path: Path) -> list[str]:
    """Return logical instructions (line-continuation joined, comment stripped)."""
    lines = path.read_text(errors="replace").splitlines()
    instructions: list[str] = []
    buf: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            buf.append(stripped[:-1].rstrip())
        else:
            buf.append(stripped)
            instructions.append(" ".join(buf))
            buf = []
    if buf:
        instructions.append(" ".join(buf))
    return instructions


def parse_instruction(line: str) -> tuple[str, str]:
    """Split 'KEYWORD rest' → (keyword, rest)."""
    parts = line.split(None, 1)
    if not parts:
        return "", ""
    return parts[0].upper(), (parts[1] if len(parts) > 1 else "")


def extract_apt_packages(run_body: str) -> list[str]:
    """Extract package names from apt-get install … lines."""
    packages: list[str] = []
    in_install = False
    # Split on whitespace, &&, ||, ;  but preserve tokens
    for token in re.split(r"[\s]+|&&|\|\||;", run_body):
        token = token.strip("\\\"'")
        if not token:
            continue
        # && / || end the install clause
        if token in ("&&", "||", ";"):
            in_install = False
            continue
        if token in ("apt-get", "apt"):
            in_install = False
            continue
        if token == "install":
            in_install = True
            continue
        if token in ("update", "upgrade", "clean", "autoremove", "purge"):
            in_install = False
            continue
        # rm / find / other commands end the install clause
        if token in ("rm", "find", "echo", "mkdir", "cd", "cp", "mv", "ln"):
            in_install = False
            continue
        if token.startswith("-"):
            continue
        if token.startswith("/"):
            # Absolute path — not a package name; ends clause
            in_install = False
            continue
        if in_install:
                # Strip version pin (e.g. asciinema=3:2023.20240207-1)
                pkg = re.split(r"[=<>]", token)[0]
                if pkg and pkg not in APT_NOISE and pkg not in SKIP_APT_PACKAGES:
                    # Validate it looks like a package name
                    if re.match(r'^[a-z0-9][a-z0-9.+\-]+$', pkg):
                        # Apply Ubuntu 24.04 renames
                        pkg = APT_RENAME.get(pkg, pkg)
                        packages.append(pkg)
    return packages


def extract_pip_packages(run_body: str) -> list[str]:
    """Extract 'pkg==version' specs from pip/pip3 install lines."""
    packages: list[str] = []
    found_install = False
    for token in re.split(r"[\s&|;\\]+", run_body):
        token = token.strip("\"'")
        if not token:
            continue
        if re.match(r"pip3?|uv", token):
            continue
        if token in ("install", "add"):
            found_install = True
            continue
        if token.startswith("-"):
            found_install = False
            continue
        if found_install and re.match(r"[a-zA-Z]", token):
            packages.append(token)
    return packages


def parse_dockerfile(df_path: Path, task: str) -> dict:
    """
    Returns:
      base_image: str
      apt_packages: list[str]
      pip_packages: list[str]   (may include '==version')
      copies: list[(src, dst)]  — relative src inside environment/
      envs: list[(key, value)]
      raw_runs: list[str]       — RUN lines not classified as apt/pip
      has_uv_copy: bool         — COPY --from=…uv… present
    """
    result = {
        "base_image": "",
        "apt_packages": [],
        "pip_packages": [],
        "copies": [],
        "envs": [],
        "raw_runs": [],
        "has_uv_copy": False,
    }

    instructions = read_dockerfile(df_path)

    for line in instructions:
        kw, body = parse_instruction(line)

        if kw == "FROM":
            if not result["base_image"]:
                result["base_image"] = body.split()[0] if body.split() else ""

        elif kw == "WORKDIR":
            pass  # workspace path handled by runner

        elif kw == "ENV":
            # ENV K=V or ENV K V
            m = re.match(r"([A-Z_][A-Z0-9_]*)=(.+)", body.strip())
            if m:
                result["envs"].append((m.group(1), m.group(2)))
            else:
                parts = body.strip().split(None, 1)
                if len(parts) == 2:
                    result["envs"].append((parts[0], parts[1]))

        elif kw == "COPY":
            if "--from=" in body:
                if "uv" in body.lower():
                    result["has_uv_copy"] = True
            else:
                # COPY src dst — src is relative to environment/
                parts = body.split()
                if len(parts) >= 2:
                    src, dst = parts[0], parts[-1]
                    result["copies"].append((src, dst))

        elif kw == "RUN":
            body_lower = body.lower()
            has_apt = "apt-get install" in body_lower or "apt install" in body_lower
            has_pip = bool(re.search(r"\bpip3?\s+install\b|\buv\s+pip\s+install\b|\buv\s+add\b", body_lower))
            has_uv_run = bool(re.search(r"\buv\s+run\b", body_lower))

            classified = False

            if has_apt:
                pkgs = extract_apt_packages(body)
                result["apt_packages"].extend(pkgs)
                classified = True

            if has_pip:
                pkgs = extract_pip_packages(body)
                result["pip_packages"].extend(pkgs)
                classified = True

            if has_uv_run:
                # uv run setup.py or similar — keep as raw
                result["raw_runs"].append(body)
                classified = True

            if not classified:
                # Skip pure cleanup lines
                if not re.match(r"^(rm\s|find\s.*-delete|apt-get clean|apt-get autoremove)", body.strip()):
                    result["raw_runs"].append(body)

    return result


def extract_test_sh_apt_packages(test_sh_path: Path) -> list[str]:
    """Scan tests/test.sh for apt-get install lines and return package names."""
    if not test_sh_path.exists():
        return []
    try:
        content = test_sh_path.read_text(errors="replace")
    except Exception:
        return []
    packages: list[str] = []
    for line in content.splitlines():
        stripped = line.strip()
        if "apt-get install" in stripped or "apt install" in stripped:
            packages.extend(extract_apt_packages(stripped))
    return packages


# ── Script generator ─────────────────────────────────────────────────────────

SETUP_DEPS_TEMPLATE = """\
#!/usr/bin/env bash
# setup_deps.sh — generated by gen_setup_deps.py
# Task: {task}
# Base image: {base_image}
#
# Sets up the task workspace at $WORKDIR (default: /app).
# TB_ROOT points at the terminal-bench-2 checkout.
# EXTRAS_ROOT: redirect out-of-/app copy destinations (e.g. /protected →
#   $EXTRAS_ROOT/protected). Set by runner to ~/bench/extras/<task>.
#
# Usage:
#   [TB_ROOT=~/z2/terminal-bench-2] [WORKDIR=/app] [EXTRAS_ROOT=] bash setup_deps.sh

set -euo pipefail

TB_ROOT="${{TB_ROOT:-$HOME/z2/terminal-bench-2}}"
TASK_ENV="$TB_ROOT/{task}/environment"
WORKDIR="${{WORKDIR:-/app}}"
EXTRAS_ROOT="${{EXTRAS_ROOT:-}}"

# ── source common base tooling ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${{BASH_SOURCE[0]}}")" && pwd)"
BASE_SCRIPT="$(dirname "$(dirname "$SCRIPT_DIR")")/setup_base.sh"
if [[ -f "$BASE_SCRIPT" ]]; then
  # shellcheck source=/dev/null
  source "$BASE_SCRIPT"
fi

mkdir -p "$WORKDIR"

{env_section}
{apt_section}
{copy_section}
{pip_section}
cd "$WORKDIR"
{raw_section}
echo "[setup_deps] {task} ready — workspace: $WORKDIR"
"""


def make_env_section(envs: list[tuple[str, str]]) -> str:
    if not envs:
        return "# (no ENV directives)"
    lines = ["# ── environment variables ──────────────────────────────────────────────────"]
    for k, v in envs:
        # Rewrite /app references to $WORKDIR
        v = v.replace("/app:", "$WORKDIR:").replace("/app/", "$WORKDIR/")
        if v == "/app":
            v = "$WORKDIR"
        # Use ${VAR:-} to avoid unbound variable errors under set -u
        import re
        v = re.sub(r'\$([A-Z_][A-Z0-9_]*)\b', r'${\1:-}', v)
        lines.append(f'export {k}="{v}"')
    return "\n".join(lines)


def make_apt_section(packages: list[str]) -> str:
    if not packages:
        return "# (no additional apt packages)"
    pkgs = " ".join(sorted(set(packages)))
    return dedent(f"""\
        # ── system packages ─────────────────────────────────────────────────────────
        # Set SKIP_APT=1 when packages are pre-installed on the host (runner sets this)
        if [[ -z "${{SKIP_APT:-}}" ]]; then
          sudo apt-get update -qq
          sudo apt-get install -y --no-install-recommends \\
            {pkgs}
          sudo rm -rf /var/lib/apt/lists/*
        fi""")


# Destination paths that are always directories (COPY file <dir> puts file inside).
_KNOWN_DIR_DESTS = {
    "/app", "/tests", "/logs", "/root", "/etc", "/tmp", "/var", "/opt",
    "/srv", "/data", "/protected", "/workspace", "/usr", "/bin", "/home", "/mnt",
}


def make_copy_section(copies: list[tuple[str, str]], task: str, tb_root: Path) -> str:
    if not copies:
        return "# (no COPY directives)"
    lines = ["# ── copy task assets ───────────────────────────────────────────────────────"]
    env_dir = tb_root / task / "environment"
    for src, dst in copies:
        # Determine whether the SOURCE is a file or directory (checked on disk).
        src_path = env_dir / src.rstrip("/")
        src_is_dir = src_path.is_dir()

        # Translate destination prefix:
        #   ./ or .   → $WORKDIR/
        #   /app/…    → $WORKDIR/…
        #   /other/…  → ${EXTRAS_ROOT:-}/other/…
        def xlate(d: str) -> str:
            if d in ("./", "."):
                return "$WORKDIR/"
            if d.startswith("/app"):
                return d.replace("/app", "$WORKDIR", 1)
            if d.startswith("/"):
                return f'${{EXTRAS_ROOT:-}}{d}'
            return d

        dst_sh = xlate(dst)

        # Directory target if: dst ends with /, dst is a known dir path,
        # or the source is a directory.
        dir_target = (
            dst.endswith("/")
            or dst.rstrip("/") in _KNOWN_DIR_DESTS
            or src_is_dir
        )

        if dir_target:
            lines.append(f'mkdir -p "{dst_sh}"')
            if src_is_dir:
                # Copy CONTENTS of the source directory into dst
                lines.append(f'cp -r "$TASK_ENV/{src.rstrip(chr(47))}/." "{dst_sh}"')
            else:
                # Copy the file INTO the destination directory
                lines.append(f'cp -r "$TASK_ENV/{src}" "{dst_sh}"')
        else:
            # file → file: mkdir the parent, copy file to the exact path
            lines.append(f'mkdir -p "$(dirname "{dst_sh}")"')
            lines.append(f'cp -r "$TASK_ENV/{src}" "{dst_sh}"')
    return "\n".join(lines)


# Paths that are always managed by the runner and need no explicit cleanup
_RUNNER_MANAGED = {"/app", "/tests", "/logs", "/logs/verifier"}


def extra_cleanup_paths(copies: list[tuple[str, str]]) -> list[str]:
    """
    Return top-level host paths written by COPY directives that are NOT
    inside /app, /tests, or /logs.  These persist across tasks and must be
    explicitly cleaned up by the runner between runs.
    """
    paths: set[str] = set()
    for _src, dst in copies:
        if dst in ("./", "."):
            continue
        # Normalise /app/… → skip
        if dst.startswith("/app") or dst.startswith("/tests") or dst.startswith("/logs"):
            continue
        # Capture the top-level directory (e.g. /protected/foo → /protected)
        top = "/" + dst.lstrip("/").split("/")[0]
        if top not in _RUNNER_MANAGED:
            paths.add(top)
    return sorted(paths)


def make_pip_section(packages: list[str], task: str, has_uv_copy: bool) -> str:
    if not packages:
        return "# (no pip packages)"
    pkgs = " ".join(f'"{p}"' for p in packages)
    return dedent(f"""\
        # ── per-task Python packages (isolated venv via uv) ─────────────────────────
        command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
        uv venv --python python3 "$WORKDIR/.venv" 2>/dev/null || true
        # shellcheck source=/dev/null
        source "$WORKDIR/.venv/bin/activate"
        uv pip install {pkgs}""")


def _rewrite_raw(cmd: str) -> str:
    """
    Rewrite a raw RUN command so it works when executed with WORKDIR=~/bench/app:
    - /app/...  → $WORKDIR/...  (workspace files)
    - /app      → $WORKDIR      (bare /app reference)
    - out-of-/app extras (e.g. /root/foo.py) → ${EXTRAS_ROOT:-}/root/foo.py
    Also guard any remaining apt-get/apt calls with SKIP_APT.
    """
    import re
    # Replace /app/ and bare /app (word-boundary)
    cmd = re.sub(r'/app/', '$WORKDIR/', cmd)
    cmd = re.sub(r'/app\b', '$WORKDIR', cmd)
    # Wrap remaining apt-get / apt calls under SKIP_APT guard
    if re.search(r'\bapt(?:-get)?\b', cmd):
        cmd = f'if [[ -z "${{SKIP_APT:-}}" ]]; then {cmd}; fi'
    return cmd


def make_raw_section(raw_runs: list[str]) -> str:
    if not raw_runs:
        return "# (no unclassified RUN directives)"
    lines = ["# ── unclassified RUN directives ────────────────────────────────────────────"]
    for r in raw_runs:
        rewritten = _rewrite_raw(r)
        if rewritten != r:
            lines.append(f"# RAW (original): {r}")
        else:
            lines.append(f"# RAW: {r}")
        lines.append(rewritten)
    return "\n".join(lines)


def generate_setup_script(task: str, parsed: dict, tb_root: Path) -> str:
    return SETUP_DEPS_TEMPLATE.format(
        task=task,
        base_image=parsed["base_image"],
        env_section=make_env_section(parsed["envs"]),
        apt_section=make_apt_section(parsed["apt_packages"]),
        copy_section=make_copy_section(parsed["copies"], task, tb_root),
        pip_section=make_pip_section(parsed["pip_packages"], task, parsed["has_uv_copy"]),
        raw_section=make_raw_section(parsed["raw_runs"]),
    )


# ── Aggregate generators ─────────────────────────────────────────────────────

SETUP_BASE = """\
#!/usr/bin/env bash
# setup_base.sh — common tooling for all Terminal-Bench 2 tasks
# Run once per machine. Most packages are already installed on this system.
set -euo pipefail

BASE_PACKAGES=(
  build-essential
  git
  curl
  wget
  python3
  python3-pip
  sqlite3
  openssl
  ca-certificates
  unzip
  zip
  tmux
  asciinema
)

echo "[setup_base] Checking / installing common tooling..."
if [[ -z "${SKIP_APT:-}" ]]; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${BASE_PACKAGES[@]}"
  sudo rm -rf /var/lib/apt/lists/*
else
  echo "[setup_base] SKIP_APT=1 — skipping apt (packages assumed pre-installed)"
fi

# Ensure uv is available
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "[setup_base] Done."
"""


def write_setup_base(out_root: Path) -> None:
    p = out_root / "setup_base.sh"
    p.write_text(SETUP_BASE)
    p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  wrote {p}")


def write_apt_packages(out_root: Path, all_apt: set[str]) -> None:
    p = out_root / "apt-packages.txt"
    p.write_text("\n".join(sorted(all_apt)) + "\n")
    print(f"  wrote {p} ({len(all_apt)} packages)")


def write_manifest(out_root: Path, manifest: dict) -> None:
    p = out_root / "manifest.json"
    p.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  wrote {p}")


def write_report(out_root: Path, unhandled: dict, all_apt: set[str]) -> None:
    # Check which union apt packages are already installed
    try:
        result = subprocess.run(
            ["dpkg-query", "-W", "-f", "${Package}\n"],
            capture_output=True, text=True
        )
        installed = set(result.stdout.splitlines())
    except Exception:
        installed = set()

    to_install = sorted(all_apt - installed)
    already = sorted(all_apt & installed)

    lines = [
        "# Terminal-Bench 2 — setup_deps generation report\n",
        f"Generated for {sum(len(v) for v in unhandled.values())} unhandled RUN lines "
        f"across {len(unhandled)} tasks.\n",
        "## Unhandled RUN directives (emitted verbatim in setup_deps.sh)\n",
    ]
    if any(v for v in unhandled.values()):
        for task, runs in sorted(unhandled.items()):
            if runs:
                lines.append(f"\n### {task}\n")
                for r in runs:
                    lines.append(f"    {r}\n")
    else:
        lines.append("*(none)*\n")

    lines.append("\n## APT packages: to install (not currently on system)\n")
    if to_install:
        for p in to_install:
            lines.append(f"  {p}\n")
    else:
        lines.append("*(all already installed)*\n")

    lines.append("\n## APT packages: already installed\n")
    for p in already:
        lines.append(f"  {p}\n")

    lines.append(
        f"\n## One-time install command\n"
        f"```bash\nsudo apt-get install -y \\\n"
        + "  \\\n".join(f"  {p}" for p in to_install)
        + "\n```\n" if to_install else "\n*(nothing to install)*\n"
    )

    out_root.joinpath("report.md").write_text("".join(lines))
    print(f"  wrote report.md  ({len(to_install)} new apt packages needed)")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tb-root", default=str(Path.home() / "z2/terminal-bench-2"))
    parser.add_argument("--out-root", default=str(Path.home() / "z2/meta-harness/term-bench2"))
    args = parser.parse_args()

    tb_root = Path(args.tb_root).expanduser()
    out_root = Path(args.out_root).expanduser()

    if not tb_root.exists():
        print(f"ERROR: tb-root not found: {tb_root}", file=sys.stderr)
        sys.exit(1)

    # Discover all tasks
    all_tasks = sorted(
        d.name for d in tb_root.iterdir()
        if d.is_dir() and not d.name.startswith(".")
        and (d / "environment" / "Dockerfile").exists()
    )
    tasks = [t for t in all_tasks if t not in EXCLUDED_TASKS]
    print(f"Processing {len(tasks)} tasks (excluded {len(EXCLUDED_TASKS)})...")

    all_apt: set[str] = set()
    manifest: dict = {}
    unhandled: dict = {}

    for task in tasks:
        df_path = tb_root / task / "environment" / "Dockerfile"
        parsed = parse_dockerfile(df_path, task)

        # Also pick up apt packages installed by tests/test.sh at test time
        test_sh_path = tb_root / task / "tests" / "test.sh"
        test_apt = extract_test_sh_apt_packages(test_sh_path)
        # Merge test.sh apt deps into the task's apt list (for union) but NOT
        # into the per-task setup_deps.sh (test.sh runs separately as verifier)
        all_apt.update(test_apt)
        if test_apt:
            manifest_test_apt = sorted(set(test_apt))
        else:
            manifest_test_apt = []

        # Accumulate union apt
        all_apt.update(parsed["apt_packages"])

        # Manifest entry
        manifest[task] = {
            "base_image": parsed["base_image"],
            "apt": sorted(set(parsed["apt_packages"])),
            "test_apt": manifest_test_apt,
            "pip": sorted(set(parsed["pip_packages"])),
            "copies": parsed["copies"],
            "envs": parsed["envs"],
            "has_uv_copy": parsed["has_uv_copy"],
            "raw_run_count": len(parsed["raw_runs"]),
            "needs_network": any(
                kw in "\n".join(parsed["raw_runs"]).lower()
                for kw in ["wget", "curl", "git clone", "pip install", "apt-get install"]
            ) or bool(parsed["pip_packages"]) or bool(parsed["apt_packages"]),
            # Paths outside /app /tests /logs that setup_deps.sh writes to;
            # runner must wipe these between tasks to avoid cross-task pollution.
            "extra_cleanup_paths": extra_cleanup_paths(parsed["copies"]),
        }

        unhandled[task] = parsed["raw_runs"]

        # Write per-task setup_deps.sh
        task_out = out_root / "tasks" / task
        task_out.mkdir(parents=True, exist_ok=True)
        script = generate_setup_script(task, parsed, tb_root)
        script_path = task_out / "setup_deps.sh"
        script_path.write_text(script)
        script_path.chmod(script_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    print(f"  wrote {len(tasks)} setup_deps.sh scripts")

    write_setup_base(out_root)
    write_apt_packages(out_root, all_apt)
    write_manifest(out_root, manifest)
    write_report(out_root, unhandled, all_apt)

    print(f"\nDone. Output in: {out_root}")
    print(f"  Tasks:   {len(tasks)}")
    print(f"  APT pkgs: {len(all_apt)} unique")


if __name__ == "__main__":
    main()
