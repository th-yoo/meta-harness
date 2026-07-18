import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { runAgent, TRANSIENT_MARK, TIMEOUT_MARK, AUTH_FAIL_MARK } from "../src/bench/agent-run.ts"
import type { AgentDriver, AgentRunOutput, AttemptClass, HarnessDelivery } from "../src/bench/drivers/types.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import type { ExecResult } from "../src/bench/exec.ts"

// Minimal FAKE driver + tmpDir/fakeBenchPaths helpers, replicated (minimally)
// from test/bench-opencode-run.test.ts's pattern — that file is not exported
// from / imported here, per task-B1-brief.md's constraint that it stay
// untouched.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-agent-run-"))
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

function ok(stdout: string, rc = 0): ExecResult {
  return { rc, stdout, stderr: "", timedOut: false }
}

function setupTask(): BenchPaths {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  return fakeBenchPaths(tbRoot)
}

const FAKE_RESULT: AgentRunOutput = {
  turnCount: 7,
  toolUsage: { fake: { calls: 1, errors: 0 } },
  events: [{ t: "text", text: "fake output" }],
}

function makeFakeDriver(opts: {
  harness?: HarnessDelivery
  classify?: (result: ExecResult) => AttemptClass
  authHint?: string
} = {}): AgentDriver {
  return {
    id: "fake-agent",
    buildArgv: ({ model, variant, instruction }) => [
      "fake-agent",
      "--model",
      model,
      ...(variant ? ["--variant", variant] : []),
      instruction,
    ],
    modelArg: (canonicalModel) => canonicalModel,
    harness: opts.harness ?? { kind: "workspace-file", filename: "HARNESS.md" },
    parseOutput: () => FAKE_RESULT,
    classifyAttempt: opts.classify ?? (() => "done"),
    prepareAuth: () => ({ mounts: [], cleanup: () => {} }),
    versionArgv: ["fake-agent", "--version"],
    ...(opts.authHint !== undefined ? { authHint: opts.authHint } : {}),
  }
}

// ── 1. timeout short-circuit ────────────────────────────────────────────

test("runAgent: timeout short-circuits to {0,{},[]} and logs TIMEOUT_MARK, no retry", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver()

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return { rc: 124, stdout: "", stderr: "", timedOut: true }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn)
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

// ── 2. auth classification ──────────────────────────────────────────────

test("runAgent: auth classification fails fast — no retry, no backoff, AUTH_FAIL_MARK logged, not TRANSIENT_MARK", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({ classify: () => "auth" })

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return ok("boom", 1)
  }
  const sleeps: number[] = []
  const sleepFn = async (s: number) => {
    sleeps.push(s)
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn, sleepFn)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(true)
    expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(false)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(1)
  expect(sleeps).toEqual([])
  // Auth fail-fast must return the zero result — never driver.parseOutput's
  // result (final-review fix 2): the claude-code auth fixture carries a
  // synthetic assistant echo with num_turns:1, and returning that as the
  // real result would slip a bogus turnCount>0 SessionRecord past
  // recordToStores' turnCount===0 skip guard.
  expect(result).toEqual({ turnCount: 0, toolUsage: {}, events: [] })
})

// ── 2b. driver-neutral auth remediation (final-review fix 5) ────────────

test("runAgent: auth log line uses driver.authHint when the driver sets one", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({ classify: () => "auth", authHint: "USE FAKE-AGENT'S OWN REMEDIATION COMMAND" })

  const execFn = async (): Promise<ExecResult> => ok("boom", 1)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("USE FAKE-AGENT'S OWN REMEDIATION COMMAND"))).toBe(true)
    // Must not fall back to another driver's hardcoded wording.
    expect(messages.some((m) => m.includes("opencode"))).toBe(false)
  } finally {
    errSpy.mockRestore()
  }
})

test("runAgent: auth log line falls back to a driver-neutral generic hint when the driver sets no authHint", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({ classify: () => "auth" }) // no authHint

  const execFn = async (): Promise<ExecResult> => ok("boom", 1)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    const authMsg = messages.find((m) => m.includes(AUTH_FAIL_MARK))
    expect(authMsg).toBeDefined()
    // The generic fallback must not name opencode-specific files/commands —
    // it may be shown for ANY driver.
    expect(authMsg).not.toContain("opencode")
    expect(authMsg).not.toContain("auth.json")
  } finally {
    errSpy.mockRestore()
  }
})

// ── 3. transient classification ─────────────────────────────────────────

test("runAgent: transient classification retries with backoff 5,10,15 (cap 30), MAX_ATTEMPTS(4) total calls", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({ classify: () => "transient" })

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return ok("still failing", 1)
  }
  const sleeps: number[] = []
  const sleepFn = async (s: number) => {
    sleeps.push(s)
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn, sleepFn)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.filter((m) => m.includes(TRANSIENT_MARK)).length).toBe(3)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(4)
  expect(sleeps).toEqual([5, 10, 15])
  // still returns driver.parseOutput after exhausting attempts, now with
  // agentElapsedSec populated (W1a: every completion path, not just timeout).
  expect(result).toEqual({ ...FAKE_RESULT, agentElapsedSec: expect.any(Number) })
})

// ── 4. done on first attempt + workspace-file harness delivery ─────────

test("runAgent: done on first attempt returns parseOutput result; workspace-file harness delivered via cp", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({ harness: { kind: "workspace-file", filename: "HARNESS.md" } })

  const seenArgv: string[][] = []
  let capturedHostFile: string | undefined
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    seenArgv.push(argv)
    if (argv[1] === "cp") capturedHostFile = argv[2]
    return ok("done")
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "my-container", "t", "m", "", 30, "harness contents", execFn)
  } finally {
    errSpy.mockRestore()
  }

  expect(result).toEqual({ ...FAKE_RESULT, agentElapsedSec: expect.any(Number) })
  const cpCall = seenArgv.find((a) => a[1] === "cp")
  expect(cpCall).toEqual(["podman", "cp", capturedHostFile!, "my-container:/app/HARNESS.md"])
  expect(fs.existsSync(capturedHostFile!)).toBe(false) // scratch cleaned up after use

  // exec call (not the cp) never used --pure-style content — just sanity that
  // buildArgv's argv reached execFn as the actual exec command.
  const execCall = seenArgv.find((a) => a[1] === "exec")
  expect(execCall).toBeDefined()
})

// ── 5. argv-flags harness delivery variant ──────────────────────────────

test("runAgent: argv-flags harness delivery appends buildFlags(harnessMd) to argv, issues no cp", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver({
    harness: {
      kind: "argv-flags",
      buildFlags: (harnessMd) => ["--harness-inline", harnessMd],
    },
  })

  const seenArgv: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    seenArgv.push(argv)
    return ok("done")
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "myvariant", 30, "the harness md", execFn)
  } finally {
    errSpy.mockRestore()
  }

  expect(result).toEqual({ ...FAKE_RESULT, agentElapsedSec: expect.any(Number) })
  expect(seenArgv.some((a) => a[1] === "cp")).toBe(false)
  const execCall = seenArgv.find((a) => a[1] === "exec")!
  expect(execCall).toContain("--harness-inline")
  expect(execCall).toContain("the harness md")
  expect(execCall).toContain("--variant")
  expect(execCall).toContain("myvariant")
})

// ── 5b. agentElapsedSec on the normal completion path (W1a) ─────────────
//
// Before this feature, agentElapsedSec was populated ONLY on the timeout
// branch — the success return discarded the locally-computed elapsedSec and
// returned driver.parseOutput(output) verbatim. Since a passing run is the
// only kind speed-stats pairs on, that meant time-to-resolve had no signal
// on the runs that matter. Every completion path (done-first-attempt,
// transient-exhausted, timeout) must now carry it.

test("runAgent: agentElapsedSec is populated on a normal non-timeout pass, not just the timeout branch", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver()
  const execFn = async (): Promise<ExecResult> => ok("done")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn)
  } finally {
    errSpy.mockRestore()
  }
  expect(result.timedOut).toBeUndefined()
  expect(typeof result.agentElapsedSec).toBe("number")
  expect(result.agentElapsedSec as number).toBeGreaterThanOrEqual(0)
})

// ── 6. timedOut discriminator (Loop-3 T1) ───────────────────────────────
//
// CRITICAL INVARIANT this guards: runAgent's timeout, auth-fail, and
// transient-exhaustion branches all return turnCount:0 — indistinguishable
// on that field alone. timedOut must be true ONLY on the wall-timeout
// branch, and stay unset (not merely false) on auth-fail and on any
// non-timeout, non-zero-turn parse — later loop-3 work (recording/skip
// logic) depends on this discriminator being set at the source.

test("runAgent sets timedOut:true (and a finite agentElapsedSec) on a wall-timeout", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver()

  const execFn = async (): Promise<ExecResult> => {
    return { rc: 124, stdout: "", stderr: "", timedOut: true }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: AgentRunOutput
  try {
    result = await runAgent(driver, paths, "c1", "t", "m", "", 30, "", execFn)
  } finally {
    errSpy.mockRestore()
  }
  expect(result.timedOut).toBe(true)
  expect(result.turnCount).toBe(0)
  expect(typeof result.agentElapsedSec).toBe("number")
  expect(result.agentElapsedSec as number).toBeGreaterThanOrEqual(0)
})

// ── 7. budget-inject (Loop-3 T5) ────────────────────────────────────────
//
// The agent gets an advisory budget line derived ONLY from agentTimeout,
// appended to the instruction before driver.buildArgv is called. It must
// never depend on the (evolvable, per-arm) harness markdown — that would
// make the constant an accidental A/B lever and contaminate the gate.

test("runAgent injects an advisory budget line carrying agentTimeout into the instruction", async () => {
  const paths = setupTask()
  const driver = makeFakeDriver()
  let capturedInstruction = ""
  const baseBuildArgv = driver.buildArgv
  driver.buildArgv = (opts) => {
    capturedInstruction = opts.instruction
    return baseBuildArgv(opts)
  }

  const execFn = async (): Promise<ExecResult> => ok("done")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runAgent(driver, paths, "c1", "t", "m", "", 600, "", execFn)
  } finally {
    errSpy.mockRestore()
  }

  expect(capturedInstruction).toContain("600s")
  expect(capturedInstruction).toContain("Budget it")
  expect(capturedInstruction.startsWith("do the thing")).toBe(true) // original instruction preserved, budget appended
})

test("runAgent's injected budget line is byte-identical across arms with the same agentTimeout (arm-symmetry)", async () => {
  const paths = setupTask()

  async function captureInstruction(harnessMd: string): Promise<string> {
    const driver = makeFakeDriver()
    let captured = ""
    const baseBuildArgv = driver.buildArgv
    driver.buildArgv = (opts) => {
      captured = opts.instruction
      return baseBuildArgv(opts)
    }
    const execFn = async (): Promise<ExecResult> => ok("done")
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      await runAgent(driver, paths, "c1", "t", "m", "", 600, harnessMd, execFn)
    } finally {
      errSpy.mockRestore()
    }
    return captured
  }

  // Simulate arm A (baseline harness) vs arm B (candidate harness) — same
  // agentTimeout, different evolvable harness markdown.
  const instructionA = await captureInstruction("# AGENTS.md v0 — baseline harness content")
  const instructionB = await captureInstruction("# AGENTS.md vN — a completely different candidate harness")

  const marker = "\n\nYou have roughly "
  const indexA = instructionA.indexOf(marker)
  const indexB = instructionB.indexOf(marker)
  expect(indexA).toBeGreaterThanOrEqual(0) // sanity: marker was actually found
  expect(indexB).toBeGreaterThanOrEqual(0)

  const budgetA = instructionA.slice(indexA)
  const budgetB = instructionB.slice(indexB)
  expect(budgetA).toBe(budgetB) // byte-identical — a function of agentTimeout only
})

test("runAgent leaves timedOut unset on auth-fail and on a normal parse", async () => {
  const paths = setupTask()

  // auth-fail branch: turnCount:0, same as timeout — but timedOut must NOT
  // be set, so callers can tell the two apart.
  const authDriver = makeFakeDriver({ classify: () => "auth" })
  const authExecFn = async (): Promise<ExecResult> => ok("authentication_failed", 1)
  const authErrSpy = spyOn(console, "error").mockImplementation(() => {})
  let authResult: AgentRunOutput
  try {
    authResult = await runAgent(authDriver, paths, "c1", "t", "m", "", 30, "", authExecFn, async () => {})
  } finally {
    authErrSpy.mockRestore()
  }
  expect(authResult.timedOut).toBeUndefined()
  expect(authResult.turnCount).toBe(0)

  // normal multi-turn parse: turnCount>0, timedOut must stay unset.
  const normalDriver = makeFakeDriver()
  const normalExecFn = async (): Promise<ExecResult> => ok("normal multi-turn output")
  const normalErrSpy = spyOn(console, "error").mockImplementation(() => {})
  let normalResult: AgentRunOutput
  try {
    normalResult = await runAgent(normalDriver, paths, "c1", "t", "m", "", 30, "", normalExecFn)
  } finally {
    normalErrSpy.mockRestore()
  }
  expect(normalResult.timedOut).toBeUndefined()
  expect(normalResult.turnCount).toBeGreaterThan(0)
})
