"""Unit tests for ab_stats.py — the Phase 1 statistical gate. No LLM, no I/O.

Run: python3 -m pytest term-bench2/test_ab_stats.py   (or: python3 test_ab_stats.py)
"""
import math

from ab_stats import (
    PairStats, DecisionConfig,
    paired_run_stats, mcnemar_exact_one_sided, bootstrap_task_ci,
    futility_stop, decide,
)


# ── mcnemar_exact_one_sided ─────────────────────────────────────────────────

def test_mcnemar_all_candidate_wins():
    # b=6, c=0: P(X>=6 | X~Bin(6,.5)) = 1/64
    assert math.isclose(mcnemar_exact_one_sided(6, 0), 1 / 64, rel_tol=1e-9)


def test_mcnemar_five_one():
    # b=5, c=1: P(X>=5 | Bin(6,.5)) = (C(6,5)+C(6,6))/64 = 7/64
    assert math.isclose(mcnemar_exact_one_sided(5, 1), 7 / 64, rel_tol=1e-9)


def test_mcnemar_tie():
    # b=3, c=3: P(X>=3 | Bin(6,.5)) = (20+15+6+1)/64 = 42/64
    assert math.isclose(mcnemar_exact_one_sided(3, 3), 42 / 64, rel_tol=1e-9)


def test_mcnemar_no_discordant_pairs():
    assert mcnemar_exact_one_sided(0, 0) == 1.0


# ── paired_run_stats ────────────────────────────────────────────────────────

def test_paired_run_stats():
    task_results = {
        "t1": {"candidate": [1, 1], "active": [0, 1]},   # pair0 b, pair1 concordant
        "t2": {"candidate": [0],    "active": [1]},        # c
        "t3": {"candidate": [1],    "active": [1]},        # concordant
        "t4": {"candidate": [0, 0], "active": [0, 0], "error": "setup_failed"},  # excluded
    }
    s = paired_run_stats(task_results)
    assert s.b == 1
    assert s.c == 1
    assert s.n_pairs == 4          # 2 + 1 + 1 (t4 excluded)
    assert s.n_tasks == 3
    assert s.cand_pass == 3
    assert s.act_pass == 3
    assert math.isclose(s.delta, 0.0)
    assert math.isclose(s.task_deltas["t1"], 0.5)
    assert math.isclose(s.task_deltas["t2"], -1.0)
    assert math.isclose(s.task_deltas["t3"], 0.0)
    assert "t4" not in s.task_deltas


def test_paired_run_stats_empty():
    s = paired_run_stats({})
    assert s.n_pairs == 0 and s.b == 0 and s.c == 0 and s.delta == 0.0


# ── futility_stop ───────────────────────────────────────────────────────────

def test_futility_kills_when_behind_after_min_tasks():
    assert futility_stop(b=1, c=4, tasks_done=12) is True   # c-b=3 >= 3, tasks>=12


def test_futility_not_before_min_tasks():
    assert futility_stop(b=0, c=5, tasks_done=11) is False   # too few tasks


def test_futility_not_when_ahead():
    assert futility_stop(b=5, c=1, tasks_done=20) is False   # candidate ahead


# ── bootstrap_task_ci ───────────────────────────────────────────────────────

def test_bootstrap_ci_degenerate():
    lo, hi = bootstrap_task_ci([0.5, 0.5, 0.5], n_boot=500, alpha=0.10, seed=0)
    assert math.isclose(lo, 0.5) and math.isclose(hi, 0.5)


def test_bootstrap_ci_reproducible_and_brackets_mean():
    deltas = [0.4, -0.1, 0.6, 0.2, 0.3]
    a = bootstrap_task_ci(deltas, n_boot=2000, alpha=0.10, seed=7)
    b = bootstrap_task_ci(deltas, n_boot=2000, alpha=0.10, seed=7)
    assert a == b                                   # deterministic under seed
    mean = sum(deltas) / len(deltas)
    assert a[0] <= mean <= a[1]


# ── decide ──────────────────────────────────────────────────────────────────

def _ps(b, c, delta):
    return PairStats(n_tasks=0, n_pairs=b + c, b=b, c=c,
                     cand_pass=0, act_pass=0, delta=delta, task_deltas={})


def test_decide_accept():
    cfg = DecisionConfig()
    d, _ = decide(_ps(6, 0, 0.20), _ps(1, 1, 0.0), cfg)
    assert d == "accept"


def test_decide_reject_active_wins_held_in():
    cfg = DecisionConfig()
    d, _ = decide(_ps(0, 6, -0.20), _ps(0, 0, 0.0), cfg)
    assert d == "reject"


def test_decide_reject_held_out_regression():
    cfg = DecisionConfig()
    d, _ = decide(_ps(6, 0, 0.20), _ps(0, 6, -1.0), cfg)
    assert d == "reject"


def test_decide_inconclusive_not_significant():
    cfg = DecisionConfig()
    # b=3,c=1: p=5/16=0.3125 > 0.05 -> not significant despite positive delta
    d, _ = decide(_ps(3, 1, 0.10), _ps(1, 1, 0.0), cfg)
    assert d == "inconclusive"


def test_decide_legacy_never_accepts():
    cfg = DecisionConfig()
    d, _ = decide(_ps(6, 0, 0.20), None, cfg)   # no held-out split
    assert d == "inconclusive"


if __name__ == "__main__":
    import sys
    fns = [g for n, g in sorted(globals().items()) if n.startswith("test_") and callable(g)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
