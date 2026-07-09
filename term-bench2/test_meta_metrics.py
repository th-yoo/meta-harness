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
