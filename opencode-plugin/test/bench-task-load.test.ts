import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdTaskLoad } from "../src/bench/cmd-task-load.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-task-load-"))
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

/** Two fixture tasks: one with a declared [environment] footprint (2 cpu /
 * 4096 MB, custom timeouts), one with no [environment] table at all (falls
 * back to the modal 1 cpu / 2048 MB, declared=false, and default timeouts). */
function writeFixtureTasks(tbRoot: string): void {
  fs.mkdirSync(path.join(tbRoot, "task-declared"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "task-declared", "task.toml"),
    "[environment]\ncpus = 2\nmemory_mb = 4096\n\n[agent]\ntimeout_sec = 600\n\n[verifier]\ntimeout_sec = 120\n",
  )
  fs.mkdirSync(path.join(tbRoot, "task-fallback"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "task-fallback", "task.toml"), "")
}

/** Capture every console.log call as an array of lines (one per call),
 * joined for substring assertions. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = []
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return lines
}

test("cmdTaskLoad: table has declared footprint + timeout columns + a co-run groups preview line", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeFixtureTasks(tbRoot)
  const paths = fakeBenchPaths(dir, tbRoot)

  const lines = captureLog(() => {
    cmdTaskLoad(paths, { tasks: ["task-declared", "task-fallback"] })
  })
  const out = lines.join("\n")

  // Declared footprint fields for both tasks.
  expect(out).toContain("task-declared")
  expect(out).toContain("task-fallback")
  expect(out).toMatch(/task-declared[^\n]*\b2\b[^\n]*\b4096\b[^\n]*yes/)
  expect(out).toMatch(/task-fallback[^\n]*\b1\b[^\n]*\b2048\b[^\n]*no/)

  // Timeout columns: declared task's custom timeouts, fallback task's defaults.
  expect(out).toMatch(/task-declared[^\n]*\b600\b[^\n]*\b120\b/)
  expect(out).toMatch(/task-fallback[^\n]*\b900\b[^\n]*\b300\b/)

  // No results-file given → no mean-elapsed column.
  expect(out).not.toMatch(/MeanElapsed/)

  // A co-run groups preview line under the active (default) budget.
  expect(out).toContain("co-run groups")
  expect(out).toContain("task-declared")
})

test("cmdTaskLoad: --results-file adds a mean-elapsed column computed from tasks[t].elapsed", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeFixtureTasks(tbRoot)
  const paths = fakeBenchPaths(dir, tbRoot)

  const resultsFile = path.join(dir, "results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      tasks: {
        "task-declared": { rewards: [1, 0], elapsed: [10, 14.6], turns: [3, 2], errors: [] },
        // task-fallback has no results yet — its row must show a placeholder,
        // not throw.
      },
    }),
  )

  const lines = captureLog(() => {
    cmdTaskLoad(paths, { tasks: ["task-declared", "task-fallback"], resultsFile })
  })
  const out = lines.join("\n")

  expect(out).toContain("MeanElapsed")
  // mean of [10, 14.6] = 12.3
  expect(out).toMatch(/task-declared[^\n]*\b12\.3\b/)
  // fallback task has no elapsed samples — shows a placeholder dash, not NaN.
  expect(out).toMatch(/task-fallback[^\n]*[-–]/)
  expect(out).not.toContain("NaN")
})

test("cmdTaskLoad: co-run groups preview reflects the active --cpu-budget/--mem-budget", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeFixtureTasks(tbRoot)
  const paths = fakeBenchPaths(dir, tbRoot)

  // task-declared alone needs 2 cpu; a budget of 1 cpu makes it exceed the
  // TOTAL budget, so it must land in its own solo group, distinct from
  // task-fallback (1 cpu, fits a 1-cpu budget on its own).
  const lines = captureLog(() => {
    cmdTaskLoad(paths, { tasks: ["task-declared", "task-fallback"], cpuBudget: 1, memBudget: 6144 })
  })
  const out = lines.join("\n")

  expect(out).toContain("[task-declared]")
  expect(out).toContain("[task-fallback]")
})

test("cmdTaskLoad: --all enumerates every tbRoot task with a task.toml", () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeFixtureTasks(tbRoot)
  const paths = fakeBenchPaths(dir, tbRoot)

  const lines = captureLog(() => {
    cmdTaskLoad(paths, { all: true })
  })
  const out = lines.join("\n")

  expect(out).toContain("task-declared")
  expect(out).toContain("task-fallback")
})
