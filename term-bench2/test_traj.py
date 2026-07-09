"""Unit tests for Phase 2 trajectory helpers. No LLM, no sandbox.

Run: python3 test_traj.py
"""
import tempfile
from pathlib import Path

from runner import normalize_events
from bench_store import write_trajectory, prune_trajectories, read_trajectory


# ── normalize_events ─────────────────────────────────────────────────────────

def test_normalize_tool_text_error():
    nd = "\n".join([
        '{"type":"tool_use","part":{"tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"file.txt","metadata":{"exit":0}}}}',
        '{"type":"tool_use","part":{"tool":"bash","state":{"status":"error","metadata":{"exit":1}}}}',
        '{"type":"text","text":"I will do X"}',
        '{"type":"error","error":{"data":{"message":"boom"}}}',
        '{"type":"step_finish","part":{"reason":"stop"}}',   # ignored
        'not json',                                            # ignored
    ])
    evs = normalize_events(nd)
    assert [e["t"] for e in evs] == ["tool", "tool", "text", "error"], evs
    assert evs[0]["tool"] == "bash" and evs[0]["error"] is False
    assert "ls" in evs[0]["args"] and evs[0]["output"] == "file.txt"
    assert evs[1]["error"] is True
    assert evs[2]["text"] == "I will do X"
    assert evs[3]["text"] == "boom"


def test_normalize_truncates_output_and_args():
    long = "x" * 2000
    evs = normalize_events('{"type":"text","text":"' + long + '"}')
    assert len(evs[0]["text"]) == 800


def test_normalize_skips_blank_text():
    assert normalize_events('{"type":"text","text":"   "}') == []


def test_normalize_empty_input():
    assert normalize_events("") == []


# ── prune_trajectories ───────────────────────────────────────────────────────

def test_write_and_read_trajectory_roundtrip():
    d = Path(tempfile.mkdtemp())
    events = [{"t": "text", "text": "hello"}, {"t": "tool", "tool": "bash", "args": "ls", "output": "f", "error": False}]
    write_trajectory(d, "v1", "sess-1", events)
    got = read_trajectory(d, "v1", "sess-1")
    assert got == events


def test_prune_keeps_recent_failures():
    d = Path(tempfile.mkdtemp())
    for i in range(26):
        write_trajectory(d, "v1", f"s{i}", [{"t": "text", "text": str(i)}])
    removed = prune_trajectories(d, "v1", keep_failures=20, keep_passes=5)
    remaining = list((d / "candidates" / "v1" / "traj").glob("*.ndjson"))
    assert len(remaining) == 20, len(remaining)
    assert removed == 6, removed


if __name__ == "__main__":
    import sys
    fns = [g for n, g in sorted(globals().items()) if n.startswith("test_") and callable(g)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"  ok  {fn.__name__}")
        except Exception as e:
            failed += 1; print(f"  FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
