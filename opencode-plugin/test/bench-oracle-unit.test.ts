import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { selectTasks, taskTimeouts } from "../src/bench/tasks.ts"
import { runHost, withTimeout } from "../src/bench/exec.ts"
import { cmdOracle, type RunOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { main } from "../src/bench/cli.ts"
import { BenchError } from "../src/bench/util.ts"

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

function writeManifest(termBenchDir: string, tasks: string[]): void {
  fs.mkdirSync(termBenchDir, { recursive: true })
  const manifest: Record<string, unknown> = {}
  for (const t of tasks) manifest[t] = {}
  fs.writeFileSync(path.join(termBenchDir, "manifest.json"), JSON.stringify(manifest))
}

// ── selectTasks ──────────────────────────────────────────────────────────

test("selectTasks: --all returns sorted manifest keys", () => {
  const dir = tmpDir()
  writeManifest(dir, ["zeta", "alpha", "mu"])
  const paths = fakeBenchPaths(dir)
  expect(selectTasks(paths, { all: true })).toEqual(["alpha", "mu", "zeta"])
})

test("selectTasks: --task-file strips blank lines and # comments", () => {
  const dir = tmpDir()
  writeManifest(dir, ["foo", "bar", "baz"])
  const paths = fakeBenchPaths(dir)
  const taskFile = path.join(dir, "tasks.txt")
  fs.writeFileSync(taskFile, "foo\n\n# a comment\nbar\n   \nbaz\n")
  expect(selectTasks(paths, { taskFile })).toEqual(["foo", "bar", "baz"])
})

test("selectTasks: explicit --tasks list, validated against manifest", () => {
  const dir = tmpDir()
  writeManifest(dir, ["foo", "bar"])
  const paths = fakeBenchPaths(dir)
  expect(selectTasks(paths, { tasks: ["bar", "foo"] })).toEqual(["bar", "foo"])
})

test("selectTasks: resolution order is all > task-file > tasks", () => {
  const dir = tmpDir()
  writeManifest(dir, ["foo", "bar", "baz"])
  const paths = fakeBenchPaths(dir)
  const taskFile = path.join(dir, "tasks.txt")
  fs.writeFileSync(taskFile, "foo\n")
  // --all wins even though task-file and tasks are also given
  expect(selectTasks(paths, { all: true, taskFile, tasks: ["bar"] })).toEqual(["bar", "baz", "foo"])
  // task-file wins over tasks when --all isn't set
  expect(selectTasks(paths, { taskFile, tasks: ["bar"] })).toEqual(["foo"])
})

test("selectTasks: unknown task dies with Python-parity message", () => {
  const dir = tmpDir()
  writeManifest(dir, ["foo"])
  const paths = fakeBenchPaths(dir)
  expect(() => selectTasks(paths, { tasks: ["nope"] })).toThrow(BenchError)
  try {
    selectTasks(paths, { tasks: ["nope"] })
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toBe("Unknown task: 'nope'. Check manifest.json.")
  }
})

test("selectTasks: none of all/task-file/tasks dies with the Python usage message", () => {
  const dir = tmpDir()
  writeManifest(dir, ["foo"])
  const paths = fakeBenchPaths(dir)
  expect(() => selectTasks(paths, {})).toThrow(BenchError)
  try {
    selectTasks(paths, {})
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toBe("Specify --tasks TASK [TASK...], --task-file PATH, or --all")
  }
})

test("selectTasks: manifest missing dies", () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir) // no manifest.json written
  expect(() => selectTasks(paths, { all: true })).toThrow(BenchError)
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

test("taskTimeouts: maxAgentTimeout of 0 means uncapped", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "uncapped"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "uncapped", "task.toml"), "[agent]\ntimeout_sec = 1200\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  expect(taskTimeouts(paths, "uncapped", 0)).toEqual({ agentTimeout: 1200, verifierTimeout: 300 })
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
  writeManifest(dir, ["a", "b"])
  const paths = fakeBenchPaths(dir)
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
  writeManifest(dir, ["only-task"])
  const paths = fakeBenchPaths(dir)
  const seen: string[] = []
  const fake: RunOneOracleTask = async (_paths, task) => {
    seen.push(task)
    return { reward: 1, elapsed: 1.0, error: "" }
  }
  await cmdOracle(paths, {}, fake)
  expect(seen).toEqual(["only-task"])
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
