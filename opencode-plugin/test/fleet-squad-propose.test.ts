import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSquadProposerPrompt, cmdSquadPropose, nextSquadVersion, validateFlowMutation,
} from "../src/fleet/squad-propose.ts"
import {
  STANDARD_SQUAD, readActiveSquadDef, recordSquadOutcome, squadRoot, writeSquadDefV1,
} from "../src/fleet/squad-def.ts"
import type { SquadDef } from "../src/fleet/squad-def.ts"
import type { ExecFn } from "../src/fleet/run.ts"
import { REMOTE_WRITE_DENY_ENV } from "../src/fleet/sandbox.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-squad-propose-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
})

/** Pull the staging file path out of the prompt's `cat > "<path>" <<
 * 'ENDOFSQUADJSON'` heredoc — the fake ExecFn stands in for the LLM: it
 * "reads" the prompt (the last argv element) and follows the same write
 * instruction a real opencode session would. */
function stagingPathFromPrompt(prompt: string): string {
  const m = /cat > "([^"]+)" << 'ENDOFSQUADJSON'/.exec(prompt)
  if (!m) throw new Error("no staging path found in prompt")
  return m[1]!
}

/** Fake ExecFn that writes `def` (and an optional diagnosis) to the staging
 * path it parses out of the prompt, mirroring a real session's file-write
 * side effect — never spawns a real opencode process. */
function fakeExecWriting(def: SquadDef, opts: { diagnosis?: string } = {}): ExecFn {
  return async (argv) => {
    const prompt = argv[argv.length - 1]!
    const stagingPath = stagingPathFromPrompt(prompt)
    writeFileSync(stagingPath, JSON.stringify(def, null, 2))
    if (opts.diagnosis !== undefined) {
      writeFileSync(`${stagingPath}.diagnosis.md`, opts.diagnosis)
    }
    return { stdout: "", rc: 0 }
  }
}

describe("nextSquadVersion", () => {
  test("v2 after seeding v1", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    expect(nextSquadVersion("standard")).toBe("v2")
  })

  test("gaps handled: v1 + v5 present -> v6, not v2", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const v5Dir = join(squadRoot("standard"), "candidates", "v5")
    mkdirSync(v5Dir, { recursive: true })
    writeFileSync(join(v5Dir, "squad.json"), JSON.stringify(STANDARD_SQUAD))
    expect(nextSquadVersion("standard")).toBe("v6")
  })
})

describe("validateFlowMutation", () => {
  test("accepts a pure flow-knob change", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 4 } },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(true)
    expect(errors).toEqual([])
  })

  test("rejects a type-only mutation", () => {
    const proposed: SquadDef = { ...STANDARD_SQUAD, type: "other-squad-type" }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /type must be unchanged/.test(e))).toBe(true)
    // nothing else was mutated — this should be the ONLY violation
    expect(errors.length).toBe(1)
  })

  test("null/non-object proposed def -> clean {ok:false}, never throws", () => {
    expect(() => validateFlowMutation(STANDARD_SQUAD, null as unknown as SquadDef)).not.toThrow()
    const nullResult = validateFlowMutation(STANDARD_SQUAD, null as unknown as SquadDef)
    expect(nullResult.ok).toBe(false)
    expect(nullResult.errors).toEqual(["proposed def is not an object"])

    expect(() => validateFlowMutation(STANDARD_SQUAD, "not-an-object" as unknown as SquadDef)).not.toThrow()
    const stringResult = validateFlowMutation(STANDARD_SQUAD, "not-an-object" as unknown as SquadDef)
    expect(stringResult.ok).toBe(false)
    expect(stringResult.errors).toEqual(["proposed def is not an object"])

    expect(() => validateFlowMutation(STANDARD_SQUAD, [] as unknown as SquadDef)).not.toThrow()
    const arrayResult = validateFlowMutation(STANDARD_SQUAD, [] as unknown as SquadDef)
    expect(arrayResult.ok).toBe(false)
    expect(arrayResult.errors).toEqual(["proposed def is not an object"])
  })

  test("rejects a slot change", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      slots: { ...STANDARD_SQUAD.slots, designer: { ...STANDARD_SQUAD.slots.designer, model: "anthropic/other-model" } },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /slots/.test(e))).toBe(true)
  })

  test("rejects a wire change", () => {
    const proposed: SquadDef = { ...STANDARD_SQUAD, wire: { ...STANDARD_SQUAD.wire, verdictRe: "^X" } }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /wire/.test(e))).toBe(true)
  })

  test("rejects R1=0 (below legal range)", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 0 } },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /R1/.test(e))).toBe(true)
  })

  test("rejects R1=99 (above legal range)", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 99 } },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /R1/.test(e))).toBe(true)
  })

  test("rejects globalBudgetSteps=5 (below legal range)", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, globalBudgetSteps: 5 } },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /globalBudgetSteps/.test(e))).toBe(true)
  })

  test("rejects a bad gatePolicy enum", () => {
    const proposed = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, gatePolicy: { gate1: "robot", gate2: "auto" } },
    } as unknown as SquadDef
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /gatePolicy\.gate1/.test(e))).toBe(true)
  })

  test("rejects a bad reentry value (frozen — Fix 4)", () => {
    const proposed = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, reentry: "whenever" },
    } as unknown as SquadDef
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /reentry/.test(e))).toBe(true)
  })

  test("rejects CHANGING reentry to the other valid enum — it is frozen, not evolvable (Fix 4)", () => {
    // STANDARD_SQUAD.flow.reentry is "delta"; "full" is a valid enum value but
    // the runner never reads reentry, so evolving it is a dead knob — frozen.
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, reentry: "full" },
    }
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /reentry.*frozen/i.test(e))).toBe(true)
  })

  test("accepts reentry left UNCHANGED alongside a real knob mutation (Fix 4)", () => {
    const proposed: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, reentry: "delta", bounds: { ...STANDARD_SQUAD.flow.bounds, R2: 2 } },
    }
    const { ok } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(true)
  })

  test("multi-error: lists every violation at once, not just the first", () => {
    const proposed = {
      ...STANDARD_SQUAD,
      slots: { ...STANDARD_SQUAD.slots, designer: { ...STANDARD_SQUAD.slots.designer, model: "x" } },
      wire: { ...STANDARD_SQUAD.wire, verdictRe: "^X" },
      flow: {
        bounds: { R1: 0, R2: 1, R3: 3, globalBudgetSteps: 40 },
        gatePolicy: { gate1: "robot", gate2: "auto" },
        reentry: "delta",
      },
    } as unknown as SquadDef
    const { ok, errors } = validateFlowMutation(STANDARD_SQUAD, proposed)
    expect(ok).toBe(false)
    expect(errors.some((e) => /slots/.test(e))).toBe(true)
    expect(errors.some((e) => /wire/.test(e))).toBe(true)
    expect(errors.some((e) => /R1/.test(e))).toBe(true)
    expect(errors.some((e) => /gatePolicy\.gate1/.test(e))).toBe(true)
    expect(errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe("buildSquadProposerPrompt", () => {
  test("contains active json, knob cheat-sheet, failing outcomes + fitness ratio", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    recordSquadOutcome("standard", { sliceId: "s1", passed: true, steps: 9, ts: "t1" })
    recordSquadOutcome("standard", {
      sliceId: "s2", passed: false, steps: 41, escalationType: "Exhausted", ts: "t2",
    })
    const stagingPath = join(squadRoot("standard"), ".staging", "x.json")
    const prompt = buildSquadProposerPrompt("standard", STANDARD_SQUAD, stagingPath)

    expect(prompt).toContain('"type": "standard"')
    expect(prompt).toContain("bounds.R1")
    expect(prompt).toContain("bounds.globalBudgetSteps")
    expect(prompt).toContain("gatePolicy.gate1")
    // Fix 4: reentry is still mentioned, but ONLY as a frozen/non-evolvable
    // field — never taught as a knob to propose.
    expect(prompt).toMatch(/reentry.*frozen/i)
    // B4: s1 passed → excluded from the failing-only list (was `toContain sliceId=s1`);
    // the pass/fail ratio line (#4) preserves the passed count instead.
    expect(prompt).toContain("1 done / 1 exhausted")
    expect(prompt).not.toMatch(/- sliceId=s1 /)
    expect(prompt).toContain("sliceId=s2")
    expect(prompt).toContain("escalationType=Exhausted")
    expect(prompt).toContain(stagingPath)
    expect(prompt).toContain(`${stagingPath}.diagnosis.md`)
  })

  test("falls back to a 'no failing sessions' note when the active version has none", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const stagingPath = join(squadRoot("standard"), ".staging", "y.json")
    const prompt = buildSquadProposerPrompt("standard", STANDARD_SQUAD, stagingPath)
    expect(prompt).toContain("no failing sessions yet")
    expect(prompt).toContain("0 done / 0 exhausted")
  })
})

describe("cmdSquadPropose", () => {
  test("happy path: valid knob mutation -> candidate v2 written, active untouched", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 3 } },
    }
    const execFn = fakeExecWriting(mutated, { diagnosis: "## Diagnosis\n\nbumped R1.\n" })

    const result = await cmdSquadPropose({}, execFn)
    expect(result.version).toBe("v2")
    expect(result.def.flow.bounds.R1).toBe(3)

    const candidateJson = join(squadRoot("standard"), "candidates", "v2", "squad.json")
    expect(existsSync(candidateJson)).toBe(true)
    const written = JSON.parse(readFileSync(candidateJson, "utf-8"))
    expect(written.flow.bounds.R1).toBe(3)

    const candidateDiag = join(squadRoot("standard"), "candidates", "v2", "diagnosis.md")
    expect(existsSync(candidateDiag)).toBe(true)
    expect(readFileSync(candidateDiag, "utf-8")).toContain("## Diagnosis")

    // active untouched
    const active = readActiveSquadDef("standard")
    expect(active.flow.bounds.R1).toBe(2)
  })

  test("happy path with no diagnosis written: candidate still lands, no diagnosis.md copied", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, gatePolicy: { gate1: "human", gate2: "auto" } },
    }
    const execFn = fakeExecWriting(mutated)
    const result = await cmdSquadPropose({}, execFn)
    expect(result.version).toBe("v2")
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2", "squad.json"))).toBe(true)
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2", "diagnosis.md"))).toBe(false)
  })

  test("invalid staged def (slot change) -> dies, no candidate dir written", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      slots: { ...STANDARD_SQUAD.slots, analyzer: { ...STANDARD_SQUAD.slots.analyzer, model: "anthropic/other" } },
    }
    const execFn = fakeExecWriting(mutated)
    await expect(cmdSquadPropose({}, execFn)).rejects.toThrow(/slots/)
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2"))).toBe(false)
  })

  test("invalid staged def (out-of-range bound) -> dies listing the violation", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R3: 99 } },
    }
    const execFn = fakeExecWriting(mutated)
    await expect(cmdSquadPropose({}, execFn)).rejects.toThrow(/R3/)
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2"))).toBe(false)
  })

  test("timeout: ExecFn writes nothing -> dies cleanly, no candidate dir", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const execFn: ExecFn = async () => ({ stdout: "", rc: 0 })
    await expect(cmdSquadPropose({ timeoutSec: 0.2 }, execFn)).rejects.toThrow(/timed out/)
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2"))).toBe(false)
  })

  test("credential isolation: the spawn env is scrubbed via sandboxEnv (remote-write creds denied, same as fleet/run.ts)", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 3 } },
    }
    let seenOpts: { timeoutSec: number; env?: Record<string, string> } | undefined
    const execFn: ExecFn = async (argv, opts) => {
      seenOpts = opts
      const prompt = argv[argv.length - 1]!
      const stagingPath = stagingPathFromPrompt(prompt)
      writeFileSync(stagingPath, JSON.stringify(mutated, null, 2))
      return { stdout: "", rc: 0 }
    }

    await cmdSquadPropose({}, execFn)

    for (const [k, v] of Object.entries(REMOTE_WRITE_DENY_ENV)) {
      expect(seenOpts?.env?.[k]).toBe(v)
    }
    expect(seenOpts?.env?.["GIT_CONFIG_GLOBAL"]).toMatch(/mh-fleet-sandbox-.*\/gitconfig$/)
    expect(seenOpts?.env?.["GH_CONFIG_DIR"]).toMatch(/mh-fleet-sandbox-.*\/gh-config$/)

    // sandboxEnv's cleanup() ran in cmdSquadPropose's `finally` — tmp
    // sandbox files are gone once the call returns.
    expect(existsSync(seenOpts!.env!["GIT_CONFIG_GLOBAL"]!)).toBe(false)
    expect(existsSync(seenOpts!.env!["GH_CONFIG_DIR"]!)).toBe(false)
  })

  test("rejects an active-identical candidate — no mutation proposed, no version bump (Fix 5)", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    // The proposer writes back the active def verbatim (no flow change).
    const execFn = fakeExecWriting(STANDARD_SQUAD)
    await expect(cmdSquadPropose({}, execFn)).rejects.toThrow(/no.*mutation|identical/i)
    // No candidate directory was created (active untouched, no v2).
    expect(existsSync(join(squadRoot("standard"), "candidates", "v2"))).toBe(false)
  })

  test("cleans up its .staging scratch files in finally (Fix 5)", async () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const mutated: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 3 } },
    }
    let stagingPath = ""
    const execFn: ExecFn = async (argv) => {
      const prompt = argv[argv.length - 1]!
      stagingPath = stagingPathFromPrompt(prompt)
      writeFileSync(stagingPath, JSON.stringify(mutated, null, 2))
      writeFileSync(`${stagingPath}.diagnosis.md`, "## Diagnosis\n\nx\n")
      return { stdout: "", rc: 0 }
    }
    await cmdSquadPropose({}, execFn)
    // The scratch staging files are gone — the store dir doesn't accumulate litter.
    expect(existsSync(stagingPath)).toBe(false)
    expect(existsSync(`${stagingPath}.diagnosis.md`)).toBe(false)
  })

  test("uses the given --squad-type (not just 'standard')", async () => {
    const custom: SquadDef = { ...STANDARD_SQUAD, type: "custom" }
    writeSquadDefV1(custom)
    const mutated: SquadDef = {
      ...custom,
      flow: { ...custom.flow, bounds: { ...custom.flow.bounds, R2: 2 } },
    }
    const execFn = fakeExecWriting(mutated)
    const result = await cmdSquadPropose({ squadType: "custom" }, execFn)
    expect(result.version).toBe("v2")
    expect(existsSync(join(squadRoot("custom"), "candidates", "v2", "squad.json"))).toBe(true)
  })
})
