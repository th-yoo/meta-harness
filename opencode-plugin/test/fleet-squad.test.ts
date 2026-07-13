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
import { answerGate, newSquadState, runSquad, type DriveFn } from "../src/fleet/squad.ts"
import { OK, scripted } from "./fleet-helpers.ts"

const AUTO: SquadDef = STANDARD_SQUAD // gate1/gate2 auto by default

describe("squad runner", () => {
  test("happy path: done with implementer payload; every slot scored good once", async () => {
    const { drive, score, scores } = scripted({})
    const { outcome } = await runSquad(newSquadState("s1", "add slugify"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.filter((s) => s.verdict === "good").length).toBeGreaterThanOrEqual(4)
    // Additive outcome field (fleet-integration §2): the done outcome names
    // the IMPLEMENTER's drive id specifically — never the evaluator's, even
    // though the evaluator's evaluator-verdict drive is the one that ran
    // last and closed the slice. scripted() ids are `d<n>-<phase>`; the
    // sequential v1 flow drives analyzer/evaluator-spec/designer/implementer/
    // evaluator-verdict in that order, so the implementer is drive 4.
    if (outcome.status === "done") {
      expect(outcome.implementerSessionId).toBe("d4-implementer")
    }
  })

  test("lint fail scores bad + redoes within R1, then passes", async () => {
    const { drive, score, scores } = scripted({ analyzer: ["not a payload", OK.analyzer!] })
    const { outcome } = await runSquad(newSquadState("s2", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.some((s) => s.gate === "lint" && s.verdict === "bad")).toBe(true)
  })

  test("evaluator-verdict spec-only payload (no VERDICT line) lint-fails immediately, not via unparseable-verdict; retries within R1 then passes", async () => {
    // Live-smoke finding (task-9): a verdict-mode payload that re-emits a
    // test spec (no VERDICT line) used to lint-PASS via the collapsed
    // "evaluator" slot's spec-mode OR-group, reach parseVerdict, fail there
    // (unparseable), and only THEN get scored bad — i.e. two "lint-ok"
    // history entries for the bad attempt's phase, never a "lint-fail". The
    // phase-aware lint key ("evaluator-verdict": [["VERDICT:"]]) must catch
    // this at the wire-lint gate instead, before parseVerdict ever runs.
    const specOnly = "## Test Spec\nran\nno verdict line here"
    const { drive, score, scores } = scripted({
      "evaluator-verdict": [specOnly, OK["evaluator-verdict"]!],
    })
    const { state, outcome } = await runSquad(newSquadState("s3v", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")

    const evVerdictEvents = state.history
      .filter((h) => h.phase === "evaluator-verdict")
      .map((h) => h.event)
    expect(evVerdictEvents).toEqual(["lint-fail", "lint-ok"])

    // Scored bad/lint for the first (spec-only) attempt's own id.
    const badLint = scores.find((s) => s.gate === "lint" && s.verdict === "bad")
    expect(badLint).toBeDefined()
    expect(badLint!.id).toContain("evaluator-verdict")
    // R1 exhaustion never triggered — this was a within-bound retry, not an
    // escalation.
    expect(state.counters.r1["evaluator"]).toBe(1)
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

  test("R3 exhaustion escalates Exhausted; escalation still names the last implementer drive", async () => {
    const failForever = Array(10).fill("VERDICT: FAIL cause=impl\n## Test Spec\nx")
    const { drive, score } = scripted({ "evaluator-verdict": failForever })
    const { outcome } = await runSquad(newSquadState("s4", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("escalation")
    if (outcome.status === "escalation") {
      expect(outcome.escalation.type).toBe("Exhausted")
      // An implementer drive ran (repeatedly) before R3 tripped — the
      // escalation surfaces its id too (spec §2 "surface on escalation
      // outcomes when an implementer drive exists").
      expect(outcome.implementerSessionId).toMatch(/-implementer$/)
    }
  })

  test("R3 exhaustion escalation carries the EXACT last implementer drive id, not just a matching shape", async () => {
    // Under-tested sub-case (fleet-integration.md:111-125): an escalation
    // that fires AFTER at least one implementer drive already ran (R3
    // exhaustion is exactly this — implementer drives repeatedly, once per
    // FAIL-impl loop, before the R3 bound trips) must carry THAT specific
    // drive's id, not merely something id-shaped. Wraps scripted()'s drive
    // to independently capture every implementer id squad.ts itself saw,
    // so the assertion below doesn't just re-derive squad.ts's own
    // bookkeeping — it cross-checks it against a second, test-owned record.
    const failForever = Array(10).fill("VERDICT: FAIL cause=impl\n## Test Spec\nx")
    const { drive: baseDrive, score } = scripted({ "evaluator-verdict": failForever })
    const implementerIds: string[] = []
    const drive: DriveFn = async (phase, input, sliceId) => {
      const r = await baseDrive(phase, input, sliceId)
      if (phase === "implementer") implementerIds.push(r.id)
      return r
    }
    const { outcome } = await runSquad(newSquadState("s4b", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("escalation")
    // R3 bound is 3 (squad-def.ts) -> implementer drives 4 times (r3 hits 4
    // > 3 on the 4th FAIL-impl) before exhaustion trips.
    expect(implementerIds.length).toBe(4)
    if (outcome.status === "escalation") {
      expect(outcome.escalation.type).toBe("Exhausted")
      expect(outcome.implementerSessionId).toBe(implementerIds[implementerIds.length - 1])
      expect(outcome.implementerSessionId).not.toBeUndefined()
    }
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
    // No implementer drive ever ran on this slice (Clarify fires at the
    // analyzer, the very first phase) — implementerSessionId must be absent,
    // not some stale/undefined-coerced value.
    if (r1.outcome.status === "escalation") expect(r1.outcome.implementerSessionId).toBeUndefined()

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
