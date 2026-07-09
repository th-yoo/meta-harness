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
