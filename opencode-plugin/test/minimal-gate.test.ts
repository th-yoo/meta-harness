import { test, expect } from "bun:test"
import {
  classifyTrials,
  fisherTwoSided,
  gateLift,
  gateGuard,
  gateVerdict,
  type RunRecord,
} from "../../minimal/gate.ts"

function rec(over: Partial<RunRecord> & { rewards?: number[] }): RunRecord {
  const rewards = over.rewards ?? [1]
  return {
    task: "sparql-university",
    host: "yoo-mac.local",
    model: "anthropic/claude-opus-4-8",
    driver: "opencode",
    system: null,
    harness: null,
    rewards,
    trials: rewards.map((r, i) => ({
      attempt: i + 1,
      reward: r,
      turns: 1,
      elapsedSec: 200,
      timedOut: false,
      suspect: false,
    })),
    ...over,
  } as RunRecord
}

// ── forensics classification ────────────────────────────────────────────────

test("classifyTrials: clean trials are all valid", () => {
  const c = classifyTrials(rec({ rewards: [1, 0, 1] }))
  expect(c.valid.length).toBe(3)
  expect(c.voids.length).toBe(0)
})

test("classifyTrials: suspect (0-turn) trial is VOID with reason", () => {
  const r = rec({ rewards: [1, 0] })
  r.trials[1]!.turns = 0
  r.trials[1]!.suspect = true
  r.trials[1]!.elapsedSec = 49
  const c = classifyTrials(r)
  expect(c.valid.length).toBe(1)
  expect(c.voids.length).toBe(1)
  expect(c.voids[0]!.reason).toContain("0 turns")
})

test("classifyTrials: genuine timeout (turns>0, timedOut) stays VALID — real failure", () => {
  const r = rec({ rewards: [0] })
  r.trials[0]!.timedOut = true
  r.trials[0]!.elapsedSec = 3600
  const c = classifyTrials(r)
  expect(c.valid.length).toBe(1)
})

// ── fisher ──────────────────────────────────────────────────────────────────

test("fisherTwoSided reproduces the loop-2 certification value", () => {
  // v7 1/10 vs v9 7/10 → p = 0.0198 (computed 2026-07-22, in reboot.md)
  expect(fisherTwoSided(1, 9, 7, 3)).toBeCloseTo(0.0198, 3)
})

test("fisherTwoSided: no difference → p = 1", () => {
  expect(fisherTwoSided(5, 5, 5, 5)).toBeCloseTo(1.0, 5)
})

// ── lift gate ───────────────────────────────────────────────────────────────

test("gateLift: certified when p < alpha, pooling multiple records per arm", () => {
  // minimal system-gate: bare 3/10+3/10 vs cand 8/10+9/10 → p ≈ 0.00106
  const base = [rec({ rewards: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0] }), rec({ rewards: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0] })]
  const cand = [
    rec({ system: "sha-x", rewards: [1, 1, 1, 1, 1, 1, 1, 1, 0, 0] }),
    rec({ system: "sha-x", rewards: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] }),
  ]
  const g = gateLift(base, cand)
  expect(g.basePass).toBe(6)
  expect(g.candPass).toBe(17)
  expect(g.p).toBeLessThan(0.05)
  expect(g.verdict).toBe("lift-certified")
})

test("gateLift: directional when positive but p >= alpha", () => {
  const g = gateLift([rec({ rewards: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] })], [rec({ system: "s", rewards: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0] })])
  expect(g.verdict).toBe("directional")
})

test("gateLift: null verdict when no lift", () => {
  const g = gateLift([rec({ rewards: [1, 1, 0] })], [rec({ system: "s", rewards: [1, 1, 0] })])
  expect(g.verdict).toBe("null")
})

test("gateLift: refuses cross-task pooling (provenance)", () => {
  expect(() => gateLift([rec({})], [rec({ task: "other-task", system: "s" })])).toThrow(/task/)
})

test("gateLift: refuses cross-host arms (provenance)", () => {
  expect(() => gateLift([rec({})], [rec({ host: "office", system: "s" })])).toThrow(/host/)
})

test("gateLift: void trials are excluded from the counts", () => {
  const b = rec({ rewards: [1, 0, 0] })
  b.trials[1]!.turns = 0
  b.trials[1]!.suspect = true
  const g = gateLift([b], [rec({ system: "s", rewards: [1, 1, 0] })])
  expect(g.baseN).toBe(2)
})

// ── guard gate ──────────────────────────────────────────────────────────────

test("gateGuard: all valid candidate trials pass → hold", () => {
  const g = gateGuard(rec({ task: "chess-best-move", rewards: [1] }), rec({ task: "chess-best-move", system: "s", rewards: [1, 1, 1] }))
  expect(g.verdict).toBe("hold")
})

test("gateGuard: any valid candidate fail → regressed, with counts", () => {
  const g = gateGuard(rec({ task: "chess-best-move", rewards: [1] }), rec({ task: "chess-best-move", system: "s", rewards: [1, 0, 1] }))
  expect(g.verdict).toBe("regressed")
  expect(g.candPass).toBe(2)
  expect(g.candN).toBe(3)
})

test("gateGuard: void candidate trial does not count as regression", () => {
  const c = rec({ task: "chess-best-move", system: "s", rewards: [1, 0, 1] })
  c.trials[1]!.turns = 0
  c.trials[1]!.suspect = true
  const g = gateGuard(rec({ task: "chess-best-move", rewards: [1] }), c)
  expect(g.verdict).toBe("hold")
  expect(g.voids).toBe(1)
})

test("gateGuard: requires a passing baseline screen — unscreened guard is an error", () => {
  expect(() => gateGuard(rec({ task: "chess-best-move", rewards: [0] }), rec({ task: "chess-best-move", system: "s", rewards: [1, 1, 1] }))).toThrow(/baseline/)
})

// ── combined verdict ────────────────────────────────────────────────────────

test("gateVerdict: ADOPT only when lift certified AND every guard holds", () => {
  const lift = { verdict: "lift-certified" } as any
  expect(gateVerdict(lift, [{ verdict: "hold" } as any, { verdict: "hold" } as any]).decision).toBe("ADOPT")
  expect(gateVerdict(lift, [{ verdict: "hold" } as any, { verdict: "regressed" } as any]).decision).toBe("REJECT")
  expect(gateVerdict({ verdict: "directional" } as any, [{ verdict: "hold" } as any]).decision).toBe("REJECT")
})

test("gateVerdict: ZERO guards measured → REJECT (v9 lesson — guard-less adoption forbidden)", () => {
  const v = gateVerdict({ verdict: "lift-certified" } as any, [])
  expect(v.decision).toBe("REJECT")
  expect(v.reasons.join(" ")).toContain("guard")
})
