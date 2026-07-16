import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { selectTasks, taskTimeouts, taskResources, enforcedResources } from "../src/bench/tasks.ts"
import { runHost, withTimeout } from "../src/bench/exec.ts"
import { cmdOracle, runOneOracleTask, type RunOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { main } from "../src/bench/cli.ts"
import { BenchError } from "../src/bench/util.ts"
import type { ExecResult } from "../src/bench/exec.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-oracle-unit-"))
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

/** selectTasks's validity source is now `<tbRoot>/<task>/task.toml` (see
 * tasks.ts's header) — write one empty task.toml per task under a fresh
 * tbRoot dir, replacing the old manifest.json fixture. */
function writeTaskTomls(tbRoot: string, tasks: string[]): void {
  for (const t of tasks) {
    fs.mkdirSync(path.join(tbRoot, t), { recursive: true })
    fs.writeFileSync(path.join(tbRoot, t, "task.toml"), "")
  }
}

// ── selectTasks ──────────────────────────────────────────────────────────

test("selectTasks: --all returns sorted task.toml dirs under tbRoot", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["zeta", "alpha", "mu"])
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(selectTasks(paths, { all: true })).toEqual(["alpha", "mu", "zeta"])
})

test("selectTasks: --task-file strips blank lines and # comments", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["foo", "bar", "baz"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const taskFile = path.join(dir, "tasks.txt")
  fs.writeFileSync(taskFile, "foo\n\n# a comment\nbar\n   \nbaz\n")
  expect(selectTasks(paths, { taskFile })).toEqual(["foo", "bar", "baz"])
})

test("selectTasks: explicit --tasks list, validated against tbRoot task.toml", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["foo", "bar"])
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(selectTasks(paths, { tasks: ["bar", "foo"] })).toEqual(["bar", "foo"])
})

test("selectTasks: resolution order is all > task-file > tasks", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["foo", "bar", "baz"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const taskFile = path.join(dir, "tasks.txt")
  fs.writeFileSync(taskFile, "foo\n")
  // --all wins even though task-file and tasks are also given
  expect(selectTasks(paths, { all: true, taskFile, tasks: ["bar"] })).toEqual(["bar", "baz", "foo"])
  // task-file wins over tasks when --all isn't set
  expect(selectTasks(paths, { taskFile, tasks: ["bar"] })).toEqual(["foo"])
})

test("selectTasks: unknown task dies naming tbRoot", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["foo"])
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(() => selectTasks(paths, { tasks: ["nope"] })).toThrow(BenchError)
  try {
    selectTasks(paths, { tasks: ["nope"] })
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toBe(`Unknown task: 'nope'. Check tbRoot (${tbRoot}) for a matching task.toml.`)
  }
})

test("selectTasks: none of all/task-file/tasks dies with the Python usage message", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["foo"])
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(() => selectTasks(paths, {})).toThrow(BenchError)
  try {
    selectTasks(paths, {})
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toBe("Specify --tasks TASK [TASK...], --task-file PATH, or --all")
  }
})

test("selectTasks: tbRoot missing dies", () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir) // tbRoot ("tb-root-unused") never created
  expect(() => selectTasks(paths, { all: true })).toThrow(BenchError)
})

test("selectTasks: --all skips upstream dirs without a task.toml", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["real-task"])
  // a dir with no task.toml (e.g. a stray non-task directory) must not appear
  fs.mkdirSync(path.join(tbRoot, "not-a-task"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(selectTasks(paths, { all: true })).toEqual(["real-task"])
})

// ── taskTimeouts ─────────────────────────────────────────────────────────

test("taskTimeouts: reads [agent]/[verifier] timeout_sec from task.toml", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "sometask"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "sometask", "task.toml"),
    "[agent]\ntimeout_sec = 123\n\n[verifier]\ntimeout_sec = 45\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "sometask", 0)).toEqual({ agentTimeout: 123, verifierTimeout: 45 })
})

test("taskTimeouts: missing task.toml defaults to 900/300", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "notoml"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "notoml", 0)).toEqual({ agentTimeout: 900, verifierTimeout: 300 })
})

test("taskTimeouts: unparseable task.toml defaults to 900/300", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "badtoml"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "badtoml", "task.toml"), "not valid [[[ toml")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "badtoml", 0)).toEqual({ agentTimeout: 900, verifierTimeout: 300 })
})

test("taskTimeouts: absent key within a parseable file defaults", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "partial"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "partial", "task.toml"), "[agent]\ntimeout_sec = 42\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "partial", 0)).toEqual({ agentTimeout: 42, verifierTimeout: 300 })
})

test("taskTimeouts: caps agent timeout and logs the Python-parity capping message", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "capped"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "capped", "task.toml"), "[agent]\ntimeout_sec = 1200\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = taskTimeouts(paths, "capped", 600)
    expect(result).toEqual({ agentTimeout: 600, verifierTimeout: 300 })
    const messages = errSpy.mock.calls.map((c) => c[0])
    expect(messages).toContain("  capping agent timeout 1200s → 600s")
  } finally {
    errSpy.mockRestore()
  }
})

test("taskTimeouts: caps verifier timeout and logs the capping message", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "vcapped"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "vcapped", "task.toml"), "[verifier]\ntimeout_sec = 1200\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = taskTimeouts(paths, "vcapped", 0, 600)
    expect(result).toEqual({ agentTimeout: 900, verifierTimeout: 600 })
    const messages = errSpy.mock.calls.map((c) => c[0])
    expect(messages).toContain("  capping verifier timeout 1200s → 600s")
  } finally {
    errSpy.mockRestore()
  }
})

test("taskTimeouts: maxVerifierTimeout of 0 means verifier uncapped", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "vuncapped"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "vuncapped", "task.toml"), "[verifier]\ntimeout_sec = 1200\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "vuncapped", 0, 0)).toEqual({ agentTimeout: 900, verifierTimeout: 1200 })
})

test("taskTimeouts: maxAgentTimeout of 0 means uncapped", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "uncapped"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "uncapped", "task.toml"), "[agent]\ntimeout_sec = 1200\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "uncapped", 0)).toEqual({ agentTimeout: 1200, verifierTimeout: 300 })
})

// ── taskResources ────────────────────────────────────────────────────────

test("taskResources: reads declared [environment] fields", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "fixture-task"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "fixture-task", "task.toml"),
    "[environment]\ncpus = 2\nmemory_mb = 4096\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskResources(paths, "fixture-task")).toEqual({ cpus: 2, memoryMb: 4096, storageMb: 10240, gpus: 0, declared: true })
})

test("taskResources: reads declared storage_mb", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "storage-task"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "storage-task", "task.toml"),
    "[environment]\ncpus = 1\nmemory_mb = 2048\nstorage_mb = 20480\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskResources(paths, "storage-task")).toEqual({ cpus: 1, memoryMb: 2048, storageMb: 20480, gpus: 0, declared: true })
})

test("taskResources: missing task.toml falls back to modal footprint", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(tbRoot, { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskResources(paths, "no-such-task")).toEqual({ cpus: 1, memoryMb: 2048, storageMb: 10240, gpus: 0, declared: false })
})

test("taskResources: broken toml falls back", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "broken-task"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "broken-task", "task.toml"), "not [ toml")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskResources(paths, "broken-task").declared).toBe(false)
})

test("taskResources: partial fields — missing memory_mb takes fallback, cpus kept", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "partial-task"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "partial-task", "task.toml"), "[environment]\ncpus = 2\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskResources(paths, "partial-task")).toEqual({ cpus: 2, memoryMb: 2048, storageMb: 10240, gpus: 0, declared: true })
})

// ── enforcedResources ────────────────────────────────────────────────────

test("enforcedResources: declared fields pass through as {cpus, memoryMb}", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "fixture-task"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "fixture-task", "task.toml"),
    "[environment]\ncpus = 2\nmemory_mb = 4096\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(enforcedResources(paths, "fixture-task")).toEqual({ cpus: 2, memoryMb: 4096 })
})

test("enforcedResources: no [environment] logs the spec-D1 warning and returns the modal footprint", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "no-env-task"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let r: { cpus: number; memoryMb: number }
  let messages: unknown[]
  try {
    r = enforcedResources(paths, "no-env-task")
    messages = errSpy.mock.calls.map((c) => c[0])
  } finally {
    errSpy.mockRestore()
  }
  expect(r).toEqual({ cpus: 1, memoryMb: 2048 })
  expect(messages.some((m) => typeof m === "string" && m.includes("no [environment] in task.toml"))).toBe(true)
})

test("enforcedResources: gpus > 0 throws BenchError naming the task and the gpu count", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "gpu-task"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "gpu-task", "task.toml"), "[environment]\ngpus = 1\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(() => enforcedResources(paths, "gpu-task")).toThrow(BenchError)
  expect(() => enforcedResources(paths, "gpu-task")).toThrow(/gpu-task.*gpus=1/)
})

// ── enforcedResources: per-task resource FLOOR (--min-cpus/--min-mem-mb) ──

test("enforcedResources: floors raise a declared footprint below them", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "small-task"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "small-task", "task.toml"),
    "[environment]\ncpus = 1\nmemory_mb = 2048\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(enforcedResources(paths, "small-task", { minCpus: 4, minMemoryMb: 8192 })).toEqual({
    cpus: 4,
    memoryMb: 8192,
  })
})

test("enforcedResources: floors below an already-generous declared footprint leave it unchanged", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "big-task"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "big-task", "task.toml"),
    "[environment]\ncpus = 6\nmemory_mb = 16384\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(enforcedResources(paths, "big-task", { minCpus: 4 })).toEqual({ cpus: 6, memoryMb: 16384 })
})

test("enforcedResources: no floors given returns the declared footprint unchanged (byte-identical to before floors existed)", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "fixture-task2"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "fixture-task2", "task.toml"),
    "[environment]\ncpus = 2\nmemory_mb = 4096\ngpus = 0\n",
  )
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(enforcedResources(paths, "fixture-task2")).toEqual({ cpus: 2, memoryMb: 4096 })
  expect(enforcedResources(paths, "fixture-task2", {})).toEqual({ cpus: 2, memoryMb: 4096 })
})

// ── exec funnel: withTimeout + rc-124 mapping (no podman required — plain bash) ──

test("withTimeout wraps a command with coreutils timeout -k 5", () => {
  expect(withTimeout(["bash", "test.sh"], 300)).toEqual(["timeout", "-k", "5", "300", "bash", "test.sh"])
})

test("withTimeout rounds up fractional seconds", () => {
  expect(withTimeout(["cmd"], 12.3)).toEqual(["timeout", "-k", "5", "13", "cmd"])
})

test("runHost: rc 124 (coreutils timeout convention) maps to timedOut: true", async () => {
  const result = await runHost(["bash", "-c", "exit 124"])
  expect(result.rc).toBe(124)
  expect(result.timedOut).toBe(true)
})

test("runHost: normal nonzero exit does not set timedOut", async () => {
  const result = await runHost(["bash", "-c", "exit 3"])
  expect(result.rc).toBe(3)
  expect(result.timedOut).toBe(false)
})

test("runHost: captures stdout and stderr concurrently without deadlock", async () => {
  const result = await runHost(["bash", "-c", "echo out; echo err 1>&2"])
  expect(result.rc).toBe(0)
  expect(result.stdout).toBe("out\n")
  expect(result.stderr).toBe("err\n")
  expect(result.timedOut).toBe(false)
})

test("runHost: host-side timeout kills the process and normalizes rc to -1", async () => {
  const result = await runHost(["sleep", "5"], { timeoutSec: 0.2 })
  expect(result.timedOut).toBe(true)
  expect(result.rc).toBe(-1)
}, 5000)

// ── cmdOracle: results-file shape (injectable per-task runner, no podman) ──

test("cmdOracle: incremental + final results-file JSON matches Python cmd_oracle's shape", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["a", "b"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const resultsFile = path.join(dir, "oracle-results.json")

  const fake: RunOneOracleTask = async (_paths, task) => {
    if (task === "a") {
      return { reward: 0, elapsed: 0.0, error: "setup_failed" }
    }
    // by the time task "b" runs, task "a"'s incremental write must already
    // be on disk with the exact Python shape (status "in_progress")
    const incremental = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
    expect(incremental).toEqual({
      label: "oracle",
      timestamp: incremental.timestamp,
      n_pass: 0,
      n_total: 1,
      pass_rate: 0,
      tasks: { a: { reward: 0, elapsed: 0, error: "setup_failed" } },
      status: "in_progress",
    })
    expect(typeof incremental.timestamp).toBe("string")
    return { reward: 1, elapsed: 12.3, error: "" }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await cmdOracle(paths, { tasks: ["a", "b"], resultsFile }, fake)

    // Python parity (runner.py:1402-1405 `_write_results`): every write to the
    // results file — incremental and final — logs "Results written → <path>".
    const messages = errSpy.mock.calls.map((c) => c[0])
    const writtenMessages = messages.filter((m) => m === `Results written → ${resultsFile}`)
    expect(writtenMessages.length).toBe(3) // 2 incremental (task a, task b) + 1 final
  } finally {
    errSpy.mockRestore()
  }

  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final).toEqual({
    label: "oracle",
    timestamp: final.timestamp,
    n_pass: 1,
    n_total: 2,
    pass_rate: 0.5,
    tasks: {
      a: { reward: 0, elapsed: 0, error: "setup_failed" },
      b: { reward: 1, elapsed: 12.3, error: "" },
    },
    status: "complete",
  })
})

test("cmdOracle: defaults to all tasks when neither --tasks nor --task-file given", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["only-task"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const seen: string[] = []
  const fake: RunOneOracleTask = async (_paths, task) => {
    seen.push(task)
    return { reward: 1, elapsed: 1.0, error: "" }
  }
  await cmdOracle(paths, {}, fake)
  expect(seen).toEqual(["only-task"])
})

// ── runOneOracleTask: podman create/start rc must not be ignored ─────────

test("runOneOracleTask: a failing `podman start` (rc 125) is setup_failed, naming the start phase — not swallowed into confusing later 'exec on non-running container' errors", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["sometask"])
  const paths = fakeBenchPaths(dir, tbRoot)

  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    if (argv[1] === "start") return { rc: 125, stdout: "", stderr: "boom", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: Awaited<ReturnType<typeof runOneOracleTask>>
  try {
    result = await runOneOracleTask(paths, "sometask", "runtime", fakeExec)
    const messages = errSpy.mock.calls.map((c) => c[0])
    expect(messages.some((m) => typeof m === "string" && m.includes("podman start failed"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }

  expect(result).toEqual({ reward: 0, elapsed: 0.0, error: "setup_failed" })
})

// ── --enforce-resources threading (default OFF) ───────────────────────────

test("runOneOracleTask: resources param appends --cpus/--memory to podman create argv", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["sometask"])
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    if (argv[1] === "create") createArgv = argv
    // stop right after create/start bring-up — mirrors this file's other
    // runOneOracleTask unit tests (never reach copyTests/runVerifier's
    // hardcoded real podman funnel).
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runOneOracleTask(paths, "sometask", "scripts", fakeExec, { cpus: 2, memoryMb: 4096 })
  } finally {
    errSpy.mockRestore()
  }
  expect(createArgv).toContain("--cpus")
  expect(createArgv).toContain("2")
  expect(createArgv).toContain("--memory")
  expect(createArgv).toContain("4096m")
})

test("runOneOracleTask: resources omitted (default) leaves podman create argv byte-identical to before", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["sometask"])
  const paths = fakeBenchPaths(dir, tbRoot)

  let createArgv: string[] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    if (argv[1] === "create") createArgv = argv
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runOneOracleTask(paths, "sometask", "scripts", fakeExec)
  } finally {
    errSpy.mockRestore()
  }
  expect(createArgv).not.toContain("--cpus")
  expect(createArgv).not.toContain("--memory")
})

test("cmdOracle --enforce-resources ON: a gpus>0 task dies before any podman call (default runOneTask, no fake injected)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "gputask"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "gputask", "task.toml"), "[environment]\ngpus = 1\n")
  const paths = fakeBenchPaths(dir, tbRoot)

  // No runOneTask fake injected — this exercises cmdOracle's actual default
  // parameter closure (args.enforceResources -> enforcedResources), which
  // must throw before ever reaching runOneOracleTask's real `podman` default
  // execFn (a synchronous throw building the create-call argument, before
  // the async container lifecycle starts).
  await expect(cmdOracle(paths, { tasks: ["gputask"], enforceResources: true })).rejects.toThrow(/gpus=1/)
})

// Option A (2026-07-11): podman containers have real root + network, so
// setup_deps.sh's own SKIP_APT-guarded apt section now genuinely runs — the
// runner must no longer suppress it via SKIP_APT=1.
test("runOneOracleTask: scripts-mode setup_deps.sh exec has no SKIP_APT in its env (Option A — apt genuinely runs now)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["sometask"])
  const paths = fakeBenchPaths(dir, tbRoot)

  // The setup_deps.sh exec deliberately returns rc 1 (setup_failed) so this
  // test stops right after capturing its argv — runOneOracleTask's later
  // steps (copyTests/runVerifier) hardcode the REAL podman funnel with no
  // injectable execFn (see verifier.ts), so this test must never reach them.
  let setupArgv: string[] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    if (argv[1] === "exec" && argv.some((a) => a.includes("setup_deps.sh"))) {
      setupArgv = argv
      return { rc: 1, stdout: "", stderr: "boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: Awaited<ReturnType<typeof runOneOracleTask>>
  try {
    result = await runOneOracleTask(paths, "sometask", "scripts", fakeExec)
  } finally {
    errSpy.mockRestore()
  }

  expect(result.error).toBe("setup_failed")
  expect(setupArgv.length).toBeGreaterThan(0)
  expect(setupArgv).not.toContain("SKIP_APT=1")
  expect(setupArgv.some((a) => a.startsWith("SKIP_APT"))).toBe(false)
  expect(setupArgv).toContain("TB_ROOT=/tb")
  expect(setupArgv).toContain("WORKDIR=/app")
})

// ── cli.ts: arg errors → rc 2, BenchError → rc 1 ──────────────────────────

test("cli main: no subcommand → rc 2", async () => {
  expect(await main([])).toBe(2)
})

test("cli main: unknown subcommand → rc 2", async () => {
  expect(await main(["bogus-command"])).toBe(2)
})

test("cli main: unknown flag on prep → rc 2", async () => {
  expect(await main(["prep", "--not-a-real-flag"])).toBe(2)
})

test("cli main: unknown flag on oracle → rc 2", async () => {
  expect(await main(["oracle", "--not-a-real-flag"])).toBe(2)
})

test("cli main: --tb-root with no value → rc 2", async () => {
  expect(await main(["--tb-root"])).toBe(2)
})

test("cli main: prep dry-run (no --apply) → rc 0, no podman spawned", async () => {
  expect(await main(["prep"])).toBe(0)
})

test("cli main: oracle --enforce-resources parses fine and falls through to normal flow (rc 1, unknown task)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["oracle", "--enforce-resources", "--tasks", "definitely-not-a-real-task-xyz"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => c[0])
    expect(messages.some((m) => typeof m === "string" && m.startsWith("error: Unknown task"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: BenchError from an unknown oracle task → rc 1", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["oracle", "--tasks", "definitely-not-a-real-task-xyz"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => c[0])
    expect(messages.some((m) => typeof m === "string" && m.startsWith("error: Unknown task"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})
