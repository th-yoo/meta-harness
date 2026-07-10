import json
from pathlib import Path
import pytest
import runner
from runner import task_pass_rates, band_partition
from ab_stats import DecisionConfig, PairStats, decide, paired_run_stats

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


# ── Task 2, Step 1: load_active_split sentinels ─────────────────────────────

def test_load_active_split_appends_sentinels(tmp_path):
    d = {"schemaVersion": 2, "seed": 1, "source": "x",
         "folds": [["a", "b"], ["c", "d"]], "activeFold": 0, "rotatedAt": None,
         "band": [0.2, 0.8], "sentinels": ["easy1", "easy2"], "excluded": []}
    p = tmp_path / "splits.json"; p.write_text(json.dumps(d))
    held_in, held_out, meta = runner.load_active_split(p)
    assert held_in == ["c", "d"]
    assert held_out == ["a", "b", "easy1", "easy2"]       # fold first, sentinels appended
    assert meta["sentinels"] == ["easy1", "easy2"]


def test_load_active_split_v1_no_sentinels(tmp_path):
    d = {"schemaVersion": 1, "seed": 1, "source": "x",
         "folds": [["a"], ["b"]], "activeFold": 1, "rotatedAt": None}
    p = tmp_path / "splits.json"; p.write_text(json.dumps(d))
    held_in, held_out, meta = runner.load_active_split(p)
    assert held_out == ["b"] and meta["sentinels"] == []
    assert held_in == ["a"]


def test_load_active_split_dedupes_sentinel_already_in_fold(tmp_path):
    d = {"schemaVersion": 2, "seed": 1, "source": "x",
         "folds": [["a", "b"], ["c", "sent1"]], "activeFold": 1, "rotatedAt": None,
         "band": [0.2, 0.8], "sentinels": ["sent1", "other"], "excluded": []}
    p = tmp_path / "splits.json"; p.write_text(json.dumps(d))
    held_in, held_out, meta = runner.load_active_split(p)
    # sent1 is already a fold member -> not appended a second time
    assert held_out == ["c", "sent1", "other"]
    assert held_out.count("sent1") == 1
    assert "sent1" not in held_in                      # sentinels never in held_in


def test_load_active_split_show_prints_sentinel_line(tmp_path, monkeypatch, capsys):
    d = {"schemaVersion": 2, "seed": 1, "source": "x",
         "folds": [["a", "b"], ["c", "d"]], "activeFold": 0, "rotatedAt": None,
         "band": [0.2, 0.8], "sentinels": ["easy1", "easy2"], "excluded": []}
    p = tmp_path / "splits.json"; p.write_text(json.dumps(d))
    args = runner.build_parser().parse_args(["split", "show", "--split-file", str(p)])
    runner.cmd_split(args)
    out = capsys.readouterr().out
    assert "sentinels (2): easy1, easy2" in out


def test_split_show_no_sentinel_line_when_none(tmp_path, capsys):
    d = {"schemaVersion": 1, "seed": 1, "source": "x",
         "folds": [["a"], ["b"]], "activeFold": 0, "rotatedAt": None}
    p = tmp_path / "splits.json"; p.write_text(json.dumps(d))
    args = runner.build_parser().parse_args(["split", "show", "--split-file", str(p)])
    runner.cmd_split(args)
    out = capsys.readouterr().out
    assert "sentinels" not in out


# ── Task 2, Step 1b: stratified held-out gate (dilution fix) ───────────────

def test_sentinel_dilution_pooled_would_pass_but_fold_only_rejects():
    """Proves the architect fix: pooling sentinel passes into the held-out gate
    dilutes a marginal fold regression below --nonregress-margin, flipping a
    reject into an accept. The fold-only view (as cmd_ab now feeds decide())
    must still catch the regression."""
    held_in_results = {
        f"hi{i}": {"phase": "held-in", "sentinel": False,
                   "candidate": [1], "active": [0]}
        for i in range(6)
    }
    # 3 fold tasks, 18 run-pairs total, one net discordant pair favouring
    # active -> delta = -1/18 ~= -0.0556, just past the default 0.05 margin.
    fold_results = {
        "fold_a": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_b": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_c": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 5 + [0], "active": [1] * 6},
    }
    # 3 concordant-pass sentinels: inflate n_pairs without moving b/c.
    sentinel_results = {
        f"sent_{x}": {"phase": "held-out", "sentinel": True,
                      "candidate": [1], "active": [1]}
        for x in ("a", "b", "c")
    }
    task_results = {**held_in_results, **fold_results, **sentinel_results}
    cfg = DecisionConfig()   # defaults: alpha=0.05, nonregress_margin=0.05

    hi_stats = paired_run_stats(runner.filter_task_results(task_results, "held-in"))

    fold_only = runner.filter_task_results(task_results, "held-out", sentinel=False)
    ho_fold_stats = paired_run_stats(fold_only)
    assert ho_fold_stats.delta < -cfg.nonregress_margin      # marginal regression

    pooled = runner.filter_task_results(task_results, "held-out")   # sentinel=None -> no filter
    ho_pooled_stats = paired_run_stats(pooled)
    assert ho_pooled_stats.delta >= -cfg.nonregress_margin   # dilution "fixes" it away — the bug

    fold_decision, fold_reasons = decide(hi_stats, ho_fold_stats, cfg)
    pooled_decision, _ = decide(hi_stats, ho_pooled_stats, cfg)

    assert pooled_decision == "accept"          # what the OLD pooled gate would wrongly do
    assert fold_decision == "reject"            # what the stratified gate correctly does
    assert any("held-out regression" in r for r in fold_reasons)


def test_sentinel_only_regression_forces_reject():
    ho_sentinel = PairStats(n_tasks=3, n_pairs=3, b=0, c=3, cand_pass=0, act_pass=3,
                            delta=-1.0, task_deltas={"s1": -1.0, "s2": -1.0, "s3": -1.0})
    decision, reasons = runner.sentinel_regression_reject(
        "accept", ["accept: held-in significant win, held-out non-regress"],
        ho_sentinel, margin=0.05)
    assert decision == "reject"
    assert "sentinel regression" in reasons


def test_sentinel_regression_guard_is_noop_when_no_regression():
    ho_sentinel = PairStats(n_tasks=3, n_pairs=3, b=0, c=0, cand_pass=3, act_pass=3,
                            delta=0.0, task_deltas={"s1": 0.0, "s2": 0.0, "s3": 0.0})
    decision, reasons = runner.sentinel_regression_reject("accept", ["ok"], ho_sentinel, margin=0.05)
    assert decision == "accept"
    assert reasons == ["ok"]

    decision2, reasons2 = runner.sentinel_regression_reject("accept", ["ok"], None, margin=0.05)
    assert decision2 == "accept" and reasons2 == ["ok"]


# ── Task 2, Step 1c: ab_decision — pins the fold-only gate wiring ──────────
#
# _verdict_dict used to build the held-out stats fed to decide() inline
# (`ho = _stats("held-out", sentinel=False)`), with zero test exercising that
# exact wiring — the dilution test above feeds hand-built PairStats straight
# into ab_stats.decide(), so silently reverting to a pooled
# `_stats("held-out")` would leave the whole suite green. These tests drive
# the extracted `runner.ab_decision` (now the only thing _verdict_dict calls)
# directly, so that revert breaks a test instead of silently reintroducing
# the dilution bug.

def test_ab_decision_fold_only_wiring_rejects_marginal_regression_despite_sentinel_dilution():
    """Same fixture as test_sentinel_dilution_pooled_would_pass_but_fold_only_rejects,
    driven through ab_decision end-to-end (not decide() directly): a marginal
    fold regression must still reject even though 3 concordant-pass sentinels
    would dilute the pooled delta back inside --nonregress-margin."""
    held_in_results = {
        f"hi{i}": {"phase": "held-in", "sentinel": False,
                   "candidate": [1], "active": [0]}
        for i in range(6)
    }
    fold_results = {
        "fold_a": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_b": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_c": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 5 + [0], "active": [1] * 6},
    }
    sentinel_results = {
        f"sent_{x}": {"phase": "held-out", "sentinel": True,
                      "candidate": [1], "active": [1]}
        for x in ("a", "b", "c")
    }
    task_results = {**held_in_results, **fold_results, **sentinel_results}
    cfg = DecisionConfig()   # defaults: alpha=0.05, nonregress_margin=0.05

    decision, reasons, hi, ho, ho_sentinel = runner.ab_decision(
        task_results, cfg, early_stopped=False,
        fold_out_tasks=list(fold_results), sentinel_out_tasks=list(sentinel_results))

    # Discrimination: prove this is a fold-only-vs-pooled distinction, not an
    # accident of these numbers — the pooled view (what a reverted wiring
    # would feed decide()) dilutes the same regression back inside margin.
    pooled = paired_run_stats(runner.filter_task_results(task_results, "held-out"))
    assert pooled.delta >= -cfg.nonregress_margin           # pooled "fixes" it away — the bug
    assert ho.delta < -cfg.nonregress_margin                # fold-only still shows the regression

    assert decision == "reject"
    assert any("held-out regression" in r for r in reasons)
    assert ho_sentinel is not None and ho_sentinel.delta == 0.0   # sentinels themselves concordant


def test_ab_decision_sentinel_regression_forces_reject_over_would_be_accept():
    """Held-in wins significantly and the fold is clean (decide() alone would
    accept) — but a sentinel regression must force reject regardless."""
    held_in_results = {
        f"hi{i}": {"phase": "held-in", "sentinel": False,
                   "candidate": [1], "active": [0]}
        for i in range(6)
    }
    fold_results = {
        "fold_a": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_b": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
    }
    sentinel_results = {
        f"sent_{x}": {"phase": "held-out", "sentinel": True,
                      "candidate": [0], "active": [1]}
        for x in ("a", "b", "c")
    }
    task_results = {**held_in_results, **fold_results, **sentinel_results}
    cfg = DecisionConfig()

    decision, reasons, hi, ho, ho_sentinel = runner.ab_decision(
        task_results, cfg, early_stopped=False,
        fold_out_tasks=list(fold_results), sentinel_out_tasks=list(sentinel_results))

    assert any("accept: held-in significant win" in r for r in reasons)  # decide() itself said accept
    assert decision == "reject"                                          # sentinel override wins
    assert "sentinel regression" in reasons


def test_ab_decision_early_stopped_forces_reject_over_would_be_accept():
    """A futility early-stop must force reject even when the (necessarily
    partial) stats decide() sees would otherwise say accept."""
    held_in_results = {
        f"hi{i}": {"phase": "held-in", "sentinel": False,
                   "candidate": [1], "active": [0]}
        for i in range(6)
    }
    fold_results = {
        "fold_a": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
        "fold_b": {"phase": "held-out", "sentinel": False,
                   "candidate": [1] * 6, "active": [1] * 6},
    }
    task_results = {**held_in_results, **fold_results}
    cfg = DecisionConfig()

    decision, reasons, hi, ho, ho_sentinel = runner.ab_decision(
        task_results, cfg, early_stopped=True,
        fold_out_tasks=list(fold_results), sentinel_out_tasks=[])

    assert any("accept: held-in significant win" in r for r in reasons)  # decide() itself said accept
    assert decision == "reject"                                          # early-stop override wins
    assert "early-stopped on futility" in reasons
    assert ho_sentinel is None


# ── Task 2: --resume split fingerprint (splitHash) ──────────────────────────

def test_split_hash_deterministic_and_order_invariant():
    h1 = runner._split_hash(["b", "a"], ["d", "c"])
    h2 = runner._split_hash(["a", "b"], ["c", "d"])
    assert h1 == h2                       # sorted internally -> order doesn't matter
    assert len(h1) == 12


def test_split_hash_changes_with_composition():
    h1 = runner._split_hash(["a", "b"], ["c", "d"])
    h2 = runner._split_hash(["a", "b"], ["c", "e"])   # regenerated split, one task swapped
    assert h1 != h2


def test_resume_ident_check_passes_when_matching():
    run_ident = {"layer": "project-global", "candidate": "v3", "baseline": "v2",
                "model": "m", "k": 2, "activeFold": 0, "splitHash": "abc123"}
    prev = dict(run_ident)
    runner._resume_ident_check(prev, run_ident)   # must not raise


def test_resume_ident_check_dies_on_split_hash_mismatch():
    """A regenerated splits.json mid-run (same fold index, different task
    composition) must fail --resume instead of silently splicing two
    compositions into one verdict."""
    run_ident = {"layer": "project-global", "candidate": "v3", "baseline": "v2",
                "model": "m", "k": 2, "activeFold": 0, "splitHash": "abc123"}
    prev = dict(run_ident, splitHash="old999")   # stale hash from the partial file
    with pytest.raises(SystemExit):
        runner._resume_ident_check(prev, run_ident)


def test_resume_ident_check_dies_on_any_other_field_mismatch():
    run_ident = {"layer": "project-global", "candidate": "v3", "baseline": "v2",
                "model": "m", "k": 2, "activeFold": 0, "splitHash": "abc123"}
    prev = dict(run_ident, model="different-model")
    with pytest.raises(SystemExit):
        runner._resume_ident_check(prev, run_ident)
