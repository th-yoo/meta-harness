/**
 * p2-cmd.test.ts — TDD for src/bench/p2/cmd-p2.ts: the `p2-run` subcommand
 * (task-4-brief.md, plan §Task 4).
 *
 * Written FIRST, failing (src/bench/p2/cmd-p2.ts does not exist yet).
 *
 * Fully hermetic per the brief: fake execFn/driver (agent-run.ts's own
 * injectable-seam pattern, test/bench-agent-run.test.ts) + a fake
 * `runReview` — NO podman, NO model call anywhere in this file.
 * verifier.ts's `runVerifier` hardcodes the real `podman` funnel with no
 * injectable execFn (see that file's header) and staging.ts's
 * `stageTaskRuntime` reads a real Dockerfile off disk — both are mocked
 * via `mock.module` for the dispatch-level tests below, mirroring
 * test/bench-cmd-run.test.ts's own `restoreVerifier` pattern exactly
 * (capture the real export at module-eval time, mock in the test body,
 * restore in a `finally`).
 *
 * F2 note: every fixture string below (DONE-CHECK content, bash commands,
 * instruction text) is synthetic, invented for this test — never a real
 * bench transcript.
 */
import { test, expect, mock } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  cmdP2,
  runOneP2Attempt,
  expectedGoCount,
  resolveP2ResultsFile,
  buildA1HarnessMd,
  type CmdP2Args,
  type P2AttemptResult,
  type RunOneP2AttemptFn,
  type RunA4ReviewFn,
} from "../src/bench/p2/cmd-p2.ts"
import { P2_RULE_TEXT, ruleSha } from "../src/bench/p2/rule.ts"
import type { A4ReviewResult } from "../src/bench/p2/a4-review.ts"
import { BenchError } from "../src/bench/util.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import type { AgentDriver, AgentRunOutput } from "../src/bench/drivers/types.ts"
import type { ExecResult } from "../src/bench/exec.ts"
import type { ExecFn } from "../src/bench/staging.ts"
import type { TrajEvent } from "../src/harness-store.ts"
import * as verifierReal from "../src/bench/verifier.ts"
import * as stagingReal from "../src/bench/staging.ts"

// ── module-mock restore plumbing (mirrors test/bench-cmd-run.test.ts) ─────

const realCopyTests = verifierReal.copyTests
const realRunVerifier = verifierReal.runVerifier
function restoreVerifier(): void {
  mock.module("../src/bench/verifier.ts", () => ({ copyTests: realCopyTests, runVerifier: realRunVerifier }))
}

const realStageTaskRuntime = stagingReal.stageTaskRuntime
function restoreStaging(): void {
  mock.module("../src/bench/staging.ts", () => ({ stageTaskRuntime: realStageTaskRuntime }))
}

function mockVerifierAndStaging(reward: number): void {
  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => reward }))
  mock.module("../src/bench/staging.ts", () => ({ stageTaskRuntime: async () => {} }))
}

// ── fixture helpers ────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-p2-cmd-"))
}

function fakeBenchPaths(metaRoot: string, tbRoot: string): BenchPaths {
  const termBenchDir = path.join(metaRoot, "term-bench2")
  return {
    metaRoot,
    termBenchDir,
    tbRoot,
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

function writeTaskTomls(tbRoot: string, tasks: string[]): void {
  for (const t of tasks) {
    fs.mkdirSync(path.join(tbRoot, t), { recursive: true })
    fs.writeFileSync(path.join(tbRoot, t, "task.toml"), "")
    // agent-run.ts's runAgent (real, never mocked here) reads
    // <tbRoot>/<task>/instruction.md off real disk — see
    // test/bench-agent-run.test.ts's own setupTask() for the same fixture.
    fs.writeFileSync(path.join(tbRoot, t, "instruction.md"), "do the thing")
  }
}

/** Standard test layout: metaRoot/tb-root with the given tasks declared,
 * and metaRoot/docs/loop-probes/p2/ as the valid results-file home. */
function setup(tasks: string[]): { paths: BenchPaths; resultsFile: string } {
  const metaRoot = tmpDir()
  const tbRoot = path.join(metaRoot, "tb-root")
  writeTaskTomls(tbRoot, tasks)
  const paths = fakeBenchPaths(metaRoot, tbRoot)
  const resultsFile = path.join(metaRoot, "docs", "loop-probes", "p2", "test-results.json")
  return { paths, resultsFile }
}

// ── expectedGoCount ───────────────────────────────────────────────────────

test("expectedGoCount: a1 = tasks × k (no re-pass multiplier)", () => {
  expect(expectedGoCount(14, 2, "a1")).toBe(28)
})

test("expectedGoCount: a3 = tasks × k (no re-pass multiplier)", () => {
  expect(expectedGoCount(14, 2, "a3")).toBe(28)
})

test("expectedGoCount: a4 = tasks × k × 2 (potential re-pass counted)", () => {
  expect(expectedGoCount(14, 2, "a4")).toBe(56)
})

// ── resolveP2ResultsFile ────────────────────────────────────────────────

test("resolveP2ResultsFile: a path under docs/loop-probes/p2/ resolves unchanged", () => {
  const { paths, resultsFile } = setup(["t"])
  expect(resolveP2ResultsFile(paths, resultsFile)).toBe(path.resolve(resultsFile))
})

test("resolveP2ResultsFile: a path outside docs/loop-probes/p2/ dies", () => {
  const { paths } = setup(["t"])
  const outside = path.join(paths.metaRoot, "term-bench2", "results", "x.json")
  expect(() => resolveP2ResultsFile(paths, outside)).toThrow(BenchError)
})

// ── buildA1HarnessMd ─────────────────────────────────────────────────────

test("buildA1HarnessMd: stock harness plus exactly one appended bullet carrying the frozen rule verbatim", () => {
  const stock = "## Project guidance\n\nsome existing content"
  const built = buildA1HarnessMd(stock)
  expect(built).toBe(`${stock}\n\n- ${P2_RULE_TEXT}`)
  // exactly one bullet — the rule text appears exactly once
  expect(built.split(P2_RULE_TEXT).length - 1).toBe(1)
})

// ── cmdP2 fences ──────────────────────────────────────────────────────────

test("cmdP2: missing --results-file dies, runOneAttempt never called", async () => {
  const { paths } = setup(["t"])
  let called = false
  const fakeRunOneAttempt: RunOneP2AttemptFn = async () => {
    called = true
    return okResult()
  }
  const args: CmdP2Args = { arm: "a1", tasks: ["t"], k: 1, go: 1 }
  await expect(cmdP2(paths, args, { runOneAttempt: fakeRunOneAttempt })).rejects.toThrow(BenchError)
  expect(called).toBe(false)
})

test("cmdP2: --results-file outside docs/loop-probes/p2/ dies, runOneAttempt never called", async () => {
  const { paths } = setup(["t"])
  let called = false
  const fakeRunOneAttempt: RunOneP2AttemptFn = async () => {
    called = true
    return okResult()
  }
  const outside = path.join(paths.metaRoot, "term-bench2", "results", "x.json")
  const args: CmdP2Args = { arm: "a1", tasks: ["t"], k: 1, go: 1, resultsFile: outside }
  await expect(cmdP2(paths, args, { runOneAttempt: fakeRunOneAttempt })).rejects.toThrow(BenchError)
  expect(called).toBe(false)
})

test("cmdP2: wrong --go dies naming the expected count, runOneAttempt never called", async () => {
  const { paths, resultsFile } = setup(["t1", "t2"])
  let called = false
  const fakeRunOneAttempt: RunOneP2AttemptFn = async () => {
    called = true
    return okResult()
  }
  const args: CmdP2Args = { arm: "a1", tasks: ["t1", "t2"], k: 2, go: 999, resultsFile }
  await expect(cmdP2(paths, args, { runOneAttempt: fakeRunOneAttempt })).rejects.toThrow(
    /expected --go 4/,
  )
  expect(called).toBe(false)
})

test("cmdP2: a4's correct --go (doubled for the re-pass budget) succeeds — no fence trip", async () => {
  const { paths, resultsFile } = setup(["t1", "t2"])
  let calls = 0
  const args: CmdP2Args = { arm: "a4", tasks: ["t1", "t2"], k: 2, go: 8, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () => {
      calls++
      return okResult()
    },
  })
  expect(calls).toBe(4) // 2 tasks × k=2 (go's ×2 is BUDGET for the potential re-pass, not attempt count)
})

test("cmdP2: a4's wrong --go (un-doubled) dies naming the doubled expected count", async () => {
  const { paths, resultsFile } = setup(["t1", "t2"])
  const args: CmdP2Args = { arm: "a4", tasks: ["t1", "t2"], k: 2, go: 4, resultsFile }
  await expect(cmdP2(paths, args, { runOneAttempt: async () => okResult() })).rejects.toThrow(/expected --go 8/)
})

test("cmdP2: invalid --arm dies", async () => {
  const { paths, resultsFile } = setup(["t"])
  const args = { arm: "bogus", tasks: ["t"], k: 1, go: 1, resultsFile } as unknown as CmdP2Args
  await expect(cmdP2(paths, args, { runOneAttempt: async () => okResult() })).rejects.toThrow(BenchError)
})

// ── cmdP2 orchestration (fake runOneAttempt) ───────────────────────────────

function okResult(overrides: Partial<P2AttemptResult> = {}): P2AttemptResult {
  return {
    reward: 1,
    elapsed: 1.2,
    turns: 3,
    error: "",
    compliant: true,
    reprompted: false,
    reviewFailed: false,
    ...overrides,
  }
}

test("cmdP2: a1 — runOneAttempt called tasks×k times, receives the appended-bullet harness", async () => {
  const { paths, resultsFile } = setup(["t1", "t2"])
  const harnessSeen: string[] = []
  const fakeRunOneAttempt: RunOneP2AttemptFn = async (_paths, _task, _arm, _model, harnessMd) => {
    harnessSeen.push(harnessMd)
    return okResult()
  }
  const args: CmdP2Args = { arm: "a1", tasks: ["t1", "t2"], k: 2, go: 4, resultsFile }
  await cmdP2(paths, args, { runOneAttempt: fakeRunOneAttempt })
  expect(harnessSeen.length).toBe(4)
  for (const h of harnessSeen) expect(h).toContain(P2_RULE_TEXT)
  expect(harnessSeen.every((h) => h === harnessSeen[0])).toBe(true) // harness built once, reused
})

test("cmdP2: a3 — runOneAttempt receives the stock harness UNCHANGED (no appended bullet)", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const harnessSeen: string[] = []
  const fakeRunOneAttempt: RunOneP2AttemptFn = async (_paths, _task, _arm, _model, harnessMd) => {
    harnessSeen.push(harnessMd)
    return okResult()
  }
  const args: CmdP2Args = { arm: "a3", tasks: ["t1"], k: 1, go: 1, resultsFile }
  await cmdP2(paths, args, { runOneAttempt: fakeRunOneAttempt })
  expect(harnessSeen[0]).not.toContain(P2_RULE_TEXT)
})

test("cmdP2: writes results with label 'p2-<arm>' and per-attempt annotation carrying arm/ruleSha/compliant/reprompted/reviewFailed", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () => okResult({ compliant: false, reprompted: true, reviewFailed: false }),
  })
  const written = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(written.label).toBe("p2-a4")
  expect(written.status).toBe("complete")
  const rows = written.tasks.t1
  expect(rows.rewards).toEqual([1])
  expect(rows.errors.length).toBe(1)
  const annotation = JSON.parse(rows.errors[0])
  expect(annotation.arm).toBe("a4")
  expect(annotation.ruleSha).toBe(ruleSha())
  expect(annotation.compliant).toBe(false)
  expect(annotation.reprompted).toBe(true)
  expect(annotation.reviewFailed).toBe(false)
})

// ── runOneP2Attempt dispatch (real container lifecycle, fake execFn/driver) ─

const FIRST_PASS_STDOUT = "FIRST_PASS_MARKER"
const REPASS_STDOUT = "REPASS_MARKER"

function bashEvent(command: string): TrajEvent {
  return { t: "tool", tool: "Bash", args: JSON.stringify({ command }), output: "", error: false } as TrajEvent
}

const FIRST_PASS_EVENTS: TrajEvent[] = [bashEvent("bun test x.test.ts")]
const REPASS_EVENTS: TrajEvent[] = [bashEvent("pytest -q")]

function makeFakeDriver(): AgentDriver {
  return {
    id: "fake-agent",
    buildArgv: ({ model, instruction }) => ["fake-agent", "--model", model, instruction],
    modelArg: (m) => m,
    harness: { kind: "workspace-file", filename: "FAKE.md" },
    parseOutput: (stdout: string): AgentRunOutput => {
      if (stdout === REPASS_STDOUT) return { turnCount: 3, toolUsage: {}, events: REPASS_EVENTS }
      return { turnCount: 5, toolUsage: {}, events: FIRST_PASS_EVENTS }
    },
    classifyAttempt: () => "done",
    prepareAuth: () => ({ mounts: [], cleanup: () => {} }),
    versionArgv: ["fake-agent", "--version"],
  }
}

/** Fake execFn: records every argv, and answers `cat /app/DONE-CHECK.txt` /
 * `ls /app` / the fake driver's own exec calls distinctly; everything else
 * (create/start/mkdir/cp/rm) is a generic rc:0 ok. `catSequence` lets a4's
 * post-re-pass evidence-gathering see a DIFFERENT DONE-CHECK content on its
 * SECOND cat call (simulating the agent writing/fixing the file only
 * during the re-pass). */
function makeFakeExecFn(opts: { catSequence: (Partial<ExecResult> | undefined)[] }): {
  execFn: ExecFn
  calls: string[][]
} {
  const calls: string[][] = []
  let catCallIndex = 0
  const execFn: ExecFn = async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv)
    if (argv.includes("cat") && argv[argv.length - 1] === "/app/DONE-CHECK.txt") {
      const cfg = opts.catSequence[catCallIndex] ?? opts.catSequence[opts.catSequence.length - 1]
      catCallIndex++
      return { rc: 0, stdout: "", stderr: "", timedOut: false, ...cfg }
    }
    if (argv[argv.length - 2] === "ls" && argv[argv.length - 1] === "/app") {
      return { rc: 0, stdout: "main.py\ntest_main.py\n", stderr: "", timedOut: false }
    }
    if (argv.includes("fake-agent")) {
      const isRePass = argv.includes("--max-turns")
      return { rc: 0, stdout: isRePass ? REPASS_STDOUT : FIRST_PASS_STDOUT, stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  return { execFn, calls }
}

const COMPLIANT_DONE_CHECK = { rc: 0, stdout: "I ran bun test x.test.ts and it passed cleanly" }
const NONCOMPLIANT_DONE_CHECK = { rc: 0, stdout: "Everything looks correct to me" }
const MISSING_DONE_CHECK = { rc: 1, stdout: "" }

async function callRunOneP2Attempt(
  arm: "a1" | "a3" | "a4",
  execArgs: { catSequence: (Partial<ExecResult> | undefined)[] },
  runReview: RunA4ReviewFn,
  reward = 1,
): Promise<{ result: P2AttemptResult; calls: string[][] }> {
  const { paths } = setup(["t1"])
  mockVerifierAndStaging(reward)
  try {
    const { execFn, calls } = makeFakeExecFn(execArgs)
    const driver = makeFakeDriver()
    const result = await runOneP2Attempt(
      paths,
      "t1",
      arm,
      "anthropic/claude-haiku-4-5",
      "stock harness",
      60,
      60,
      driver,
      execFn,
      async () => {},
      {},
      runReview,
    )
    return { result, calls }
  } finally {
    restoreVerifier()
    restoreStaging()
  }
}

test("runOneP2Attempt: a1 issues NO settings-cp and NO re-pass; runReview never called", async () => {
  let reviewCalls = 0
  const fakeReview: RunA4ReviewFn = async () => {
    reviewCalls++
    return undefined
  }
  const { calls } = await callRunOneP2Attempt("a1", { catSequence: [COMPLIANT_DONE_CHECK] }, fakeReview)
  expect(calls.some((c) => c.join(" ").includes("/app/.claude/settings.json"))).toBe(false)
  expect(calls.filter((c) => c.includes("fake-agent")).length).toBe(1) // exactly one agent exec, no re-pass
  expect(reviewCalls).toBe(0)
})

test("runOneP2Attempt: a3 issues the settings cp for its container, a1 does not", async () => {
  let reviewCalls = 0
  const fakeReview: RunA4ReviewFn = async () => {
    reviewCalls++
    return undefined
  }
  const { calls } = await callRunOneP2Attempt("a3", { catSequence: [COMPLIANT_DONE_CHECK] }, fakeReview)
  const settingsCp = calls.find(
    (c) => c[0] === "podman" && c[1] === "cp" && c[c.length - 1]?.endsWith(":/app/.claude/settings.json"),
  )
  expect(settingsCp).toBeDefined()
  expect(settingsCp?.some((a) => a.includes("stop-gate-settings.json"))).toBe(true)
  expect(reviewCalls).toBe(0) // a3 never spends a review call
})

test("runOneP2Attempt: a4 with complied:true fires NO re-pass", async () => {
  const review: A4ReviewResult = { complied: true, requiredEdits: [] }
  let reviewCalls = 0
  const fakeReview: RunA4ReviewFn = async () => {
    reviewCalls++
    return review
  }
  const { result, calls } = await callRunOneP2Attempt("a4", { catSequence: [COMPLIANT_DONE_CHECK] }, fakeReview)
  expect(reviewCalls).toBe(1)
  expect(result.reprompted).toBe(false)
  expect(result.reviewFailed).toBe(false)
  expect(calls.filter((c) => c.includes("fake-agent")).length).toBe(1) // no re-pass exec
  expect(result.compliant).toBe(true)
})

test("runOneP2Attempt: a4 with complied:false fires exactly ONE re-pass carrying the reinject instruction + --max-turns 10, and re-evaluates compliance post-re-pass", async () => {
  const review: A4ReviewResult = { complied: false, requiredEdits: ["run the actual test suite"] }
  let reviewCalls = 0
  const fakeReview: RunA4ReviewFn = async () => {
    reviewCalls++
    return review
  }
  const { result, calls } = await callRunOneP2Attempt(
    "a4",
    { catSequence: [NONCOMPLIANT_DONE_CHECK, COMPLIANT_DONE_CHECK] },
    fakeReview,
  )
  expect(reviewCalls).toBe(1)
  expect(result.reprompted).toBe(true)
  expect(result.reviewFailed).toBe(false)

  const agentExecs = calls.filter((c) => c.includes("fake-agent"))
  expect(agentExecs.length).toBe(2) // first pass + exactly one re-pass
  const rePassCall = agentExecs.find((c) => c.includes("--max-turns"))
  expect(rePassCall).toBeDefined()
  const idx = rePassCall!.indexOf("--max-turns")
  expect(rePassCall![idx + 1]).toBe("10")
  const joined = rePassCall!.join("")
  expect(joined).toContain("run the actual test suite") // buildReinjectInstruction's demand list
  expect(joined).toContain(P2_RULE_TEXT) // buildReinjectInstruction re-states the frozen rule
  expect(joined.toLowerCase()).toContain("10 turns") // belt: cap ALSO stated in instruction text

  // post-re-pass compliance uses the SECOND (post-re-pass) DONE-CHECK read
  expect(result.compliant).toBe(true)
})

test("runOneP2Attempt: a4 review failure (undefined) fires NO re-pass, records reviewFailed", async () => {
  const fakeReview: RunA4ReviewFn = async () => undefined
  const { result, calls } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reviewFailed).toBe(true)
  expect(result.reprompted).toBe(false)
  expect(calls.filter((c) => c.includes("fake-agent")).length).toBe(1) // no re-pass
  expect(result.compliant).toBe(false) // evidence1 was non-compliant, no re-pass to fix it
})

// ── compliance bit from fake DONE-CHECK + events ───────────────────────────

test("runOneP2Attempt: compliance bit true — DONE-CHECK shares an 8+ char substring with an eligible bash command", async () => {
  const { result } = await callRunOneP2Attempt("a1", { catSequence: [COMPLIANT_DONE_CHECK] }, async () => undefined)
  expect(result.compliant).toBe(true)
})

test("runOneP2Attempt: compliance bit false — DONE-CHECK shares nothing with any bash command", async () => {
  const { result } = await callRunOneP2Attempt("a1", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, async () => undefined)
  expect(result.compliant).toBe(false)
})

test("runOneP2Attempt: compliance bit false — DONE-CHECK.txt absent entirely", async () => {
  const { result } = await callRunOneP2Attempt("a1", { catSequence: [MISSING_DONE_CHECK] }, async () => undefined)
  expect(result.compliant).toBe(false)
})
