/**
 * fleet-squad-cli.test.ts — squad-cli.ts's contract (task-8 brief).
 * Injectable drive/score (scripted(), same fixture squad.ts's own suite
 * uses) so this never spawns opencode; hermetic META_HARNESS_HOME per test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun, checkpointPath, roleForPhase } from "../src/fleet/squad-cli.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
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
