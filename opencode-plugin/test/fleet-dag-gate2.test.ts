/**
 * fleet-dag-gate2.test.ts — T3 (N4) Task 4: gate2 emit -> parse -> approve,
 * end-to-end through the SHIPPED gate. Produces nothing new — integration
 * proof only, over Tasks 1-3's dag.ts + PLANNER_SQUAD. Hermetic: injected
 * DriveFn (Test A, no personas) / injected execFn (Test B, NDJSON idiom
 * fleet-squad-run-model.test.ts already uses) — no real opencode spawn, no
 * real git.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun } from "../src/fleet/squad-cli.ts"
import { writeSquadDefV1, PLANNER_SQUAD } from "../src/fleet/squad-def.ts"
import { formatDagBlock, parseDagFromPayload, type TaskDag } from "../src/fleet/dag.ts"
import { cmdRoleRun, type ExecFn } from "../src/fleet/run.ts"
import { scripted, seedRenderedRole } from "./fleet-helpers.ts"

const DAG: TaskDag = {
  nodes: [
    { id: "a", task: "build worktree prim", deps: [] },
    { id: "b", task: "build dag schema", deps: [] },
    { id: "c", task: "wire scheduler", deps: ["a", "b"], files: ["src/fleet/dag-scheduler.ts"] },
  ],
}

describe("planner gate2 = DAG approval (shipped gate)", () => {
  let home: string, project: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-dag-g2-home-"))
    project = mkdtempSync(join(tmpdir(), "mh-dag-g2-proj-"))
    process.env.META_HARNESS_HOME = home
    writeSquadDefV1(PLANNER_SQUAD) // planner def active (syncs the DAG contract)
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  test("Designer emits the DAG; gate2 pauses on it; parse yields a valid TaskDag; approve advances", async () => {
    // Override ONLY the designer phase to emit the ## Task DAG block; the
    // analyzer/evaluator-spec phases fall back to fleet-helpers' OK payloads.
    const { drive, score } = scripted({ designer: [formatDagBlock(DAG)] })
    const first = await cmdSquadRun(
      { project, sliceId: "plan1", slice: "self-host feature X", squadType: "planner", gatePolicy: "auto" },
      drive, score,
    )
    expect(first.status).toBe("gate")
    if (first.status !== "gate") throw new Error("unreachable")
    expect(first.gate).toBe("gate2") // gate1 auto-approved; gate2 is the DAG gate
    const parsed = parseDagFromPayload(first.payload) // the DAG rode the Designer payload to gate2
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.dag).toEqual(DAG) // byte-consistent with T4's runDag input

    // approve via the SHIPPED gate machinery (answerGate / --resume) — no new gate
    const second = await cmdSquadRun(
      { project, sliceId: "plan1", resume: true, gateAnswer: "approve", squadType: "planner", gatePolicy: "auto" },
      drive, score,
    )
    expect(second.status).not.toBe("gate") // approve moved the flow past gate2 (existing mechanism)
  })
})

/** Minimal NDJSON trace: one text turn (the payload) + a step_finish, same
 * shape fleet-squad-run-model.test.ts's own `trace()` fixture uses — just
 * enough for cmdRoleRun's classify/parse/extract chain to treat this as a
 * real, well-formed drive. */
function trace(payload: string): string {
  const lines = [
    { type: "text", sessionID: "ses_dag_gate2_1", text: payload },
    { type: "step_finish", sessionID: "ses_dag_gate2_1", part: { reason: "stop", tokens: { input: 1, output: 1 }, cost: 0 } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

describe("the DAG survives the REAL role-output parse path (NDJSON execFn idiom)", () => {
  let home: string, project: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-dag-g2b-home-"))
    project = mkdtempSync(join(tmpdir(), "mh-dag-g2b-proj-"))
    process.env.META_HARNESS_HOME = home
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  test("cmdRoleRun's NDJSON->extractFinalPayload round-trips the DAG block", async () => {
    // STANDARD's designer render-lint (## Alternatives + ## Recommended) is
    // satisfied by the seeded body — the DAG rides the injected execFn's
    // payload, not the persona body (T3 plan scope note).
    seedRenderedRole(project, "designer", "designer body\n## Alternatives\nx\n## Recommended\ny")
    const execFn: ExecFn = async () => ({ stdout: trace(formatDagBlock(DAG)), rc: 0 })
    const res = await cmdRoleRun({ project, role: "designer", input: "x" }, execFn)
    const parsed = parseDagFromPayload(res.payload)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.dag).toEqual(DAG)
  })
})
