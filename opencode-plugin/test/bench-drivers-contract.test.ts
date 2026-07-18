/**
 * bench-drivers-contract.test.ts — cross-driver contract suite
 * (task-B5-brief.md section 4).
 *
 * Parameterized over drivers/index.ts's DRIVER_IDS: every registered driver
 * gets the SAME behavioral contract exercised against its OWN captured
 * fixtures (test/fixtures/drivers/<id>/). A driver registered without an
 * entry in DRIVER_CASES below fails the "every driver has a contract case"
 * test at the bottom of this file LOUDLY (not silently skipped) — that's
 * the "auto-extends" property the brief asks for: adding a driver to
 * DRIVER_IDS without wiring it into this table is a build-time-visible gap,
 * not a silent hole in coverage.
 */
import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { DRIVER_IDS, getDriver } from "../src/bench/drivers/index.ts"
import { runAgent, TRANSIENT_MARK, TIMEOUT_MARK, AUTH_FAIL_MARK } from "../src/bench/agent-run.ts"
import type { ToolUsage } from "../src/harness-store.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import type { ExecResult } from "../src/bench/exec.ts"

// ── fixture / paths helpers (replicated minimally from
//    test/bench-agent-run.test.ts's pattern, per that file's own comment —
//    not imported/shared to keep each test file self-contained) ──────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-drivers-contract-"))
}

function fakeBenchPaths(tbRoot: string): BenchPaths {
  const termBenchDir = path.join(tbRoot, "..", "term-bench2")
  return {
    metaRoot: path.dirname(termBenchDir),
    termBenchDir,
    tbRoot,
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

function setupTask(): BenchPaths {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  return fakeBenchPaths(tbRoot)
}

function ok(stdout: string, rc = 0): ExecResult {
  return { rc, stdout, stderr: "", timedOut: false }
}

const FIXTURES_ROOT = path.join(import.meta.dir, "fixtures", "drivers")

function fixture(driverDir: string, name: string): string {
  return fs.readFileSync(path.join(FIXTURES_ROOT, driverDir, name), "utf-8")
}

// ── per-driver contract table ──────────────────────────────────────────

interface DriverContractCase {
  id: string
  fixtureDir: string
  files: { success: string; toolError: string; auth: string; transient: string }
  expected: {
    successToolUsage: ToolUsage
    successTurnsMin: number
    toolErrorUsage: ToolUsage
  }
  modelArg: {
    valid: string
    validExpected: string
    /** undefined = this driver accepts any canonical slug (opencode). */
    invalid?: string
  }
  buildArgv: {
    model: string
    instruction: string
    variantDies: boolean
    variantOk?: string
  }
  /** Synthetic n-event NDJSON stream in this driver's own event shape, all
   * of type "text" — used only to prove the maxEvents=400 cap; independent
   * of any real fixture. */
  makeOversizedNdjson(n: number): string
}

const DRIVER_CASES: Record<string, DriverContractCase> = {
  opencode: {
    id: "opencode",
    fixtureDir: "opencode",
    files: { success: "success.ndjson", toolError: "tool-error.ndjson", auth: "auth-error.txt", transient: "transient.txt" },
    expected: {
      successToolUsage: { bash: { calls: 1, errors: 0 } },
      successTurnsMin: 1,
      toolErrorUsage: { bash: { calls: 1, errors: 1 }, read: { calls: 1, errors: 0 } },
    },
    modelArg: { valid: "anthropic/claude-x", validExpected: "anthropic/claude-x" }, // identity — accepts anything
    buildArgv: { model: "claude-x", instruction: "do it", variantDies: false, variantOk: "v2" },
    makeOversizedNdjson: (n) =>
      Array.from({ length: n }, (_, i) => JSON.stringify({ type: "text", text: `t${i}` })).join("\n"),
  },
  "claude-code": {
    id: "claude-code",
    fixtureDir: "claude-code",
    files: { success: "success.ndjson", toolError: "tool-error.ndjson", auth: "auth-error.txt", transient: "transient.txt" },
    expected: {
      successToolUsage: { Bash: { calls: 1, errors: 0 } },
      successTurnsMin: 2,
      toolErrorUsage: { Bash: { calls: 1, errors: 1 } },
    },
    modelArg: { valid: "anthropic/claude-sonnet-4-6", validExpected: "claude-sonnet-4-6", invalid: "openai/gpt-4" },
    buildArgv: { model: "claude-sonnet-4-6", instruction: "do it", variantDies: true },
    makeOversizedNdjson: (n) =>
      Array.from({ length: n }, (_, i) =>
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `t${i}` }] } }),
      ).join("\n"),
  },
}

// Every driver actually registered must have a contract case — a driver
// added to DRIVER_IDS without one fails HERE, loudly, rather than silently
// getting zero contract coverage.
test("DRIVER_CASES covers every id in DRIVER_IDS", () => {
  for (const id of DRIVER_IDS) {
    expect(DRIVER_CASES[id]).toBeDefined()
  }
})

for (const id of DRIVER_IDS) {
  const kase = DRIVER_CASES[id]
  if (!kase) continue // already flagged by the coverage test above
  const driver = getDriver(id)

  // ── 1. success fixture -> parseOutput ────────────────────────────────

  test(`[${id}] parseOutput: success fixture — turnCount >= min, toolUsage matches, events non-empty + capped`, () => {
    const out = fixture(kase.fixtureDir, kase.files.success)
    const result = driver.parseOutput(out)
    expect(result.turnCount).toBeGreaterThanOrEqual(kase.expected.successTurnsMin)
    expect(result.toolUsage).toEqual(kase.expected.successToolUsage)
    expect(result.events.length).toBeGreaterThan(0)
    for (const ev of result.events) {
      if (ev.args !== undefined) expect(ev.args.length).toBeLessThanOrEqual(300)
      if (ev.output !== undefined) expect(ev.output.length).toBeLessThanOrEqual(800)
      if (ev.text !== undefined) expect(ev.text.length).toBeLessThanOrEqual(800)
    }
  })

  test(`[${id}] parseOutput: synthetic oversized stream caps events at 400`, () => {
    const big = kase.makeOversizedNdjson(1000)
    const result = driver.parseOutput(big)
    expect(result.events.length).toBe(400)
  })

  // ── 2. tool-error fixture -> toolUsage errors for execution tools only ─

  test(`[${id}] parseOutput: tool-error fixture — toolUsage matches (errors only on execution tools)`, () => {
    const out = fixture(kase.fixtureDir, kase.files.toolError)
    const result = driver.parseOutput(out)
    expect(result.toolUsage).toEqual(kase.expected.toolErrorUsage)
  })

  // ── 3. auth fixture via runAgent: 1 attempt, no backoff, AUTH_FAIL_MARK ─

  test(`[${id}] runAgent: auth fixture fails fast — 1 attempt, no backoff, AUTH_FAIL_MARK logged, TRANSIENT_MARK absent`, async () => {
    const paths = setupTask()
    const authOut = fixture(kase.fixtureDir, kase.files.auth)

    let calls = 0
    const execFn = async (): Promise<ExecResult> => {
      calls++
      return ok(authOut, 1)
    }
    const sleeps: number[] = []
    const sleepFn = async (s: number) => {
      sleeps.push(s)
    }

    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    let result
    try {
      result = await runAgent(driver, paths, "c1", "t", kase.modelArg.valid, "", 30, "", execFn, sleepFn)
      const messages = errSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(true)
      expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(false)
    } finally {
      errSpy.mockRestore()
    }
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    // Auth fail-fast must return the zero result — never driver.parseOutput's
    // result (final-review fix 2). This is the load-bearing assertion for
    // claude-code in particular: its REAL captured auth-error.txt fixture
    // carries a synthetic assistant echo with num_turns:1, so
    // driver.parseOutput(authOut) is NOT the zero result — proving this
    // path is genuinely driver-agnostic, not just true-by-coincidence like
    // opencode's (whose auth fixture happens to already parse to 0 turns).
    expect(result).toEqual({ turnCount: 0, toolUsage: {}, events: [] })
  })

  // ── 4. transient fixture via runAgent: retries then gives up ──────────

  test(`[${id}] runAgent: transient fixture retries with backoff then exhausts MAX_ATTEMPTS(4), logs TRANSIENT_MARK x3`, async () => {
    const paths = setupTask()
    const transientOut = fixture(kase.fixtureDir, kase.files.transient)
    const expectedResult = driver.parseOutput(transientOut)

    let calls = 0
    const execFn = async (): Promise<ExecResult> => {
      calls++
      return ok(transientOut, 1)
    }
    const sleeps: number[] = []
    const sleepFn = async (s: number) => {
      sleeps.push(s)
    }

    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    let result
    try {
      result = await runAgent(driver, paths, "c1", "t", kase.modelArg.valid, "", 30, "", execFn, sleepFn)
      const messages = errSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.filter((m) => m.includes(TRANSIENT_MARK)).length).toBe(3)
      expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(false)
    } finally {
      errSpy.mockRestore()
    }
    expect(calls).toBe(4)
    expect(sleeps).toEqual([5, 10, 15])
    // W1a: transient-exhausted still falls through to the success return, now
    // carrying agentElapsedSec alongside driver.parseOutput's fields.
    expect(result).toEqual({ ...expectedResult, agentElapsedSec: expect.any(Number) })
  })

  // ── 5. timeout -> {0,{},[]} + TIMEOUT_MARK, no retry ───────────────────

  test(`[${id}] runAgent: timeout short-circuits to {0,{},[]}, logs TIMEOUT_MARK, no retry`, async () => {
    const paths = setupTask()
    let calls = 0
    const execFn = async (): Promise<ExecResult> => {
      calls++
      return { rc: 124, stdout: "", stderr: "", timedOut: true }
    }

    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    let result
    try {
      result = await runAgent(driver, paths, "c1", "t", kase.modelArg.valid, "", 30, "", execFn)
      const messages = errSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes(TIMEOUT_MARK) && m.includes("30s"))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
    expect(result).toEqual({
      turnCount: 0,
      toolUsage: {},
      events: [],
      timedOut: true,
      agentElapsedSec: expect.any(Number),
    })
    expect(calls).toBe(1)
  })

  // ── 6. modelArg ──────────────────────────────────────────────────────

  test(`[${id}] modelArg: valid canonical slug round-trips to the driver-native model arg`, () => {
    expect(driver.modelArg(kase.modelArg.valid)).toBe(kase.modelArg.validExpected)
  })

  if (kase.modelArg.invalid !== undefined) {
    test(`[${id}] modelArg: an unsupported canonical slug dies`, () => {
      expect(() => driver.modelArg(kase.modelArg.invalid!)).toThrow()
    })
  } else {
    test(`[${id}] modelArg: accepts an arbitrary slug unchanged (no per-driver model restriction)`, () => {
      expect(driver.modelArg("some/arbitrary-slug")).toBe("some/arbitrary-slug")
    })
  }

  // ── 7. buildArgv ─────────────────────────────────────────────────────

  test(`[${id}] buildArgv: contains the translated model + instruction`, () => {
    const argv = driver.buildArgv({ model: kase.buildArgv.model, variant: "", instruction: kase.buildArgv.instruction })
    expect(argv).toContain(kase.buildArgv.model)
    expect(argv).toContain(kase.buildArgv.instruction)
  })

  if (kase.buildArgv.variantDies) {
    test(`[${id}] buildArgv: a non-empty variant dies (no variant concept)`, () => {
      expect(() =>
        driver.buildArgv({ model: kase.buildArgv.model, variant: "v1", instruction: kase.buildArgv.instruction }),
      ).toThrow()
    })
  } else {
    test(`[${id}] buildArgv: a non-empty variant is threaded into argv`, () => {
      const argv = driver.buildArgv({
        model: kase.buildArgv.model,
        variant: kase.buildArgv.variantOk!,
        instruction: kase.buildArgv.instruction,
      })
      expect(argv).toContain(kase.buildArgv.variantOk)
    })
  }
}
