/**
 * fleet-squad.test.ts — squad.ts's contract (task-7 brief). `scripted()`/
 * `OK` live in ./fleet-helpers.ts (shared fleet-test fixture, see that
 * file's header) rather than inline here.
 *
 * Adaptation from the brief: the brief's Step 1 coverage list names
 * "FAIL-design re-enters designer and testSpec survives" as required
 * coverage and its Step 4 expects 9 passing tests, but the brief's own
 * fenced code block only contains 8 `test(...)` blocks and none of them
 * exercises FAIL-design. Added the missing test below (mirrors the
 * FAIL-impl/FAIL-intent tests' shape) to close that gap and reach 9.
 */
import { describe, expect, test } from "bun:test"
import { STANDARD_SQUAD, type SquadDef } from "../src/fleet/squad-def.ts"
import { answerGate, newSquadState, runSquad } from "../src/fleet/squad.ts"
import { OK, scripted } from "./fleet-helpers.ts"

const AUTO: SquadDef = STANDARD_SQUAD // gate1/gate2 auto by default

describe("squad runner", () => {
  test("happy path: done with implementer payload; every slot scored good once", async () => {
    const { drive, score, scores } = scripted({})
    const { outcome } = await runSquad(newSquadState("s1", "add slugify"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.filter((s) => s.verdict === "good").length).toBeGreaterThanOrEqual(4)
  })

  test("lint fail scores bad + redoes within R1, then passes", async () => {
    const { drive, score, scores } = scripted({ analyzer: ["not a payload", OK.analyzer!] })
    const { outcome } = await runSquad(newSquadState("s2", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.some((s) => s.gate === "lint" && s.verdict === "bad")).toBe(true)
  })

  test("VERDICT FAIL-impl loops implementer within R3 then passes", async () => {
    const { drive, score, scores } = scripted({
      "evaluator-verdict": ["## Test Spec\nx\nVERDICT: FAIL cause=impl", OK["evaluator-verdict"]!],
    })
    const { outcome } = await runSquad(newSquadState("s3", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.filter((s) => s.gate === "verdict" && s.verdict === "bad").length).toBe(1)
  })

  test("VERDICT FAIL-design re-enters designer, absolves implementer, testSpec survives", async () => {
    const { drive, score, scores } = scripted({
      "evaluator-verdict": ["## Test Spec\nx\nVERDICT: FAIL cause=design", OK["evaluator-verdict"]!],
    })
    const { state, outcome } = await runSquad(newSquadState("s3d", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    // implementer absolved: FAIL-design never scores "verdict" bad
    expect(scores.some((s) => s.gate === "verdict" && s.verdict === "bad")).toBe(false)
    // re-entered designer, NOT analyzer — testSpec never invalidated, so
    // evaluator-spec only ever ran once; designer ran twice.
    expect(state.history.filter((h) => h.phase === "evaluator-spec").length).toBe(1)
    expect(state.history.filter((h) => h.phase === "designer").length).toBe(2)
  })

  test("R3 exhaustion escalates Exhausted", async () => {
    const failForever = Array(10).fill("VERDICT: FAIL cause=impl\n## Test Spec\nx")
    const { drive, score } = scripted({ "evaluator-verdict": failForever })
    const { outcome } = await runSquad(newSquadState("s4", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("escalation")
    if (outcome.status === "escalation") expect(outcome.escalation.type).toBe("Exhausted")
  })

  test("FAIL-intent invalidates test spec (evaluator-spec redriven)", async () => {
    const { drive, score } = scripted({
      "evaluator-verdict": ["## Test Spec\nx\nVERDICT: FAIL cause=intent", OK["evaluator-verdict"]!],
    })
    const state0 = newSquadState("s5", "x")
    const { state, outcome } = await runSquad(state0, AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(state.history.filter((h) => h.phase === "evaluator-spec").length).toBe(2)
  })

  test("Clarify escalates; Refused escalates and is never scored", async () => {
    const c = scripted({ analyzer: ["## Clarify\nA or B?"] })
    const r1 = await runSquad(newSquadState("s6", "x"), AUTO, c.drive, c.score)
    expect(r1.outcome.status).toBe("escalation")

    const r = scripted({ implementer: ["## Refused\nharmful"] })
    const r2 = await runSquad(newSquadState("s7", "x"), AUTO, r.drive, r.score)
    expect(r2.outcome.status).toBe("escalation")
    if (r2.outcome.status === "escalation") expect(r2.outcome.escalation.type).toBe("Refused")
    expect(r.scores.find((s) => s.id.includes("implementer"))).toBeUndefined()
  })

  test("human gate1 pauses; approve continues; revise re-runs analyzer without burning R1", async () => {
    const def: SquadDef = { ...AUTO, flow: { ...AUTO.flow, gatePolicy: { gate1: "human", gate2: "auto" } } }
    const { drive, score } = scripted({})
    const first = await runSquad(newSquadState("s8", "x"), def, drive, score)
    expect(first.outcome.status).toBe("gate")
    const revised = answerGate(first.state, "revise")
    expect(revised.counters.r1["analyzer"] ?? 0).toBe(0)
    const second = await runSquad(revised, def, drive, score)
    expect(second.outcome.status).toBe("gate") // re-ran analyzer, back at gate1
    const approved = answerGate(second.state, "approve")
    const third = await runSquad(approved, def, drive, score)
    expect(third.outcome.status).toBe("done")
  })

  test("globalBudgetSteps trips Exhausted", async () => {
    const def: SquadDef = { ...AUTO, flow: { ...AUTO.flow, bounds: { ...AUTO.flow.bounds, globalBudgetSteps: 2 } } }
    const { drive, score } = scripted({})
    const { outcome } = await runSquad(newSquadState("s9", "x"), def, drive, score)
    expect(outcome.status).toBe("escalation")
  })
})
