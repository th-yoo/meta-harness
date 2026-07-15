/**
 * fleet-squad-worktree.test.ts — cmdSquadRun must thread `worktreeDir` onto
 * every role drive's `--dir` while the ledger (pending) lands under `project`
 * (runtimeRoot). Mirrors fleet-squad-run-model.test.ts's execFn-seam pattern:
 * an analyzer Clarify short-circuits to a terminal escalation after one drive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun } from "../src/fleet/squad-cli.ts"
import { cmdRolesImport } from "../src/fleet/import.ts"
import { cmdRolesRender } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { listPending } from "../src/fleet/pending.ts"
import type { ExecFn } from "../src/fleet/run.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")

function trace(payload: string): string {
  const lines = [
    { type: "text", sessionID: "ses_wt_1", text: payload },
    { type: "step_finish", sessionID: "ses_wt_1", part: { reason: "stop", tokens: { input: 1, output: 1 }, cost: 0 } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

describe("cmdSquadRun worktreeDir threading", () => {
  let home: string, rt: string, wt: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-sqwt-home-"))
    rt = mkdtempSync(join(tmpdir(), "mh-sqwt-rt-"))       // runtimeRoot: ledger, NO personas
    wt = mkdtempSync(join(tmpdir(), "mh-sqwt-wt-"))       // worktree: personas rendered here
    process.env.META_HARNESS_HOME = home
    writeSquadDefV1(STANDARD_SQUAD)
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })
    cmdRolesRender({ project: wt })                        // personas into the worktree
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(rt, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  })

  test("drives --dir=worktree while the ledger lands under project (N1/N1b)", async () => {
    const captured: string[][] = []
    const execFn: ExecFn = async (argv) => { captured.push(argv); return { stdout: trace("## Clarify\nneed more"), rc: 0 } }
    const outcome = await cmdSquadRun(
      { project: rt, worktreeDir: wt, sliceId: "s1", slice: "x" },
      undefined, undefined, execFn,
    )
    expect(outcome.status).toBe("escalation")
    const at = captured[0]!.indexOf("--dir")
    expect(captured[0]![at + 1]).toBe(wt)                  // N1: role drives the worktree
    // pendingDir === checkpointPath dir (<project>/.meta-harness/runtime/fleet/),
    // so listPending also returns the checkpoint file squad-<slice>.json — filter
    // to the real session (ses_ prefix) to assert the SESSION ledger, not the checkpoint.
    expect(listPending(rt).filter((id) => id.startsWith("ses_")).length).toBeGreaterThan(0) // N1b: session ledger under runtimeRoot
    expect(listPending(wt)).toEqual([])                    // not the worktree
  })

  test("no worktreeDir: --dir=project (byte-identical back-compat)", async () => {
    cmdRolesRender({ project: rt })                        // when no worktree, personas live in project
    const captured: string[][] = []
    const execFn: ExecFn = async (argv) => { captured.push(argv); return { stdout: trace("## Clarify\nx"), rc: 0 } }
    await cmdSquadRun({ project: rt, sliceId: "s2", slice: "x" }, undefined, undefined, execFn)
    const at = captured[0]!.indexOf("--dir")
    expect(captured[0]![at + 1]).toBe(rt)
  })
})
