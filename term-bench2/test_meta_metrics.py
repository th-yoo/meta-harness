"""Unit tests for meta-metrics appender (Phase 4 Part A observability).

Run: cd term-bench2 && uv run --with pytest python -m pytest test_meta_metrics.py -q
"""
import json
from pathlib import Path
from datetime import datetime, timezone

from bench_store import append_meta_metric


def test_append_meta_metric_appends_jsonl(tmp_path):
    """Test that append_meta_metric appends JSON lines and auto-stamps ts."""
    sink = tmp_path / "results" / "meta-metrics.jsonl"
    append_meta_metric({"event": "ab", "decision": "accept"}, sink=sink)
    append_meta_metric({"event": "rotate", "splitFold": 1}, sink=sink)
    lines = sink.read_text().strip().split("\n")
    assert len(lines) == 2
    e0, e1 = json.loads(lines[0]), json.loads(lines[1])
    assert e0["event"] == "ab" and e0["decision"] == "accept"
    assert e1["event"] == "rotate" and e1["splitFold"] == 1
    assert "ts" in e0 and "ts" in e1   # auto-stamped


def test_append_meta_metric_supplied_ts(tmp_path):
    """Test that supplied ts is preserved (not overwritten)."""
    sink = tmp_path / "results" / "meta-metrics.jsonl"
    custom_ts = "2026-01-15T10:30:45.123456+00:00"
    append_meta_metric({"event": "test", "ts": custom_ts}, sink=sink)
    line = sink.read_text().strip()
    e = json.loads(line)
    assert e["ts"] == custom_ts


def test_summarize_loop_counts_and_trend(tmp_path):
    from runner import summarize_loop
    events = [
        {"ts": "2026-07-09T01:00:00Z", "event": "ab", "decision": "inconclusive",
         "heldOutDelta": 0.5, "splitFold": 0},
        {"ts": "2026-07-09T02:00:00Z", "event": "ab", "decision": "accept",
         "heldOutDelta": 0.25, "splitFold": 1},
        {"ts": "2026-07-09T03:00:00Z", "event": "trial", "action": "confirmed"},
        {"ts": "2026-07-09T04:00:00Z", "event": "judge", "agreed": True},
        {"ts": "2026-07-09T05:00:00Z", "event": "judge", "agreed": False},
    ]
    s = summarize_loop(events)
    assert s["abDecisions"] == {"accept": 1, "inconclusive": 1}
    assert s["trialActions"] == {"confirmed": 1}
    assert s["heldOutDeltas"] == [("2026-07-09T01:00:00Z", 0, 0.5),
                                  ("2026-07-09T02:00:00Z", 1, 0.25)]
    assert s["judgeAgreement"] == {"n": 2, "rate": 0.5}


PROJECT_SINK = "/repo/.meta-harness/meta-metrics.jsonl"   # passed explicitly as project_sink=


def _ab(decision, hi_delta, layer="account-global"):   # heldInDelta is the trend series
    return {"event": "ab", "layer": layer, "decision": decision,
            "heldInDelta": hi_delta, "heldOutDelta": 0.0, "splitFold": 0,
            "ts": "2026-07-10T00:00:00Z"}


def _trial(action, tr, br, sink=PROJECT_SINK):
    return {"event": "trial", "action": action, "trialRate": tr,
            "baselineRate": br, "ts": "2026-07-10T00:00:00Z", "_sink": sink}


def test_plateau_bench_per_layer():
    from runner import plateau_verdict
    evs = [_ab("reject", 0.0), _ab("inconclusive", 0.0), _ab("reject", -0.1)]
    v = plateau_verdict(evs)
    assert v["bench"]["account-global"]["plateaued"] is True
    assert v["plateaued"] is False          # bench NEVER drives the flag
    # an accept in the window breaks that layer's plateau
    evs2 = [_ab("reject", 0.0), _ab("accept", 0.3), _ab("reject", 0.0)]
    assert plateau_verdict(evs2)["bench"]["account-global"]["plateaued"] is False
    # rising HELD-IN trend under all-inconclusive = underpowered, NOT plateau (fix #5)
    evs3 = [_ab("inconclusive", 0.0), _ab("inconclusive", 0.2), _ab("inconclusive", 0.4)]
    assert plateau_verdict(evs3)["bench"]["account-global"]["plateaued"] is False
    # layers are independent: another layer's accept must not break this one (fix #4)
    evs4 = [_ab("reject", 0.0), _ab("reject", 0.0), _ab("reject", 0.0),
            _ab("accept", 0.5, layer="account-role")]
    v4 = plateau_verdict(evs4)
    assert v4["bench"]["account-global"]["plateaued"] is True
    assert v4["bench"]["account-role"]["plateaued"] is False


def test_plateau_project_stream_drives_flag():
    from runner import plateau_verdict
    ties = [_trial("confirmed", 0.8, 0.8)] * 3 + [_trial("reverted", 0.6, 0.8)]
    v = plateau_verdict(ties, project_sink=PROJECT_SINK)
    assert v["project"]["plateaued"] is True and v["plateaued"] is True
    improv = ties[:3] + [_trial("confirmed", 0.9, 0.8)]
    assert plateau_verdict(improv, project_sink=PROJECT_SINK)["plateaued"] is False
    # started events + null-baseline confirms are neutral, not improvements
    boot = [_trial("started", None, None)] + [_trial("confirmed", 1.0, None)] * 4
    assert plateau_verdict(boot, project_sink=PROJECT_SINK)["project"]["plateaued"] is True
    # trial events from a NON-project sink are ignored (fix #7)
    foreign = [_trial("confirmed", 0.8, 0.8, sink="/home/u/.config/opencode/.meta-harness/meta-metrics.jsonl")] * 4
    v2 = plateau_verdict(foreign, project_sink=PROJECT_SINK)
    assert v2["project"]["reason"].startswith("insufficient")


def test_plateau_insufficient_data():
    from runner import plateau_verdict
    v = plateau_verdict([_ab("reject", 0.0)])
    assert v["bench"]["account-global"]["plateaued"] is False
    assert v["plateaued"] is False


def test_summarize_loop_gains_plateau_key():
    from runner import summarize_loop
    s = summarize_loop([])
    assert "plateau" in s and s["plateau"]["plateaued"] is False


def test_load_meta_metrics_annotates_sink(tmp_path):
    from runner import load_meta_metrics
    import json as _json
    p = tmp_path / "m.jsonl"
    p.write_text(_json.dumps({"event": "rotate", "ts": "2026-07-10T00:00:00Z"}) + "\n")
    evs = load_meta_metrics([p])
    assert evs[0]["_sink"] == str(p)


def test_report_loop_flag_write_and_clear(tmp_path, monkeypatch, capsys):
    """cmd_report_loop writes/clears PAUSED_FLAG based on the project verdict
    only, using the default sinks (project sink = default_meta_metrics_sinks()[1]).
    Bench-only plateau must NOT write the flag; extra --sink or --no-flag must
    never touch it."""
    import runner
    import argparse

    bench_sink = tmp_path / "bench" / "meta-metrics.jsonl"
    project_sink = tmp_path / "project" / "meta-metrics.jsonl"
    account_sink = tmp_path / "account" / "meta-metrics.jsonl"
    flag_path = tmp_path / "paused"

    monkeypatch.setattr(runner, "default_meta_metrics_sinks",
                         lambda: [bench_sink, project_sink, account_sink])
    monkeypatch.setattr(runner, "PAUSED_FLAG", flag_path)

    def _write(sink, events):
        sink.parent.mkdir(parents=True, exist_ok=True)
        sink.write_text("\n".join(json.dumps(e) for e in events) + "\n")

    def _args(sink=None, no_flag=False, as_json=False):
        return argparse.Namespace(sink=sink, no_flag=no_flag, json=as_json,
                                   plateau_ab_k=None, plateau_trial_k=None)

    # 4 tie/revert project trials -> project plateaued -> flag written
    _write(project_sink, [
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:00Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:01Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:02Z"},
        {"event": "trial", "action": "reverted", "trialRate": 0.6,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:03Z"},
    ])
    runner.cmd_report_loop(_args())
    assert flag_path.exists()
    flag_data = json.loads(flag_path.read_text())
    assert "ts" in flag_data and "verdict" in flag_data
    assert flag_data["verdict"]["project"]["plateaued"] is True

    # rerun with a strict-improvement trial appended -> flag removed
    _write(project_sink, [
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:00Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:01Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:02Z"},
        {"event": "trial", "action": "reverted", "trialRate": 0.6,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:03Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.95,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:04Z"},
    ])
    runner.cmd_report_loop(_args())
    assert not flag_path.exists()

    # bench-only plateau (3 non-accept ab events, no trial events) must NOT write the flag
    _write(project_sink, [])
    _write(bench_sink, [
        {"event": "ab", "layer": "account-global", "decision": "reject",
         "heldInDelta": 0.0, "ts": "2026-07-10T00:00:00Z"},
        {"event": "ab", "layer": "account-global", "decision": "reject",
         "heldInDelta": 0.0, "ts": "2026-07-10T00:00:01Z"},
        {"event": "ab", "layer": "account-global", "decision": "reject",
         "heldInDelta": 0.0, "ts": "2026-07-10T00:00:02Z"},
    ])
    runner.cmd_report_loop(_args())
    assert not flag_path.exists()

    # re-seed project plateau, then run with extra --sink -> flag untouched (not created)
    _write(project_sink, [
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:00Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:01Z"},
        {"event": "trial", "action": "confirmed", "trialRate": 0.8,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:02Z"},
        {"event": "trial", "action": "reverted", "trialRate": 0.6,
         "baselineRate": 0.8, "ts": "2026-07-10T00:00:03Z"},
    ])
    extra_sink = tmp_path / "extra" / "meta-metrics.jsonl"
    _write(extra_sink, [])
    runner.cmd_report_loop(_args(sink=[str(extra_sink)]))
    assert not flag_path.exists()

    # default sinks again (no extra --sink) but --no-flag -> opts out entirely
    runner.cmd_report_loop(_args(no_flag=True))
    assert not flag_path.exists()


def test_load_meta_metrics_sorts_across_iso_formats(tmp_path):
    """Test that load_meta_metrics correctly sorts events with mixed ISO-8601 formats.
    Two events in the same second, one with Z suffix (TS appender) and one with +00:00
    (Python appender), given in reverse order, must come back in chronological order."""
    from runner import load_meta_metrics
    f = tmp_path / "m.jsonl"
    # later event listed first (14.900), with the Z/+00:00 format split
    f.write_text(
        json.dumps({"event": "b", "ts": "2026-07-09T13:24:14.900000+00:00"}) + "\n" +
        json.dumps({"event": "a", "ts": "2026-07-09T13:24:14.100Z"}) + "\n"
    )
    got = [e["event"] for e in load_meta_metrics([f])]
    # 14.100 (a) before 14.900 (b) regardless of suffix format
    assert got == ["a", "b"], f"Expected ['a', 'b'] but got {got}"
