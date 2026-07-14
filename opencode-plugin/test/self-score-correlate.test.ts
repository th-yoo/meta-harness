import { describe, expect, test } from "bun:test"
import { correlateSelfScores, type ResultsLike } from "../src/bench/self-score-correlate.ts"

describe("correlateSelfScores", () => {
  test("perfect predictor: self-PASS ⇒ reward, self-FAIL ⇒ no reward → predictive", () => {
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1, 0], selfScores: [1.0, 0.5] },   // self-PASS→pass, self-fail→fail
        b: { rewards: [1, 0], selfScores: [1.0, 0.3] },
        c: { rewards: [0, 0], selfScores: [0.4, 0.2] },
      },
    }
    const rep = correlateSelfScores(r)
    expect(rep.nPairs).toBe(6)
    expect(rep.baseRewardRate).toBeCloseTo(2 / 6, 5)
    expect(rep.rewardRateGivenSelfPass).toBe(1)          // both selfScore=1.0 attempts passed
    expect(rep.liftSelfPass).toBeGreaterThan(0.2)
    expect(rep.bestOfKSelectionRate).toBeCloseTo(2 / 3, 5) // argmax picks the passing attempt in a,b
    expect(rep.bestOfKLift).toBeGreaterThan(0)
    expect(rep.pointBiserial).toBeGreaterThan(0)
    expect(rep.predictive).toBe(true)
  })

  test("no signal: self-score uncorrelated with reward → NOT predictive", () => {
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1, 0], selfScores: [1.0, 1.0] }, // self-PASS both, one passes
        b: { rewards: [0, 1], selfScores: [1.0, 1.0] },
      },
    }
    const rep = correlateSelfScores(r)
    expect(rep.rewardRateGivenSelfPass).toBeCloseTo(0.5, 5) // = base rate → no lift
    expect(rep.liftSelfPass).toBeCloseTo(0, 5)
    expect(rep.predictive).toBe(false)
  })

  test("null selfScores skipped; setup_failed slots ignored", () => {
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1, 0, 0], selfScores: [1.0, null, null] }, // only 1 usable pair
      },
    }
    const rep = correlateSelfScores(r)
    expect(rep.nPairs).toBe(1)
    expect(rep.nTasks).toBe(1)
    expect(rep.bestOfKSelectionRate).toBe(1) // the single non-null attempt passed
  })

  test("tasks without selfScores (normal run) contribute nothing", () => {
    const r: ResultsLike = { tasks: { a: { rewards: [1, 0] } } } // no selfScores key
    const rep = correlateSelfScores(r)
    expect(rep.nPairs).toBe(0)
    expect(rep.predictive).toBe(false)
  })

  test("liftGate is configurable", () => {
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1], selfScores: [1.0] },
        b: { rewards: [0], selfScores: [0.0] },
      },
    }
    // base=0.5, self-PASS rate=1.0 → lift=0.5. Gate 0.6 → not predictive; 0.4 → predictive.
    expect(correlateSelfScores(r, { liftGate: 0.6 }).predictive).toBe(false)
    expect(correlateSelfScores(r, { liftGate: 0.4 }).predictive).toBe(true)
  })
})
