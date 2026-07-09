"""Unit tests for judge-audit (Phase 4 Part D5: anti-gaming audit). Replays
the dense judge on BENCH trajectories against verifier ground truth.

No LLM, no sandbox: the pure fns are tested directly; cmd_judge_audit's
control flow (table/agreement/alarm) is exercised with run_judge_opencode
monkeypatched to canned replies, against an isolated tmp_path store (never
touches the real ~/.config/opencode or repo .meta-harness stores).

Run: cd term-bench2 && uv run --with pytest python -m pytest test_judge_audit.py -q
"""
import argparse
import json

import pytest

import bench_store
import runner
from runner import build_judge_audit_prompt, parse_judge_reply


# ── build_judge_audit_prompt ─────────────────────────────────────────────────

def test_build_judge_audit_prompt_contains_verdict_shape_and_events():
    events = [
        {"t": "tool", "tool": "bash", "args": "cat file.txt", "output": "hello world", "error": False},
        {"t": "text", "text": "I will count the tokens now"},
        {"t": "error", "text": "boom: command not found"},
    ]
    prompt = build_judge_audit_prompt(events, "count tokens")

    # task note rendered
    assert "count tokens" in prompt
    # rendered tool/text/error events
    assert "bash" in prompt
    assert "cat file.txt" in prompt
    assert "hello world" in prompt
    assert "I will count the tokens now" in prompt
    assert "boom: command not found" in prompt
    # verdict JSON shape
    assert '"passed"' in prompt
    assert '"confidence"' in prompt
    assert '"reasoning"' in prompt
    # instructs replying inline as the FINAL message (not a file)
    assert "final message" in prompt.lower()


def test_build_judge_audit_prompt_empty_events():
    prompt = build_judge_audit_prompt([], "some task")
    assert "some task" in prompt
    assert '"passed"' in prompt


# ── parse_judge_reply ─────────────────────────────────────────────────────────

def test_parse_judge_reply_extracts_trailing_json():
    text = 'blah blah {"passed": true, "confidence": 0.9, "reasoning": "x"}'
    got = parse_judge_reply(text)
    assert got == {"passed": True, "confidence": 0.9, "reasoning": "x"}


def test_parse_judge_reply_garbage_returns_none():
    assert parse_judge_reply("no json here") is None


def test_parse_judge_reply_returns_last_of_two_json_objects():
    text = (
        '{"passed": false, "confidence": 0.4, "reasoning": "first draft"} '
        'actually wait, let me reconsider... '
        '{"passed": true, "confidence": 0.95, "reasoning": "final answer"}'
    )
    got = parse_judge_reply(text)
    assert got == {"passed": True, "confidence": 0.95, "reasoning": "final answer"}


def test_parse_judge_reply_ignores_json_missing_required_keys():
    text = '{"foo": "bar"} then {"passed": true, "confidence": 0.5, "reasoning": "ok"}'
    got = parse_judge_reply(text)
    assert got == {"passed": True, "confidence": 0.5, "reasoning": "ok"}


# ── cmd_judge_audit control flow ─────────────────────────────────────────────
#
# No LLM, no sandbox: run_judge_opencode is monkeypatched to canned replies,
# and the store lives entirely under tmp_path (runner.META_ROOT is
# monkeypatched so project_global_root resolves under tmp_path — this never
# touches the real repo .meta-harness/ or ~/.config/opencode/.meta-harness/).


def _seed_store(tmp_path, records_and_traj):
    """Write score.json + traces/ (via record_session) and traj/ (via
    write_trajectory) for candidate v1 of the project-global layer, entirely
    under tmp_path. records_and_traj: list of (session_id, passed, traj_events)."""
    store_root = tmp_path / ".meta-harness" / "global"
    for sid, passed, traj in records_and_traj:
        rec = {
            "sessionID": sid, "passed": passed, "note": f"bench:{sid}",
            "turnCount": 3, "timestamp": "2026-07-09T00:00:00+00:00",
            "summary": sid, "model": "anthropic/claude-x", "variant": "",
            "toolUsage": {}, "env": {},
        }
        bench_store.record_session(store_root, "v1", rec)
        if traj is not None:
            bench_store.write_trajectory(store_root, "v1", sid, traj)
    return store_root


def _args(**overrides):
    ns = argparse.Namespace(layer="project-global", candidate="v1",
                            model="fake-judge", limit=10, agent="")
    for k, v in overrides.items():
        setattr(ns, k, v)
    return ns


def test_cmd_judge_audit_full_agreement_exits_cleanly(tmp_path, monkeypatch, capsys):
    traj = [{"t": "tool", "tool": "bash", "args": "echo hi", "output": "hi", "error": False}]
    _seed_store(tmp_path, [("s1", True, traj), ("s2", False, traj)])
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)

    verdicts = {"s1": True, "s2": False}   # judge agrees with ground truth on both

    def fake_run_judge_opencode(prompt, model, timeout=90.0, max_attempts=3):
        for sid, v in verdicts.items():
            if sid in prompt:
                return json.dumps({"passed": v, "confidence": 0.9, "reasoning": "ok"})
        return None

    monkeypatch.setattr(runner, "run_judge_opencode", fake_run_judge_opencode)
    metrics = []
    monkeypatch.setattr(bench_store, "append_meta_metric",
                        lambda e, sink=None: metrics.append(e))

    runner.cmd_judge_audit(_args())   # must NOT raise SystemExit

    out = capsys.readouterr().out
    assert "agreement=100.0%" in out
    assert "ALARM" not in out
    assert len(metrics) == 1
    assert metrics[0] == {"event": "judge-audit", "n": 2, "agreement": 1.0,
                          "model": "fake-judge", "layer": "project-global",
                          "candidate": "v1"}


def test_cmd_judge_audit_low_agreement_alarms_exit_1(tmp_path, monkeypatch, capsys):
    traj = [{"t": "text", "text": "done"}]
    _seed_store(tmp_path, [("s1", True, traj), ("s2", False, traj), ("s3", True, traj)])
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)

    # Judge disagrees on 2 of 3 -> agreement 1/3 ≈ 33% < 80% threshold
    verdicts = {"s1": False, "s2": True, "s3": True}

    def fake_run_judge_opencode(prompt, model, timeout=90.0, max_attempts=3):
        for sid, v in verdicts.items():
            if sid in prompt:
                return json.dumps({"passed": v, "confidence": 0.5, "reasoning": "x"})
        return None

    monkeypatch.setattr(runner, "run_judge_opencode", fake_run_judge_opencode)
    monkeypatch.setattr(bench_store, "append_meta_metric", lambda e, sink=None: None)

    with pytest.raises(SystemExit) as exc:
        runner.cmd_judge_audit(_args())
    assert exc.value.code == 1

    out = capsys.readouterr().out
    assert "ALARM" in out


def test_cmd_judge_audit_skips_failed_judge_calls_without_crashing(tmp_path, monkeypatch, capsys):
    traj = [{"t": "text", "text": "done"}]
    _seed_store(tmp_path, [("s1", True, traj), ("s2", False, traj)])
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)

    def fake_run_judge_opencode(prompt, model, timeout=90.0, max_attempts=3):
        if "s1" in prompt:
            return None   # simulate judge call failing after retries -> skip
        return json.dumps({"passed": False, "confidence": 0.9, "reasoning": "ok"})

    monkeypatch.setattr(runner, "run_judge_opencode", fake_run_judge_opencode)
    metrics = []
    monkeypatch.setattr(bench_store, "append_meta_metric",
                        lambda e, sink=None: metrics.append(e))

    runner.cmd_judge_audit(_args())   # only s2 scored & agrees -> no alarm, no crash

    out = capsys.readouterr().out
    assert "1 skipped" in out
    assert metrics[0]["n"] == 1
    assert metrics[0]["agreement"] == 1.0


def test_cmd_judge_audit_all_judge_calls_fail_is_non_alarming(tmp_path, monkeypatch, capsys):
    """If every judge call fails/parses as garbage, n_scored is 0 — this must
    NOT be treated as a 0% agreement alarm (that would be a false alarm about
    the judge invocation itself, not about anti-gaming); it exits cleanly."""
    traj = [{"t": "text", "text": "done"}]
    _seed_store(tmp_path, [("s1", True, traj), ("s2", False, traj)])
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)
    monkeypatch.setattr(runner, "run_judge_opencode", lambda *a, **k: None)
    metrics = []
    monkeypatch.setattr(bench_store, "append_meta_metric",
                        lambda e, sink=None: metrics.append(e))

    runner.cmd_judge_audit(_args())   # must not raise SystemExit

    assert metrics[0]["n"] == 0
    assert metrics[0]["agreement"] == 0.0
    out = capsys.readouterr().out
    assert "2 skipped" in out
    assert "ALARM" not in out


def test_cmd_judge_audit_no_eligible_sessions_is_a_clean_noop(tmp_path, monkeypatch, capsys):
    _seed_store(tmp_path, [("s1", True, None)])   # trace but no traj -> not eligible
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)

    runner.cmd_judge_audit(_args())   # must not raise / not call the judge at all

    out = capsys.readouterr().out
    assert "nothing to audit" in out


def test_cmd_judge_audit_nonexistent_candidate_dies_cleanly(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(runner, "META_ROOT", tmp_path)

    with pytest.raises(SystemExit) as exc:
        runner.cmd_judge_audit(_args(candidate="v99"))
    assert exc.value.code == 1
