"""
bench_store.py

Python port of the relevant parts of opencode-plugin/src/harness-store.ts.
Writes SessionRecord JSON into the same multi-layer store layout so bench
scores appear alongside interactive scores and feed the same proposer.

Store layout (mirroring the TypeScript):
  <storeRoot>/
    active/
      system.md
      tools.md
      .version
    candidates/
      vN/
        system.md
        tools.md
        score.json      { version, nPass, nFail, sessions: [SessionRecord] }
        traces/
          <sessionID>.json

Injection order: account-global -> project-global -> account-role -> project-role
(the two global layers are always available; role layers are composed when the
runner is given an --agent, via account_role_root/project_role_root below)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# ── Root resolvers ─────────────────────────────────────────────────────────


def _opencode_config_dir() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    if xdg:
        return Path(xdg) / "opencode"
    return Path.home() / ".config" / "opencode"


def account_global_root() -> Path:
    """~/.config/opencode/.meta-harness/global/"""
    return _opencode_config_dir() / ".meta-harness" / "global"


def project_global_root(meta_root: Path) -> Path:
    """<meta_root>/.meta-harness/global/  (meta_root = repo root)"""
    return meta_root / ".meta-harness" / "global"


def account_role_root(agent: str) -> Path:
    """~/.config/opencode/.meta-harness/roles/<agent>/  (mirrors harness-store.ts accountRoleRoot)"""
    return _opencode_config_dir() / ".meta-harness" / "roles" / agent


def project_role_root(meta_root: Path, agent: str) -> Path:
    """<meta_root>/.meta-harness/roles/<agent>/  (mirrors harness-store.ts projectRoleRoot)"""
    return meta_root / ".meta-harness" / "roles" / agent


# ── Paths inside a store ───────────────────────────────────────────────────


def active_path(store_root: Path, filename: str) -> Path:
    return store_root / "active" / filename


def candidate_path(store_root: Path, version: str, *parts: str) -> Path:
    return store_root / "candidates" / version / Path(*parts) if parts else store_root / "candidates" / version


def _candidate_file(store_root: Path, version: str, *parts: str) -> Path:
    p = store_root / "candidates" / version
    for part in parts:
        p = p / part
    return p


# ── Helpers ────────────────────────────────────────────────────────────────


def _read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _write_text(p: Path, content: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _read_json(p: Path, fallback: Any) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _write_json(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ── Store API ──────────────────────────────────────────────────────────────


def active_version(store_root: Path) -> str:
    """Return the active version string, e.g. 'v0'. Defaults to 'v0'."""
    return _read_text(active_path(store_root, ".version")) or "v0"


def list_versions(store_root: Path) -> list[str]:
    cands = store_root / "candidates"
    if not cands.is_dir():
        return []
    versions = [
        d.name for d in cands.iterdir()
        if d.is_dir() and d.name.startswith("v") and d.name[1:].isdigit()
    ]
    return sorted(versions, key=lambda v: int(v[1:]))


def read_score(store_root: Path, version: str) -> dict:
    p = _candidate_file(store_root, version, "score.json")
    return _read_json(p, {"version": version, "nPass": 0, "nFail": 0, "sessions": []})


def record_session(store_root: Path, version: str, record: dict) -> dict:
    """
    Append a SessionRecord to candidates/vN/traces/<id>.json and update score.json.
    Returns the updated CandidateScore dict.

    record fields (matching SessionRecord in harness-store.ts):
      sessionID   str
      passed      bool
      note        str
      turnCount   int
      timestamp   str   (ISO-8601)
      summary     str
      model       str
      variant     str
      toolUsage   dict[str, {calls: int, errors: int}]
    """
    # Write trace
    trace_path = _candidate_file(store_root, version, "traces", f"{record['sessionID']}.json")
    _write_json(trace_path, record)

    # Update score
    score = read_score(store_root, version)
    score["sessions"].append(record)
    score["nPass"] = sum(1 for s in score["sessions"] if s.get("passed"))
    score["nFail"] = sum(1 for s in score["sessions"] if not s.get("passed"))
    _write_json(_candidate_file(store_root, version, "score.json"), score)
    return score


def read_active_system(store_root: Path) -> str:
    return _read_text(active_path(store_root, "system.md"))


def read_active_tools(store_root: Path) -> str:
    return _read_text(active_path(store_root, "tools.md"))


def candidate_exists(store_root: Path, version: str) -> bool:
    return (store_root / "candidates" / version).is_dir()


def read_candidate_system(store_root: Path, version: str) -> str:
    return _read_text(_candidate_file(store_root, version, "system.md"))


def read_candidate_tools(store_root: Path, version: str) -> str:
    return _read_text(_candidate_file(store_root, version, "tools.md"))


# ── Harness assembly ───────────────────────────────────────────────────────


def assemble_agents_md(
    account_global: Path,
    project_global: Path,
    instruction_md: str = "",
) -> str:
    """
    Build the AGENTS.md content injected into /app for each task run.

    Option Y order (general -> specific, project beats account):
      1. account-global system.md
      2. project-global system.md
      3. ## Tool usage guidance
         account-global tools.md
         project-global tools.md

    Each section only included if non-empty.
    instruction_md is appended at the end if provided.
    """
    parts: list[str] = []

    ag_sys = read_active_system(account_global)
    pg_sys = read_active_system(project_global)
    ag_tools = read_active_tools(account_global)
    pg_tools = read_active_tools(project_global)

    if ag_sys:
        parts.append(f"## General coding guidance\n\n{ag_sys}")
    if pg_sys:
        parts.append(f"## Project guidance\n\n{pg_sys}")

    tool_parts: list[str] = []
    if ag_tools:
        tool_parts.append(ag_tools)
    if pg_tools:
        tool_parts.append(pg_tools)
    if tool_parts:
        parts.append("## Tool usage guidance\n\n" + "\n\n".join(tool_parts))

    if instruction_md:
        parts.append(f"## Task\n\n{instruction_md}")

    return "\n\n---\n\n".join(parts) if parts else ""
