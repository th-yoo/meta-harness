/**
 * fleet-squad-run-model.test.ts — regression coverage for the "dead
 * model_override flag" follow-up: `squad-run --model M` must actually reach
 * the drive. Two seams, two describes:
 *
 *  1. cli.ts's `parseSquadRunArgs` — does `--model` parse into
 *     `SquadRunCliArgs.model`? Direct unit test on the exported pure parser
 *     (mirrors `role-run`'s own already-working `--model` case) — the
 *     wiring from parsed args into the `cmdSquadRun({...})` call object at
 *     cli.ts's squad-run case is a one-line, visually-verifiable
 *     passthrough (`model: squadRunArgs.model`), covered by inspection.
 *
 *  2. squad-cli.ts's `cmdSquadRun` prod (non-injected) `DriveFn` — does
 *     `args.model` actually land in the object built for `cmdRoleRun`, and
 *     from there onto `opencode run`'s real argv? Driven end-to-end through
 *     the REAL `cmdSquadRun` -> `cmdRoleRun` chain via `cmdSquadRun`'s
 *     test-only `execFn` seam (mirrors `fleet-e2e.test.ts`'s own pattern of
 *     injecting an `ExecFn` through `cmdRoleRun`) — no module mocking, no
 *     real process spawn, no cross-test-file leakage risk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSquadRunArgs } from "../src/bench/cli.ts"
import { cmdSquadRun } from "../src/fleet/squad-cli.ts"
import { cmdRolesImport } from "../src/fleet/import.ts"
import { cmdRolesRender } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import type { ExecFn } from "../src/fleet/run.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")

describe("cli.ts parseSquadRunArgs --model", () => {
  test("--model M parses into SquadRunCliArgs.model", () => {
    const out = parseSquadRunArgs(["--project", "P", "--slice-id", "S", "--slice", "x", "--model", "claude-fake-9"])
    expect(out).not.toBeNull()
    expect(out!.model).toBe("claude-fake-9")
  })

  test("without --model, model is undefined (unchanged behavior)", () => {
    const out = parseSquadRunArgs(["--project", "P", "--slice-id", "S", "--slice", "x"])
    expect(out).not.toBeNull()
    expect(out!.model).toBeUndefined()
  })
})

describe("squad-cli.ts cmdSquadRun default DriveFn model forwarding", () => {
  let home: string, project: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-sqmodel-home-"))
    project = mkdtempSync(join(tmpdir(), "mh-sqmodel-proj-"))
    process.env.META_HARNESS_HOME = home
    writeSquadDefV1(STANDARD_SQUAD)
    // A rendered analyzer persona is required — cmdRoleRun dies before ever
    // reaching execFn if `<project>/.opencode/agents/mh-analyzer.md` is
    // missing (see run.ts's existsSync(mdPath) check).
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })
    cmdRolesRender({ project })
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  /** Minimal NDJSON trace: one text turn (the payload) + a step_finish, just
   * enough for `cmdRoleRun`'s classify/parse/extract chain to treat this as
   * a real, well-formed drive (same shape fleet-e2e.test.ts's own `trace()`
   * fixture uses). */
  function trace(payload: string): string {
    const lines = [
      { type: "text", sessionID: "ses_model_fwd_1", text: payload },
      { type: "step_finish", sessionID: "ses_model_fwd_1", part: { reason: "stop", tokens: { input: 1, output: 1 }, cost: 0 } },
    ]
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  }

  test("cmdSquadRun({ model }) threads the flat override onto the real opencode argv", async () => {
    const capturedArgvs: string[][] = []
    const execFn: ExecFn = async (argv) => {
      capturedArgvs.push(argv)
      // analyzer emits Clarify -> detectEscalation short-circuits before
      // any score() call, so a single drive reaches a terminal outcome —
      // no other fleet plumbing needs to be exercised for this assertion.
      return { stdout: trace("## Clarify\nneed more info"), rc: 0 }
    }
    const outcome = await cmdSquadRun(
      { project, sliceId: "s1", slice: "x", model: "claude-fake-9" },
      undefined,
      undefined,
      execFn,
    )
    expect(outcome.status).toBe("escalation")
    expect(capturedArgvs.length).toBe(1)
    const at = capturedArgvs[0]!.indexOf("--model")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(capturedArgvs[0]![at + 1]).toBe("claude-fake-9")
  })

  test("cmdSquadRun without model falls back to the analyzer role's own spec.model (unchanged)", async () => {
    const capturedArgvs: string[][] = []
    const execFn: ExecFn = async (argv) => {
      capturedArgvs.push(argv)
      return { stdout: trace("## Clarify\nneed more info"), rc: 0 }
    }
    const outcome = await cmdSquadRun({ project, sliceId: "s1", slice: "x" }, undefined, undefined, execFn)
    expect(outcome.status).toBe("escalation")
    expect(capturedArgvs.length).toBe(1)
    const at = capturedArgvs[0]!.indexOf("--model")
    expect(at).toBeGreaterThanOrEqual(0)
    // Whatever landed there is the analyzer role's tiered spec.model, NOT
    // some stray override — just assert it's non-empty and NOT the model
    // string the other test injects, so a regression that hardcodes a
    // literal would still be caught.
    expect(capturedArgvs[0]![at + 1]).toBeTruthy()
    expect(capturedArgvs[0]![at + 1]).not.toBe("claude-fake-9")
  })
})
