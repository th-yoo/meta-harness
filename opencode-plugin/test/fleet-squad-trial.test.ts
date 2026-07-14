/**
 * fleet-squad-trial.test.ts — squad-trial.ts's contract (spec §6 channel 2
 * "Trial-gate stats now" / tier-2 candidate selection). `runFn` is injected
 * directly (a scripted stand-in for `cmdSquadRun` itself, not just its
 * drive/score seams) so this suite never spawns opencode and never drives
 * the real squad state machine — it only exercises cmdSquadTrial's own
 * batching/retry/verdict logic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadTrial } from "../src/fleet/squad-trial.ts"
import { writeSquadDefV1, STANDARD_SQUAD, recordSquadOutcome } from "../src/fleet/squad-def.ts"
import type { SquadOutcome } from "../src/fleet/squad.ts"
import type { cmdSquadRun } from "../src/fleet/squad-cli.ts"

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-sqtrial-"))
  project = mkdtempSync(join(tmpdir(), "mh-sqtrial-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

type RunFnArgs = Parameters<typeof cmdSquadRun>[0]

/** Fake runFn stand-in for cmdSquadRun: replays a scripted sequence of
 * outcomes/throws in call order, recording every call's args for assertion. */
function fakeRunFn(script: Array<SquadOutcome | Error>) {
  const calls: RunFnArgs[] = []
  let i = 0
  const runFn = async (args: RunFnArgs): ReturnType<typeof cmdSquadRun> => {
    calls.push(args)
    if (i >= script.length) throw new Error("fakeRunFn: script exhausted")
    const next = script[i++]!
    if (next instanceof Error) throw next
    return next
  }
  return { runFn, calls }
}

const DONE: SquadOutcome = { status: "done", payload: "impl report" }
const EXHAUSTED: SquadOutcome = { status: "escalation", escalation: { type: "Exhausted", body: "budget" } }

describe("cmdSquadTrial", () => {
  test("3 runs, 2 pass -> candRate 2/3; confirm-suggested vs an active baseline of 1/3", async () => {
    recordSquadOutcome("standard", { sliceId: "base1", passed: true, steps: 3, ts: "t1" })
    recordSquadOutcome("standard", { sliceId: "base2", passed: false, steps: 3, ts: "t2" })
    recordSquadOutcome("standard", { sliceId: "base3", passed: false, steps: 3, ts: "t3" })

    const { runFn, calls } = fakeRunFn([DONE, DONE, EXHAUSTED])
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "add slugify", n: 3 }, runFn)

    expect(result.candidate).toBe("v2")
    expect(result.nRuns).toBe(3)
    expect(result.candPass).toBe(2)
    expect(result.candRate).toBeCloseTo(2 / 3)
    expect(result.activeRate).toBeCloseTo(1 / 3)
    expect(result.verdict).toBe("confirm-suggested")

    // sliceIds, defVersion, and gatePolicy threaded correctly to every call.
    expect(calls.map((c) => c.sliceId)).toEqual(["trial-v2-0", "trial-v2-1", "trial-v2-2"])
    for (const c of calls) {
      expect(c.defVersion).toBe("v2")
      expect(c.gatePolicy).toBe("auto")
      expect(c.slice).toBe("add slugify")
      expect(c.squadType).toBe("standard")
    }
  })

  test("reject-suggested: candidate underperforms an active baseline of 3/3", async () => {
    recordSquadOutcome("standard", { sliceId: "base1", passed: true, steps: 3, ts: "t1" })
    recordSquadOutcome("standard", { sliceId: "base2", passed: true, steps: 3, ts: "t2" })
    recordSquadOutcome("standard", { sliceId: "base3", passed: true, steps: 3, ts: "t3" })

    const { runFn } = fakeRunFn([EXHAUSTED, EXHAUSTED, DONE])
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 3 }, runFn)

    expect(result.candRate).toBeCloseTo(1 / 3)
    expect(result.activeRate).toBe(1)
    expect(result.verdict).toBe("reject-suggested")
  })

  test("insufficient-baseline: active version has no scored sessions yet", async () => {
    const { runFn } = fakeRunFn([DONE, DONE, DONE])
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 3 }, runFn)

    expect(result.activeRate).toBeNull()
    expect(result.candRate).toBe(1)
    expect(result.verdict).toBe("insufficient-baseline")
  })

  test("a thrown die retries the SAME run once; second failure counts as fail (logged, never throws)", async () => {
    const boom = new Error("transient error driving analyzer — re-drive")
    const { runFn, calls } = fakeRunFn([
      DONE, // run 0: pass
      boom, boom, // run 1: throws twice -> fail
      DONE, // run 2: pass
    ])
    const result = await cmdSquadTrial({ project, candidate: "v3", slice: "x", n: 3 }, runFn)

    expect(result.candPass).toBe(2)
    expect(result.candRate).toBeCloseTo(2 / 3)
    expect(calls.length).toBe(4) // 3 runs, one retried once
    expect(calls[1]!.sliceId).toBe("trial-v3-1")
    expect(calls[2]!.sliceId).toBe("trial-v3-1") // retry reuses the SAME sliceId
  })

  test("a thrown die that SUCCEEDS on retry counts as a pass", async () => {
    const boom = new Error("transient")
    const { runFn, calls } = fakeRunFn([boom, DONE])
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 1 }, runFn)
    expect(result.candPass).toBe(1)
    expect(result.candRate).toBe(1)
    expect(calls.length).toBe(2)
  })

  test("--slice-file cycles slices across n runs (one slice per line)", async () => {
    const sliceFile = join(project, "slices.txt")
    writeFileSync(sliceFile, "slice A\nslice B\n")
    const { runFn, calls } = fakeRunFn([DONE, DONE, DONE])
    await cmdSquadTrial({ project, candidate: "v2", sliceFile, n: 3 }, runFn)
    expect(calls.map((c) => c.slice)).toEqual(["slice A", "slice B", "slice A"])
  })

  test("default n is 3 when omitted", async () => {
    const { runFn, calls } = fakeRunFn([DONE, DONE, DONE])
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x" }, runFn)
    expect(result.nRuns).toBe(3)
    expect(calls.length).toBe(3)
  })

  test("requires --slice or --slice-file", async () => {
    const { runFn } = fakeRunFn([DONE])
    await expect(cmdSquadTrial({ project, candidate: "v2", n: 1 }, runFn)).rejects.toThrow(/slice/)
  })

  test("never throws when the squad type has no active def at all (activeSquadVersion defaults, no sessions)", async () => {
    const { runFn } = fakeRunFn([DONE])
    const result = await cmdSquadTrial({ project, squadType: "ghost", candidate: "v1", slice: "x", n: 1 }, runFn)
    expect(result.verdict).toBe("insufficient-baseline")
  })
})
