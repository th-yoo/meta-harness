/**
 * fleet-e2e.test.ts — the plan's acceptance test for spec §8 step 2 (task-9
 * brief): the FULL depth-1 squad chain, hermetic and zero-token —
 *
 *   cmdRolesImport(fixtures) -> cmdRolesRender(project) ->
 *   cmdSquadRun(gate-policy: "auto")
 *
 * — driven end to end through the REAL cmdRoleRun -> pending -> cmdRoleScore
 * chain (only the opencode process spawn is faked).
 *
 * squad-cli.ts's `cmdSquadRun` has no ExecFn seam of its own: its prod
 * (non-injected) DriveFn closure calls `cmdRoleRun` directly with the real
 * `defaultExec` (bench/exec.ts's `runHost`, a genuine host spawn). To drive
 * this hermetically we build our OWN DriveFn below that mirrors that prod
 * closure byte-for-byte (phase -> wire slot via the exported `roleForPhase`,
 * `silent: true`, `nodePath: root/<sliceId>/<phase>`) but threads an
 * INJECTED `ExecFn` through `cmdRoleRun` instead. That still exercises the
 * real `cmdRoleRun` (render-stamp read, NDJSON parse, pending write) and,
 * since `scoreFn` is left undefined below, the real `cmdRoleScore` (stamped-
 * version recording, fleet provenance, archive) too — the only thing this
 * test fakes is the opencode subprocess itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cmdRolesImport } from "../src/fleet/import.ts"
import { cmdRolesRender } from "../src/fleet/render.ts"
import { cmdRoleRun, type ExecFn } from "../src/fleet/run.ts"
import { pendingDir } from "../src/fleet/pending.ts"
import { cmdSquadRun, roleForPhase } from "../src/fleet/squad-cli.ts"
import { STANDARD_SQUAD, writeSquadDefV1 } from "../src/fleet/squad-def.ts"
import type { DriveFn } from "../src/fleet/squad.ts"
import { accountRoleRoot, readScore } from "../src/harness-store.ts"
import { OK } from "./fleet-helpers.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-e2e-home-"))
  project = mkdtempSync(join(tmpdir(), "mh-e2e-proj-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

/**
 * NDJSON trace matching test/fixtures/fleet/trace-multi-turn.ndjson's event
 * shape (a tool_use turn, a final text turn, one step_finish) — just enough
 * for `opencodeDriver.classifyAttempt` to read "done" (rc 0 + step_finish
 * activity) and `extractFinalPayload` to return exactly `payload` as the
 * last step_finish-delimited segment. `sessionId` is stamped onto every
 * event (real opencode NDJSON carries `sessionID` on every line) so
 * `extractSessionId` recovers it verbatim — each of this test's 5 drives
 * gets its OWN distinct id, since readPending/archivePending key on id and
 * duplicate ids would collide (double-score).
 */
function trace(sessionId: string, payload: string): string {
  const lines = [
    {
      type: "tool_use",
      sessionID: sessionId,
      part: { tool: "read", state: { input: "notes.md", output: "ok", status: "completed", metadata: { exit: 0 } } },
    },
    { type: "text", sessionID: sessionId, text: payload },
    { type: "step_finish", sessionID: sessionId, part: { reason: "stop", tokens: { input: 10, output: 20 }, cost: 0.001 } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

describe("fleet squad E2E (hermetic, zero tokens)", () => {
  test("import -> render -> squad-run(all-auto) drives the real run/pending/score chain to done", async () => {
    // 1. squad def must exist before render/run can find an active one
    // (mirrors the `squad-def-init` CLI case).
    writeSquadDefV1(STANDARD_SQUAD)

    // 2. import: the Task 4 fixture personas. architect.md seeds BOTH
    // analyzer + designer (spec §11's 3-role-doctrine bridge: one source
    // body may seed several role stores verbatim until the 4-role split
    // lands fleet-side); implementer.md/evaluator.md seed themselves.
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })

    // 3. render all 4 personas onto the project. Wire-lint note: the Task 4
    // fixtures already carry their consuming squad's wire headings (verified
    // by inspection + test/fleet-import.test.ts's own assertions: architect.md
    // mentions "## Use Cases"/"## Functional Spec"/"## Alternatives"/
    // "## Recommended"/"## Clarify"; implementer.md mentions
    // "## Implementation Report"; evaluator.md mentions BOTH "## Test Spec"
    // and "VERDICT:") — this call must NOT need --force.
    cmdRolesRender({ project })

    // 4. per-agent fixture NDJSON queues, matched by argv's --agent value
    // (run.ts's argv shape: [...,"--agent",spec.agent,...]). mh-evaluator
    // drives TWICE in one full auto pass (evaluator-spec, then
    // evaluator-verdict) — queued front-to-back, each with its own id.
    const ids = {
      analyzer: "ses_e2e_analyzer01",
      evaluatorSpec: "ses_e2e_evalspec01",
      designer: "ses_e2e_designer01",
      implementer: "ses_e2e_implemen01",
      evaluatorVerdict: "ses_e2e_evalverd01",
    }
    const queues: Record<string, string[]> = {
      "mh-analyzer": [trace(ids.analyzer, OK.analyzer!)],
      "mh-designer": [trace(ids.designer, OK.designer!)],
      "mh-implementer": [trace(ids.implementer, OK.implementer!)],
      "mh-evaluator": [
        trace(ids.evaluatorSpec, OK["evaluator-spec"]!),
        trace(ids.evaluatorVerdict, OK["evaluator-verdict"]!),
      ],
    }
    const execFn: ExecFn = async (argv) => {
      const at = argv.indexOf("--agent")
      const agent = at >= 0 ? argv[at + 1] : undefined
      const q = agent ? queues[agent] : undefined
      if (!q || q.length === 0) throw new Error(`no fixture trace queued for --agent ${agent}`)
      return { stdout: q.shift()!, rc: 0 }
    }

    // 5. the test's OWN DriveFn — mirrors squad-cli.ts's prod (non-injected)
    // DriveFn closure exactly (phase -> wire slot via the exported
    // `roleForPhase`, `silent: true`, `nodePath: root/<sliceId>/<phase>`),
    // with the injected `execFn` threaded through `cmdRoleRun` in place of
    // the real host spawn `cmdSquadRun` itself would use. `scoreFn` is left
    // undefined below so `cmdSquadRun`'s own prod path (the real
    // `cmdRoleScore`) runs untouched.
    const drive: DriveFn = async (phase, input, sliceId) => {
      const role = roleForPhase(phase)
      const r = await cmdRoleRun(
        { project, role, input, sliceId, nodePath: `root/${sliceId}/${phase}`, silent: true },
        execFn,
      )
      return { id: r.id, payload: r.payload }
    }

    const sliceId = "demo-slice"
    const outcome = await cmdSquadRun(
      { project, sliceId, slice: "add slugify(s) to util.sh + a test", gatePolicy: "auto" },
      drive,
    )

    expect(outcome.status).toBe("done")
    if (outcome.status === "done") expect(outcome.payload).toContain("## Implementation Report")

    // -- per-role stores got scores on the STAMPED v1 (cmdRolesImport wrote
    // v1 as each role's active account-role version; renderRole pinned that
    // exact version into the render stamp, which score.ts routes on) --
    for (const agent of ["mh-analyzer", "mh-designer", "mh-implementer", "mh-evaluator"]) {
      const score = readScore(accountRoleRoot(agent), "v1")
      expect(score.nPass).toBeGreaterThanOrEqual(1)
    }
    // mh-evaluator drove twice (spec-authoring + verdict) -> 2 records.
    expect(readScore(accountRoleRoot("mh-evaluator"), "v1").sessions.length).toBe(2)

    // -- fleet provenance: a session record's nodePath is rooted at this
    // slice (root/demo-slice/<phase>) --
    const analyzerRec = readScore(accountRoleRoot("mh-analyzer"), "v1").sessions[0]!
    const fleetEnv = analyzerRec.env?.["fleet"] as { nodePath?: string } | undefined
    expect(fleetEnv?.nodePath).toMatch(/^root\/demo-slice\//)

    // -- pending dir: no leftover PENDING SESSIONS — all 5 drives archived
    // into scored/. squad-run's own checkpoint file is co-located in this
    // same directory (checkpointPath's parent == pendingDir(project)) by
    // construction; it is the one non-scored-session entry expected here,
    // not a leftover pending drive. --
    const leftover = readdirSync(pendingDir(project)).sort()
    expect(leftover).toEqual(["scored", `squad-${sliceId}.json`].sort())
    for (const id of Object.values(ids)) {
      expect(existsSync(join(pendingDir(project), "scored", `${id}.json`))).toBe(true)
    }
  })
})
