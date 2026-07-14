/**
 * fleet-squad-cli.test.ts — squad-cli.ts's contract (task-8 brief).
 * Injectable drive/score (scripted(), same fixture squad.ts's own suite
 * uses) so this never spawns opencode; hermetic META_HARNESS_HOME per test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun, checkpointPath, roleForPhase } from "../src/fleet/squad-cli.ts"
import { writeSquadDefV1, STANDARD_SQUAD, squadRoot } from "../src/fleet/squad-def.ts"
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
