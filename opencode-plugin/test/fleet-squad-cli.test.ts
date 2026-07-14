/**
 * fleet-squad-cli.test.ts — squad-cli.ts's contract (task-8 brief).
 * Injectable drive/score (scripted(), same fixture squad.ts's own suite
 * uses) so this never spawns opencode; hermetic META_HARNESS_HOME per test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSquadRunArgs } from "../src/bench/cli.ts"
import { cmdSquadRun, checkpointPath, roleForPhase } from "../src/fleet/squad-cli.ts"
import { writeSquadDefV1, STANDARD_SQUAD, squadRoot, type SquadDef } from "../src/fleet/squad-def.ts"
import { scripted } from "./fleet-helpers.ts"

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-sq-"))
  project = mkdtempSync(join(tmpdir(), "mh-sq-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("roleForPhase", () => {
  test("collapses squad.ts phases to cmdRoleRun's 4 wire slots", () => {
    expect(roleForPhase("analyzer")).toBe("analyzer")
    expect(roleForPhase("evaluator-spec")).toBe("evaluator")
    expect(roleForPhase("evaluator-verdict")).toBe("evaluator")
    expect(roleForPhase("designer")).toBe("designer")
    expect(roleForPhase("implementer")).toBe("implementer")
  })
})

describe("squad-run CLI", () => {
  test("root-human: pauses at gate1 with checkpoint; resume approve → gate2… → done", async () => {
    const { drive, score } = scripted({})
    const first = await cmdSquadRun({ project, sliceId: "s1", slice: "add slugify", gatePolicy: "root-human" }, drive, score)
    expect(first.status).toBe("gate")
    expect(existsSync(checkpointPath(project, "s1"))).toBe(true)

    const second = await cmdSquadRun({ project, sliceId: "s1", resume: true, gateAnswer: "approve" }, drive, score)
    expect(second.status).toBe("gate") // now gate2
    const third = await cmdSquadRun({ project, sliceId: "s1", resume: true, gateAnswer: "approve" }, drive, score)
    expect(third.status).toBe("done")
  })

  test("all-auto runs straight to done; checkpoint recorded", async () => {
    const { drive, score } = scripted({})
    const out = await cmdSquadRun({ project, sliceId: "s2", slice: "x", gatePolicy: "auto" }, drive, score)
    expect(out.status).toBe("done")
  })

  test("resume without checkpoint dies; fresh without slice dies", async () => {
    const { drive, score } = scripted({})
    await expect(cmdSquadRun({ project, sliceId: "nope", resume: true }, drive, score)).rejects.toThrow(/checkpoint/)
    await expect(cmdSquadRun({ project, sliceId: "s3" }, drive, score)).rejects.toThrow(/slice/)
  })

  test("resume revise scores the gate's producer drive bad, under the gate's name, before answerGate", async () => {
    const { drive, score, scores } = scripted({})
    const first = await cmdSquadRun({ project, sliceId: "s4", slice: "x", gatePolicy: "root-human" }, drive, score)
    expect(first.status).toBe("gate")
    if (first.status !== "gate") throw new Error("unreachable")
    expect(first.gate).toBe("gate1")

    const before = scores.length
    const second = await cmdSquadRun({ project, sliceId: "s4", resume: true, gateAnswer: "revise" }, drive, score)
    // exactly one new score call landed from the revise, scored bad under gate1
    const added = scores.slice(before)
    expect(added.length).toBe(1)
    expect(added[0]).toMatchObject({ verdict: "bad", gate: "gate1" })
    // revise re-enters the analyzer, so the squad is back at gate1 again
    expect(second.status).toBe("gate")
    if (second.status === "gate") expect(second.gate).toBe("gate1")
  })
})

describe("squad-run channel 2 — squad-level fitness (spec §6, D5)", () => {
  const scorePath = () => join(squadRoot("standard"), "candidates", "v1", "score.json")

  test("all-auto run to done records passed:true under squads/standard's score.json", async () => {
    const { drive, score } = scripted({})
    const out = await cmdSquadRun({ project, sliceId: "sc1", slice: "x", gatePolicy: "auto" }, drive, score)
    expect(out.status).toBe("done")

    const s = JSON.parse(readFileSync(scorePath(), "utf-8"))
    expect(s.nPass).toBe(1)
    expect(s.nFail).toBe(0)
    expect(s.sessions[0]).toMatchObject({ sliceId: "sc1", passed: true, nodePath: "root/sc1" })
  })

  test("R3-exhaustion run to Exhausted records passed:false with escalationType Exhausted", async () => {
    // Same failForever pattern as fleet-squad.test.ts's R3-exhaustion test:
    // the evaluator keeps returning FAIL-impl until R3 (default 3) trips.
    const failForever = Array(10).fill("VERDICT: FAIL cause=impl\n## Test Spec\nx")
    const { drive, score } = scripted({ "evaluator-verdict": failForever })
    const out = await cmdSquadRun({ project, sliceId: "sc2", slice: "x", gatePolicy: "auto" }, drive, score)
    expect(out.status).toBe("escalation")
    if (out.status === "escalation") expect(out.escalation.type).toBe("Exhausted")

    const s = JSON.parse(readFileSync(scorePath(), "utf-8"))
    expect(s.nFail).toBe(1)
    expect(s.nPass).toBe(0)
    expect(s.sessions[0]).toMatchObject({ sliceId: "sc2", passed: false, escalationType: "Exhausted" })
  })

  test("a gate pause records nothing until resumed to a terminal (done) outcome", async () => {
    const { drive, score } = scripted({})
    const first = await cmdSquadRun({ project, sliceId: "sc3", slice: "x", gatePolicy: "root-human" }, drive, score)
    expect(first.status).toBe("gate")
    expect(existsSync(scorePath())).toBe(false)

    const second = await cmdSquadRun({ project, sliceId: "sc3", resume: true, gateAnswer: "approve" }, drive, score)
    expect(second.status).toBe("gate") // now gate2 — still nothing recorded
    expect(existsSync(scorePath())).toBe(false)

    const third = await cmdSquadRun({ project, sliceId: "sc3", resume: true, gateAnswer: "approve" }, drive, score)
    expect(third.status).toBe("done")
    const s = JSON.parse(readFileSync(scorePath(), "utf-8"))
    expect(s.nPass).toBe(1)
    expect(s.sessions[0]).toMatchObject({ sliceId: "sc3", passed: true })
  })
})

describe("parseSquadRunArgs --def-version (CLI wiring, spec §6 ch2)", () => {
  test("parses --def-version into SquadRunCliArgs.defVersion", () => {
    const out = parseSquadRunArgs(["--project", "P", "--slice-id", "S", "--slice", "x", "--def-version", "v3"])
    expect(out).not.toBeNull()
    expect(out!.defVersion).toBe("v3")
  })

  test("without --def-version, defVersion is undefined", () => {
    const out = parseSquadRunArgs(["--project", "P", "--slice-id", "S", "--slice", "x"])
    expect(out).not.toBeNull()
    expect(out!.defVersion).toBeUndefined()
  })
})

describe("squad-run --def-version pin (spec §6 ch2 — tier-2 candidate selection)", () => {
  test("uses the CANDIDATE def (not active) when --def-version is given, and records to that candidate's score.json", async () => {
    // Candidate v2's tight budget (2) discriminates it from active v1's
    // generous default (40): the happy path costs 7 counted steps
    // (analyzer, gate1, evaluator-spec, designer, gate2, implementer,
    // evaluator-verdict), so v1 sails to "done" while v2 exhausts early.
    const candidate: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, globalBudgetSteps: 2 } },
    }
    mkdirSync(join(squadRoot("standard"), "candidates", "v2"), { recursive: true })
    writeFileSync(join(squadRoot("standard"), "candidates", "v2", "squad.json"), JSON.stringify(candidate))

    const { drive, score } = scripted({})
    const candOut = await cmdSquadRun(
      { project, sliceId: "dv1", slice: "x", gatePolicy: "auto", defVersion: "v2" },
      drive, score,
    )
    expect(candOut.status).toBe("escalation")
    if (candOut.status === "escalation") expect(candOut.escalation.type).toBe("Exhausted")

    // Sanity: the active def (v1, budget 40) really would have passed —
    // proves the discriminator is real, not an unrelated scripted() quirk.
    const activeOut = await cmdSquadRun({ project, sliceId: "dv1b", slice: "x", gatePolicy: "auto" }, drive, score)
    expect(activeOut.status).toBe("done")

    const v2Score = JSON.parse(readFileSync(join(squadRoot("standard"), "candidates", "v2", "score.json"), "utf-8"))
    expect(v2Score.nFail).toBe(1)
    expect(v2Score.sessions[0]).toMatchObject({ sliceId: "dv1", passed: false, escalationType: "Exhausted" })

    // v1's score.json only has the SANITY run recorded, never the v2-pinned one.
    const v1Score = JSON.parse(readFileSync(join(squadRoot("standard"), "candidates", "v1", "score.json"), "utf-8"))
    expect(v1Score.sessions.length).toBe(1)
    expect(v1Score.sessions[0]).toMatchObject({ sliceId: "dv1b", passed: true })
  })

  test("checkpoint carries defVersion; --resume without --def-version stays pinned to the candidate", async () => {
    // v2: gate1 forced human (so the FIRST call pauses+checkpoints) and a
    // tight budget (2) that only trips AFTER resuming — discriminates a
    // correctly-pinned resume (exhausts) from an incorrectly-defaulted one
    // (would fall back to v1's budget of 40 and sail to "done").
    const candidate: SquadDef = {
      ...STANDARD_SQUAD,
      flow: {
        ...STANDARD_SQUAD.flow,
        gatePolicy: { gate1: "human", gate2: "auto" },
        bounds: { ...STANDARD_SQUAD.flow.bounds, globalBudgetSteps: 2 },
      },
    }
    mkdirSync(join(squadRoot("standard"), "candidates", "v2"), { recursive: true })
    writeFileSync(join(squadRoot("standard"), "candidates", "v2", "squad.json"), JSON.stringify(candidate))

    const { drive, score } = scripted({})
    const first = await cmdSquadRun(
      { project, sliceId: "dv2", slice: "x", gatePolicy: "auto", defVersion: "v2" },
      drive, score,
    )
    expect(first.status).toBe("gate")
    if (first.status === "gate") expect(first.gate).toBe("gate1")

    // No --def-version here — must still read v2 (tight budget), not silently
    // fall back to the active v1 def (budget 40, which would reach "done").
    const second = await cmdSquadRun(
      { project, sliceId: "dv2", resume: true, gateAnswer: "approve", gatePolicy: "auto" },
      drive, score,
    )
    expect(second.status).toBe("escalation")
    if (second.status === "escalation") expect(second.escalation.type).toBe("Exhausted")

    const v2Score = JSON.parse(readFileSync(join(squadRoot("standard"), "candidates", "v2", "score.json"), "utf-8"))
    expect(v2Score.nFail).toBe(1)
    // v1's score.json was never written — the resumed run stayed pinned to v2.
    expect(existsSync(join(squadRoot("standard"), "candidates", "v1", "score.json"))).toBe(false)
  })
})
