/**
 * fleet-squad-trial.test.ts — squad-trial.ts's contract (spec §6 channel 2
 * "Trial-gate stats now" / tier-2 candidate selection). `runFn` is injected
 * directly (a scripted stand-in for `cmdSquadRun` itself, not just its
 * drive/score seams) so this suite never spawns opencode and never drives
 * the real squad state machine — it only exercises cmdSquadTrial's own
 * batching/retry/verdict logic.
 *
 * Fix 2 (paired comparison): the trial now drives BOTH the candidate AND the
 * active def through the SAME slice set, so candRate/activeRate are computed
 * on identical tasks — an easy trial set can no longer manufacture a false
 * win against the active def's unrelated history.
 * Fix 3 (significance): promotion requires a McNemar-significant paired edge
 * over a minimum number of pairs, not a raw `>=` on noisy small-n rates.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadTrial } from "../src/fleet/squad-trial.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
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

const DONE: SquadOutcome = { status: "done", payload: "impl report" }
const EXHAUSTED: SquadOutcome = { status: "escalation", escalation: { type: "Exhausted", body: "budget" } }

/**
 * Paired fake for cmdSquadTrial: the trial drives the CANDIDATE and the
 * ACTIVE def over the same slice set, dispatched by `defVersion`. Each stream
 * replays its own scripted outcome sequence in call order (a thrown Error
 * models a transient drive failure → cmdSquadTrial retries the SAME run once).
 * `candVersion` (default "v2") is the candidate; anything else is the active
 * def ("v1" here, since writeSquadDefV1 seeds v1 active).
 */
function pairedFake(
  cand: Array<SquadOutcome | Error>,
  active: Array<SquadOutcome | Error>,
  candVersion = "v2",
) {
  const calls: RunFnArgs[] = []
  let ci = 0
  let ai = 0
  const runFn = async (args: RunFnArgs): ReturnType<typeof cmdSquadRun> => {
    calls.push(args)
    const isCand = args.defVersion === candVersion
    const script = isCand ? cand : active
    const idx = isCand ? ci++ : ai++
    if (idx >= script.length) throw new Error(`pairedFake: ${isCand ? "cand" : "active"} script exhausted`)
    const next = script[idx]!
    if (next instanceof Error) throw next
    return next
  }
  return { runFn, calls }
}

/** Convenience: build a script of n outcomes, `passes` of them DONE (in order). */
function outcomes(pattern: Array<"D" | "E">): SquadOutcome[] {
  return pattern.map((p) => (p === "D" ? DONE : EXHAUSTED))
}

describe("cmdSquadTrial — paired comparison (Fix 2)", () => {
  test("drives BOTH candidate and active over the SAME slice set (2 runs per slice)", async () => {
    const { runFn, calls } = pairedFake(outcomes(["D", "D", "D"]), outcomes(["D", "D", "D"]))
    await cmdSquadTrial({ project, candidate: "v2", slice: "add slugify", n: 3 }, runFn)

    // 3 slices × 2 defs = 6 runs; candidate + active each see the same slice.
    expect(calls.length).toBe(6)
    const candCalls = calls.filter((c) => c.defVersion === "v2")
    const activeCalls = calls.filter((c) => c.defVersion === "v1")
    expect(candCalls.length).toBe(3)
    expect(activeCalls.length).toBe(3)
    for (const c of calls) {
      expect(c.gatePolicy).toBe("auto")
      expect(c.slice).toBe("add slugify")
      expect(c.squadType).toBe("standard")
    }
  })

  test("an easy trial set does NOT manufacture a false win: if the active def passes the SAME slices, no confirm", async () => {
    // Both defs sail through the (easy) trial slices → tied rates → the paired
    // comparison refuses to confirm, where the old history-based baseline
    // (active's low historical rate) would have falsely confirmed.
    const { runFn } = pairedFake(outcomes(["D", "D", "D", "D", "D", "D"]), outcomes(["D", "D", "D", "D", "D", "D"]))
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 6 }, runFn)
    expect(result.candRate).toBe(1)
    expect(result.activeRate).toBe(1)
    expect(result.verdict).not.toBe("confirm-suggested")
  })
})

describe("cmdSquadTrial — significance gate (Fix 3)", () => {
  test("a genuine, significant margin over enough paired samples → confirm-suggested", async () => {
    // n=6, candidate wins all 6 discordant pairs: McNemar p = 1/2^6 ≈ 0.016 ≤ 0.05.
    const { runFn } = pairedFake(
      outcomes(["D", "D", "D", "D", "D", "D"]),
      outcomes(["E", "E", "E", "E", "E", "E"]),
    )
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 6 }, runFn)
    expect(result.candRate).toBe(1)
    expect(result.activeRate).toBe(0)
    expect(result.verdict).toBe("confirm-suggested")
  })

  test("a tie (equal rates) is NOT confirmed", async () => {
    const { runFn } = pairedFake(
      outcomes(["D", "D", "D", "E", "E", "E"]),
      outcomes(["E", "E", "E", "D", "D", "D"]),
    )
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 6 }, runFn)
    expect(result.candRate).toBeCloseTo(3 / 6)
    expect(result.activeRate).toBeCloseTo(3 / 6)
    expect(result.verdict).not.toBe("confirm-suggested")
  })

  test("a small-n lucky win (n=3, candidate sweeps) is NOT confirmed", async () => {
    // n=3 is below the minimum-pair floor AND McNemar p = 1/8 = 0.125 > 0.05 —
    // either way, a 3-run sweep is noise, never a promotion.
    const { runFn } = pairedFake(outcomes(["D", "D", "D"]), outcomes(["E", "E", "E"]))
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 3 }, runFn)
    expect(result.candRate).toBe(1)
    expect(result.verdict).not.toBe("confirm-suggested")
    expect(result.verdict).toBe("insufficient-baseline")
  })

  test("enough samples but the edge isn't significant → reject-suggested", async () => {
    // n=5, candidate ahead (3 vs 2) but McNemar on the discordant pairs
    // (b=2,c=1) gives p=0.5 — a real but non-significant lead.
    const { runFn } = pairedFake(
      outcomes(["D", "D", "D", "E", "E"]),
      outcomes(["E", "E", "D", "D", "E"]),
    )
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 5 }, runFn)
    expect(result.candRate).toBeCloseTo(3 / 5)
    expect(result.activeRate).toBeCloseTo(2 / 5)
    expect(result.verdict).toBe("reject-suggested")
  })
})

describe("cmdSquadTrial — batching / retry / arg plumbing", () => {
  test("a thrown die retries the SAME candidate run once; second failure counts as fail", async () => {
    const boom = new Error("transient error driving analyzer — re-drive")
    // 6 slices; candidate run at slice 1 throws twice → fail. Active all pass.
    const { runFn, calls } = pairedFake(
      [DONE, boom, boom, DONE, DONE, DONE, DONE], // slice1 candidate: two throws → counted fail
      outcomes(["E", "E", "E", "E", "E", "E"]),
      "v3",
    )
    const result = await cmdSquadTrial({ project, candidate: "v3", slice: "x", n: 6 }, runFn)
    // candidate passed 5/6 (slice1 failed after retry); still a significant sweep of the rest.
    expect(result.candPass).toBe(5)
    // The retried candidate run reused the SAME sliceId.
    const candCalls = calls.filter((c) => c.defVersion === "v3")
    expect(candCalls[1]!.sliceId).toBe(candCalls[2]!.sliceId)
  })

  test("a thrown die that SUCCEEDS on retry counts as a pass", async () => {
    const boom = new Error("transient")
    const { runFn } = pairedFake([boom, DONE], [EXHAUSTED], "v2")
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 1 }, runFn)
    expect(result.candPass).toBe(1)
  })

  test("--slice-file cycles slices across n runs (one slice per line)", async () => {
    const sliceFile = join(project, "slices.txt")
    writeFileSync(sliceFile, "slice A\nslice B\n")
    const { runFn, calls } = pairedFake(outcomes(["D", "D", "D"]), outcomes(["D", "D", "D"]))
    await cmdSquadTrial({ project, candidate: "v2", sliceFile, n: 3 }, runFn)
    const candCalls = calls.filter((c) => c.defVersion === "v2")
    expect(candCalls.map((c) => c.slice)).toEqual(["slice A", "slice B", "slice A"])
  })

  test("default n is MIN_TRIAL_PAIRS (5) when omitted — so a default trial can reach the significance floor", async () => {
    const { runFn, calls } = pairedFake(outcomes(["D", "D", "D", "D", "D"]), outcomes(["D", "D", "D", "D", "D"]))
    const result = await cmdSquadTrial({ project, candidate: "v2", slice: "x" }, runFn)
    expect(result.nRuns).toBe(5)
    expect(calls.length).toBe(10) // 5 slices × 2 defs
  })

  test("requires --slice or --slice-file", async () => {
    const { runFn } = pairedFake([DONE], [DONE])
    await expect(cmdSquadTrial({ project, candidate: "v2", n: 1 }, runFn)).rejects.toThrow(/slice/)
  })

  test("--n 0 dies (not a positive integer)", async () => {
    const { runFn } = pairedFake([DONE], [DONE])
    await expect(cmdSquadTrial({ project, candidate: "v2", slice: "x", n: 0 }, runFn)).rejects.toThrow(
      /--n must be a positive integer/,
    )
  })

  test("--n -1 dies (not a positive integer)", async () => {
    const { runFn } = pairedFake([DONE], [DONE])
    await expect(cmdSquadTrial({ project, candidate: "v2", slice: "x", n: -1 }, runFn)).rejects.toThrow(
      /--n must be a positive integer/,
    )
  })
})
