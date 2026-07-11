import { test, expect } from "bun:test"
import {
  pairedRunStats,
  mcnemarExactOneSided,
  bootstrapTaskCi,
  futilityStop,
  decide,
  DEFAULT_DECISION_CONFIG,
  type PairStats,
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

test("decide: inconclusive when held-in win is not significant (p=5/16)", () => {
  const { decision } = decide(ps(3, 1, 0.1), ps(1, 1, 0.0), DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
})

test("decide: legacy mode (null held-out) never accepts", () => {
  const { decision } = decide(ps(6, 0, 0.2), null, DEFAULT_DECISION_CONFIG)
  expect(decision).toBe("inconclusive")
})

// ── additions: TS-specific risks ─────────────────────────────────────────

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
  expect(reasons[0]).toBe("held-in: delta=+0.200 p=0.016 (b=6,c=0,n=6)")
})
