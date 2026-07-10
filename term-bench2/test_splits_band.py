import json
from pathlib import Path
import pytest
import runner
from runner import task_pass_rates, band_partition

def _agent_results(tmp_path, name, tasks):   # {"rewards":[...]} shape
    p = tmp_path / name
    p.write_text(json.dumps({"label": name, "model": "m", "tasks":
        {t: {"rewards": rs} for t, rs in tasks.items()}}))
    return p

def _oracle_results(tmp_path, name, tasks):  # {"reward": 0|1} shape
    p = tmp_path / name
    p.write_text(json.dumps({"label": name, "tasks":
        {t: {"reward": r} for t, r in tasks.items()}}))
    return p

def test_task_pass_rates_merges_both_shapes(tmp_path):
    a = _agent_results(tmp_path, "a.json", {"t1": [1, 0], "t2": [1, 1]})
    o = _oracle_results(tmp_path, "o.json", {"t1": [1], "t3": [0]})
    # oracle writer uses scalar reward; emulate: rewrite o.json with scalars
    o.write_text(json.dumps({"tasks": {"t1": {"reward": 1}, "t3": {"reward": 0}}}))
    rates = task_pass_rates([a, o])
    assert rates["t1"] == 2/3          # pooled: [1,0] + [1]
    assert rates["t2"] == 1.0
    assert rates["t3"] == 0.0

def test_band_partition_pool_sentinels_excluded():
    tasks = ["easy1", "easy2", "easy3", "easy4", "mid1", "mid2", "hard0", "unknown"]
    rates = {"easy1": 1.0, "easy2": 0.95, "easy3": 0.9, "easy4": 1.0,
             "mid1": 0.5, "mid2": 0.3, "hard0": 0.0}
    pool, sentinels, excluded = band_partition(tasks, rates, 0.2, 0.8, 0.9, 2, seed=42)
    assert set(pool) == {"mid1", "mid2", "unknown"}      # unknown stays in
    assert len(sentinels) == 2 and set(sentinels) <= {"easy1", "easy2", "easy3", "easy4"}
    assert "hard0" in excluded                            # below lo = out of reach
    assert set(excluded) | set(sentinels) | set(pool) == set(tasks)
    # deterministic under the same seed
    assert band_partition(tasks, rates, 0.2, 0.8, 0.9, 2, seed=42)[1] == sentinels

def test_split_make_with_band_writes_v2(tmp_path, monkeypatch):
    src = tmp_path / "tasks.txt"
    src.write_text("mid1\nmid2\nmid3\nmid4\neasy1\neasy2\nhard0\n")
    res = _agent_results(tmp_path, "base.json",
        {"mid1": [1,0], "mid2": [0,1], "mid3": [1,0], "mid4": [0,1],
         "easy1": [1,1], "easy2": [1,1], "hard0": [0,0]})
    out = tmp_path / "splits.json"
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    args = runner.build_parser().parse_args(
        ["split", "make", "--source", "tasks.txt", "--folds", "2", "--seed", "1",
         "--split-file", str(out), "--results", str(res),
         "--band", "0.2,0.8", "--sentinels", "2", "--sentinel-hi", "0.9"])
    runner.cmd_split(args)
    d = json.loads(out.read_text())
    assert d["schemaVersion"] == 2
    assert set(d["sentinels"]) == {"easy1", "easy2"}
    assert "hard0" in d["excluded"]
    fold_tasks = [t for f in d["folds"] for t in f]
    assert set(fold_tasks) == {"mid1", "mid2", "mid3", "mid4"}   # pool only
    assert d["band"] == [0.2, 0.8]

def test_split_make_without_results_unchanged(tmp_path, monkeypatch):
    src = tmp_path / "tasks.txt"; src.write_text("a\nb\nc\nd\n")
    out = tmp_path / "splits.json"
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    args = runner.build_parser().parse_args(
        ["split", "make", "--source", "tasks.txt", "--folds", "2", "--split-file", str(out)])
    runner.cmd_split(args)
    d = json.loads(out.read_text())
    assert d["schemaVersion"] == 1
    assert "sentinels" not in d and "band" not in d

def test_split_make_malformed_band_dies(tmp_path, monkeypatch):
    src = tmp_path / "tasks.txt"; src.write_text("a\nb\n")
    res = _oracle_results(tmp_path, "r.json", {"a": 1, "b": 0})
    monkeypatch.setattr(runner, "SCRIPT_DIR", tmp_path)
    for bad in ("foo", "0.8,0.2", "1,2,3"):
        args = runner.build_parser().parse_args(
            ["split", "make", "--source", "tasks.txt", "--split-file", str(tmp_path/"s.json"),
             "--results", str(res), "--band", bad])
        with pytest.raises(SystemExit):
            runner.cmd_split(args)
