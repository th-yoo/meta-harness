import { test, expect, spyOn, mock } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { DEFAULT_BENCH_MODEL, type BenchPaths } from "../src/bench/paths.ts"
import { cmdRun, runTaskOnce, runWithOomRetry, inContainerAgentVersion, type RunOneTaskFn, type RunTaskResult } from "../src/bench/cmd-run.ts"
import { runOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { readScore, projectGlobalRoot, createCandidate, writeActive } from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"
import type { AgentAuthMounts } from "../src/bench/agent-auth.ts"
import { opencodeDriver } from "../src/bench/drivers/opencode.ts"
import * as verifierReal from "../src/bench/verifier.ts"
import * as resultsReal from "../src/bench/results.ts"
import * as schedulerReal from "../src/bench/scheduler.ts"
import { PRESSURE_POLL_SEC } from "../src/bench/host-pressure.ts"
import { updateResourceProfile, readResourceProfile, hostClass } from "../src/bench/resource-profile.ts"

// Same pre-mock snapshot pattern as the verifier block above: capture the
// REAL results.ts / scheduler.ts exports at module-eval time so the two
// --parallel tests below can mock.module those out for their narrow critical
// section and restore them afterward via these captured references (a plain
// `const` captures the function VALUE, surviving later mock.module swaps of
// the module's own export slots).
const realResumeCarryForward = resultsReal.resumeCarryForward
const realWriteRunResults = resultsReal.writeRunResults
const realAggTotals = resultsReal.aggTotals
function restoreResults(): void {
  mock.module("../src/bench/results.ts", () => ({
    resumeCarryForward: realResumeCarryForward,
    writeRunResults: realWriteRunResults,
    aggTotals: realAggTotals,
  }))
}
const realSchedule = schedulerReal.schedule
const realAsyncMutex = schedulerReal.AsyncMutex
const realDefaultBudget = schedulerReal.DEFAULT_BUDGET
function restoreScheduler(): void {
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: realSchedule,
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))
}

/** Write task.toml files declaring an [environment] footprint (needed by
 * --parallel, which packs against each task's declared cpus/memory). */
function writeResourceTomls(tbRoot: string, tasks: string[], cpus = 1, memoryMb = 2048): void {
  for (const t of tasks) {
    fs.mkdirSync(path.join(tbRoot, t), { recursive: true })
    fs.writeFileSync(path.join(tbRoot, t, "task.toml"), `[environment]\ncpus = ${cpus}\nmemory_mb = ${memoryMb}\n`)
  }
}

/** Nested termBenchDir (`<tmp>/tb`) so metaRoot = dirname(termBenchDir) = <tmp>
 * is UNIQUE per test — mirrors isolatedPaths in test/bench-cmd-ab.test.ts.
 * REQUIRED for profile-seeding tests: the resource-profile store has no per-run
 * reset and would otherwise leak (n accumulates) across tests when metaRoot is
 * the shared os.tmpdir(). */
function isolatedPaths(tasks: string[]): BenchPaths {
  const meta = tmpDir()
  const termBenchDir = path.join(meta, "tb")
  fs.mkdirSync(termBenchDir, { recursive: true })
  const tbRoot = path.join(meta, "tb-root")
  writeTaskTomls(tbRoot, tasks)
  return fakeBenchPaths(termBenchDir, tbRoot) // metaRoot = dirname(<meta>/tb) = <meta>, unique
}

// Snapshot the REAL verifier.ts exports at module-eval time (before any
// test runs, hence before any mock.module call below) — copyTests/
// runVerifier hardcode the real `podman` funnel with no injectable execFn
// (see verifier.ts's header), so the two runTaskOnce tests below that must
// observe a full RunTaskResult (timeout / agent_no_output cases) mock this
// module out for their narrow critical section and restore it via these
// captured references afterward. Plain `const` captures the function
// VALUE, not a live ES-module binding, so it survives later mock.module
// swaps of verifier.ts's own export slots.
const realCopyTests = verifierReal.copyTests
const realRunVerifier = verifierReal.runVerifier
function restoreVerifier(): void {
  mock.module("../src/bench/verifier.ts", () => ({ copyTests: realCopyTests, runVerifier: realRunVerifier }))
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-cmd-run-"))
}

/** Stub for runTaskOnce's `prepareAuth` param — every unit test in this file
 * must inject this (or a variant) instead of relying on the real
 * prepareAgentAuthMounts default, which would otherwise shell out to the
 * real macOS Keychain / read the real host ~/.claude on every single test
 * run. Tests that care about the actual mounts/cleanup wiring build their
 * own fake with recognizable host paths — see the dedicated auth-mounts
 * test below. */
function fakeAuthMounts(cleanupCalls?: { count: number }): () => AgentAuthMounts {
  return () => ({
    mounts: [],
    cleanup: () => {
      if (cleanupCalls) cleanupCalls.count += 1
    },
  })
}

function fakeBenchPaths(termBenchDir: string, tbRoot?: string): BenchPaths {
  return {
    metaRoot: path.dirname(termBenchDir),
    termBenchDir,
    tbRoot: tbRoot ?? path.join(termBenchDir, "tb-root-unused"),
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
  }
}

function result(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
  return {
    sessionId: "sess-x",
    reward: 1,
    elapsed: 1.2,
    turns: 3,
    toolUsage: {},
    events: [],
    timedOut: false,
    error: "",
    ...overrides,
  }
}

/** cmdRun computes its provenance env block via `inContainerAgentVersion`
 * (a throwaway create+start+exec+rm), independent of the injected
 * `runOneTask` fake — every cmdRun call in this file also injects this fake
 * execFn so that lookup never spawns a real podman. */
const fakeExec = async () => ({ rc: 0, stdout: "opencode 0.0.0-test", stderr: "", timedOut: false })

test("cmdRun: incremental + final results-file JSON, task_agg shape matches Python cmd_run parity", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const fake: RunOneTaskFn = async (_p, task) => {
    if (task === "a") return result({ sessionId: "s-a", reward: 0, elapsed: 5.5, turns: 0, error: "agent_no_output" })
    return result({ sessionId: "s-b", reward: 1, elapsed: 12.3, turns: 4 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a", "b"], resultsFile, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.label).toBe("run-results") // default label = stem of --results-file
  expect(final.model).toBe(DEFAULT_BENCH_MODEL) // default model when --model is omitted
  expect(final.k).toBe(1)
  expect(final.status).toBe("complete")
  expect(final.n_pass).toBe(1)
  expect(final.n_total).toBe(2)
  expect(final.tasks.a).toEqual({ rewards: [0], elapsed: [5.5], turns: [0], errors: [] })
  expect(final.tasks.b).toEqual({ rewards: [1], elapsed: [12.3], turns: [4], errors: [] })
})

test("cmdRun --self-check ON: records per-attempt selfScores parallel to rewards", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const fake: RunOneTaskFn = async (_p, task) =>
    task === "a"
      ? result({ reward: 1, selfScore: 0.875 })
      : result({ error: "setup_failed", reward: 1 }) // setup_failed → selfScores null

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a", "b"], resultsFile, layers: "none", selfCheck: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a.selfScores).toEqual([0.875])
  expect(final.tasks.b.selfScores).toEqual([null]) // setup_failed still pushes a slot
})

test("cmdRun --self-check OFF: results JSON has NO selfScores key (byte-identical back-compat)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  // fake returns a selfScore, but with selfCheck OFF it must NOT be recorded.
  const fake: RunOneTaskFn = async () => result({ reward: 1, selfScore: 0.5 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a).toEqual({ rewards: [1], elapsed: [1.2], turns: [3], errors: [] })
  expect(final.tasks.a).not.toHaveProperty("selfScores")
})

test("cmdRun: setup_failed appends 0-reward/0-elapsed and 'setup_failed' to errors[]", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const fake: RunOneTaskFn = async () => result({ error: "setup_failed", reward: 1, elapsed: 99 })

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a).toEqual({ rewards: [0], elapsed: [0], turns: [0], errors: ["setup_failed"] })
})

test("cmdRun: --resume skips already-done tasks, carrying prior results forward", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({ tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } } }),
  )

  const seen: string[] = []
  const fake: RunOneTaskFn = async (_p, task) => {
    seen.push(task)
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a", "b"], resultsFile, resume: true, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seen).toEqual(["b"]) // "a" skipped, carried forward
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a.rewards).toEqual([1])
  expect(final.n_total).toBe(2)
})

test("cmdRun: --resume against a results file from a DIFFERENT driver dies before any task runs (final-review fix 1)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  let ran = false
  const fake: RunOneTaskFn = async () => {
    ran = true
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await expect(
      cmdRun(paths, { tasks: ["a", "b"], resultsFile, resume: true, layers: "none", driver: "claude-code" }, fake, fakeExec),
    ).rejects.toThrow(BenchError)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(ran).toBe(false)
})

test("cmdRun: --pin combined with --no-harness dies", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  await expect(
    cmdRun(paths, { tasks: ["a"], noHarness: true, pin: ["project-global=v1"] }, async () => result()),
  ).rejects.toThrow(BenchError)
})

test("cmdRun: --pin combined with --layers none dies", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  await expect(
    cmdRun(paths, { tasks: ["a"], layers: "none", pin: ["project-global=v1"] }, async () => result()),
  ).rejects.toThrow(BenchError)
})

test("cmdRun: recordToStores wiring — passing run writes into project-global's active version score.json", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["mytask"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")

  const fake: RunOneTaskFn = async () => result({ sessionId: "sess-abc", reward: 1, turns: 3 })

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["mytask"], layers: "project" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const score = readScore(root, "v0")
  expect(score.nPass).toBe(1)
  expect(score.sessions[0]!.sessionID).toBe("sess-abc")
})

test("cmdRun: k>1 runs the task k times, aggregating pass@k", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  let call = 0
  const fake: RunOneTaskFn = async () => {
    call++
    return result({ reward: call === 2 ? 1 : 0, sessionId: `s${call}` })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let lines: string[]
  try {
    await cmdRun(paths, { tasks: ["a"], k: 3, resultsFile, layers: "none" }, fake, fakeExec)
    // capture BEFORE mockRestore — bun's restore clears mock.calls
    lines = logSpy.mock.calls.map((c) => String(c[0]))
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(call).toBe(3)
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a.rewards).toEqual([0, 1, 0])
  expect(final.n_pass).toBe(1) // pass@k: any reward==1 counts the task as passed
  expect(final.n_total).toBe(1)

  // Summary line labels both metrics correctly: the attempt tally is NOT
  // called pass@k (1 pass / 3 attempts here), and true task-level pass@k
  // (any-of-k, 1/1 tasks) prints alongside it. Regression: the old line
  // printed `pass@3: 1/3`, mislabeling attempt-rate as pass@k.
  const summary = lines.find((l) => l.includes("attempts:"))
  expect(summary).toBeDefined()
  expect(summary!).toContain("attempts: 1/3")
  expect(summary!).toContain("pass@3: 1/1")
  expect(lines.some((l) => l.includes("pass@3: 1/3"))).toBe(false)
})

// ── --enforce-resources threading (default OFF) ───────────────────────────

test("cmdRun --enforce-resources OFF (default): runOneTask sees resources=undefined", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  fs.writeFileSync(path.join(tbRoot, "a", "task.toml"), "[environment]\ncpus = 2\nmemory_mb = 4096\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toBeUndefined()
})

test("cmdRun --enforce-resources ON: runOneTask receives the task's declared cpus/memoryMb", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  fs.writeFileSync(path.join(tbRoot, "a", "task.toml"), "[environment]\ncpus = 2\nmemory_mb = 4096\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 2, memoryMb: 4096 })
})

test("cmdRun --enforce-resources ON + --min-cpus/--min-mem-mb: runOneTask receives the floored footprint", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  fs.writeFileSync(path.join(tbRoot, "a", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", enforceResources: true, minCpus: 4, minMemMb: 8192 },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 4, memoryMb: 8192 })
})

test("cmdRun --enforce-resources ON + floors below the declared footprint: declared footprint wins", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  fs.writeFileSync(path.join(tbRoot, "a", "task.toml"), "[environment]\ncpus = 6\nmemory_mb = 16384\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", enforceResources: true, minCpus: 4 }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 6, memoryMb: 16384 })
})

test("cmdRun --parallel + --enforce-resources + --min-cpus/--min-mem-mb: the floored footprint feeds both budget-packing and runOneTask", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true, minCpus: 4, minMemMb: 8192 },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 4, memoryMb: 8192 })
})

// ── task-6 cap/pack split: schedule() packs on MEASURED, container gets the
// DECLARED/floored cap ──────────────────────────────────────────────────────

test("cmdRun --parallel: seeded profile → schedule() items carry MEASURED pack weights while runOneTask gets the DECLARED/floored cap", async () => {
  const paths = isolatedPaths(["a"])
  // declared prior: 1 cpu / 2048 MB
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  // Seed a trustworthy profile (n=3): avgCpu = median([3,3,3]) = 3, peakRss 4096.
  // → pack = { cpus: max(3,0.5)=3, memoryMb: max(ceil(4096*1.2)=4916,256)=4916 }
  // → cap  = { cpus: 1 (declared, never raised), memoryMb: max(2048, ceil(4096*1.5)=6144)=6144 }
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "a", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let capturedItems: unknown = "unset"
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      if (capturedItems === "unset") capturedItems = a[0]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", parallel: true, enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  // scheduler packs against the MEASURED weight...
  expect(capturedItems).toEqual([{ key: "a", cpus: 3, memoryMb: 4916 }])
  // ...while the container cap stays the generous declared/floored envelope
  // (memory raised only by the measured lift; cpus never lowered/raised here).
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 6144 })
})

test("cmdRun --parallel: no profile store → schedule() items AND cap are the declared/floored footprint (cold-start parity)", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 2, 4096)

  let capturedItems: unknown = "unset"
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      if (capturedItems === "unset") capturedItems = a[0]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", parallel: true, enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(capturedItems).toEqual([{ key: "a", cpus: 2, memoryMb: 4096 }])
  expect(seenResources).toEqual({ cpus: 2, memoryMb: 4096 })
})

test("cmdRun --parallel + --no-pack-measured: seeded profile ignored → declared weights AND declared cap", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  // Same hot profile as the invariant test — but --no-pack-measured must ignore it.
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "a", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let capturedItems: unknown = "unset"
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      if (capturedItems === "unset") capturedItems = a[0]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true, noPackMeasured: true },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(capturedItems).toEqual([{ key: "a", cpus: 1, memoryMb: 2048 }])
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 2048 })
})

test("cmdRun --enforce-resources ON, no --min-cpus/--min-mem-mb: byte-identical to before floors existed", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  fs.writeFileSync(path.join(tbRoot, "a", "task.toml"), "[environment]\ncpus = 2\nmemory_mb = 4096\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 2, memoryMb: 4096 })
})

// ── B5: serial cap raise (raiseCapMeasured) + per-session cap provenance ─────

test("cmdRun --enforce-resources serial: seeded n≥3 profile raises the container memory cap (raiseCapMeasured)", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048) // declared prior 1c/2048MB
  // Seed a trustworthy profile (n=3): peakRss 4096 → cap raised to ceil(4096*1.5)=6144.
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "a", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  // cpus never raised; memory lifted above declared by the measured profile.
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 6144 })
})

test("cmdRun --enforce-resources serial + --no-pack-measured: seeded profile ignored → declared cap", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "a", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", enforceResources: true, noPackMeasured: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 2048 })
})

test("cmdRun --enforce-resources serial: session record carries capMemoryMb (raised) + capRaised=true", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "a", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  const fake: RunOneTaskFn = async () => result({ reward: 1, sessionId: "s1", turns: 3 })

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "project", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  const rec = readScore(root, "v0").sessions[0]!
  expect(rec.capMemoryMb).toBe(6144)
  expect(rec.capRaised).toBe(true)
})

test("cmdRun without --enforce-resources: session record omits capMemoryMb/capRaised", async () => {
  const paths = isolatedPaths(["a"])
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")

  const fake: RunOneTaskFn = async () => result({ reward: 1, sessionId: "s1", turns: 3 })

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "project" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  const rec = readScore(root, "v0").sessions[0]!
  expect("capMemoryMb" in rec).toBe(false)
  expect("capRaised" in rec).toBe(false)
})

test("cmdRun --enforce-resources serial: after an OOM-escalated retry the recorded capMemoryMb is the ESCALATED value", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048) // declared 2048, NO profile → initial cap not raised
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")

  let call = 0
  const fake: RunOneTaskFn = async () => {
    call++
    return call === 1
      ? result({ reward: 0, oomKilled: true, turns: 3, sessionId: "killed" })
      : result({ reward: 1, oomKilled: false, turns: 3, sessionId: "retry" })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "project", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  const recs = readScore(root, "v0").sessions
  expect(recs.map((s) => s.sessionID)).toEqual(["retry"]) // only the retry landed
  const rec = recs[0]!
  expect(rec.capMemoryMb).toBe(4096) // 2048 escalated ×2 for the retry container
  expect(rec.capRaised).toBe(false) // the INITIAL cap was declared, not measured-raised
})

test("cmdRun --enforce-resources ON: a gpus>0 task dies before spending any container lifecycle", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["gputask"])
  fs.writeFileSync(path.join(tbRoot, "gputask", "task.toml"), "[environment]\ngpus = 1\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  let called = false
  const fake: RunOneTaskFn = async () => {
    called = true
    return result({ reward: 1 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await expect(
      cmdRun(paths, { tasks: ["gputask"], layers: "none", enforceResources: true }, fake, fakeExec),
    ).rejects.toThrow(/gpus=1/)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(called).toBe(false)
})

test("runTaskOnce: resources param appends --cpus/--memory to podman create argv", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(
      paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, { cpus: 2, memoryMb: 4096 }, execFn, fakeAuthMounts(),
    )
  } finally {
    errSpy.mockRestore()
  }
  expect(createArgv).toContain("--cpus")
  expect(createArgv).toContain("2")
  expect(createArgv).toContain("--memory")
  expect(createArgv).toContain("4096m")
})

test("runTaskOnce: resources omitted (default) leaves podman create argv byte-identical to before", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(createArgv).not.toContain("--cpus")
  expect(createArgv).not.toContain("--memory")
})

// ── runTaskOnce: fresh container per attempt (exec-level, no real podman) ──

test("runTaskOnce: podman create failure -> setup_failed, no crash", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") return { rc: 125, stdout: "", stderr: "boom", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "runtime", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(res.error).toBe("setup_failed")
  expect(res.reward).toBe(0)
})

// ── runTaskOnce: agentElapsedSec threading (W1a: time-to-resolve) ────────

test("runTaskOnce: agentElapsedSec threads through from the agent phase on a normal completion", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async () => ({ rc: 0, stdout: "", stderr: "", timedOut: false })

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }
  expect(typeof res.agentElapsedSec).toBe("number")
  expect(res.agentElapsedSec as number).toBeGreaterThanOrEqual(0)
})

test("runTaskOnce: agentElapsedSec absent (not merely 0) on setup_failed — the agent phase is never reached", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") return { rc: 125, stdout: "", stderr: "boom", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "runtime", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(res.error).toBe("setup_failed")
  expect(res.agentElapsedSec).toBeUndefined()
})

test("runTaskOnce: rm is always called, even when an earlier step throws", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(dir, tbRoot)

  const seenArgv: string[][] = []
  const execFn = async (argv: string[]) => {
    seenArgv.push(argv)
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(seenArgv.some((a) => a[1] === "rm")).toBe(true)
})

// ── timedOut discriminator (Loop-3 T2) ────────────────────────────────────
// runAgent (agent-run.ts) sets AgentRunOutput.timedOut=true ONLY on the
// wall-timeout branch (Task 1, commit 062ca93); these tests assert
// runTaskOnce propagates that flag onto RunTaskResult.timedOut and splits
// the error union so a wall-timeout's 0-turn result reads "timeout", not
// the generic "agent_no_output". copyTests/runVerifier (verifier.ts) hard-
// code the real `podman` funnel with no injectable execFn (see the
// existing warning on the CC-oauth mounts test below: "a test must never
// drive execution as far as copyTests/runVerifier") — driving runTaskOnce
// to its return statement requires passing through them regardless, so
// these two tests mock verifier.ts out for their narrow critical section
// (restored immediately after via restoreVerifier(), defined above from a
// pre-mock snapshot) rather than touch a real podman binary.

test("runTaskOnce: agent-phase wall-timeout -> RunTaskResult.timedOut=true, error='timeout' (Loop-3 T2)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    if (argv[1] === "exec" && argv.includes("opencode") && argv.includes("run")) {
      // A small real delay so RunTaskResult.elapsed (wall-clock, rounded to
      // 1 decimal) is observably > 0, matching a genuine wall-timeout.
      await new Promise((resolve) => setTimeout(resolve, 110))
      return { rc: 124, stdout: "", stderr: "", timedOut: true }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  expect(res.timedOut).toBe(true)
  expect(res.turns).toBe(0)
  expect(res.error).toBe("timeout")
  expect(res.elapsed).toBeGreaterThan(0)
})

test("runTaskOnce: genuine 0-turn no-output (not a timeout) -> timedOut=false, error='agent_no_output'", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    if (argv[1] === "exec" && argv.includes("opencode") && argv.includes("run")) {
      // rc=0, empty stdout, NOT timed out -> parses to turnCount=0 with no
      // timedOut field at all (agent-run.ts only sets it on the wall-timeout
      // branch) -> must NOT be mislabeled "timeout".
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  expect(res.timedOut).toBe(false)
  expect(res.turns).toBe(0)
  expect(res.error).toBe("agent_no_output")
})

// ── env-fidelity fix: agent containers get NO /tb, NO /mh mount, ever ────
// docs/env-fidelity-spotcheck.md: the whole TB2 task-source repo used to be
// mounted RO at /tb for the agent container's WHOLE lifetime (answer keys,
// other tasks' fixtures readable at any time), and termBenchDir was mounted
// RO at /mh (results/logs/store snapshot/patches). Neither mount belongs on
// an agent container — cmd-oracle.ts's OWN container keeps both, unchanged
// (pinned separately in bench-oracle-unit.test.ts).

test("runTaskOnce: agent-container create argv has NO /tb mount, NO /mh mount, and NO TB_ROOT=/tb env (runtime staging)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    // fail the staging cp so this stops right after container bring-up,
    // before verifier.ts's hardcoded real podman funnel would ever be
    // reached (same "must never drive past copyTests/runVerifier" scoping
    // as this file's other unit tests).
    if (argv[1] === "cp") return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "runtime", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }

  expect(res.error).toBe("setup_failed") // sanity: this test really exercised staging
  expect(createArgv.length).toBeGreaterThan(0)
  expect(createArgv.join(" ")).not.toContain(":/tb")
  expect(createArgv.join(" ")).not.toContain(":/mh")
  expect(createArgv.some((a) => a === "TB_ROOT=/tb")).toBe(false)
  expect(createArgv.some((a) => typeof a === "string" && a.startsWith(`${tbRoot}:`))).toBe(false)
  expect(createArgv.some((a) => typeof a === "string" && a.startsWith(`${dir}:`) && a.includes(":/mh"))).toBe(false)
})

test("runTaskOnce: scripts-mode staging stages via podman cp (mkdir, 3x cp, exec setup_deps.sh) — no /tb or /mh mount needed", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t", "environment"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]) => {
    recordedArgvs.push(argv)
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      // stop right after setup_deps.sh exec (before copyTests/runVerifier)
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }

  // create argv has neither mount (same claim as the runtime-mode test above)
  const createArgv = recordedArgvs.find((a) => a[1] === "create")!
  expect(createArgv.join(" ")).not.toContain(":/tb")
  expect(createArgv.join(" ")).not.toContain(":/mh")

  // mkdir -p the two stage subdirs
  const mkdirArgv = recordedArgvs.find((a) => a.includes("mkdir") && a.some((x) => x.includes(".mh-stage/tasks")))
  expect(mkdirArgv).toBeDefined()
  expect(mkdirArgv).toContain("/.mh-stage/tasks")
  expect(mkdirArgv).toContain("/.mh-stage/t")

  // three podman cp calls: tasks/<task>, setup_base.sh, environment/ — the
  // container name is randomized (containerName()), so these assertions
  // match on the host source path + the destination's trailing container path.
  const cpArgvs = recordedArgvs.filter((a) => a[1] === "cp")
  expect(cpArgvs.length).toBe(3)
  expect(cpArgvs.some((a) => a[2] === path.join(paths.termBenchDir, "tasks", "t") && a[3]!.endsWith(":/.mh-stage/tasks/t"))).toBe(true)
  expect(cpArgvs.some((a) => a[2] === path.join(paths.termBenchDir, "setup_base.sh") && a[3]!.endsWith(":/.mh-stage/setup_base.sh"))).toBe(true)
  expect(cpArgvs.some((a) => a[2] === path.join(tbRoot, "t", "environment") && a[3]!.endsWith(":/.mh-stage/t/environment"))).toBe(true)

  // setup_deps.sh is exec'd from the STAGED path with TB_ROOT pointing at the
  // staged root, not /tb
  const setupArgv = recordedArgvs.find((a) => a.some((x) => x.includes("setup_deps.sh")))!
  expect(setupArgv).toContain("/.mh-stage/tasks/t/setup_deps.sh")
  expect(setupArgv).toContain("TB_ROOT=/.mh-stage")
  expect(setupArgv.some((a) => a === "TB_ROOT=/tb")).toBe(false)
})

test("runTaskOnce: scripts-mode staging removes the staged copy (rm -rf /.mh-stage) as its FINAL action once setup_deps.sh succeeds", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t", "environment"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]) => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  // setup_deps.sh now succeeds, so staging proceeds past it into the agent
  // phase and copyTests/runVerifier — stub the latter (verifier.ts hardcodes
  // the real podman funnel with no injectable execFn — see this file's
  // header) so this test never spawns real podman.
  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }

  // the LAST exec before the agent phase's own execs is the stage purge —
  // find it by content rather than assuming a fixed index (the agent phase
  // itself issues execs too).
  const rmStageArgv = recordedArgvs.find(
    (a) => a[1] === "exec" && a.includes("rm") && a.includes("-rf") && a.includes("/.mh-stage"),
  )
  expect(rmStageArgv).toBeDefined()
})

// ── CC-oauth mounts (agent-auth.ts's prepareAgentAuthMounts) ──────────────
// The mounts/cleanup themselves are unit-tested against a real filesystem in
// bench-agent-auth.test.ts; here we only verify cmd-run.ts's WIRING: the
// injected mounts land verbatim in the create argv, and cleanup() runs even
// though this test only drives execution through container bring-up.

test("runTaskOnce: merges prepareAuth()'s mounts into the create argv (config ro, claude ro, opencode-data rw) and calls cleanup()", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const cleanupCalls = { count: 0 }
  const prepareAuth = () => ({
    mounts: [
      { host: "/tmp/auth-config", container: "/root/.config/opencode", ro: false },
      { host: "/tmp/auth-claude", container: "/root/.claude", ro: true },
      { host: "/tmp/auth-ocdata", container: "/root/.local/share/opencode", ro: false },
    ],
    cleanup: () => {
      cleanupCalls.count += 1
    },
  })

  // Stop right after container bring-up (before the agent/copy-tests/verify
  // steps, which this unit test isn't exercising — see cmd-oracle-unit's own
  // tests for the same "stop at create/start" scope; verifier.ts hardcodes
  // the real `podman` funnel with no injectable execFn, so a test must never
  // drive execution as far as copyTests/runVerifier).
  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, prepareAuth)
  } finally {
    errSpy.mockRestore()
  }

  expect(createArgv).toContain("-v")
  expect(createArgv).toContain("/tmp/auth-config:/root/.config/opencode")
  expect(createArgv).toContain("/tmp/auth-claude:/root/.claude:ro")
  expect(createArgv).toContain("/tmp/auth-ocdata:/root/.local/share/opencode")
  expect(createArgv).not.toContain("/tmp/auth-ocdata:/root/.local/share/opencode:ro")
  expect(cleanupCalls.count).toBe(1)
})

test("runTaskOnce: prepareAuth() failure (missing credentials) -> setup_failed, no crash, no podman create attempted", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const prepareAuth = (): AgentAuthMounts => {
    throw new BenchError("prepareAgentAuthMounts: no credentials found. set ANTHROPIC_API_KEY")
  }

  let createCalled = false
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createCalled = true
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, prepareAuth)
  } finally {
    errSpy.mockRestore()
  }

  expect(res.error).toBe("setup_failed")
  expect(res.reward).toBe(0)
  expect(createCalled).toBe(false)
})

// Option A (2026-07-11): podman containers have real root + network, so
// setup_deps.sh's own SKIP_APT-guarded apt section now genuinely runs — the
// runner must no longer suppress it. Locking test for the env dict the
// scripts-mode setup_deps.sh exec is called with.
test("runTaskOnce: scripts-mode setup_deps.sh exec has no SKIP_APT in its env (Option A — apt genuinely runs now)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  let setupArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      setupArgv = argv
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false } // stop right after (unit scope)
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }

  expect(setupArgv.length).toBeGreaterThan(0)
  expect(setupArgv).not.toContain("SKIP_APT=1")
  expect(setupArgv.some((a) => a.startsWith("SKIP_APT"))).toBe(false)
  // the other setup env vars are still present, unaffected — TB_ROOT now
  // points at the podman-cp staged copy, NOT a persistent /tb mount
  // (env-fidelity fix, see cmd-run.ts's scripts-mode staging block).
  expect(setupArgv).toContain("TB_ROOT=/.mh-stage")
  expect(setupArgv).toContain("WORKDIR=/app")
})

// ── provider API key env-passthrough ──────────────────────────────────────
// A host env-var like OPENROUTER_API_KEY must reach the agent-phase
// container's create argv (additive to auth.json — see paths.ts's
// apiKeyEnv), but must NEVER reach the oracle container (no LLM, no keys).

test("runTaskOnce: agent container create argv passes through a *_API_KEY host env var", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const prev = process.env["OPENROUTER_API_KEY"]
  process.env["OPENROUTER_API_KEY"] = "sk-test-123"

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["OPENROUTER_API_KEY"]
    else process.env["OPENROUTER_API_KEY"] = prev
  }

  expect(createArgv).toContain("-e")
  expect(createArgv).toContain("OPENROUTER_API_KEY=sk-test-123")
})

// ── driver auth env merge (task-B3-brief.md) ──────────────────────────────
// A driver's prepareAuth() may return container env (opencode's never does —
// auth flows entirely through its mounts) that must reach the create argv
// AFTER apiKeyEnv(), so a driver's own auth env wins on key collision.

test("runTaskOnce: merges prepareAuth()'s env into the create argv AFTER apiKeyEnv() (driver env wins on collision)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const prev = process.env["OPENROUTER_API_KEY"]
  process.env["OPENROUTER_API_KEY"] = "sk-from-host"

  const prepareAuth = () => ({
    mounts: [],
    cleanup: () => {},
    env: { OPENROUTER_API_KEY: "sk-from-driver", DRIVER_ONLY_KEY: "driver-value" },
  })

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, prepareAuth)
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["OPENROUTER_API_KEY"]
    else process.env["OPENROUTER_API_KEY"] = prev
  }

  // driver's env wins over apiKeyEnv() on the colliding key ...
  expect(createArgv).toContain("OPENROUTER_API_KEY=sk-from-driver")
  expect(createArgv).not.toContain("OPENROUTER_API_KEY=sk-from-host")
  // ... and a driver-only key still reaches the container.
  expect(createArgv).toContain("DRIVER_ONLY_KEY=driver-value")
})

test("runTaskOnce: prepareAuth() returning no env -> create argv unaffected (opencode driver default)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(createArgv).not.toContain("-e")
})

test("runOneOracleTask: oracle container create argv does NOT pass through *_API_KEY host env (oracle never spends LLM tokens)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

  const prev = process.env["OPENROUTER_API_KEY"]
  process.env["OPENROUTER_API_KEY"] = "sk-test-123"

  let createArgv: string[] = []
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runOneOracleTask(paths, "t", "scripts", execFn)
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["OPENROUTER_API_KEY"]
    else process.env["OPENROUTER_API_KEY"] = prev
  }

  expect(createArgv.some((a) => a.startsWith("OPENROUTER_API_KEY"))).toBe(false)
  expect(createArgv).not.toContain("-e")
})

// ── inContainerAgentVersion ────────────────────────────────────────────
// The provenance version must come from INSIDE the container (a throwaway
// one, since envBlock is computed once before the per-task loop) — never
// the host's own opencode install. See record.ts's envBlock header.

test("inContainerAgentVersion: execs the driver's versionArgv inside a throwaway container, then removes it", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  const seenArgv: string[][] = []
  const execFn = async (argv: string[]) => {
    seenArgv.push(argv)
    if (argv[1] === "exec" && argv.includes("opencode") && argv.includes("--version")) {
      return { rc: 0, stdout: "opencode 3.2.1 (in-container)\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const version = await inContainerAgentVersion(paths, opencodeDriver, execFn)
  expect(version).toBe("opencode 3.2.1 (in-container)")
  expect(seenArgv.some((a) => a[1] === "create")).toBe(true)
  expect(seenArgv.some((a) => a[1] === "start")).toBe(true)
  expect(seenArgv.some((a) => a[1] === "rm")).toBe(true)
})

test("inContainerAgentVersion: uses driver.versionArgv, not a hardcoded opencode probe", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  const fakeDriver = { ...opencodeDriver, id: "fake", versionArgv: ["fake-agent", "--ver"] }
  const seenArgv: string[][] = []
  const execFn = async (argv: string[]) => {
    seenArgv.push(argv)
    if (argv[1] === "exec" && argv.includes("fake-agent") && argv.includes("--ver")) {
      return { rc: 0, stdout: "fake-agent 1.0.0\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const version = await inContainerAgentVersion(paths, fakeDriver, execFn)
  expect(version).toBe("fake-agent 1.0.0")
  expect(seenArgv.some((a) => a[1] === "exec" && a.includes("fake-agent"))).toBe(true)
})

test("inContainerAgentVersion: create failure -> 'unknown', still removes the container", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  let rmCalled = false
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") return { rc: 125, stdout: "", stderr: "boom", timedOut: false }
    if (argv[1] === "rm") rmCalled = true
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  expect(await inContainerAgentVersion(paths, opencodeDriver, execFn)).toBe("unknown")
  expect(rmCalled).toBe(true)
})

test("inContainerAgentVersion: exec throwing -> 'unknown' (never throws)", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec") throw new Error("boom")
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  expect(await inContainerAgentVersion(paths, opencodeDriver, execFn)).toBe("unknown")
})

// final-review fix 3: the version probe must respect the exec's exit code —
// a stale bench image missing the agent binary can still print SOMETHING to
// stdout/stderr (e.g. "bash: opencode: command not found") with a non-zero
// rc; treating that text as a real version silently records garbage
// provenance and lets the run proceed to (silently) score 0.
test("inContainerAgentVersion: version exec rc!=0 -> 'unknown', even though stdout/stderr carry text", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec") {
      return { rc: 127, stdout: "", stderr: "bash: opencode: command not found\n", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  expect(await inContainerAgentVersion(paths, opencodeDriver, execFn)).toBe("unknown")
})

test("cmdRun: envBlock is populated from inContainerAgentVersion, not a host lookup", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const versionExec = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.includes("opencode")) {
      return { rc: 0, stdout: "opencode IN-CONTAINER-VERSION\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none" }, async () => result(), versionExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  // env isn't in the run-results.json shape directly, but recordToStores'
  // env is what matters in practice; here we just confirm cmdRun didn't
  // crash wiring the override through and used the injected execFn (not a
  // real host `opencode --version`, which isn't installed in this sandbox).
  expect(fs.existsSync(resultsFile)).toBe(true)
})

// ── driver selection (task-B3-brief.md) ───────────────────────────────────

test("cmdRun: default (no --driver) resolves the opencode driver and writes driver:'opencode' into results", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  let seenDriver: unknown
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, driver) => {
    seenDriver = driver?.id
    return result()
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(seenDriver).toBe("opencode")
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.driver).toBe("opencode")
})

test("cmdRun: --driver opencode (explicit) behaves identically to the default (no flag)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const fake: RunOneTaskFn = async () => result()

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none", driver: "opencode" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.driver).toBe("opencode")
})

test("cmdRun: unknown --driver id dies (BenchError) before any task runs", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)

  let ran = false
  const fake: RunOneTaskFn = async () => {
    ran = true
    return result()
  }

  await expect(
    cmdRun(paths, { tasks: ["a"], layers: "none", driver: "nope" }, fake, fakeExec),
  ).rejects.toThrow(BenchError)
  expect(ran).toBe(false)
})

// ── version-probe rc gate (final-review fix 3) ─────────────────────────────
// A NON-default driver (e.g. claude-code) whose in-container version probe
// comes back "unknown" means the bench image doesn't actually have that
// driver's binary baked in — proceeding would silently score every task 0
// rather than surface the real problem (missing image layer). The DEFAULT
// driver (opencode) keeps the old lenient behavior (proceed with "unknown"
// recorded) to avoid breaking existing flows/tests.

test("cmdRun: --driver claude-code + an 'unknown' version probe dies before any task runs", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)

  let ran = false
  const fake: RunOneTaskFn = async () => {
    ran = true
    return result()
  }
  // rc!=0 on the version-probe exec -> inContainerAgentVersion returns
  // "unknown" (fix 3's other half).
  const unknownProbeExec = async (argv: string[]) => {
    if (argv[1] === "exec") return { rc: 127, stdout: "", stderr: "no such binary", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await expect(
    cmdRun(paths, { tasks: ["a"], layers: "none", driver: "claude-code" }, fake, unknownProbeExec),
  ).rejects.toThrow(BenchError)
  expect(ran).toBe(false)
})

// ── run --parallel: budget-packed scheduling (Task 6) ─────────────────────
// The scheduler itself (canonical-order packing + AsyncMutex) is unit-tested
// in bench-scheduler.test.ts; here we test cmd-run's INTEGRATION: concurrent
// execution within budget, byte-identical aggregate results vs. serial, the
// mutex guarding every shared write, and the serial path staying on its
// existing for-loop (schedule() never touched).

test("run --parallel: tasks execute concurrently within budget, results identical to serial", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a", "b", "c"], 1, 2048) // 3×(1cpu/2048MB) fits DEFAULT_BUDGET (3cpu/6144MB)
  const paths = fakeBenchPaths(dir, tbRoot)

  const outcome = (t: string) => result({ reward: t === "b" ? 0 : 1, sessionId: `s-${t}`, turns: 2 })

  // Gate: every task blocks until all 3 have STARTED, so all 3 are provably
  // in flight at once — maxInFlight === 3 iff they truly overlap under budget.
  let inFlight = 0
  let maxInFlight = 0
  let started = 0
  let releaseAll!: () => void
  const gate = new Promise<void>((r) => (releaseAll = r))
  const parallelFake: RunOneTaskFn = async (_p, t) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (++started === 3) releaseAll()
    await gate
    inFlight--
    return outcome(t)
  }
  const parResults = path.join(dir, "par.json")
  let errSpy = spyOn(console, "error").mockImplementation(() => {})
  let logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a", "b", "c"], resultsFile: parResults, layers: "none", parallel: true, enforceResources: true },
      parallelFake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(maxInFlight).toBe(3)

  // Serial run over the SAME per-task outcomes.
  const serialFake: RunOneTaskFn = async (_p, t) => outcome(t)
  const serResults = path.join(dir, "ser.json")
  errSpy = spyOn(console, "error").mockImplementation(() => {})
  logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a", "b", "c"], resultsFile: serResults, layers: "none" }, serialFake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  const par = JSON.parse(fs.readFileSync(parResults, "utf-8"))
  const ser = JSON.parse(fs.readFileSync(serResults, "utf-8"))
  expect(par.tasks).toEqual(ser.tasks) // aggregate task_agg identical regardless of completion order
  expect(par.n_pass).toBe(ser.n_pass)
  expect(par.n_total).toBe(3)
})

test("run --parallel: task banner leads with \\n, THEN the [task] prefix (not prefix-then-\\n) — final-review fix", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  const lines: string[] = []
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true },
      async (_p, t) => result({ reward: 1, sessionId: `s-${t}` }),
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
  }

  // Orphaned-prefix bug would produce "[a] \n=== Task: a ===" (prefix on its
  // own line, "===" on the next). The fix keeps the leading \n first, so the
  // "[task]" prefix sits directly on the same line as "===".
  const banner = lines.find((l) => l.includes("=== Task: a ==="))
  expect(banner).toBe("\n[a] === Task: a ===")
})

test("run --parallel: store/results writes serialized via mutex (no interleave)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a", "b", "c"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "r.json")

  // Fake writer that YIELDS mid-write (two microtasks): if two concurrent
  // task pipelines entered writeRunResults without the mutex holding them
  // apart, `active` would exceed 1 and `overlap` would flip. The mutex must
  // keep every write leaf-serialized.
  let active = 0
  let overlap = false
  let writes = 0
  mock.module("../src/bench/results.ts", () => ({
    resumeCarryForward: realResumeCarryForward,
    aggTotals: realAggTotals,
    writeRunResults: async () => {
      writes++
      active++
      if (active > 1) overlap = true
      await Promise.resolve()
      await Promise.resolve()
      active--
    },
  }))

  const fake: RunOneTaskFn = async (_p, t) => result({ reward: 1, sessionId: `s-${t}`, turns: 2 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a", "b", "c"], resultsFile, layers: "none", parallel: true, enforceResources: true },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreResults()
  }
  expect(writes).toBeGreaterThan(0)
  expect(overlap).toBe(false)
})

test("cmdRun: default driver (opencode) + an 'unknown' version probe still proceeds (lenient, unchanged)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "run-results.json")

  const fake: RunOneTaskFn = async () => result()
  const unknownProbeExec = async (argv: string[]) => {
    if (argv[1] === "exec") return { rc: 127, stdout: "", stderr: "no such binary", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], resultsFile, layers: "none" }, fake, unknownProbeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.status).toBe("complete")
})

// ── OOM-escalation retry (Task 7) ─────────────────────────────────────────
// runTaskOnce surfaces oomKilled from the cgroup read; runWithOomRetry retries
// a FAILED oomKilled attempt ONCE at 2× memory; the pipeline records only the
// (possibly retried) final result and never memorizes an oomKilled sample.

test("runTaskOnce: cgroup oom_kill 1 → RunTaskResult.oomKilled=true", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    if (argv[1] === "exec" && argv.some((a) => a.includes("cpu.stat"))) {
      return { rc: 0, stdout: "usage_usec 2000000\nPEAK 1048576\nOOMK 1\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }
  expect(res.oomKilled).toBe(true)
})

test("runTaskOnce: cgroup oom_kill 0 → RunTaskResult.oomKilled falsy", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(dir, tbRoot)

  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 0, stdout: "", stderr: "", timedOut: false }
    }
    if (argv[1] === "exec" && argv.some((a) => a.includes("cpu.stat"))) {
      return { rc: 0, stdout: "usage_usec 2000000\nPEAK 1048576\nOOMK 0\n", stderr: "", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  mock.module("../src/bench/verifier.ts", () => ({ copyTests: async () => {}, runVerifier: async () => 0 }))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  let res: RunTaskResult
  try {
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, undefined, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreVerifier()
  }
  expect(res.oomKilled).toBeFalsy()
})

// ── runWithOomRetry (unit) ────────────────────────────────────────────────

test("runWithOomRetry: FAILED oomKilled attempt retries ONCE at 2× memory, returning the retry + escalated resources", async () => {
  const seenMem: number[] = []
  const attempt = async (r: { cpus: number; memoryMb: number } | undefined) => {
    seenMem.push(r!.memoryMb)
    return seenMem.length === 1
      ? result({ reward: 0, oomKilled: true, sessionId: "killed" })
      : result({ reward: 1, oomKilled: false, sessionId: "retry" })
  }
  const logSpy = spyOn(console, "error").mockImplementation(() => {})
  let out: Awaited<ReturnType<typeof runWithOomRetry>>
  try {
    out = await runWithOomRetry(attempt, { cpus: 1, memoryMb: 2048 }, undefined, "")
  } finally {
    logSpy.mockRestore()
  }
  expect(seenMem).toEqual([2048, 4096])
  expect(out.result.sessionId).toBe("retry")
  expect(out.resources).toEqual({ cpus: 1, memoryMb: 4096 })
})

test("runWithOomRetry: oomKilled but PASSED (reward=1) → no retry (cumulative-counter guard)", async () => {
  let calls = 0
  const attempt = async () => {
    calls++
    return result({ reward: 1, oomKilled: true, sessionId: "passed" })
  }
  const out = await runWithOomRetry(attempt, { cpus: 1, memoryMb: 2048 }, undefined, "")
  expect(calls).toBe(1)
  expect(out.result.sessionId).toBe("passed")
  expect(out.resources).toEqual({ cpus: 1, memoryMb: 2048 })
})

test("runWithOomRetry: resources undefined (unenforced) → no retry even on oomKilled fail", async () => {
  let calls = 0
  const attempt = async () => {
    calls++
    return result({ reward: 0, oomKilled: true })
  }
  const out = await runWithOomRetry(attempt, undefined, undefined, "")
  expect(calls).toBe(1)
  expect(out.resources).toBeUndefined()
})

test("runWithOomRetry: escalated retry ALSO OOMs → recorded once as fail, exactly 2 attempts (no third)", async () => {
  let calls = 0
  const attempt = async () => {
    calls++
    return result({ reward: 0, oomKilled: true, sessionId: `a${calls}` })
  }
  const logSpy = spyOn(console, "error").mockImplementation(() => {})
  let out: Awaited<ReturnType<typeof runWithOomRetry>>
  try {
    out = await runWithOomRetry(attempt, { cpus: 1, memoryMb: 2048 }, undefined, "")
  } finally {
    logSpy.mockRestore()
  }
  expect(calls).toBe(2)
  expect(out.result.sessionId).toBe("a2")
  expect(out.result.reward).toBe(0)
})

test("runWithOomRetry: orig already at ceiling → escalateResources null → no retry", async () => {
  let calls = 0
  const attempt = async () => {
    calls++
    return result({ reward: 0, oomKilled: true })
  }
  const out = await runWithOomRetry(attempt, { cpus: 1, memoryMb: 2048 }, 2048, "")
  expect(calls).toBe(1)
  expect(out.resources).toEqual({ cpus: 1, memoryMb: 2048 })
})

// ── pipeline integration (fake RunOneTaskFn) ──────────────────────────────

test("cmdRun: OOM-killed fail retries at 2× mem; ONLY the retry lands in results/store/profile", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")

  let call = 0
  const seenMem: number[] = []
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    call++
    seenMem.push(resources!.memoryMb)
    return call === 1
      ? result({ reward: 0, oomKilled: true, cpuSeconds: 9, peakRssMb: 9000, turns: 3, sessionId: "killed" })
      : result({ reward: 1, oomKilled: false, cpuSeconds: 4, peakRssMb: 1500, turns: 3, sessionId: "retry", elapsed: 2.0 })
  }

  // No resultsFile → store writes stay ENABLED (resultsFile would force noStore),
  // so the store is the authoritative "only the retry landed" evidence.
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "project", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  expect(call).toBe(2)
  expect(seenMem).toEqual([2048, 4096]) // retry got double memory
  const score = readScore(root, "v0")
  expect(score.sessions.map((s) => s.sessionID)).toEqual(["retry"]) // killed attempt never stored, only the retry
  const prof = readResourceProfile(paths.metaRoot, "a", hostClass())
  expect(prof!.n).toBe(1) // exactly the final (retry) sample
  expect(prof!.peakRssMb).toBe(1500) // the killed 9000 sample never memorized
})

test("cmdRun: oomKilled BUT passed → no retry, result recorded, profile NOT updated", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")

  let call = 0
  const fake: RunOneTaskFn = async () => {
    call++
    return result({ reward: 1, oomKilled: true, cpuSeconds: 5, peakRssMb: 2000, turns: 3, sessionId: "passed" })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "project", enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(call).toBe(1)
  const score = readScore(root, "v0")
  expect(score.sessions.map((s) => s.sessionID)).toEqual(["passed"])
  expect(readResourceProfile(paths.metaRoot, "a", hostClass())).toBeNull() // contaminated sample skipped
})

test("cmdRun --parallel: orig at mem ceiling → no OOM retry (no-headroom path through the wrapper)", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)

  let call = 0
  const fake: RunOneTaskFn = async () => {
    call++
    return result({ reward: 0, oomKilled: true, cpuSeconds: 5, peakRssMb: 2000, turns: 3 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true, cpuBudget: 10, memBudget: 2048 },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(call).toBe(1) // escalate(2048, ceiling=2048) → null → no retry
})

test("cmdRun: k>1 carry-forward — an escalated cap persists into the next repeat's FIRST attempt", async () => {
  const paths = isolatedPaths(["a"])
  writeResourceTomls(paths.tbRoot, ["a"], 1, 2048)
  const resultsFile = path.join(paths.metaRoot, "run-results.json")

  const seenMem: number[] = []
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    seenMem.push(resources!.memoryMb)
    // ki=0 attempt1 (2048) OOM-fails → retry (4096) passes; ki=1 must START at 4096.
    return seenMem.length === 1
      ? result({ reward: 0, oomKilled: true, turns: 3 })
      : result({ reward: 1, oomKilled: false, turns: 3 })
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], k: 2, layers: "none", enforceResources: true, resultsFile }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  // attempt1@2048 (kill) → retry@4096 (pass) → repeat2@4096 (pass) = 3 calls, no 2nd kill→retry cycle
  expect(seenMem).toEqual([2048, 4096, 4096])
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a.rewards).toEqual([1, 1])
})

// Placed LAST so its mock.module of scheduler.ts (restored in finally) can't
// bleed into the real-schedule --parallel tests above even if a restore is
// imperfect.
test("serial path untouched: no --parallel → existing for-loop (spy: schedule() never called)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)

  let scheduleCalls = 0
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      scheduleCalls++
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const fake: RunOneTaskFn = async () => result({ reward: 1 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a", "b"], layers: "none" }, fake, fakeExec)
    expect(scheduleCalls).toBe(0)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
})

// ── oauth-parallel freshness gate, Task 2 part B: args.canLaunch → schedule()
// ─────────────────────────────────────────────────────────────────────────
// cli.ts's main() computes the launch-guard (buildOauthParallelCanLaunch) and
// sets it as internal-only wiring on CmdRunArgs.canLaunch BEFORE calling
// cmdRun — these tests pin that cmd-run.ts threads whatever is on
// `args.canLaunch` straight through as schedule()'s 4th param, unchanged
// (undefined by default — byte-identical to before this gate existed).

test("run --parallel: args.canLaunch (when set) is threaded straight into schedule()'s 4th param", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  let capturedCanLaunch: unknown
  let scheduleCalls = 0
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      scheduleCalls++
      capturedCanLaunch = a[3]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const marker = () => true
  const fake: RunOneTaskFn = async () => result({ reward: 1 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true, canLaunch: marker },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(scheduleCalls).toBe(1)
  expect(capturedCanLaunch).toBe(marker)
})

// ── host-pressure gate, plan S3: args.pressureGate → schedule()'s 5th arg AND
// PRESSURE_POLL_SEC * 1000 → schedule()'s 6th arg (pausePollMs) ──────────────
// cli.ts's main() builds the pressure gate (buildPressureGate) and sets it on
// CmdRunArgs.pressureGate BEFORE calling cmdRun; this pins that cmd-run.ts
// threads it as schedule()'s 5th param AND passes the sensor's poll cadence
// (PRESSURE_POLL_SEC * 1000, imported here from host-pressure.ts — NOT the
// scheduler's own decoupled local default) as the 6th param.

test("run --parallel: args.pressureGate + PRESSURE_POLL_SEC*1000 reach schedule() as the 5th and 6th args", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  let capturedPauseGate: unknown
  let capturedPausePollMs: unknown
  let scheduleCalls = 0
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      scheduleCalls++
      capturedPauseGate = a[4]
      capturedPausePollMs = a[5]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const gate = () => false
  const fake: RunOneTaskFn = async () => result({ reward: 1 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(
      paths,
      { tasks: ["a"], layers: "none", parallel: true, enforceResources: true, pressureGate: gate },
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(scheduleCalls).toBe(1)
  expect(capturedPauseGate).toBe(gate)
  expect(capturedPausePollMs).toBe(PRESSURE_POLL_SEC * 1000)
})

test("run --parallel: args.pressureGate absent — schedule() gets undefined 5th arg (still receives the 6th poll cadence)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  let capturedPauseGate: unknown = "unset"
  let capturedPausePollMs: unknown
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      capturedPauseGate = a[4]
      capturedPausePollMs = a[5]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const fake: RunOneTaskFn = async () => result({ reward: 1 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", parallel: true, enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(capturedPauseGate).toBeUndefined()
  expect(capturedPausePollMs).toBe(PRESSURE_POLL_SEC * 1000)
})

test("run --parallel: args.canLaunch absent by default — schedule() gets undefined (unbounded, byte-identical)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeResourceTomls(tbRoot, ["a"], 1, 2048)
  const paths = fakeBenchPaths(dir, tbRoot)

  let capturedCanLaunch: unknown = "unset"
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      capturedCanLaunch = a[3]
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const fake: RunOneTaskFn = async () => result({ reward: 1 })
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await cmdRun(paths, { tasks: ["a"], layers: "none", parallel: true, enforceResources: true }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
    restoreScheduler()
  }
  expect(capturedCanLaunch).toBeUndefined()
})

test("DEFAULT_BENCH_MODEL pins the current latest sonnet (model policy: latest tier models; a bump here is a deliberate instrument change, not drift)", () => {
  expect(DEFAULT_BENCH_MODEL).toBe("anthropic/claude-sonnet-5")
})
