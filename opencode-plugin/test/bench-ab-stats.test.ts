import { test, expect } from "bun:test"
import {
  pairedRunStats,
  mcnemarExactOneSided,
  mcnemarMidPOneSided,
  bootstrapTaskCi,
  futilityStop,
  decide,
  pairedSpeedStats,
  DEFAULT_DECISION_CONFIG,
  type PairStats,
  type TaskResults,
} from "../src/bench/ab-stats.ts"

// Ported from term-bench2/test_ab_stats.py — see that file for the original
// vectors and comments. Additions at the bottom cover TS-specific risks
// (BigInt overflow guard, PRNG determinism) called out in the port brief.

// ── mcnemarExactOneSided ─────────────────────────────────────────────────

test("mcnemar: b=6,c=0 -> 1/64 (all candidate wins)", () => {
  expect(mcnemarExactOneSided(6, 0)).toBeCloseTo(1 / 64, 9)
})

test("mcnemar: b=5,c=1 -> 7/64", () => {
  expect(mcnemarExactOneSided(5, 1)).toBeCloseTo(7 / 64, 9)
})

test("mcnemar: b=3,c=3 (tie) -> 42/64", () => {
  expect(mcnemarExactOneSided(3, 3)).toBeCloseTo(42 / 64, 9)
})

test("mcnemar: b=0,c=0 -> 1.0 (no discordant pairs)", () => {
  expect(mcnemarExactOneSided(0, 0)).toBe(1.0)
})

// ── pairedRunStats ────────────────────────────────────────────────────────

test("pairedRunStats aggregates b/c/pass counts and per-task deltas, excluding errored tasks", () => {
  const taskResults = {
    t1: { candidate: [1, 1], active: [0, 1] }, // pair0 b, pair1 concordant
    t2: { candidate: [0], active: [1] }, // c
    t3: { candidate: [1], active: [1] }, // concordant
    t4: { candidate: [0, 0], active: [0, 0], error: "setup_failed" }, // excluded
  }
  const s = pairedRunStats(taskResults)
  expect(s.b).toBe(1)
  expect(s.c).toBe(1)
  expect(s.nPairs).toBe(4) // 2 + 1 + 1 (t4 excluded)
  expect(s.nTasks).toBe(3)
  expect(s.candPass).toBe(3)
  expect(s.actPass).toBe(3)
  expect(s.delta).toBeCloseTo(0.0, 9)
  expect(s.taskDeltas.t1).toBeCloseTo(0.5, 9)
  expect(s.taskDeltas.t2).toBeCloseTo(-1.0, 9)
  expect(s.taskDeltas.t3).toBeCloseTo(0.0, 9)
  expect(s.taskDeltas.t4).toBeUndefined()
})

test("pairedRunStats on empty input", () => {
  const s = pairedRunStats({})
  expect(s.nPairs).toBe(0)
  expect(s.b).toBe(0)
  expect(s.c).toBe(0)
  expect(s.delta).toBe(0.0)
})

// ── futilityStop ────────────────────────────────────────────────────────

test("futilityStop kills when behind after min tasks", () => {
  expect(futilityStop(1, 4, 12)).toBe(true) // c-b=3 >= 3, tasks>=12
})

test("futilityStop does not fire before min tasks", () => {
  expect(futilityStop(0, 5, 11)).toBe(false) // too few tasks
})

test("futilityStop does not fire when candidate ahead", () => {
  expect(futilityStop(5, 1, 20)).toBe(false) // candidate ahead
})

// ── bootstrapTaskCi ─────────────────────────────────────────────────────

test("bootstrapTaskCi on a degenerate (all-equal) input collapses to that value", () => {
  const [lo, hi] = bootstrapTaskCi([0.5, 0.5, 0.5], 500, 0.1, 0)
  expect(lo).toBeCloseTo(0.5, 9)
  expect(hi).toBeCloseTo(0.5, 9)
})

test("bootstrapTaskCi is deterministic under a fixed seed and brackets the sample mean", () => {
  const deltas = [0.4, -0.1, 0.6, 0.2, 0.3]
  const a = bootstrapTaskCi(deltas, 2000, 0.1, 7)
  const b = bootstrapTaskCi(deltas, 2000, 0.1, 7)
  expect(a).toEqual(b) // deterministic under seed
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length
  expect(a[0]).toBeLessThanOrEqual(mean)
  expect(a[1]).toBeGreaterThanOrEqual(mean)
})

test("bootstrapTaskCi on empty input returns [0, 0]", () => {
  expect(bootstrapTaskCi([])).toEqual([0.0, 0.0])
})

// ── decide ──────────────────────────────────────────────────────────────

function ps(b: number, c: number, delta: number): PairStats {
  return {
    nTasks: 0,
    nPairs: b + c,
    b,
    c,
    candPass: 0,
    actPass: 0,
    delta,
    taskDeltas: {},
  }
}

test("decide: accepts a significant held-in win with a clean held-out", () => {
  const { decision } = decide(ps(6, 0, 0.2), ps(1, 1, 0.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("accept")
})

test("decide: rejects when active wins held-in significantly", () => {
  const { decision } = decide(ps(0, 6, -0.2), ps(0, 0, 0.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("reject")
})

test("decide: rejects on held-out regression despite a held-in win", () => {
  const { decision } = decide(ps(6, 0, 0.2), ps(0, 6, -1.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("reject")
})

// Margin-only held-out regression (point estimate past the margin but NOT
// statistically supported) must not hard-reject — reject feeds the permanent
// do-not-re-derive ledger, and the v18 crank proved this fires on pure noise
// (delta −0.10 at p_active=0.377; one pair-flip of 20 erased it). The margin
// still BLOCKS accept; the verdict is inconclusive.
test("decide: margin-only held-out regression (not significant) → inconclusive, not reject", () => {
  // v18's actual numbers: held-in b=4,c=3 (+0.05); held-out b=4,c=6 (−0.10), p_active≈0.377
  const { decision, reasons } = decide(ps(4, 3, 0.05), ps(4, 6, -0.1), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
  expect(reasons.some((r) => r.includes("not significant"))).toBe(true)
})

test("decide: margin-only held-out regression still blocks an otherwise-significant accept", () => {
  // held-in 6/0 would accept; held-out delta −0.08 at p_active=0.25 must veto
  const { decision } = decide(ps(6, 0, 0.2), ps(0, 2, -0.08), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
})

test("decide: statistically supported held-out regression still hard-rejects", () => {
  // c=5,b=0 → p_active = 1/32 ≈ 0.031 ≤ 0.05 → real regression, reject
  const { decision } = decide(ps(4, 3, 0.05), ps(0, 5, -0.15), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("reject")
})

test("decide: inconclusive when held-in win is not significant (p=5/16)", () => {
  const { decision } = decide(ps(3, 1, 0.1), ps(1, 1, 0.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
})

test("decide: legacy mode (null held-out) never accepts", () => {
  const { decision } = decide(ps(6, 0, 0.2), null, DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
})

// ── additions: TS-specific risks ─────────────────────────────────────────

// ── mid-p McNemar (power fix, 2026-08-12): the exact one-sided test is
// deliberately conservative at the small discordant counts our k=5-7 abs
// produce, making accept structurally unreachable (v18 crank post-mortem).
// mid-p subtracts HALF the probability of the observed count — standard
// correction, same false-positive control in practice, real power gain.

test("mcnemarMidPOneSided: mid-p = exact − 0.5·P(X=b)", () => {
  // b=6,c=0: exact = (1/2)^6 = 0.015625; P(X=6)=0.015625 → mid-p = 0.0078125
  expect(mcnemarMidPOneSided(6, 0)).toBeCloseTo(0.0078125, 10)
  // b=4,c=6 (v18's held-out, candidate side): exact P(X>=4|n=10)... reversed
  // call as decide() does: (c,b)=(6,4): exact = P(X>=6|n=10) = 0.376953125,
  // P(X=6)=210/1024 → mid-p = 0.376953125 − 0.1025390625 = 0.2744140625
  expect(mcnemarMidPOneSided(6, 4)).toBeCloseTo(0.2744140625, 10)
  // n=0 → 1.0 (same convention as exact)
  expect(mcnemarMidPOneSided(0, 0)).toBe(1.0)
})

test("decide uses mid-p: a 15/6 discordant held-in win now accepts (exact would too-conservatively pass p=.05 only at wider margins)", () => {
  // b=15,c=6,n=21: exact P(X>=15) = 0.0392 — accept either way; the pinned
  // point is that decide()'s printed p matches MID-P (0.0392 − 0.5·0.0259
  // = 0.0262), locking which test feeds the gate.
  const { decision, reasons } = decide(ps(15, 6, 0.2), ps(1, 1, 0.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("accept")
  expect(reasons[0]).toContain("p=0.026")
})

test("mcnemar: large-n BigInt guard stays finite and in (0,1)", () => {
  const p = mcnemarExactOneSided(60, 40)
  expect(Number.isFinite(p)).toBe(true)
  expect(p).toBeGreaterThan(0)
  expect(p).toBeLessThan(1)
})

test("mcnemar: n=200 all-one-side stays representable and tiny", () => {
  const p = mcnemarExactOneSided(200, 0)
  expect(p).toBeGreaterThan(0)
  expect(p).toBeLessThan(1e-30)
})

test("bootstrapTaskCi: different seeds usually produce different CIs", () => {
  const deltas = [0.4, -0.1, 0.6, 0.2, 0.3, -0.5, 0.9, 0.0]
  const a = bootstrapTaskCi(deltas, 2000, 0.1, 1)
  const b = bootstrapTaskCi(deltas, 2000, 0.1, 2)
  expect(a).not.toEqual(b)
})

test("decide: reasons formatting locks pySigned/pyFixed integration", () => {
  const { reasons } = decide(ps(6, 0, 0.2), null, DEFAULT_DECISION_CONFIG)
  // 1/64 = 0.015625 -> ".3f" = 0.016
  // mid-p (power fix): 6/0 exact 0.015625 − 0.5·0.015625 = 0.0078125 → ".3f" 0.008
  expect(reasons[0]).toBe("held-in: delta=+0.200 p=0.008 (b=6,c=0,n=6)")
})

// ── pairedSpeedStats (W1a: time-to-resolve) ──────────────────────────────

test("pairedSpeedStats: pairs only both-pass run-pairs, never compares fail times", () => {
  const taskResults: TaskResults = {
    t1: { candidate: [1, 1], active: [1, 0], candidateElapsed: [10, 8], activeElapsed: [20, 3] },
    // pair0: both pass, candidate faster (10 < 20) -> counted.
    // pair1: candidate passed, active FAILED -> excluded even though both elapsed values exist.
    t2: { candidate: [0], active: [1], candidateElapsed: [1], activeElapsed: [50] }, // both fail-side (candidate failed) -> excluded
  }
  const s = pairedSpeedStats(taskResults)
  expect(s).not.toBeNull()
  expect(s!.nPairs).toBe(1)
  expect(s!.nTasks).toBe(1)
  expect(s!.medianCandidate).toBe(10)
  expect(s!.medianActive).toBe(20)
})

test("pairedSpeedStats: excludes pairs missing elapsed data even when both rewards are 1", () => {
  const taskResults: TaskResults = {
    t1: { candidate: [1], active: [1] }, // no elapsed arrays at all (old-shape/back-compat)
    t2: { candidate: [1], active: [1], candidateElapsed: [0], activeElapsed: [5] }, // zero elapsed excluded (present>0 required)
  }
  expect(pairedSpeedStats(taskResults)).toBeNull()
})

test("pairedSpeedStats: excludes errored tasks", () => {
  const taskResults: TaskResults = {
    t1: {
      candidate: [1],
      active: [1],
      candidateElapsed: [5],
      activeElapsed: [10],
      error: "setup_failed",
    },
  }
  expect(pairedSpeedStats(taskResults)).toBeNull()
})

test("pairedSpeedStats: median odd count picks the middle value", () => {
  const taskResults: TaskResults = {
    t1: {
      candidate: [1, 1, 1],
      active: [1, 1, 1],
      candidateElapsed: [10, 30, 20],
      activeElapsed: [5, 5, 5],
    },
  }
  const s = pairedSpeedStats(taskResults)!
  expect(s.medianCandidate).toBe(20) // sorted [10,20,30] -> middle
  expect(s.medianActive).toBe(5)
})

test("pairedSpeedStats: median even count averages the two middle values", () => {
  const taskResults: TaskResults = {
    t1: {
      candidate: [1, 1],
      active: [1, 1],
      candidateElapsed: [10, 30],
      activeElapsed: [5, 15],
    },
  }
  const s = pairedSpeedStats(taskResults)!
  expect(s.medianCandidate).toBe(20) // (10+30)/2
  expect(s.medianActive).toBe(10) // (5+15)/2
})

test("pairedSpeedStats: medianRatio < 1 when candidate is faster, > 1 when slower", () => {
  const faster: TaskResults = {
    t1: { candidate: [1], active: [1], candidateElapsed: [5], activeElapsed: [10] },
  }
  const slower: TaskResults = {
    t1: { candidate: [1], active: [1], candidateElapsed: [20], activeElapsed: [10] },
  }
  expect(pairedSpeedStats(faster)!.medianRatio).toBeCloseTo(0.5, 9)
  expect(pairedSpeedStats(slower)!.medianRatio).toBeCloseTo(2.0, 9)
})

test("pairedSpeedStats: medianRatio is the median over PER-PAIR ratios, never the ratio of pooled medians", () => {
  // Pairs 10/20 (ratio 0.5) and 30/10 (ratio 3.0): per-pair median = 1.75.
  // The wrong construction — medianCandidate/medianActive = 20/15 ≈ 1.333 —
  // must NOT be produced; this fixture discriminates the two formulas.
  const taskResults: TaskResults = {
    t1: { candidate: [1, 1], active: [1, 1], candidateElapsed: [10, 30], activeElapsed: [20, 10] },
  }
  const s = pairedSpeedStats(taskResults)!
  expect(s.medianRatio).toBeCloseTo(1.75, 9)
  expect(s.medianRatio).not.toBeCloseTo(s.medianCandidate / s.medianActive, 2)
})

test("pairedSpeedStats: fasterB/slowerC mirror mcnemar's b/c and signTestP reuses mcnemarExactOneSided", () => {
  const taskResults: TaskResults = {
    // 5 pairs where candidate is faster, 1 where active is faster -> b=5,c=1 (matches the
    // "mcnemar: b=5,c=1 -> 7/64" hand-case above).
    t1: {
      candidate: [1, 1, 1, 1, 1, 1],
      active: [1, 1, 1, 1, 1, 1],
      candidateElapsed: [1, 1, 1, 1, 1, 20],
      activeElapsed: [10, 10, 10, 10, 10, 10],
    },
  }
  const s = pairedSpeedStats(taskResults)!
  expect(s.fasterB).toBe(5)
  expect(s.slowerC).toBe(1)
  expect(s.signTestP).toBeCloseTo(mcnemarExactOneSided(5, 1), 12)
  expect(s.signTestP).toBeCloseTo(7 / 64, 9)
})

test("pairedSpeedStats: ties (equal elapsed) count toward nPairs but not fasterB/slowerC", () => {
  const taskResults: TaskResults = {
    t1: { candidate: [1], active: [1], candidateElapsed: [10], activeElapsed: [10] },
  }
  const s = pairedSpeedStats(taskResults)!
  expect(s.nPairs).toBe(1)
  expect(s.fasterB).toBe(0)
  expect(s.slowerC).toBe(0)
})

test("pairedSpeedStats: null on empty input", () => {
  expect(pairedSpeedStats({})).toBeNull()
})
