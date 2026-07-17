import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdTaskLoad } from "../src/bench/cmd-task-load.ts"
import { updateResourceProfile } from "../src/bench/resource-profile.ts"

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
 * 4096 MB / 20480 storage_mb / 1 gpu, custom timeouts), one with no
 * [environment] table at all (falls back to the modal 1 cpu / 2048 MB /
 * 10240 storage_mb / 0 gpus, declared=false, and default timeouts). */
function writeFixtureTasks(tbRoot: string): void {
  fs.mkdirSync(path.join(tbRoot, "task-declared"), { recursive: true })
  fs.writeFileSync(
    path.join(tbRoot, "task-declared", "task.toml"),
    "[environment]\ncpus = 2\nmemory_mb = 4096\nstorage_mb = 20480\ngpus = 1\n\n[agent]\ntimeout_sec = 600\n\n[verifier]\ntimeout_sec = 120\n",
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

  // Storage + GPU columns (spec D6/D7: declared, read-only, unenforced):
  // task-declared's declared storage/gpu values, task-fallback's modal
  // storage fallback (10240) and zero-gpu default.
  expect(out).toMatch(/task-declared[^\n]*\b20480\b[^\n]*\b1\b[^\n]*yes/)
  expect(out).toMatch(/task-fallback[^\n]*\b10240\b[^\n]*\b0\b[^\n]*no/)

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

// --- measured-packing preview (Task 5) --------------------------------------
//
// NOTE these tests use a NESTED termBenchDir (`<tmp>/tb`) so metaRoot =
// dirname(termBenchDir) is UNIQUE per test — mirrors bench-cmd-ab.test.ts's
// isolatedPaths (:177-190). The resource-profile store has no per-test reset
// (unlike the score dir createCandidate resets), so profile-seeding tests
// MUST isolate metaRoot or samples leak across tests/suite runs.
function isolatedPaths(): BenchPaths {
  const meta = tmpDir()
  const termBenchDir = path.join(meta, "tb")
  fs.mkdirSync(termBenchDir, { recursive: true })
  const tbRoot = path.join(meta, "tb-root")
  return fakeBenchPaths(termBenchDir, tbRoot) // metaRoot = dirname(<meta>/tb) = <meta>, unique
}

function writeTaskToml(tbRoot: string, task: string, cpus: number, memoryMb: number): void {
  fs.mkdirSync(path.join(tbRoot, task), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, task, "task.toml"), `[environment]\ncpus = ${cpus}\nmemory_mb = ${memoryMb}\n`)
}

test("cmdTaskLoad: with a seeded n>=3 profile, MeasCPU/MeasMB/n show measured values and the measured co-run preview can differ from the declared one", () => {
  const paths = isolatedPaths()
  // task-big: declared 3 cpu / 4096 MB — alone it consumes the WHOLE default
  // cpu budget (3), so under DECLARED weights it and task-small can never
  // co-run (task-small needs 1 more cpu than the 0 left over).
  writeTaskToml(paths.tbRoot, "task-big", 3, 4096)
  // task-small: declared 1 cpu / 2048 MB, never profiled — stays declared.
  writeTaskToml(paths.tbRoot, "task-small", 1, 2048)

  // Seed task-big's profile (default host class) with 3 samples so n>=3 and
  // avgCpu>0 → packingWeight uses the measured values, not the declared prior.
  // avgCpu = median(4.0/4.0, 4.0/4.0, 4.0/4.0) = 1.0; peakRssMb=1000 →
  // measured memoryMb = ceil(1000*1.2) = 1200. Both well under the declared
  // 3 cpu / 4096 MB, so measured task-big + task-small (1 cpu/2048 MB) fit
  // together under the default budget (3 cpu / 6144 MB) where the declared
  // weights could not.
  for (let i = 0; i < 3; i++) {
    updateResourceProfile(paths.metaRoot, "task-big", { cpuSeconds: 4.0, peakRssMb: 1000, wall: 4.0 })
  }

  const lines = captureLog(() => {
    cmdTaskLoad(paths, { tasks: ["task-big", "task-small"] })
  })
  const out = lines.join("\n")

  // Measured columns: task-big shows measured cpus=1, memoryMb=1200, n=3.
  expect(out).toMatch(/task-big[^\n]*\b1\b[^\n]*\b1200\b[^\n]*\b3\b/)
  // task-small was never profiled — placeholder dashes, not measured values.
  expect(out).toMatch(/task-small[^\n]*-[^\n]*-[^\n]*-/)

  // Declared preview: task-big alone consumes the whole budget → its own
  // solo group, distinct from task-small.
  expect(out).toContain("[task-big]")
  expect(out).toContain("[task-small]")

  // Measured preview block is present and labeled, and packs both tasks into
  // ONE group (measured task-big weight leaves enough budget for task-small)
  // — differing from the declared preview above.
  expect(out).toContain("co-run groups (measured packing — what run --parallel will pack):")
  expect(out).toContain("[task-big, task-small]")
})

test("cmdTaskLoad: with no profiles, MeasCPU/MeasMB/n show placeholders and the measured preview block is present with identical grouping", () => {
  const paths = isolatedPaths()
  writeFixtureTasks(paths.tbRoot)

  const lines = captureLog(() => {
    cmdTaskLoad(paths, { tasks: ["task-declared", "task-fallback"] })
  })
  const out = lines.join("\n")

  // Every row falls back to declared weights → placeholder dashes in the
  // measured columns for both tasks.
  expect(out).toMatch(/task-declared[^\n]*-[^\n]*-[^\n]*-/)
  expect(out).toMatch(/task-fallback[^\n]*-[^\n]*-[^\n]*-/)

  // Both preview blocks present...
  expect(out).toContain("co-run groups (preview")
  expect(out).toContain("co-run groups (measured packing — what run --parallel will pack):")

  // ...and with no profiles the measured preview equals the declared one:
  // extract the group lines following each header and compare.
  const declaredIdx = out.indexOf("co-run groups (preview")
  const measuredIdx = out.indexOf("co-run groups (measured packing")
  const declaredBlock = out.slice(declaredIdx, measuredIdx)
  const measuredBlock = out.slice(measuredIdx)
  const groupLines = (block: string): string[] => block.split("\n").filter((l) => l.trim().startsWith("["))
  expect(groupLines(declaredBlock)).toEqual(groupLines(measuredBlock))
  expect(groupLines(declaredBlock).length).toBeGreaterThan(0)
})
