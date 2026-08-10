/** Tests for scripts/p2-tally.ts (task-5-brief.md, docs/superpowers/plans/
 * 2026-08-06-p2-actuator-binding.md §Task 5). Direct-import unit tests for
 * the pure core (per-attempt zip, bars math, b2 window math — cheap, no
 * subprocess) plus one subprocess-level integration test wiring three
 * hermetic fixture results files + a fixture review-findings ndjson
 * through the real CLI via its env seams. Placement mirrors
 * km-crank/test/loop-probes-cli.test.ts, which tests
 * scripts/p0-signal-variance.ts's pure helpers the same way (task-5-brief
 * pointed at that file's sibling script b3-binarization-measure.ts as the
 * "formulas live in the script, not reimplemented elsewhere" shape;
 * task-5-report.md records the km-crank/test/ placement choice). */
import { describe, expect, test, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import {
  parseAttemptAnnotation,
  computeArmStats,
  computeA3StopBlocks,
  computeA4Extra,
  earnsRouting,
  computeB2Shadow,
  COMPLIANCE_BAR,
  PASS_DROP_BAR,
  COMPUTE_BONUS_CAVEAT,
  BAND,
  SPEC_PATH,
  SHADOW_EVIDENTIAL_MIN_N,
  type P2ResultsDoc,
  type ReviewFindingsLine,
} from "../../scripts/p2-tally.ts"

const P2_TALLY = path.join(import.meta.dir, "..", "..", "scripts", "p2-tally.ts")

const CLEANUP: string[] = []
afterEach(() => {
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}

function ann(compliant: boolean, reprompted = false, reviewFailed = false, error = ""): string {
  return JSON.stringify({ arm: "a1", ruleSha: "deadbeef", compliant, reprompted, reviewFailed, error })
}

// ---------------------------------------------------------------------
// parseAttemptAnnotation
// ---------------------------------------------------------------------

describe("parseAttemptAnnotation", () => {
  test("parses cmd-p2.ts's exact encoding", () => {
    expect(parseAttemptAnnotation(ann(true, false, false, ""))).toEqual({
      compliant: true, reprompted: false, reviewFailed: false, error: "",
    })
  })
  test("undefined input -> undefined", () => {
    expect(parseAttemptAnnotation(undefined)).toBeUndefined()
  })
  test("malformed JSON -> undefined", () => {
    expect(parseAttemptAnnotation("{not json")).toBeUndefined()
  })
  test("valid JSON, wrong shape (missing compliant) -> undefined", () => {
    expect(parseAttemptAnnotation(JSON.stringify({ reprompted: false, reviewFailed: false, error: "" }))).toBeUndefined()
  })
  test("valid JSON, non-object (array) -> undefined", () => {
    expect(parseAttemptAnnotation(JSON.stringify([1, 2, 3]))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------
// computeArmStats — per-attempt zip (rewards/turns/elapsed/errors),
// per-task pass@k (any reward===1)
// ---------------------------------------------------------------------

describe("computeArmStats", () => {
  test("zips per-attempt arrays and computes per-task pass@k", () => {
    const doc: P2ResultsDoc = {
      tasks: {
        taskA: { rewards: [1, 0], turns: [5, 6], elapsed: [10, 12], errors: [ann(true), ann(false)] },
        taskB: { rewards: [0, 0], turns: [3, 4], elapsed: [8, 9], errors: [ann(false), ann(false)] },
      },
    }
    const stats = computeArmStats(doc)
    expect(stats.n).toBe(4)
    expect(stats.compliance).toBeCloseTo(0.25, 10) // 1/4 compliant
    expect(stats.passAtK).toBeCloseTo(0.5, 10) // taskA passes (max=1), taskB fails
    expect(stats.meanTurns).toBeCloseTo(4.5, 10) // (5+6+3+4)/4
    expect(stats.meanElapsedSec).toBeCloseTo(9.75, 10) // (10+12+8+9)/4
  })

  test("empty tasks -> all zeros, no NaN/division-by-zero", () => {
    const stats = computeArmStats({ tasks: {} })
    expect(stats).toEqual({ n: 0, compliance: 0, passAtK: 0, meanTurns: 0, meanElapsedSec: 0 })
  })

  test("missing tasks field -> all zeros", () => {
    expect(computeArmStats({})).toEqual({ n: 0, compliance: 0, passAtK: 0, meanTurns: 0, meanElapsedSec: 0 })
  })

  test("malformed errors[] entries count as non-compliant, never throw", () => {
    const doc: P2ResultsDoc = {
      tasks: { t: { rewards: [1], turns: [1], elapsed: [1], errors: ["{not json"] } },
    }
    const stats = computeArmStats(doc)
    expect(stats.n).toBe(1)
    expect(stats.compliance).toBe(0)
  })
})

// ---------------------------------------------------------------------
// computeA3StopBlocks — non-compliant attempt count (recorded proxy —
// no direct block-event counter exists in the annotation, see
// task-5-report.md)
// ---------------------------------------------------------------------

describe("computeA3StopBlocks", () => {
  test("counts non-compliant attempts across all tasks", () => {
    const doc: P2ResultsDoc = {
      tasks: {
        taskA: { rewards: [1, 0], turns: [5, 6], elapsed: [10, 12], errors: [ann(true), ann(false)] },
        taskB: { rewards: [0, 0], turns: [3, 4], elapsed: [8, 9], errors: [ann(false), ann(false)] },
      },
    }
    expect(computeA3StopBlocks(doc)).toBe(3)
  })
  test("all compliant -> 0", () => {
    const doc: P2ResultsDoc = { tasks: { t: { rewards: [1], turns: [1], elapsed: [1], errors: [ann(true)] } } }
    expect(computeA3StopBlocks(doc)).toBe(0)
  })
})

// ---------------------------------------------------------------------
// computeA4Extra — rePassRate (reprompted fraction), reviewFailedCount
// ---------------------------------------------------------------------

describe("computeA4Extra", () => {
  test("computes rePassRate and reviewFailedCount over all attempts", () => {
    const doc: P2ResultsDoc = {
      tasks: {
        taskA: {
          rewards: [1, 0], turns: [5, 6], elapsed: [10, 12],
          errors: [ann(true, false, false), ann(false, true, false)],
        },
        taskB: {
          rewards: [1, 1], turns: [3, 4], elapsed: [8, 9],
          errors: [ann(true, true, false), ann(true, false, true)],
        },
      },
    }
    const extra = computeA4Extra(doc)
    expect(extra.rePassRate).toBeCloseTo(2 / 4, 10) // 2 of 4 reprompted
    expect(extra.reviewFailedCount).toBe(1)
  })
  test("empty -> zeros", () => {
    expect(computeA4Extra({ tasks: {} })).toEqual({ rePassRate: 0, reviewFailedCount: 0 })
  })
})

// ---------------------------------------------------------------------
// earnsRouting — pre-registered decision rule
// ---------------------------------------------------------------------

describe("earnsRouting", () => {
  test("compliance>=bar AND drop<=bar -> true", () => {
    expect(earnsRouting(0.8, 0.5, 0.6)).toBe(true) // drop = 0.1
  })
  test("compliance below bar -> false regardless of pass@k", () => {
    expect(earnsRouting(0.7, 0.9, 0.9)).toBe(false)
  })
  test("compliance>=bar but drop exceeds bar -> false", () => {
    expect(earnsRouting(0.9, 0.5, 0.9)).toBe(false) // drop = 0.4
  })
  test("boundary: compliance exactly at bar -> passes that leg", () => {
    expect(earnsRouting(COMPLIANCE_BAR, 0.5, 0.6)).toBe(true) // drop = 0.1
  })
  test("boundary: drop exactly at bar -> passes that leg", () => {
    expect(earnsRouting(1.0, 0.5, 0.5 + PASS_DROP_BAR)).toBe(true)
  })
  test("arm pass@k exceeding a1's (negative drop) -> true", () => {
    expect(earnsRouting(1.0, 0.9, 0.5)).toBe(true)
  })
})

// ---------------------------------------------------------------------
// computeB2Shadow — window filter + evidential threshold
// ---------------------------------------------------------------------

describe("computeB2Shadow", () => {
  const DAY = 86_400_000
  test("counts non-skipped in-window lines, evidential at >=10", () => {
    const lines: ReviewFindingsLine[] = Array.from({ length: 12 }, (_, i) => ({ ts: 1000 + i }))
    const shadow = computeB2Shadow(lines, 1000, 1000 + 2 * DAY)
    expect(shadow.realizedN).toBe(12)
    expect(shadow.eventsPerDay).toBeCloseTo(6, 10)
    expect(shadow.evidential).toBe(true)
  })
  test("below SHADOW_EVIDENTIAL_MIN_N -> not evidential", () => {
    const lines: ReviewFindingsLine[] = Array.from({ length: SHADOW_EVIDENTIAL_MIN_N - 1 }, (_, i) => ({ ts: 1000 + i }))
    const shadow = computeB2Shadow(lines, 1000, 1000 + DAY)
    expect(shadow.realizedN).toBe(SHADOW_EVIDENTIAL_MIN_N - 1)
    expect(shadow.evidential).toBe(false)
  })
  test("skipped lines excluded from realizedN", () => {
    const lines: ReviewFindingsLine[] = [
      { ts: 1000 }, { ts: 1001, skipped: true }, { ts: 1002 },
    ]
    const shadow = computeB2Shadow(lines, 1000, 2000)
    expect(shadow.realizedN).toBe(2)
  })
  test("out-of-window lines excluded", () => {
    const lines: ReviewFindingsLine[] = [{ ts: 500 }, { ts: 1500 }, { ts: 5000 }]
    const shadow = computeB2Shadow(lines, 1000, 2000)
    expect(shadow.realizedN).toBe(1)
  })
  test("zero-span window -> eventsPerDay 0, never divides by zero", () => {
    const shadow = computeB2Shadow([{ ts: 1000 }], 1000, 1000)
    expect(shadow.eventsPerDay).toBe(0)
  })
})

// ---------------------------------------------------------------------
// subprocess — the real CLI wired through env seams (hermetic fixtures)
// ---------------------------------------------------------------------

interface RunResult { stdout: string; stderr: string; status: number | null }
function run(cwd: string, env: Record<string, string>): RunResult {
  const r = spawnSync("bun", [P2_TALLY], { cwd, encoding: "utf8", env: { ...process.env, ...env } })
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status }
}

function writeResultsDoc(file: string, doc: P2ResultsDoc): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc))
}

function writeNdjson(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

describe("p2-tally CLI", () => {
  test("wires a1/a3/a4 results + b2 shadow into a valid verdict json", () => {
    const cwd = mkTmp("p2-tally-")
    // Must stay comfortably in the PAST relative to real wall-clock now
    // (windowEnd below is the real Date.now() the CLI computes at run
    // time) — a future timestamp would make windowStart > windowEnd,
    // collapsing the window to empty.
    const runStartTs = Date.now() - 3600_000
    const runStartIso = new Date(runStartTs).toISOString()

    const a1: P2ResultsDoc = {
      k: 2, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "deadbeef" },
      tasks: {
        t1: { rewards: [1, 1], turns: [4, 4], elapsed: [10, 10], errors: [ann(false), ann(false)] },
        t2: { rewards: [0, 1], turns: [5, 5], elapsed: [12, 12], errors: [ann(false), ann(false)] },
      },
    }
    const a3: P2ResultsDoc = {
      k: 2, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "deadbeef" },
      tasks: {
        t1: { rewards: [1, 1], turns: [6, 6], elapsed: [14, 14], errors: [ann(true), ann(true)] },
        t2: { rewards: [1, 0], turns: [7, 7], elapsed: [16, 16], errors: [ann(true), ann(true)] },
      },
    }
    const a4: P2ResultsDoc = {
      k: 2, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "deadbeef" },
      tasks: {
        t1: { rewards: [1, 1], turns: [8, 8], elapsed: [18, 18], errors: [ann(true, true, false), ann(true, false, false)] },
        t2: { rewards: [1, 1], turns: [9, 9], elapsed: [20, 20], errors: [ann(false, false, true), ann(true, false, false)] },
      },
    }

    const a1File = path.join(cwd, "a1-results.json")
    const a3File = path.join(cwd, "a3-results.json")
    const a4File = path.join(cwd, "a4-results.json")
    writeResultsDoc(a1File, a1)
    writeResultsDoc(a3File, a3)
    writeResultsDoc(a4File, a4)

    // b2 shadow: 3 non-skipped lines inside [runStartTs, now] -> below the
    // evidential floor -> "not evidential" printed verbatim.
    const ndjsonFile = path.join(cwd, "review-findings.ndjson")
    writeNdjson(ndjsonFile, [
      { ts: runStartTs + 1000, findingsCount: 2, host: "test-host" },
      { ts: runStartTs + 2000, skipped: true, reason: "debounce" },
      { ts: runStartTs + 3000, findingsCount: 0, host: "test-host" },
      { ts: runStartTs + 4000, findingsCount: 1, host: "test-host" },
    ])

    const outFile = path.join(cwd, "verdict.json")
    const r = run(cwd, {
      KKAMAK_P2_A1_RESULTS: a1File,
      KKAMAK_P2_A3_RESULTS: a3File,
      KKAMAK_P2_A4_RESULTS: a4File,
      KKAMAK_P2_REVIEW_FINDINGS_NDJSON: ndjsonFile,
      KKAMAK_P2_VERDICT_OUT: outFile,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("shadow n too small, not evidential")
    expect(fs.existsSync(outFile)).toBe(true)

    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))
    expect(out.spec).toBe(SPEC_PATH)
    expect(out.ruleSha).toBe("deadbeef")
    expect(out.band).toBe(BAND)
    expect(out.k).toBe(2)
    expect(out.model).toBe("claude-haiku-4-5")

    // a1: n=4, compliance=0 (all false), passAtK=1 (both tasks pass)
    expect(out.arms.a1).toEqual({ n: 4, compliance: 0, passAtK: 1, meanTurns: 4.5, meanElapsedSec: 11 })

    // a3: n=4, compliance=1 (all true), passAtK=1, stopBlocks=0
    expect(out.arms.a3.n).toBe(4)
    expect(out.arms.a3.compliance).toBe(1)
    expect(out.arms.a3.passAtK).toBe(1)
    expect(out.arms.a3.stopBlocks).toBe(0)

    // a4: n=4, compliance=3/4, passAtK=1, rePassRate=1/4, reviewFailedCount=1
    expect(out.arms.a4.n).toBe(4)
    expect(out.arms.a4.compliance).toBeCloseTo(0.75, 10)
    expect(out.arms.a4.passAtK).toBe(1)
    expect(out.arms.a4.rePassRate).toBeCloseTo(0.25, 10)
    expect(out.arms.a4.reviewFailedCount).toBe(1)

    // bars: a3 compliance=1>=0.75, drop = a1.passAtK - a3.passAtK = 0 -> earns.
    // a4 compliance=0.75>=0.75, drop = 1 - 1 = 0 -> earns.
    expect(out.bars).toEqual({
      a3earnsRouting: true, a4earnsRouting: true, complianceBar: COMPLIANCE_BAR, passDropBar: PASS_DROP_BAR,
    })
    expect(out.computeBonusCaveat).toBe(COMPUTE_BONUS_CAVEAT)

    expect(out.b2Shadow.realizedN).toBe(3)
    expect(out.b2Shadow.evidential).toBe(false)
    expect(out.b2Shadow.windowStart).toBe(runStartTs)
    expect(typeof out.b2Shadow.windowEnd).toBe("number")
    expect(out.b2Shadow.windowEnd).toBeGreaterThanOrEqual(runStartTs)
  })

  // Silent-done hardening (launch-0 rule, minimal/HISTORY.md 2026-08-09/10):
  // "tally only when all three results files exist" — an rc=0 sized-go that
  // produced no results files is a no-op, and a tolerant all-zero verdict
  // laundered exactly that into a structurally-valid answer once already.
  test("missing arm results files -> REFUSES with non-zero exit, no verdict written (silent-done hardening)", () => {
    const cwd = mkTmp("p2-tally-missing-")
    const outFile = path.join(cwd, "verdict.json")
    const r = run(cwd, {
      KKAMAK_P2_A1_RESULTS: path.join(cwd, "does-not-exist-a1.json"),
      KKAMAK_P2_A3_RESULTS: path.join(cwd, "does-not-exist-a3.json"),
      KKAMAK_P2_A4_RESULTS: path.join(cwd, "does-not-exist-a4.json"),
      KKAMAK_P2_REVIEW_FINDINGS_NDJSON: path.join(cwd, "does-not-exist.ndjson"),
      KKAMAK_P2_VERDICT_OUT: outFile,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("does-not-exist-a1.json")
    expect(r.stderr).toContain("does-not-exist-a3.json")
    expect(r.stderr).toContain("does-not-exist-a4.json")
    expect(fs.existsSync(outFile)).toBe(false)
  })

  test("ONE missing arm results file -> refuses and names exactly the missing one", () => {
    const cwd = mkTmp("p2-tally-missing-one-")
    const runStartIso = new Date(2_000_000_000_000).toISOString()
    const doc: P2ResultsDoc = {
      k: 1, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "deadbeef" },
      tasks: { t1: { rewards: [1], turns: [1], elapsed: [1], errors: [ann(true)] } },
    }
    const a1File = path.join(cwd, "a1.json")
    const a3File = path.join(cwd, "a3.json")
    fs.writeFileSync(a1File, JSON.stringify(doc))
    fs.writeFileSync(a3File, JSON.stringify(doc))
    const outFile = path.join(cwd, "verdict.json")
    const r = run(cwd, {
      KKAMAK_P2_A1_RESULTS: a1File,
      KKAMAK_P2_A3_RESULTS: a3File,
      KKAMAK_P2_A4_RESULTS: path.join(cwd, "does-not-exist-a4.json"),
      KKAMAK_P2_REVIEW_FINDINGS_NDJSON: path.join(cwd, "does-not-exist.ndjson"),
      KKAMAK_P2_VERDICT_OUT: outFile,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("does-not-exist-a4.json")
    expect(r.stderr).not.toContain("a1.json missing")
    expect(fs.existsSync(outFile)).toBe(false)
  })

  test("disagreeing k/model/ruleSha across present arms -> hard die, non-zero exit", () => {
    const cwd = mkTmp("p2-tally-mismatch-")
    const runStartIso = new Date(2_000_000_000_000).toISOString()
    const a1: P2ResultsDoc = {
      k: 2, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "deadbeef" },
      tasks: { t1: { rewards: [1], turns: [1], elapsed: [1], errors: [ann(true)] } },
    }
    const a3: P2ResultsDoc = {
      k: 2, model: "claude-haiku-4-5", timestamp: runStartIso, harness: { ruleSha: "DIFFERENT-SHA" },
      tasks: { t1: { rewards: [1], turns: [1], elapsed: [1], errors: [ann(true)] } },
    }
    const a1File = path.join(cwd, "a1.json")
    const a3File = path.join(cwd, "a3.json")
    const a4File = path.join(cwd, "a4.json")
    writeResultsDoc(a1File, a1)
    writeResultsDoc(a3File, a3)
    // all three files must EXIST under the silent-done refusal — the
    // mismatch under test is ruleSha, so a4 just mirrors a1's config
    writeResultsDoc(a4File, a1)
    const r = run(cwd, {
      KKAMAK_P2_A1_RESULTS: a1File,
      KKAMAK_P2_A3_RESULTS: a3File,
      KKAMAK_P2_A4_RESULTS: a4File,
      KKAMAK_P2_REVIEW_FINDINGS_NDJSON: path.join(cwd, "does-not-exist.ndjson"),
      KKAMAK_P2_VERDICT_OUT: path.join(cwd, "verdict.json"),
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("ruleSha disagrees")
  })
})
