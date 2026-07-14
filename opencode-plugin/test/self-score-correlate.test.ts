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
    const rep = correlateSelfScores(r, { minTasks: 1, minSelfPass: 1 }) // small fixture; exercise the lift axis
    expect(rep.nPairs).toBe(6)
    expect(rep.nSelfPass).toBe(2) // a and b each contribute one selfScore=1.0 attempt
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
    // minTasks:1 isolates the lift axis (N=2 would otherwise fail the N floor).
    expect(correlateSelfScores(r, { liftGate: 0.6, minTasks: 1 }).predictive).toBe(false)
    expect(correlateSelfScores(r, { liftGate: 0.4, minTasks: 1 }).predictive).toBe(true)
  })

  test("N floor (default 30): huge lift on tiny N is NOT predictive (review R4#1)", () => {
    // 2 tasks, a perfect self-PASS→reward signal, lift = +100pp — but N=2 ≪ 30.
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1], selfScores: [1.0] },
        b: { rewards: [0], selfScores: [0.0] },
      },
    }
    const rep = correlateSelfScores(r) // default minTasks = 30
    expect(rep.nTasks).toBe(2)
    expect(rep.minTasks).toBe(30)
    expect(rep.liftSelfPass).toBeCloseTo(0.5, 5)
    expect(rep.predictive).toBe(false) // N floor forces false despite the lift
  })

  test("N floor met + lift clears bar → predictive", () => {
    // 30 tasks: self-PASS ⇒ pass, self-fail ⇒ fail → base 0.5, self-PASS rate 1.0.
    const tasks: ResultsLike["tasks"] = {}
    for (let i = 0; i < 30; i++) {
      tasks[`pass${i}`] = { rewards: [1], selfScores: [1.0] }
      tasks[`fail${i}`] = { rewards: [0], selfScores: [0.0] }
    }
    const rep = correlateSelfScores({ tasks })
    expect(rep.nTasks).toBe(60)
    expect(rep.liftSelfPass).toBeCloseTo(0.5, 5)
    expect(rep.predictive).toBe(true)
  })

  test("N floor met but lift below gate → not predictive", () => {
    // 40 tasks, self-score uncorrelated with reward → ~0 lift.
    const tasks: ResultsLike["tasks"] = {}
    for (let i = 0; i < 40; i++) {
      tasks[`t${i}`] = { rewards: [i % 2], selfScores: [1.0] } // all self-PASS, half reward
    }
    const rep = correlateSelfScores({ tasks })
    expect(rep.nTasks).toBe(40)
    expect(rep.liftSelfPass).toBeCloseTo(0, 5)
    expect(rep.predictive).toBe(false)
  })

  test("self-PASS sample floor: 29 self-FAIL + 1 lucky self-PASS over 30 tasks (lift ~0.967) → NOT predictive", () => {
    // Reproduces the C1 gap: bestOfKTasks (30) clears minTasks (30), and the
    // single self-PASS attempt happens to have reward=1 → huge liftSelfPass —
    // but n_selfpass=1 must NOT be enough to trust that lift.
    const tasks: ResultsLike["tasks"] = {}
    for (let i = 0; i < 29; i++) tasks[`fail${i}`] = { rewards: [0], selfScores: [0.0] }
    tasks["luckyPass"] = { rewards: [1], selfScores: [1.0] }
    const rep = correlateSelfScores({ tasks })
    expect(rep.nTasks).toBe(30)
    expect(rep.nSelfPass).toBe(1)
    expect(rep.liftSelfPass).toBeGreaterThan(0.9)
    expect(rep.predictive).toBe(false) // n_selfpass floor, not the lift, blocks this
  })

  test("self-PASS sample floor met + real lift → predictive", () => {
    // 30 tasks, 10 genuine self-PASS (all reward=1) + 20 self-FAIL (reward=0).
    const tasks: ResultsLike["tasks"] = {}
    for (let i = 0; i < 10; i++) tasks[`pass${i}`] = { rewards: [1], selfScores: [1.0] }
    for (let i = 0; i < 20; i++) tasks[`fail${i}`] = { rewards: [0], selfScores: [0.0] }
    const rep = correlateSelfScores({ tasks })
    expect(rep.nTasks).toBe(30)
    expect(rep.nSelfPass).toBe(10)
    expect(rep.liftSelfPass).toBeGreaterThan(0.2)
    expect(rep.predictive).toBe(true)
  })

  test("minSelfPass is configurable and defaults to a fraction of minTasks", () => {
    // minTasks:1 (isolates the N-task floor, as other small-fixture tests do)
    // but minSelfPass explicitly raised above the fixture's 1 self-PASS.
    const r: ResultsLike = {
      tasks: {
        a: { rewards: [1], selfScores: [1.0] },
        b: { rewards: [0], selfScores: [0.0] },
      },
    }
    expect(correlateSelfScores(r, { minTasks: 1, minSelfPass: 1 }).predictive).toBe(true)
    expect(correlateSelfScores(r, { minTasks: 1, minSelfPass: 2 }).predictive).toBe(false)
  })
})
