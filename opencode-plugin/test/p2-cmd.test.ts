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
  judgeEvidencePath,
  buildA1HarnessMd,
  type CmdP2Args,
  type P2AttemptResult,
  type RunOneP2AttemptFn,
  type RunA4ReviewFn,
} from "../src/bench/p2/cmd-p2.ts"
import { P2_RULE_TEXT, ruleSha, DONE_CHECK_PATH } from "../src/bench/p2/rule.ts"
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
    reviewTruncated: false,
    judgeComplied: null,
    rulePreReview: null,
    judgeEvidence: undefined,
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

test("cmdP2: writes results with label 'p2-<arm>' and per-attempt annotation carrying arm/ruleSha/compliant/reprompted/reviewFailed/reviewTruncated", async () => {
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
  expect(annotation.reviewTruncated).toBe(false)
})

test("cmdP2: per-attempt annotation carries reviewTruncated: true when the fake runOneAttempt reports it (surface-truncation v0.5.0)", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () => okResult({ compliant: false, reprompted: false, reviewFailed: true, reviewTruncated: true }),
  })
  const written = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  const annotation = JSON.parse(written.tasks.t1.errors[0])
  expect(annotation.reviewFailed).toBe(true)
  expect(annotation.reviewTruncated).toBe(true)
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

const EVIDENCE = { doneCheck: "I ran the suite", bashCommands: ["bun test x.test.ts"], workspaceFiles: ["main.py"] }

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

test("runOneP2Attempt: a4 review failure (undefined) fires NO re-pass, records reviewFailed but NOT reviewTruncated", async () => {
  const fakeReview: RunA4ReviewFn = async () => undefined
  const { result, calls } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reviewFailed).toBe(true)
  expect(result.reviewTruncated).toBe(false)
  expect(result.reprompted).toBe(false)
  expect(calls.filter((c) => c.includes("fake-agent")).length).toBe(1) // no re-pass
  expect(result.compliant).toBe(false) // evidence1 was non-compliant, no re-pass to fix it
})

test("runOneP2Attempt: a4 review TRUNCATED ({truncated: true}) fires NO re-pass, records BOTH reviewFailed and reviewTruncated — distinguishable from a plain junk-output failure (surface-truncation v0.5.0)", async () => {
  const fakeReview: RunA4ReviewFn = async () => ({ truncated: true })
  const { result, calls } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reviewFailed).toBe(true)
  expect(result.reviewTruncated).toBe(true)
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

// ── A3 carrier-content drift guard (task-6-brief.md deferred item 1;
// progress.md Task 4 minor deferred, DEADLINE before Task 6 sized-go) ──────
//
// P2's premise is "same rule content, three carriers" (rule.ts header):
// A1 embeds P2_RULE_TEXT verbatim in the harness markdown, A4 re-states it
// via buildReinjectInstruction (already asserted above, `joined).toContain
// (P2_RULE_TEXT)`), but A3 speaks through a SEPARATE, hand-authored asset
// (assets/stop-gate-settings.json's shell-embedded hook message) that has
// no structural tie back to rule.ts — nothing previously caught the asset
// drifting out of sync with the frozen rule text. This test reads the
// asset directly (not through cmd-p2.ts) and pins its hook message to the
// two load-bearing fragments so an edit to either file that breaks parity
// fails CI, without demanding byte-identical prose (the asset is allowed
// to phrase the rule differently — Task 4's review judged the paraphrase
// sound — only the DONE-CHECK path and the "does not count as
// verification" clause are pinned, per the brief's literal minimum).

test("A3 carrier: stop-gate-settings.json's hook message pins the frozen rule's load-bearing fragments", () => {
  const raw = fs.readFileSync(
    path.join(import.meta.dirname, "../src/bench/p2/assets/stop-gate-settings.json"),
    "utf-8",
  )
  const settings = JSON.parse(raw)
  const hookMessage: string = settings.hooks.Stop[0].hooks[0].command
  expect(hookMessage).toContain(DONE_CHECK_PATH)
  expect(hookMessage).toContain("does not count as verification")
  // C1 (final whole-branch review, confidence 95): CC Stop-hook semantics
  // block ONLY on exit 2 (stderr fed back to the agent as continuation
  // instructions); exit 1 is non-blocking (agent stops, stderr goes to the
  // user only) — see cc-gate-plugin/src/output.ts's exit2-stderr mode
  // (exitCode: 2) and hook-cli.ts:10-11 for the in-repo precedent. Pin the
  // exit code so a regression to exit 1 (a silent no-op for the A3 arm)
  // fails CI.
  expect(hookMessage).toContain("exit 2")
  expect(hookMessage).not.toContain("exit 1")
})

// ── judge-vs-rule logging (pre-data amendment 2026-08-08) ──────────────────
// The a4 judge's `complied` verdict gates the bounded re-pass; the metric
// p2-tally scores is `isCompliant` (rule.ts:117), never the judge. These
// tests pin the per-attempt record needed to audit the judge afterwards,
// obtainable ONLY during the run: no baseline exists (docs/loop-probes/p2
// holds no results json; `complied` appears in no committed record).
//
// What the pre-existing fields already reveal, and what they do not:
//   reprompted=false, reviewFailed=false  => judge said complied, and
//     `compliant` IS the pre-review rule verdict. So judge=T/rule=F (the
//     missed re-pass) was ALREADY inferable — these fields make it
//     explicit rather than reconstructed, nothing more.
//   reprompted=true                       => judge said not-complied, and
//     `compliant` is the POST-re-pass verdict; the pre-review value was
//     overwritten. A DESERVED re-pass and a SPURIOUS one (judge flagged
//     work the rule accepted, burning up to A4_TURN_CAP turns) were
//     indistinguishable. `rulePreReview` is what separates them.
//
// Neither signal is ground truth. `isCompliant` is a mechanical proxy
// (>=8-char substring overlap) with failure modes in both directions — it
// was already fooled once, hence the 2026-08-06 anti-gaming amendment. So
// judge-vs-rule measures AGREEMENT BETWEEN TWO FALLIBLE PROXIES, not
// judge accuracy. Establishing accuracy requires re-judging the retained
// evidence with a stronger tier across the FULL set, then human
// adjudication where the tiers disagree — which is what the sidecar
// (`judgeEvidencePath`) exists to make possible at all.

test("runOneP2Attempt: a4 records the judge verdict and the pre-review rule verdict separately (missed-re-pass cell: judge says complied, rule says not)", async () => {
  const fakeReview: RunA4ReviewFn = async () => ({ complied: true, requiredEdits: [] })
  const { result } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reprompted).toBe(false)
  expect(result.judgeComplied).toBe(true)
  expect(result.rulePreReview).toBe(false)
  // This cell was already inferable (reprompted=false + reviewFailed=false
  // implies judge=complied, and `compliant` is then the rule verdict). The
  // fields make it explicit; the cell they genuinely rescue is the
  // re-pass branch below.
  expect(result.compliant).toBe(false)
})

test("runOneP2Attempt: a4 re-pass branch still records the PRE-review rule verdict, not the post-re-pass one", async () => {
  const fakeReview: RunA4ReviewFn = async () => ({ complied: false, requiredEdits: ["run the suite"] })
  const { result } = await callRunOneP2Attempt(
    "a4",
    { catSequence: [NONCOMPLIANT_DONE_CHECK, COMPLIANT_DONE_CHECK] },
    fakeReview,
  )
  expect(result.reprompted).toBe(true)
  expect(result.judgeComplied).toBe(false)
  // evidence1 was non-compliant; the re-pass fixed it. Without this field the
  // pre-review verdict is discarded in exactly the branch that matters.
  expect(result.rulePreReview).toBe(false)
  expect(result.compliant).toBe(true)
})

test("runOneP2Attempt: a4 agreement cell — judge and rule both say compliant", async () => {
  const fakeReview: RunA4ReviewFn = async () => ({ complied: true, requiredEdits: [] })
  const { result } = await callRunOneP2Attempt("a4", { catSequence: [COMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.judgeComplied).toBe(true)
  expect(result.rulePreReview).toBe(true)
})

test("runOneP2Attempt: a4 review failure records judgeComplied null but still records the rule verdict", async () => {
  const fakeReview: RunA4ReviewFn = async () => undefined
  const { result } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reviewFailed).toBe(true)
  expect(result.judgeComplied).toBe(null)
  expect(result.rulePreReview).toBe(false)
})

test("runOneP2Attempt: a1 and a3 record both judge fields as null (no judge runs)", async () => {
  const never: RunA4ReviewFn = async () => {
    throw new Error("runReview must not be called for a1/a3")
  }
  for (const arm of ["a1", "a3"] as const) {
    const { result } = await callRunOneP2Attempt(arm, { catSequence: [COMPLIANT_DONE_CHECK] }, never)
    expect(result.judgeComplied).toBe(null)
    expect(result.rulePreReview).toBe(null)
  }
})

test("runOneP2Attempt: a4 returns the exact evidence the judge saw, so a stronger judge can be replayed offline with zero containers", async () => {
  let seen: unknown
  const fakeReview: RunA4ReviewFn = async (evidence) => {
    seen = evidence
    return { complied: true, requiredEdits: [] }
  }
  const { result } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.judgeEvidence).toEqual(seen as never)
  expect(result.judgeEvidence?.doneCheck).toBe(NONCOMPLIANT_DONE_CHECK.stdout)
  expect(result.judgeEvidence?.bashCommands).toEqual(["bun test x.test.ts"])
})

test("cmdP2: the per-attempt annotation carries the judge verdict and the pre-review rule verdict", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () =>
      okResult({ compliant: false, judgeComplied: true, rulePreReview: false, judgeEvidence: EVIDENCE }),
  })
  const written = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  const annotation = JSON.parse(written.tasks.t1.errors[0])
  expect(annotation.judgeComplied).toBe(true)
  expect(annotation.rulePreReview).toBe(false)
  // the evidence itself never bloats errors[] — the sidecar carries it
  expect(annotation.judgeEvidence).toBeUndefined()
})

test("judgeEvidencePath: derives an ndjson sidecar beside the arm's results file", () => {
  expect(judgeEvidencePath("/x/docs/loop-probes/p2/h-p2-a4-results.json")).toBe(
    "/x/docs/loop-probes/p2/h-p2-a4-judge-evidence.ndjson",
  )
})

test("cmdP2: a4 appends one sidecar line per attempt carrying the evidence the judge saw plus both verdicts", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const sidecar = judgeEvidencePath(resultsFile)
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 2, go: 4, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () =>
      okResult({ compliant: false, judgeComplied: true, rulePreReview: false, judgeEvidence: EVIDENCE }),
  })
  const lines = fs.readFileSync(sidecar, "utf-8").trim().split("\n")
  expect(lines.length).toBe(2)
  const row = JSON.parse(lines[0]!)
  expect(row.task).toBe("t1")
  expect(row.arm).toBe("a4")
  expect(row.judgeComplied).toBe(true)
  expect(row.rulePreReview).toBe(false)
  expect(row.evidence).toEqual(EVIDENCE)
  expect(row.ruleSha).toBe(ruleSha())
})

test("cmdP2: a1 writes NO sidecar (no judge ran)", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const sidecar = judgeEvidencePath(resultsFile)
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
  const args: CmdP2Args = { arm: "a1", tasks: ["t1"], k: 1, go: 1, resultsFile }
  await cmdP2(paths, args, { runOneAttempt: async () => okResult() })
  expect(fs.existsSync(sidecar)).toBe(false)
})

test("runOneP2Attempt: a4 truncated review records judgeComplied null — a cut-off reply carries no usable verdict", async () => {
  // Merge-resolution decision (2026-08-09): the truncation arm and the
  // judge-audit fields landed from two branches and had to be reconciled.
  // A4ReviewTruncated has no `complied` at all, so recording a verdict here
  // would mean inventing one — a fabricated row in the judge-vs-rule table,
  // and precisely the "instrumentation failure folded into a real one"
  // confusion that reviewTruncated exists to prevent. Truncation records
  // null, exactly like the undefined failure.
  const fakeReview: RunA4ReviewFn = async () => ({ truncated: true }) as never
  const { result, calls } = await callRunOneP2Attempt("a4", { catSequence: [NONCOMPLIANT_DONE_CHECK] }, fakeReview)
  expect(result.reviewTruncated).toBe(true)
  expect(result.reviewFailed).toBe(true)
  expect(result.judgeComplied).toBe(null)
  // the rule verdict is still recorded — it never depended on the judge
  expect(result.rulePreReview).toBe(false)
  expect(result.reprompted).toBe(false)
  expect(calls.filter((c) => c.includes("fake-agent")).length).toBe(1) // no re-pass
})

// ── sidecar lifecycle fixes (data-integrity defects) ───────────────────────
//
// The results file is fully OVERWRITTEN every run (writeJsonAtomic's
// temp+rename, no --resume flag exists), so a re-invocation against the
// same --results-file after a crash yields a clean, correct file. Before
// this fix the sidecar did NOT get that treatment — it was opened with
// `appendFileSync` and never truncated, so stale rows from an aborted
// invocation would silently interleave with a restarted run's rows. This
// matters concretely for P2: READINESS.md documents a FIXED per-host/
// per-arm results-file name and estimates the a4 arm at up to ~7.8h serial
// wall-clock, so an operator restarting a killed run against the same
// filename is the expected case, not an exotic one.

test("cmdP2: a second invocation against the same --results-file leaves the sidecar containing ONLY the second run's rows (no stale interleave from an aborted first run)", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const sidecar = judgeEvidencePath(resultsFile)
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)

  // First "run" (simulating a since-aborted invocation): 2 attempts worth
  // of rows land on disk.
  const firstArgs: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 2, go: 4, resultsFile }
  await cmdP2(paths, firstArgs, {
    runOneAttempt: async () =>
      okResult({ compliant: false, judgeComplied: true, rulePreReview: false, judgeEvidence: EVIDENCE }),
  })
  expect(fs.readFileSync(sidecar, "utf-8").trim().split("\n").length).toBe(2)

  // Second invocation against the SAME --results-file (the restart case) —
  // only 1 attempt this time.
  const secondArgs: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile }
  await cmdP2(paths, secondArgs, {
    runOneAttempt: async () =>
      okResult({ compliant: true, judgeComplied: false, rulePreReview: true, judgeEvidence: EVIDENCE }),
  })
  const lines = fs.readFileSync(sidecar, "utf-8").trim().split("\n")
  expect(lines.length).toBe(1) // NOT 3 — the stale first-run row must be gone
  const row = JSON.parse(lines[0]!)
  expect(row.judgeComplied).toBe(false) // the second run's row, not the first's
  expect(row.rulePreReview).toBe(true)
})

test("cmdP2: an a1/a3 run (no evidence produced) leaves no stray sidecar file on disk, even though the arm never writes one", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const sidecar = judgeEvidencePath(resultsFile)
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
  const args: CmdP2Args = { arm: "a3", tasks: ["t1"], k: 1, go: 1, resultsFile }
  await cmdP2(paths, args, { runOneAttempt: async () => okResult() })
  // A blind truncate-at-start (unconditional on arm) would have created an
  // empty sidecar file here that never existed before this fix — a1/a3
  // never produce judge evidence, so no sidecar should exist at all.
  expect(fs.existsSync(sidecar)).toBe(false)
})

test("cmdP2: a truncated review's sidecar row carries reviewTruncated: true, so an offline consumer treating the sidecar as self-contained can still distinguish it from a plain judge failure", async () => {
  const { paths, resultsFile } = setup(["t1"])
  const sidecar = judgeEvidencePath(resultsFile)
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile }
  await cmdP2(paths, args, {
    runOneAttempt: async () =>
      okResult({
        compliant: false,
        reviewFailed: true,
        reviewTruncated: true,
        judgeComplied: null,
        rulePreReview: false,
        judgeEvidence: EVIDENCE,
      }),
  })
  const lines = fs.readFileSync(sidecar, "utf-8").trim().split("\n")
  expect(lines.length).toBe(1)
  const row = JSON.parse(lines[0]!)
  expect(row.reviewFailed).toBe(true)
  expect(row.reviewTruncated).toBe(true)
})

test("cmdP2: a non-conforming --results-file name (doesn't end in -results.json) fails loudly instead of silently writing evidence into the results file", async () => {
  const { paths } = setup(["t1"])
  const badResultsFile = path.join(paths.metaRoot, "docs", "loop-probes", "p2", "test.json")
  let called = false
  const args: CmdP2Args = { arm: "a4", tasks: ["t1"], k: 1, go: 2, resultsFile: badResultsFile }
  await expect(
    cmdP2(paths, args, {
      runOneAttempt: async () => {
        called = true
        return okResult({ judgeEvidence: EVIDENCE })
      },
    }),
  ).rejects.toThrow(BenchError)
  expect(called).toBe(false) // fenced BEFORE any container work, like the other cmdP2 fences
  // the results file itself must not have absorbed evidence rows
  expect(fs.existsSync(badResultsFile)).toBe(false)
})

test("judgeEvidencePath: a non-conforming path throws instead of silently returning the results-file path unchanged", () => {
  expect(() => judgeEvidencePath("/x/docs/loop-probes/p2/test.json")).toThrow(BenchError)
})

// ---- Container auth wiring (2026-08-09). The first live P2 launch burned
// a1 entirely as `agent_no_output`: runOneP2Attempt created containers with
// `mounts: []` + `apiKeyEnv()` only, dropping everything the driver's
// prepareAuth() provides (oauth credential mounts, onboarding claude.json,
// and IS_SANDBOX=1 — without which the CC CLI refuses
// --dangerously-skip-permissions as root, exiting rc=1 with an EMPTY stdout
// that classifyAttempt reads as "done"). These tests pin the cmd-run.ts
// lifecycle mirror: prepareAuth before create, mounts+env on the create
// argv, cleanup in the teardown path, prepareAuth failure = setup_failed
// before any container work.

function makeAuthProbeDriver(): { driver: AgentDriver; cleanups: number[] } {
  const cleanups: number[] = []
  const base = makeFakeDriver()
  const driver: AgentDriver = {
    ...base,
    prepareAuth: () => ({
      mounts: [{ host: "/host/auth-dir", container: "/root/.claude", ro: false }],
      env: { IS_SANDBOX: "1" },
      cleanup: () => {
        cleanups.push(1)
      },
    }),
  }
  return { driver, cleanups }
}

async function callWithDriver(
  driver: AgentDriver,
): Promise<{ result: P2AttemptResult; calls: string[][] }> {
  const { paths } = setup(["t1"])
  mockVerifierAndStaging(1)
  try {
    const { execFn, calls } = makeFakeExecFn({ catSequence: [COMPLIANT_DONE_CHECK] })
    const result = await runOneP2Attempt(
      paths,
      "t1",
      "a1",
      "anthropic/claude-haiku-4-5",
      "stock harness",
      60,
      60,
      driver,
      execFn,
      async () => {},
      {},
      async () => undefined,
    )
    return { result, calls }
  } finally {
    restoreVerifier()
    restoreStaging()
  }
}

test("runOneP2Attempt: create argv carries the driver's auth mounts AND auth env; cleanup runs after teardown", async () => {
  const { driver, cleanups } = makeAuthProbeDriver()
  const { result, calls } = await callWithDriver(driver)
  expect(result.error).toBe("")
  const create = calls.find((c) => c[1] === "create")
  expect(create).toBeDefined()
  const joined = create!.join(" ")
  expect(joined).toContain("-v /host/auth-dir:/root/.claude")
  expect(joined).toContain("-e IS_SANDBOX=1")
  expect(cleanups.length).toBe(1)
})

test("runOneP2Attempt: prepareAuth throwing → setup_failed before any container create", async () => {
  const base = makeFakeDriver()
  const throwing: AgentDriver = {
    ...base,
    prepareAuth: () => {
      throw new BenchError("keychain export failed")
    },
  }
  const { result, calls } = await callWithDriver(throwing)
  expect(result.error).toBe("setup_failed")
  expect(calls.find((c) => c[1] === "create")).toBeUndefined()
})

test("runOneP2Attempt: auth cleanup runs even when bring-up fails after prepareAuth", async () => {
  const { driver, cleanups } = makeAuthProbeDriver()
  const { paths } = setup(["t1"])
  mockVerifierAndStaging(1)
  try {
    const failingExec: ExecFn = async (argv: string[]): Promise<ExecResult> => {
      if (argv[1] === "create") return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    const result = await runOneP2Attempt(
      paths,
      "t1",
      "a1",
      "anthropic/claude-haiku-4-5",
      "stock harness",
      60,
      60,
      driver,
      failingExec,
      async () => {},
      {},
      async () => undefined,
    )
    expect(result.error).toBe("setup_failed")
    expect(cleanups.length).toBe(1)
  } finally {
    restoreVerifier()
    restoreStaging()
  }
})
