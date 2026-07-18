import { test, expect } from "bun:test"
import { harnessVariance, tierVariance, curateBand, type Matrix, type TaskStats, type TiersMap } from "../src/bench/leaderboard.ts"

// ── harnessVariance ──────────────────────────────────────────────────────

test("harnessVariance: mean/variance computed only over subs that reported (missing pairs omitted)", () => {
  const matrix: Matrix = {
    t1: { a: 1, b: 1, c: 0, d: 0 }, // coverage 4, mean .5, population variance .25
    t5: { a: 1, e: 0, f: 1, g: 1, h: 0 }, // coverage 5, mean .6, variance .24
  }
  const stats = harnessVariance(matrix, 4)
  expect(stats.t1!.coverage).toBe(4)
  expect(stats.t1!.mean).toBeCloseTo(0.5, 9)
  expect(stats.t1!.variance).toBeCloseTo(0.25, 9)
  expect(stats.t5!.coverage).toBe(5)
  expect(stats.t5!.mean).toBeCloseTo(0.6, 9)
  expect(stats.t5!.variance).toBeCloseTo(0.24, 9)
})

test("harnessVariance: below minSubs floor -> variance null/untrusted, but mean still reported", () => {
  const matrix: Matrix = {
    t2: { a: 1, b: 0, c: 1 }, // coverage 3 < minSubs 4
    t3: { a: 1 }, // coverage 1
    t4: {}, // coverage 0 -> mean/variance both null
  }
  const stats = harnessVariance(matrix, 4)
  expect(stats.t2!.coverage).toBe(3)
  expect(stats.t2!.variance).toBeNull()
  expect(stats.t2!.mean).toBeCloseTo(2 / 3, 9)

  expect(stats.t3!.coverage).toBe(1)
  expect(stats.t3!.variance).toBeNull()
  expect(stats.t3!.mean).toBe(1)

  expect(stats.t4!.coverage).toBe(0)
  expect(stats.t4!.variance).toBeNull()
  expect(stats.t4!.mean).toBeNull()
})

test("harnessVariance: minSubs floor is configurable", () => {
  const matrix: Matrix = { t2: { a: 1, b: 0, c: 1 } }
  const stats = harnessVariance(matrix, 3)
  expect(stats.t2!.variance).not.toBeNull()
  expect(stats.t2!.variance).toBeCloseTo(2 / 9, 9) // mean 2/3, dev^2: 1/9,4/9,1/9 -> sum 6/9 /3 = 2/9
})

// ── tierVariance ─────────────────────────────────────────────────────────

const tiers: TiersMap = { a: "frontier", b: "frontier", c: "mid", d: "mid", e: "small" }

test("tierVariance: groups by tier and measures BETWEEN-tier spread, not raw noise", () => {
  const matrix: Matrix = {
    // raw values noisy (variance .25) but tiers agree (both tier-means .5) -> tierVariance 0
    noisyButNoTierSignal: { a: 1, b: 0, c: 1, d: 0 },
    // clean tier separation: frontier always passes, mid always fails
    cleanTierSignal: { a: 1, b: 1, c: 0, d: 0 },
  }
  const raw = harnessVariance(matrix, 4)
  const tiered = tierVariance(matrix, tiers, 4)

  expect(raw.noisyButNoTierSignal!.variance).toBeCloseTo(0.25, 9)
  expect(tiered.noisyButNoTierSignal!.variance).toBeCloseTo(0, 9)
  expect(tiered.noisyButNoTierSignal!.tierMeans).toEqual({ frontier: 0.5, mid: 0.5 })

  expect(tiered.cleanTierSignal!.tierMeans).toEqual({ frontier: 1, mid: 0 })
  expect(tiered.cleanTierSignal!.variance).toBeCloseTo(0.25, 9) // population variance of [1,0]
})

test("tierVariance: subs absent from the tiers map are excluded from grouping but still count toward coverage", () => {
  const matrix: Matrix = { t: { a: 1, b: 1, c: 0, d: 0, unmapped: 1 } }
  const stats = tierVariance(matrix, tiers, 4)
  expect(stats.t!.coverage).toBe(5)
  expect(stats.t!.tierMeans).toEqual({ frontier: 1, mid: 0 })
  expect(stats.t!.tiersCovered).toBe(2)
})

test("tierVariance: fewer than 2 tiers represented -> variance untrusted even with high coverage", () => {
  const matrix: Matrix = { t: { a: 1, b: 0 } } // both frontier, only 1 tier
  const stats = tierVariance(matrix, tiers, 1) // minSubs satisfied trivially
  expect(stats.t!.coverage).toBe(2)
  expect(stats.t!.tiersCovered).toBe(1)
  expect(stats.t!.variance).toBeNull()
})

test("tierVariance: below minSubs floor -> variance untrusted", () => {
  const matrix: Matrix = { t: { a: 1, c: 0 } } // coverage 2, 2 tiers, but minSubs 4
  const stats = tierVariance(matrix, tiers, 4)
  expect(stats.t!.tiersCovered).toBe(2)
  expect(stats.t!.variance).toBeNull()
})

// ── curateBand ───────────────────────────────────────────────────────────

function fixtureStats(): Record<string, TaskStats> {
  return {
    taskG: { mean: 0.5, variance: 0.2, coverage: 5 },
    taskD: { mean: 0.6, variance: null, coverage: 2 }, // untrusted
    taskB: { mean: 0.1, variance: 0.09, coverage: 5 }, // below band
    taskH: { mean: 0.55, variance: 0.2, coverage: 5 }, // ties taskG on variance
    taskA: { mean: 0.5, variance: 0.25, coverage: 5 },
    taskF: { mean: 0.5, variance: 0.3, coverage: 5 }, // local, no our-rate
    taskC: { mean: 0.9, variance: 0.09, coverage: 5 }, // above band
    taskE: { mean: 0.4, variance: 0.16, coverage: 6 }, // qualifies but not local
  }
}

test("curateBand: filters by mean band, drops untrusted (null variance) tasks", () => {
  const stats = fixtureStats()
  const ourRates = { taskA: 0.5, taskG: 0.6, taskH: 0.5 }
  const localTasks = ["taskA", "taskB", "taskD", "taskF", "taskG", "taskH"]
  const result = curateBand(stats, ourRates, { band: [0.2, 0.8], localTasks, max: 10, minSubs: 4 })
  // taskB (mean .1), taskC (mean .9, also not local), taskD (untrusted) must never appear anywhere
  const all = [...result.band, ...result.shortlist, ...result.excludedNonLocal]
  expect(all).not.toContain("taskB")
  expect(all).not.toContain("taskC")
  expect(all).not.toContain("taskD")
})

test("curateBand: local-intersection -> qualifying non-local tasks land in excludedNonLocal", () => {
  const stats = fixtureStats()
  const ourRates = { taskA: 0.5, taskG: 0.6, taskH: 0.5 }
  const localTasks = ["taskA", "taskG", "taskH", "taskF"] // taskE deliberately absent (not local)
  const result = curateBand(stats, ourRates, { band: [0.2, 0.8], localTasks, max: 10, minSubs: 4 })
  expect(result.excludedNonLocal).toEqual(["taskE"])
  expect(result.band).not.toContain("taskE")
  expect(result.shortlist).not.toContain("taskE")
})

test("curateBand: local task with no ourRates entry -> shortlist, not band", () => {
  const stats = fixtureStats()
  const ourRates = { taskA: 0.5, taskG: 0.6, taskH: 0.5 } // taskF intentionally missing
  const localTasks = ["taskA", "taskG", "taskH", "taskF"]
  const result = curateBand(stats, ourRates, { band: [0.2, 0.8], localTasks, max: 10, minSubs: 4 })
  expect(result.shortlist).toEqual(["taskF"])
  expect(result.band).not.toContain("taskF")
})

test("curateBand: band is sorted by variance descending, tie broken alphabetically, deterministic under key-order shuffle", () => {
  const stats = fixtureStats()
  const ourRates = { taskA: 0.5, taskG: 0.6, taskH: 0.5 }
  const localTasks = ["taskA", "taskG", "taskH"]
  const result1 = curateBand(stats, ourRates, { band: [0.2, 0.8], localTasks, max: 10, minSubs: 4 })
  // taskA var .25 > taskG/taskH var .2 (tie -> alphabetical: G before H)
  expect(result1.band).toEqual(["taskA", "taskG", "taskH"])

  // Re-run with stats object keys inserted in a different order -> same output
  const shuffled: Record<string, TaskStats> = {}
  for (const k of ["taskH", "taskA", "taskG", "taskB", "taskC", "taskD", "taskE", "taskF"]) {
    shuffled[k] = stats[k]!
  }
  const result2 = curateBand(shuffled, ourRates, { band: [0.2, 0.8], localTasks, max: 10, minSubs: 4 })
  expect(result2.band).toEqual(result1.band)
})

test("curateBand: max caps the returned band size (highest-variance tasks kept)", () => {
  const stats = fixtureStats()
  const ourRates = { taskA: 0.5, taskG: 0.6, taskH: 0.5 }
  const localTasks = ["taskA", "taskG", "taskH"]
  const result = curateBand(stats, ourRates, { band: [0.2, 0.8], localTasks, max: 1, minSubs: 4 })
  expect(result.band).toEqual(["taskA"])
})

test("curateBand: minSubs default is 4 when omitted", () => {
  const stats: Record<string, TaskStats> = {
    lowCoverage: { mean: 0.5, variance: 0.2, coverage: 3 },
  }
  const result = curateBand(stats, {}, { band: [0.2, 0.8], localTasks: ["lowCoverage"], max: 10 })
  expect(result.band).toEqual([])
  expect(result.shortlist).toEqual([])
})
