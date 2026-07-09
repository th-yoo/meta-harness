"""
ab_stats.py — statistics for the Phase 1 A/B selection gate.

Pure functions, no I/O, no third-party deps (no scipy/numpy). The inferential
unit is the *run-pair*: arm A (active) run i and arm B (candidate) run i of the
same task, interleaved by cmd_ab. McNemar's exact test on the discordant pairs
is the cheap screen; a bootstrap-over-tasks CI is the clustering-aware
confirmatory statistic. Everything is deliberately small-sample honest — see
docs/enhancement-roadmap.md for the power analysis.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import comb
import random


@dataclass
class PairStats:
    n_tasks: int
    n_pairs: int
    b: int                       # discordant run-pairs where candidate passed, active failed
    c: int                       # discordant run-pairs where active passed, candidate failed
    cand_pass: int               # total candidate passes across all run-pairs
    act_pass: int                # total active passes
    delta: float                 # mean paired per-run delta (candidate - active)
    task_deltas: dict            # task -> mean(candidate rewards) - mean(active rewards)


@dataclass
class DecisionConfig:
    alpha: float = 0.05                # held-in significance threshold
    nonregress_margin: float = 0.05    # tolerated held-out point drop
    ho_guard_alpha: float = 0.05       # held-out "significantly worse" guard


def paired_run_stats(task_results: dict) -> PairStats:
    """Aggregate {task: {candidate:[rewards], active:[rewards], error?}} into PairStats.
    Tasks with a truthy `error` (e.g. setup_failed) are excluded from every count."""
    b = c = cand_pass = act_pass = n_pairs = 0
    task_deltas: dict = {}
    n_tasks = 0
    for task, tr in task_results.items():
        if tr.get("error"):
            continue
        cand = tr.get("candidate", [])
        act = tr.get("active", [])
        m = min(len(cand), len(act))
        if m == 0:
            continue
        n_tasks += 1
        tc = ta = 0
        for i in range(m):
            rc, ra = cand[i], act[i]
            cand_pass += rc
            act_pass += ra
            tc += rc
            ta += ra
            n_pairs += 1
            if rc == 1 and ra == 0:
                b += 1
            elif rc == 0 and ra == 1:
                c += 1
        task_deltas[task] = (tc - ta) / m
    delta = (cand_pass - act_pass) / n_pairs if n_pairs else 0.0
    return PairStats(n_tasks=n_tasks, n_pairs=n_pairs, b=b, c=c,
                     cand_pass=cand_pass, act_pass=act_pass,
                     delta=delta, task_deltas=task_deltas)


def mcnemar_exact_one_sided(b: int, c: int) -> float:
    """One-sided McNemar exact p-value for the hypothesis that the candidate is
    better: P(X >= b) where X ~ Binomial(b+c, 0.5). Small p = candidate wins the
    discordant pairs more than chance. Returns 1.0 when there are no discordant pairs."""
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(comb(n, k) for k in range(b, n + 1))
    return tail / (2 ** n)


def bootstrap_task_ci(task_deltas, n_boot: int = 10_000, alpha: float = 0.10,
                      seed: int = 0):
    """Bootstrap CI on the mean per-task delta, resampling *tasks* with replacement
    (respects within-task clustering). Returns the (alpha/2, 1-alpha/2) percentiles
    — a (1-alpha) two-sided interval, e.g. a 90% CI at alpha=0.10. Deterministic
    under `seed`."""
    deltas = list(task_deltas)
    if not deltas:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(deltas)
    means = []
    for _ in range(n_boot):
        s = 0.0
        for _ in range(n):
            s += deltas[rng.randrange(n)]
        means.append(s / n)
    means.sort()
    lo = means[max(0, int((alpha / 2) * n_boot) - 1)]
    hi = means[min(n_boot - 1, int((1 - alpha / 2) * n_boot))]
    return (round(lo, 4), round(hi, 4))


def futility_stop(b: int, c: int, tasks_done: int,
                  min_tasks: int = 12, net_behind: int = 3) -> bool:
    """Early-KILL only (never early-accept, so no alpha inflation): stop once the
    candidate is `net_behind` discordant pairs behind after `min_tasks` completed."""
    return tasks_done >= min_tasks and (c - b) >= net_behind


def decide(held_in: PairStats, held_out, cfg: DecisionConfig):
    """Return (decision, reasons). decision ∈ {accept, reject, inconclusive}.

    accept  iff  held-in wins significantly (delta>0, McNemar p<=alpha) AND a
                 held-out split exists AND held-out shows no regression.
    reject  if   active wins held-in significantly, or held-out regresses.
    else    inconclusive (the common case at these sample sizes).
    """
    reasons = []
    p_in = mcnemar_exact_one_sided(held_in.b, held_in.c)
    p_in_rev = mcnemar_exact_one_sided(held_in.c, held_in.b)
    reasons.append(f"held-in: delta={held_in.delta:+.3f} p={p_in:.3f} "
                   f"(b={held_in.b},c={held_in.c},n={held_in.n_pairs})")

    if held_in.delta < 0 and p_in_rev <= cfg.alpha:
        reasons.append("active significantly better on held-in")
        return "reject", reasons

    win_in = held_in.delta > 0 and p_in <= cfg.alpha

    if held_out is None:
        reasons.append("no held-out split (legacy mode) — cannot accept")
        return "inconclusive", reasons

    p_ho_rev = mcnemar_exact_one_sided(held_out.c, held_out.b)
    reasons.append(f"held-out: delta={held_out.delta:+.3f} p_active={p_ho_rev:.3f} "
                   f"(b={held_out.b},c={held_out.c},n={held_out.n_pairs})")
    ho_regress = (held_out.delta < -cfg.nonregress_margin
                  or (held_out.delta < 0 and p_ho_rev <= cfg.ho_guard_alpha))
    if ho_regress:
        reasons.append("held-out regression")
        return "reject", reasons

    if win_in:
        reasons.append("accept: held-in significant win, held-out non-regress")
        return "accept", reasons

    reasons.append("inconclusive: held-in win not significant")
    return "inconclusive", reasons
