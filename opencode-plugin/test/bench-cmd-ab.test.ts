import { test, expect, spyOn, mock } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdAb, type CmdAbArgs } from "../src/bench/cmd-ab.ts"
import type { RunOneTaskFn, RunTaskResult } from "../src/bench/cmd-run.ts"
import { loadMetaMetrics, plateauVerdict } from "../src/bench/report-loop.ts"
import {
  readScore,
  readAbVerdict,
  abAccepted,
  projectGlobalRoot,
  createCandidate,
  writeActive,
} from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"
import { readResourceProfile, hostClass, updateResourceProfile } from "../src/bench/resource-profile.ts"
import * as schedulerReal from "../src/bench/scheduler.ts"
import { PRESSURE_POLL_SEC } from "../src/bench/host-pressure.ts"
import { mcnemarExactOneSided } from "../src/bench/ab-stats.ts"

// Snapshot the REAL scheduler.ts exports at module-eval time (before any
// mock.module call below) — same pattern as bench-cmd-run.test.ts's own
// restoreScheduler: a plain `const` captures the function VALUE, surviving
// later mock.module swaps of the module's own export slots.
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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-cmd-ab-"))
}

function fakeBenchPaths(termBenchDir: string, tbRoot: string): BenchPaths {
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

function writeTaskTomls(tbRoot: string, tasks: string[]): void {
  for (const t of tasks) {
    fs.mkdirSync(path.join(tbRoot, t), { recursive: true })
    fs.writeFileSync(path.join(tbRoot, t, "task.toml"), "")
  }
}

function res(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
    reward: 1,
    elapsed: 1.0,
    turns: 3,
    toolUsage: {},
    events: [{ t: "text", text: "did stuff" }],
    timedOut: false,
    error: "",
    ...overrides,
  }
}

function setupCandidate(paths: BenchPaths, layer: "project-global", candidate: string): string {
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "baseline sys")
  writeActive(root, "v0", "baseline sys")
  createCandidate(root, candidate, "candidate sys")
  return root
}

/** cmdAb computes its provenance env block via `inContainerAgentVersion`
 * (a throwaway create+start+exec+rm), independent of the injected
 * `runOneTask` fake — every cmdAb call that runs to completion in this file
 * also injects this fake execFn so that lookup never spawns a real podman. */
const fakeExec = async () => ({ rc: 0, stdout: "opencode 0.0.0-test", stderr: "", timedOut: false })

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  return fn().finally(() => {
    errSpy.mockRestore()
    logSpy.mockRestore()
  })
}

// ── validations ──────────────────────────────────────────────────────────

test("cmdAb: --candidate not vN dies", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  await expect(
    cmdAb(paths, { layer: "project-global", candidate: "bogus", all: true } as CmdAbArgs, async () => res()),
  ).rejects.toThrow(BenchError)
})

test("cmdAb: role layer without --agent dies", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  await expect(
    cmdAb(paths, { layer: "project-role", candidate: "v1", all: true } as CmdAbArgs, async () => res()),
  ).rejects.toThrow(BenchError)
})

test("cmdAb: nonexistent candidate dies naming the have-list", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")
  await expect(
    cmdAb(paths, { layer: "project-global", candidate: "v99", all: true } as CmdAbArgs, async () => res()),
  ).rejects.toThrow(BenchError)
})

test("cmdAb: candidate === active version dies (nothing to compare)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const root = projectGlobalRoot(paths.metaRoot)
  createCandidate(root, "v0", "sys")
  writeActive(root, "v0", "sys")
  await expect(
    cmdAb(paths, { layer: "project-global", candidate: "v0", all: true } as CmdAbArgs, async () => res()),
  ).rejects.toThrow(BenchError)
})

test("cmdAb: no splits.json and no explicit tasks dies", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  setupCandidate(paths, "project-global", "v1")
  await expect(
    cmdAb(paths, { layer: "project-global", candidate: "v1" } as CmdAbArgs, async () => res()),
  ).rejects.toThrow(BenchError)
})

// ── legacy explicit-tasks mode ───────────────────────────────────────────

test("cmdAb: LEGACY explicit --tasks mode never records held-out (there is none) and can only reject/inconclusive", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["t1", "t2"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const root = setupCandidate(paths, "project-global", "v1")

  // Candidate always beats active — but legacy mode has no held-out split,
  // so decide() must stay "inconclusive" (never "accept").
  const fake: RunOneTaskFn = async (_p, task, model, variant, harnessMd) => {
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: isCandidateArm ? 1 : 0 })
  }

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1", "t2"], k: 1 }, fake, fakeExec))

  const verdict = readAbVerdict(root, "v1")
  expect(verdict).not.toBeNull()
  expect(verdict!.decision).not.toBe("accept")
  expect(abAccepted(verdict!)).toBe(false)
  // held-in arm B (the only phase in legacy mode) IS recorded.
  const score = readScore(root, "v1")
  expect(score.sessions.length).toBe(2)
})

// NOTE these two use a NESTED termBenchDir (`<tmp>/tb`) so metaRoot =
// dirname(termBenchDir) = <tmp> is UNIQUE per test. The other tests in this
// file pass the tmpDir directly as termBenchDir → metaRoot = os.tmpdir()
// (shared); they get away with it because createCandidate resets the score dir
// each run, but the resource-profile store has no such reset and would leak
// across tests + suite runs (n accumulates) — so profile tests MUST isolate.
function isolatedPaths(tasks: string[]): BenchPaths {
  const meta = tmpDir()
  const termBenchDir = path.join(meta, "tb")
  fs.mkdirSync(termBenchDir, { recursive: true })
  const tbRoot = path.join(meta, "tb-root")
  writeTaskTomls(tbRoot, tasks)
  return fakeBenchPaths(termBenchDir, tbRoot) // metaRoot = dirname(<meta>/tb) = <meta>, unique
}

test("cmdAb: memorizes the measured cgroup footprint for BOTH arms into the resource profile", async () => {
  const paths = isolatedPaths(["t1"])
  setupCandidate(paths, "project-global", "v1")

  // Both arms return a measured footprint (cpuSeconds=4.2 over wall=2.0 → 2.1).
  const fake: RunOneTaskFn = async () => res({ cpuSeconds: 4.2, peakRssMb: 300, elapsed: 2.0 })
  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, fakeExec))

  const prof = readResourceProfile(paths.metaRoot, "t1", hostClass())
  expect(prof).not.toBeNull()
  expect(prof!.n).toBe(2) // active arm + candidate arm both memorized
  expect(prof!.avgCpu).toBe(2.1) // median([4.2/2.0, 4.2/2.0])
  expect(prof!.peakRssMb).toBe(300)
})

test("cmdAb: a 0-turn arm (no cgroup reading) is NOT memorized (skips auth/transient)", async () => {
  const paths = isolatedPaths(["t1"])
  setupCandidate(paths, "project-global", "v1")

  // turns=0 + no cpuSeconds → the guard skips memorize (mirrors the store-record
  // discriminator; avoids skewing avgCpu with idle-wait failures).
  const fake: RunOneTaskFn = async () => res({ turns: 0, error: "agent_no_output" })
  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, fakeExec))

  expect(readResourceProfile(paths.metaRoot, "t1", hostClass())).toBeNull()
})

// ── OOM-escalation retry (Task 7): arm-level, independent per arm ──────────

test("cmdAb: an OOM-killed arm retries at 2× mem; verdict counts only the final result and the killed sample is NOT memorized", async () => {
  const paths = isolatedPaths(["t1"])
  fs.writeFileSync(path.join(paths.tbRoot, "t1", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  const root = setupCandidate(paths, "project-global", "v1")

  const armAMem: number[] = []
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, harnessMd, _at, _vt, _s, _d, resources) => {
    if (harnessMd.includes("candidate sys")) {
      // arm B (candidate): clean pass.
      return res({ reward: 1, oomKilled: false, cpuSeconds: 4, peakRssMb: 300, elapsed: 2.0 })
    }
    // arm A (active): first attempt OOM-killed fail, retry passes.
    armAMem.push(resources!.memoryMb)
    return armAMem.length === 1
      ? res({ reward: 0, oomKilled: true, cpuSeconds: 9, peakRssMb: 9000, elapsed: 2.0 })
      : res({ reward: 1, oomKilled: false, cpuSeconds: 4, peakRssMb: 300, elapsed: 2.0 })
  }

  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true }, fake, fakeExec),
  )

  // arm A retried once at double memory (2048 → 4096).
  expect(armAMem).toEqual([2048, 4096])
  // Verdict sees only the FINAL results — the killed attempt's 0 never lands.
  const verdict = readAbVerdict(root, "v1")!
  expect(verdict.taskResults!["t1"]!.active).toEqual([1])
  expect(verdict.taskResults!["t1"]!.candidate).toEqual([1])
  // Profile: 2 clean samples (arm-A retry + arm-B); the killed 9000MB peak is
  // never memorized.
  const prof = readResourceProfile(paths.metaRoot, "t1", hostClass())!
  expect(prof.n).toBe(2)
  expect(prof.peakRssMb).toBe(300)
})

test("cmdAb --parallel: task-pair banner leads with \\n, THEN the [task] prefix (not prefix-then-\\n) — final-review fix", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["t1"])
  const paths = fakeBenchPaths(dir, tbRoot)
  setupCandidate(paths, "project-global", "v1")

  const fake: RunOneTaskFn = async () => res({ reward: 1 })
  const lines: string[] = []
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  try {
    await cmdAb(
      paths,
      {
        layer: "project-global",
        candidate: "v1",
        tasks: ["t1"],
        k: 1,
        parallel: true,
        enforceResources: true,
        cpuBudget: 100,
        memBudget: 1_000_000,
      } as CmdAbArgs,
      fake,
      fakeExec,
    )
  } finally {
    errSpy.mockRestore()
  }

  // Orphaned-prefix bug would produce "[t1] \n=== ab t1 [held-in]: ..." (the
  // prefix on its own line, "===" on the next). The fix keeps the leading \n
  // first, so the "[task]" prefix sits directly on the same line as "===".
  const banner = lines.find((l) => l.includes("=== ab t1 [held-in]"))
  expect(banner).toBe("\n[t1] === ab t1 [held-in]: v1 vs active v0 ===")
})

// ── --min-cpus/--min-mem-mb resource floor (under --enforce-resources) ───

test("cmdAb --enforce-resources ON + --min-cpus/--min-mem-mb: runOneTask receives the floored footprint", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["t1"]) // no [environment] -> modal 1cpu/2048MB
  const paths = fakeBenchPaths(dir, tbRoot)
  setupCandidate(paths, "project-global", "v1")

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true, minCpus: 4, minMemMb: 8192 },
      fake,
      fakeExec,
    ),
  )
  expect(seenResources).toEqual({ cpus: 4, memoryMb: 8192 })
})

test("cmdAb --enforce-resources ON + floors below the declared footprint: declared footprint wins", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t1"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t1", "task.toml"), "[environment]\ncpus = 6\nmemory_mb = 16384\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  setupCandidate(paths, "project-global", "v1")

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true, minCpus: 4 },
      fake,
      fakeExec,
    ),
  )
  expect(seenResources).toEqual({ cpus: 6, memoryMb: 16384 })
})

test("cmdAb --enforce-resources ON, no --min-cpus/--min-mem-mb: byte-identical to before floors existed", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t1"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t1", "task.toml"), "[environment]\ncpus = 2\nmemory_mb = 4096\n")
  const paths = fakeBenchPaths(dir, tbRoot)
  setupCandidate(paths, "project-global", "v1")

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true }, fake, fakeExec),
  )
  expect(seenResources).toEqual({ cpus: 2, memoryMb: 4096 })
})

// ── B5: serial cap raise (raiseCapMeasured) + per-session cap provenance ─────

test("cmdAb --enforce-resources serial: seeded n≥3 profile raises the arm container memory cap (raiseCapMeasured)", async () => {
  const paths = isolatedPaths(["t1"])
  fs.writeFileSync(path.join(paths.tbRoot, "t1", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  setupCandidate(paths, "project-global", "v1")
  // Seed a trustworthy profile (n=3): peakRss 4096 → cap raised to ceil(4096*1.5)=6144.
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "t1", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true }, fake, fakeExec),
  )
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 6144 })
})

test("cmdAb --enforce-resources serial + --no-pack-measured: seeded profile ignored → declared cap", async () => {
  const paths = isolatedPaths(["t1"])
  fs.writeFileSync(path.join(paths.tbRoot, "t1", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  setupCandidate(paths, "project-global", "v1")
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "t1", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true, noPackMeasured: true } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  )
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 2048 })
})

test("cmdAb --enforce-resources serial: recorded arm-B session carries capMemoryMb (raised) + capRaised=true; unenforced omits", async () => {
  const paths = isolatedPaths(["t1"])
  fs.writeFileSync(path.join(paths.tbRoot, "t1", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  const root = setupCandidate(paths, "project-global", "v1")
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "t1", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  const fake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })

  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, enforceResources: true }, fake, fakeExec),
  )
  const rec = readScore(root, "v1").sessions[0]!
  expect(rec.capMemoryMb).toBe(6144)
  expect(rec.capRaised).toBe(true)
})

test("cmdAb without --enforce-resources: recorded arm-B session omits capMemoryMb/capRaised", async () => {
  const paths = isolatedPaths(["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  const fake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, fakeExec))
  const rec = readScore(root, "v1").sessions[0]!
  expect("capMemoryMb" in rec).toBe(false)
  expect("capRaised" in rec).toBe(false)
})

// ── split-based mode + the held-out-never-recorded invariant ─────────────

function writeSplitsFile(paths: BenchPaths, heldIn: string[], heldOut: string[]): void {
  writeTaskTomls(paths.tbRoot, [...heldIn, ...heldOut])
  fs.mkdirSync(path.dirname(paths.splitsFile), { recursive: true })
  fs.writeFileSync(
    paths.splitsFile,
    JSON.stringify({ schemaVersion: 1, seed: 1, source: "x", folds: [heldOut, heldIn], activeFold: 0, rotatedAt: null }),
  )
}

test("cmdAb --parallel: seeded profile → held-in schedule() items carry MEASURED pack while runOneTask gets the DECLARED/floored cap", async () => {
  // Nested termBenchDir so metaRoot is unique per test — the profile store has
  // no per-run reset (mirrors isolatedPaths' rationale above).
  const meta = tmpDir()
  const termBenchDir = path.join(meta, "tb")
  fs.mkdirSync(termBenchDir, { recursive: true })
  const tbRoot = path.join(meta, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)
  writeSplitsFile(paths, ["hi1"], ["ho1"]) // writes empty tomls (modal) + splits
  // declared prior for hi1: 1 cpu / 2048 MB
  fs.writeFileSync(path.join(tbRoot, "hi1", "task.toml"), "[environment]\ncpus = 1\nmemory_mb = 2048\n")
  setupCandidate(paths, "project-global", "v1")
  // Seed a trustworthy hi1 profile (n=3): avgCpu=3, peakRss 4096
  // → pack = { cpus: 3, memoryMb: ceil(4096*1.2)=4916 }
  // → cap  = { cpus: 1, memoryMb: max(2048, ceil(4096*1.5)=6144)=6144 }
  for (let i = 0; i < 3; i++) updateResourceProfile(paths.metaRoot, "hi1", { cpuSeconds: 3, peakRssMb: 4096, wall: 1 })

  let capturedItems: unknown = "unset"
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      if (capturedItems === "unset") capturedItems = a[0] // first (held-in) phase
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  let seenResources: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, _driver, resources) => {
    if (seenResources === "unset") seenResources = resources // first (held-in arm A) call
    return res({ reward: 1 })
  }

  try {
    await quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          parallel: true,
          enforceResources: true,
          cpuBudget: 100,
          memBudget: 1_000_000,
        } as CmdAbArgs,
        fake,
        fakeExec,
      ),
    )
  } finally {
    restoreScheduler()
  }
  // held-in scheduler packs against the MEASURED weight...
  expect(capturedItems).toEqual([{ key: "hi1", cpus: 3, memoryMb: 4916 }])
  // ...while the container cap stays the declared/floored envelope (+ measured lift).
  expect(seenResources).toEqual({ cpus: 1, memoryMb: 6144 })
})

test("cmdAb (mandatory invariant): held-out arm-B sessions are NEVER recorded into score.json, even when they pass", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["hi1", "hi2", "hi3", "hi4", "hi5", "hi6", "hi7", "hi8", "hi9", "hi10", "hi11", "hi12"], ["ho1", "ho2"])
  const root = setupCandidate(paths, "project-global", "v1")

  const seenTasks: { task: string; harnessMd: string }[] = []
  const fake: RunOneTaskFn = async (_p, task, model, variant, harnessMd) => {
    seenTasks.push({ task, harnessMd })
    // candidate arm always passes — if the invariant were broken, this would
    // show up as recorded held-out sessions in score.json below.
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: isCandidateArm ? 1 : 0, turns: 5 })
  }

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999 }, fake, fakeExec))

  const score = readScore(root, "v1")
  // Exactly 12 held-in sessions recorded (one per held-in task) — zero from
  // the 2 held-out tasks, regardless of their (passing) outcome.
  expect(score.sessions.length).toBe(12)
  expect(score.sessions.every((s) => s.note.startsWith("bench:hi"))).toBe(true)
  expect(score.sessions.some((s) => s.note.includes("ho1") || s.note.includes("ho2"))).toBe(false)

  // Both held-out tasks DID run (both arms), they're just not recorded.
  expect(seenTasks.filter((t) => t.task === "ho1" || t.task === "ho2").length).toBe(4) // 2 tasks x 2 arms
})

test("cmdAb: verdict written by cmdAb round-trips through readAbVerdict/abAccepted", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = Array.from({ length: 12 }, (_, i) => `hi${i}`)
  writeSplitsFile(paths, heldIn, ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")

  // Candidate wins every held-in pair decisively and doesn't regress held-out.
  const fake: RunOneTaskFn = async (_p, task, model, variant, harnessMd) => {
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: isCandidateArm ? 1 : 0, turns: 4 })
  }

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, alpha: 0.5, nonregressMargin: 0.5 }, fake, fakeExec))

  const verdict = readAbVerdict(root, "v1")
  expect(verdict).not.toBeNull()
  expect(verdict!.schemaVersion).toBe(2)
  expect(verdict!.decision).toBe("accept")
  expect(verdict!.winner).toBe("candidate")
  expect(abAccepted(verdict!)).toBe(true)
  expect(verdict!.heldIn).toBeDefined()
  expect(verdict!.heldOut).toBeDefined()
})

test("cmdAb: futility early-stop skips the held-out phase entirely and forces reject", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = Array.from({ length: 12 }, (_, i) => `hi${i}`)
  writeSplitsFile(paths, heldIn, ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")

  const seenTasks: string[] = []
  // candidate arm ALWAYS loses -> futility should trigger well before task 12.
  const fake: RunOneTaskFn = async (_p, task, model, variant, harnessMd) => {
    seenTasks.push(task)
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: isCandidateArm ? 0 : 1, turns: 2 })
  }

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 3 }, fake, fakeExec))

  expect(seenTasks.some((t) => t === "ho1")).toBe(false) // held-out phase never ran
  const verdict = readAbVerdict(root, "v1")!
  expect(verdict.decision).toBe("reject")
  expect(verdict.earlyStopped).toBe(true)
})

test("cmdAb: --no-store suppresses even held-in recording (verdict file still written)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  const fake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })
  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, noStore: true }, fake, fakeExec),
  )

  expect(readScore(root, "v1").sessions.length).toBe(0)
  expect(readAbVerdict(root, "v1")).not.toBeNull()
})

test("cmdAb: partial file is removed after a completed run, and --results-file gets a copy of the final verdict", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  setupCandidate(paths, "project-global", "v1")
  const resultsFile = path.join(dir, "ab-results.json")

  const fake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })
  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, resultsFile }, fake, fakeExec),
  )

  const root = projectGlobalRoot(paths.metaRoot)
  expect(fs.existsSync(path.join(root, "candidates", "v1", "ab-verdict.partial.json"))).toBe(false)
  expect(fs.existsSync(resultsFile)).toBe(true)
  const fromResultsFile = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(fromResultsFile.candidate).toBe("v1")
})

// ── driver selection (task-B3-brief.md) ───────────────────────────────────

test("cmdAb: default (no --driver) resolves the opencode driver, threading it into runOneTask and the verdict's env block", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  const seenDrivers: unknown[] = []
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, _at, _vt, _staging, driver) => {
    seenDrivers.push(driver?.id)
    return res({ reward: 1, turns: 3 })
  }
  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, fakeExec),
  )

  expect(seenDrivers.every((d) => d === "opencode")).toBe(true)
  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  expect((verdict["env"] as Record<string, unknown>)["driver"]).toBe("opencode")
})

test("cmdAb: unknown --driver id dies (BenchError) before any task runs", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  setupCandidate(paths, "project-global", "v1")

  let ran = false
  const fake: RunOneTaskFn = async () => {
    ran = true
    return res({ reward: 1, turns: 3 })
  }
  await expect(
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, driver: "nope" } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  ).rejects.toThrow(BenchError)
  expect(ran).toBe(false)
})

// ── version-probe rc gate (final-review fix 3) ─────────────────────────────

test("cmdAb: --driver claude-code + an 'unknown' version probe dies before any task runs", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  setupCandidate(paths, "project-global", "v1")

  let ran = false
  const fake: RunOneTaskFn = async () => {
    ran = true
    return res({ reward: 1, turns: 3 })
  }
  const unknownProbeExec = async (argv: string[]) => {
    if (argv[1] === "exec") return { rc: 127, stdout: "", stderr: "no such binary", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await expect(
    quiet(() =>
      cmdAb(
        paths,
        { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, driver: "claude-code" } as CmdAbArgs,
        fake,
        unknownProbeExec,
      ),
    ),
  ).rejects.toThrow(BenchError)
  expect(ran).toBe(false)
})

test("cmdAb: default driver (opencode) + an 'unknown' version probe still proceeds (lenient, unchanged)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  const fake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })
  const unknownProbeExec = async (argv: string[]) => {
    if (argv[1] === "exec") return { rc: 127, stdout: "", stderr: "no such binary", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, unknownProbeExec),
  )
  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  expect((verdict["env"] as Record<string, unknown>)["driver"]).toBe("opencode")
})

// ── budget-identity provenance (Loop-3 T6) ─────────────────────────────────
//
// Hermetic MhConfig seam: redirect META_HARNESS_HOME to a throwaway dir for
// the duration of the callback so readMhConfig()'s recordTimeouts read never
// touches the developer's real ~/.config/meta-harness/config.json.
async function withMetaHome<T>(recordTimeouts: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cmd-ab-config-"))
  if (recordTimeouts !== undefined) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ recordTimeouts }))
  }
  const saved = process.env["META_HARNESS_HOME"]
  process.env["META_HARNESS_HOME"] = dir
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env["META_HARNESS_HOME"]
    else process.env["META_HARNESS_HOME"] = saved
  }
}

test("cmdAb: verdict stamps top-level maxAgentTimeout + timeoutRecording=false (flag off)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  await withMetaHome(false, () =>
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, maxAgentTimeout: 900 }, async () => res(), fakeExec),
    ),
  )

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  expect(verdict["maxAgentTimeout"]).toBe(900)
  expect(verdict["timeoutRecording"]).toBe(false)
})

test("cmdAb: verdict stamps timeoutRecording=true when MhConfig.recordTimeouts is ON", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeTaskTomls(tbRoot, ["t1"])
  const root = setupCandidate(paths, "project-global", "v1")

  await withMetaHome(true, () =>
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, maxAgentTimeout: 300 }, async () => res(), fakeExec),
    ),
  )

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  expect(verdict["maxAgentTimeout"]).toBe(300)
  expect(verdict["timeoutRecording"]).toBe(true)
})

// ── budget-identity PRODUCER wiring onto the emitted "ab" meta-metric event
// (Loop-3 T7 gap fix) ───────────────────────────────────────────────────────
//
// T6 stamps maxAgentTimeout/timeoutRecording/env.resourceEnforcement into
// ab-verdict.json; T7 (report-loop.ts) reads those same 3 fields off
// MetaMetricEvent to segment the loop's trailing window by budget-identity.
// But the "ab" meta-metric event this file appends (near cmdAb's final
// verdict write) never carried them — so on a live meta-metrics.jsonl every
// event looked "legacy" and the segmentation never fired. These tests prove
// the emitted event now carries the run's actual values.
//
// NOTE: this file's shared `fakeBenchPaths(dir, tbRoot)` idiom treats `dir`
// itself AS `termBenchDir`, so `metaRoot` (= dirname(termBenchDir)) resolves
// to the shared OS tmp root, not a per-test directory — harmless for the
// existing tests (they only ever read/overwrite whole JSON files), but fatal
// for reading an APPEND-ONLY meta-metrics.jsonl, which would then accumulate
// events across every test (and every prior run) ever executed against that
// shared root. These new tests build a genuinely isolated BenchPaths instead
// (metaRoot IS the fresh mkdtemp dir, matching paths.ts's real metaRoot ->
// termBenchDir = metaRoot/term-bench2 relationship) so their sink is private.
function isolatedBenchPaths(): BenchPaths {
  const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mh-t7-cmdab-"))
  const termBenchDir = path.join(metaRoot, "term-bench2")
  const tbRoot = path.join(metaRoot, "tb-root")
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

function readMetaMetricsLines(metaRoot: string): Record<string, unknown>[] {
  const sink = path.join(metaRoot, ".meta-harness", "meta-metrics.jsonl")
  return fs
    .readFileSync(sink, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

test("cmdAb: emitted 'ab' meta-metric event carries the run's maxAgentTimeout/timeoutRecording/resourceEnforcement", async () => {
  const paths = isolatedBenchPaths()
  writeTaskTomls(paths.tbRoot, ["t1"])
  setupCandidate(paths, "project-global", "v1")

  await withMetaHome(true, () =>
    quiet(() =>
      cmdAb(
        paths,
        { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, maxAgentTimeout: 600, enforceResources: true },
        async () => res(),
        fakeExec,
      ),
    ),
  )

  const lines = readMetaMetricsLines(paths.metaRoot)
  const abEvent = lines.find((e) => e["event"] === "ab")!
  expect(abEvent).toBeDefined()
  expect(abEvent["maxAgentTimeout"]).toBe(600)
  expect(abEvent["timeoutRecording"]).toBe(true)
  expect((abEvent["env"] as Record<string, unknown>)["resourceEnforcement"]).toBe(true)
})

test("Loop-3 T7 integration: two REAL cmdAb runs at different maxAgentTimeout are no longer treated as one comparable bench-layer window", async () => {
  const paths = isolatedBenchPaths()
  writeTaskTomls(paths.tbRoot, ["t1"])
  setupCandidate(paths, "project-global", "v1")

  // Pre-change: operator has been running at maxAgentTimeout=600.
  await withMetaHome(false, () =>
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, maxAgentTimeout: 600 }, async () => res(), fakeExec),
    ),
  )
  // Post-change: operator bumps the wall to 900 (a real budget-identity change).
  await withMetaHome(false, () =>
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, maxAgentTimeout: 900 }, async () => res(), fakeExec),
    ),
  )

  const sink = path.join(paths.metaRoot, ".meta-harness", "meta-metrics.jsonl")
  const events = loadMetaMetrics([sink])
  const abEvents = events.filter((e) => e.event === "ab")
  expect(abEvents.length).toBe(2)
  expect(abEvents[0]!["maxAgentTimeout"]).toBe(600)
  expect(abEvents[1]!["maxAgentTimeout"]).toBe(900)

  // abK=2: without producer-side stamping both events would count toward one
  // window (n=2). With real budget-identity stamps, the 600s event is
  // excluded — only the current (900s) identity's 1 event counts.
  const verdict = plateauVerdict(events, 2)
  expect(verdict.bench["project-global"]!.n).toBe(1)
  expect(verdict.bench["project-global"]!.reason).toBe("insufficient data")
})

// ── --resume ident-check must see a top-level driver (regression) ─────────

test("cmdAb: partial written mid-run stamps a top-level driver matching runIdent, and --resume against it does not die on driver mismatch", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = ["hi0", "hi1"]
  writeSplitsFile(paths, heldIn, ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")
  const partialPath = path.join(root, "candidates", "v1", "ab-verdict.partial.json")

  // First run: complete hi0 normally, then blow up on hi1 (simulating a
  // mid-run crash) so the process aborts leaving only hi0's partial on disk
  // — never reaching the final-verdict write that deletes the partial.
  const crashingFake: RunOneTaskFn = async (_p, task) => {
    if (task === "hi1") throw new Error("simulated crash mid-run")
    return res({ reward: 1, turns: 3 })
  }

  await expect(
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999 }, crashingFake, fakeExec),
    ),
  ).rejects.toThrow("simulated crash mid-run")

  expect(fs.existsSync(partialPath)).toBe(true)
  const partial = JSON.parse(fs.readFileSync(partialPath, "utf-8")) as Record<string, unknown>
  // (a) the persisted partial must stamp a top-level `driver` matching the
  // run's driver id — resumeIdentCheck compares every runIdent key
  // (including `driver`) against this file's top-level fields.
  expect(partial["driver"]).toBe("opencode")

  // (b) --resume against this exact partial must NOT die on a driver
  // mismatch — full write-then-resume round trip, completing the rest of
  // the run (hi1 + held-out ho1).
  const resumingFake: RunOneTaskFn = async () => res({ reward: 1, turns: 3 })
  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, resume: true },
      resumingFake,
      fakeExec,
    ),
  )

  const verdict = readAbVerdict(root, "v1")
  expect(verdict).not.toBeNull()
})

// ── D2 invariant (task-3-brief.md, the ac0cd18 bug class): runIdent must
// NEVER gain a resourceEnforcement key ─────────────────────────────────────

test("cmdAb resume: resourceEnforcement is NOT a runIdent field (resumeIdentCheck's strict per-key compare never sees it), only an informational env stamp", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = ["hi0", "hi1"]
  writeSplitsFile(paths, heldIn, ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")
  const partialPath = path.join(root, "candidates", "v1", "ab-verdict.partial.json")

  // Same crash-mid-run trick as the driver-provenance regression test above
  // — produces a real on-disk partial file (flag OFF) without hand-rolling
  // a fixture.
  const crashingFake: RunOneTaskFn = async (_p, task) => {
    if (task === "hi1") throw new Error("simulated crash mid-run")
    return res({ reward: 1, turns: 3 })
  }

  await expect(
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999 } as CmdAbArgs, crashingFake, fakeExec),
    ),
  ).rejects.toThrow("simulated crash mid-run")

  const partial = JSON.parse(fs.readFileSync(partialPath, "utf-8")) as Record<string, unknown>
  // (a) NOT a top-level runIdent field — resumeIdentCheck iterates runIdent's
  // OWN keys and dies on `prev[k] !== v`; if resourceEnforcement had been
  // folded into runIdent, this pre-feature-shaped partial (flag off, no
  // top-level key) would die resuming under flag ON purely from the missing
  // top-level key, which is exactly the ac0cd18 class this task prevents.
  expect(Object.prototype.hasOwnProperty.call(partial, "resourceEnforcement")).toBe(false)
  // (b) IS present as informational provenance nested under env (default
  // off -> false).
  expect((partial["env"] as Record<string, unknown>)["resourceEnforcement"]).toBe(false)

  // Resuming under a DIFFERENT resourceEnforcement regime must die via the
  // separate coalescing guard's own "measurement regimes" message, not
  // resumeIdentCheck's generic per-key message — proving this is distinct
  // machinery sitting beside resumeIdentCheck, not a runIdent key.
  await expect(
    quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          minTasksBeforeStop: 999,
          resume: true,
          enforceResources: true,
        } as CmdAbArgs,
        async () => res({ reward: 1, turns: 3 }),
        fakeExec,
      ),
    ),
  ).rejects.toThrow(/resource/i)

  // Resuming under the SAME (matching, off) regime completes normally.
  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, resume: true } as CmdAbArgs,
      async () => res({ reward: 1, turns: 3 }),
      fakeExec,
    ),
  )
  expect(readAbVerdict(root, "v1")).not.toBeNull()
})

// ── --min-agent-timeout floor: env stamp + resume-ident (mirrors the ─────────
// resourceEnforcement guard above — the loosest-envelope floor is part of the
// budget-identity, so a resume under a DIFFERENT floor must be refused) ───────

test("cmdAb resume: minAgentTimeout is an informational env stamp (NOT a runIdent key); resuming under a different floor dies via the coalescing guard", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = ["hi0", "hi1"]
  writeSplitsFile(paths, heldIn, ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")
  const partialPath = path.join(root, "candidates", "v1", "ab-verdict.partial.json")

  // Crash mid-run WITH a floor set (3600s) → a real on-disk partial whose env
  // block carries minAgentTimeout=3600 (env-stamp-carries-floor coverage).
  const crashingFake: RunOneTaskFn = async (_p, task) => {
    if (task === "hi1") throw new Error("simulated crash mid-run")
    return res({ reward: 1, turns: 3 })
  }

  await expect(
    quiet(() =>
      cmdAb(
        paths,
        { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, minAgentTimeout: 3600 } as CmdAbArgs,
        crashingFake,
        fakeExec,
      ),
    ),
  ).rejects.toThrow("simulated crash mid-run")

  const partial = JSON.parse(fs.readFileSync(partialPath, "utf-8")) as Record<string, unknown>
  // (a) Present top-level in the verdict provenance (the budget-identity stamp,
  // alongside maxAgentTimeout) — budgetIdentityMatches reads it there — AND in
  // the env block. Crucially it is NOT a runIdent key (runIdent = layer/
  // candidate/baseline/model/k/activeFold/splitHash/driver): resumeIdentCheck's
  // strict per-key compare never sees it, so a pre-feature partial (no floor)
  // doesn't die on the missing key — the ac0cd18 class the separate guard below
  // avoids. Same top-level-in-verdict-but-not-runIdent shape maxAgentTimeout has.
  expect(partial["minAgentTimeout"]).toBe(3600)
  expect((partial["env"] as Record<string, unknown>)["minAgentTimeout"]).toBe(3600)

  // Resuming under a DIFFERENT floor (none) must die via the separate
  // coalescing guard's own "measurement regimes" message.
  await expect(
    quiet(() =>
      cmdAb(
        paths,
        { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, resume: true } as CmdAbArgs,
        async () => res({ reward: 1, turns: 3 }),
        fakeExec,
      ),
    ),
  ).rejects.toThrow(/minAgentTimeout|measurement regimes/i)

  // Resuming under the SAME floor (3600) completes normally.
  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, resume: true, minAgentTimeout: 3600 } as CmdAbArgs,
      async () => res({ reward: 1, turns: 3 }),
      fakeExec,
    ),
  )
  expect(readAbVerdict(root, "v1")).not.toBeNull()
})

test("cmdAb: --min-agent-timeout floor is APPLIED to task execution (raises a task's LOW declared agent timeout up to the floor)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  fs.mkdirSync(path.join(tbRoot, "t1"), { recursive: true })
  // task declares a LOW agent timeout (900s) — below the 3600s floor.
  fs.writeFileSync(path.join(tbRoot, "t1", "task.toml"), "[agent]\ntimeout_sec = 900\n")
  setupCandidate(paths, "project-global", "v1")

  // Capture the agentTimeout (6th positional arg) that actually reaches the run
  // — this is the value that would have stayed 900 under the item-1 bug (floor
  // stamped into budget-identity but never threaded into taskTimeouts).
  let seenAgentTimeout: unknown = "unset"
  const fake: RunOneTaskFn = async (_p, _t, _m, _v, _h, agentTimeout) => {
    if (seenAgentTimeout === "unset") seenAgentTimeout = agentTimeout
    return res({ reward: 1 })
  }

  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1, minAgentTimeout: 3600 } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  )
  expect(seenAgentTimeout).toBe(3600)
})

// ── --parallel: canonical-order early-stop + postStop (task-7-brief.md) ─────

interface FakeState {
  seen: string[] // every runOneTask call's task (arm A + arm B)
  launched: string[] // each task once, at its first arm — launch order
  maxConcurrent: number // peak concurrent in-flight arms across all tasks
}

/** A deterministic injected runner: per-task pass/fail outcome + a per-task
 * delay so the scheduler completes tasks OUT of canonical order. Tracks
 * launch order + peak concurrency so a parallel run is provably concurrent
 * (a serial fallback pins maxConcurrent at 1). */
function scriptedFake(opts: {
  outcome: (task: string, isCandidate: boolean) => number
  delayMs?: (task: string) => number
  state: FakeState
}): RunOneTaskFn {
  const started = new Set<string>()
  let inflight = 0
  return async (_p, task, _m, _v, harnessMd) => {
    if (!started.has(task)) {
      started.add(task)
      opts.state.launched.push(task)
    }
    opts.state.seen.push(task)
    inflight++
    opts.state.maxConcurrent = Math.max(opts.state.maxConcurrent, inflight)
    try {
      const d = opts.delayMs?.(task) ?? 0
      if (d > 0) await new Promise((r) => setTimeout(r, d))
      const isCandidate = harnessMd.includes("candidate sys")
      return res({ reward: opts.outcome(task, isCandidate), turns: 3 })
    } finally {
      inflight--
    }
  }
}

function freshState(): FakeState {
  return { seen: [], launched: [], maxConcurrent: 0 }
}

/** Tasks that a completed verdict actually counted: non-error AND non-postStop
 * — the exact `counted` view verdictDict derives every field from. */
function countedKeys(verdict: Record<string, unknown>): string[] {
  const tr = verdict["taskResults"] as Record<string, { error?: string; postStop?: boolean }>
  return Object.entries(tr)
    .filter(([, r]) => !r.error && !r.postStop)
    .map(([t]) => t)
    .sort()
}

const HELD_IN_7 = ["hi0", "hi1", "hi2", "hi3", "hi4", "hi5", "hi6"]
// Distinct per-task delays → a shuffled completion order (hi2, hi4, hi0, hi1,
// hi3, hi5, hi6) that is deliberately NOT canonical, so hi4 lands (index 4)
// before hi3 (index 3) — exercising the "completed-early but consumed-after-
// stop → postStop" path, not just store-time tagging.
const SHUFFLE_DELAYS: Record<string, number> = { hi0: 50, hi1: 80, hi2: 20, hi3: 90, hi4: 40, hi5: 110, hi6: 130 }
// candidate loses every task → futility. minTasksBeforeStop=4 makes the rule
// fire right after the 4th consumed task (hi3, index 3): c-b=4 ≥ 3, done ≥ 4.
const CAND_LOSES = (_t: string, isCand: boolean): number => (isCand ? 0 : 1)

async function runAb(parallel: boolean, extra: Partial<CmdAbArgs>, state: FakeState) {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, HELD_IN_7, ["ho0"])
  const root = setupCandidate(paths, "project-global", "v1")
  const fake = scriptedFake({ outcome: CAND_LOSES, delayMs: (t) => SHUFFLE_DELAYS[t] ?? 0, state })
  const parallelArgs: Partial<CmdAbArgs> = parallel
    ? { parallel: true, enforceResources: true, cpuBudget: 100, memBudget: 1_000_000 }
    : {}
  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 4, ...parallelArgs, ...extra } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  )
  return readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
}

test("ab --parallel sequential equivalence: out-of-order completions → identical verdictDict decision fields", async () => {
  const serialState = freshState()
  const parallelState = freshState()
  const serial = await runAb(false, {}, serialState)
  const parallel = await runAb(true, {}, parallelState)

  // decision + counted set + nTasks/candidateRate/activeRate all byte-identical
  expect(parallel["decision"]).toBe(serial["decision"])
  expect(parallel["decision"]).toBe("reject")
  expect(parallel["nTasks"]).toBe(serial["nTasks"])
  expect(parallel["nTasks"]).toBe(4)
  expect(parallel["candidateRate"]).toBe(serial["candidateRate"])
  expect(parallel["activeRate"]).toBe(serial["activeRate"])
  expect(parallel["candidateRate"]).toBe(0)
  expect(parallel["activeRate"]).toBe(1)
  expect(countedKeys(parallel)).toEqual(countedKeys(serial))
  expect(countedKeys(serial)).toEqual(["hi0", "hi1", "hi2", "hi3"])

  // Completion order really was shuffled (hi2/hi4 finished before hi3) —
  // proving equivalence held despite non-canonical completion.
  const parallelHeldInLaunched = parallelState.launched.filter((t) => t.startsWith("hi"))
  expect(parallelHeldInLaunched.length).toBe(7) // full drain: every held-in task launched
  expect(parallelState.maxConcurrent).toBeGreaterThan(1) // genuinely concurrent

  // Serial stopped at 4 tasks; parallel drained all 7 but tagged the 3 that
  // completed after the stop fired postStop (excluded from the counted set).
  const serialHeldIn = new Set(serialState.seen.filter((t) => t.startsWith("hi")))
  expect(serialHeldIn.size).toBe(4)
  const trFull = parallel["taskResults"] as Record<string, { postStop?: boolean }>
  for (const t of ["hi4", "hi5", "hi6"]) expect(trFull[t]!.postStop).toBe(true)
})

test("postStop entries excluded from nTasks/candidateRate/activeRate but present in partial taskResults", async () => {
  const state = freshState()
  const verdict = await runAb(true, {}, state)

  // The full map (same serialization the in_progress partial writes) carries
  // all 7 held-in tasks, incl. the 3 postStop ones…
  const tr = verdict["taskResults"] as Record<string, { postStop?: boolean; candidate: number[] }>
  const heldInKeys = Object.keys(tr).filter((t) => t.startsWith("hi"))
  expect(heldInKeys.sort()).toEqual(HELD_IN_7)
  expect(tr["hi4"]!.postStop).toBe(true)
  expect(tr["hi5"]!.postStop).toBe(true)
  expect(tr["hi6"]!.postStop).toBe(true)
  // …but they are absent from every derived count.
  expect(verdict["nTasks"]).toBe(4)
  expect(verdict["candidateRate"]).toBe(0)
  expect(verdict["activeRate"]).toBe(1)
  // heldIn paired-stats block also excludes them: 4 counted pairs, not 7.
  expect((verdict["heldIn"] as { nPairs: number }).nPairs).toBe(4)
})

test("scheduler instantiated per phase: no held-out task launches before held-in earlyStopped resolves", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = ["hi0", "hi1", "hi2", "hi3"]
  const heldOut = ["ho0", "ho1"]
  writeSplitsFile(paths, heldIn, heldOut)
  const root = setupCandidate(paths, "project-global", "v1")

  // Candidate WINS every pair (no futility) so the held-out phase runs. Held-in
  // arms are slow, held-out arms fast: a shared/overlapping scheduler would let
  // a held-out task launch while held-in is still draining. Fresh-per-phase +
  // the await between phases forbids it.
  const state = freshState()
  const fake = scriptedFake({
    outcome: (_t, isCand) => (isCand ? 1 : 0),
    delayMs: (t) => (t.startsWith("hi") ? 60 : 5),
    state,
  })
  await quiet(() =>
    cmdAb(
      paths,
      {
        layer: "project-global",
        candidate: "v1",
        k: 1,
        alpha: 0.5,
        nonregressMargin: 0.5,
        parallel: true,
        enforceResources: true,
        cpuBudget: 100,
        memBudget: 1_000_000,
      } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  )

  // Held-in ran genuinely concurrently…
  expect(state.maxConcurrent).toBeGreaterThan(1)
  // …and EVERY held-in launch precedes EVERY held-out launch.
  const lastHeldIn = state.launched.reduce((acc, t, i) => (t.startsWith("hi") ? i : acc), -1)
  const firstHeldOut = state.launched.findIndex((t) => t.startsWith("ho"))
  expect(firstHeldOut).toBeGreaterThan(lastHeldIn)
  // Sanity: the held-out phase actually happened (candidate won, so accept).
  expect(readAbVerdict(root, "v1")!.decision).toBe("accept")
})

test("serial ab: postStop never set; verdict byte-identical to today (existing snapshot)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  const heldIn = Array.from({ length: 12 }, (_, i) => `hi${i}`)
  writeSplitsFile(paths, heldIn, ["ho0"])
  const root = setupCandidate(paths, "project-global", "v1")

  const fake: RunOneTaskFn = async (_p, _t, _m, _v, harnessMd) =>
    res({ reward: harnessMd.includes("candidate sys") ? 1 : 0, turns: 3 })
  await quiet(() =>
    cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, alpha: 0.5, nonregressMargin: 0.5 }, fake, fakeExec),
  )

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  const tr = verdict["taskResults"] as Record<string, { postStop?: boolean }>
  // A serial run must NEVER tag postStop on any result.
  for (const r of Object.values(tr)) expect(r.postStop).toBeUndefined()
  // And the verdict is a normal accept over all 13 counted tasks.
  expect(verdict["decision"]).toBe("accept")
  expect(verdict["nTasks"]).toBe(13)
})

// ── --resume --parallel of an already earlyStopped partial (D5 equivalence
// fix): a partial written by a parallel run that crashed AFTER the futility
// stop had fired (earlyStopped: true persisted) but BEFORE full drain still
// carries pending held-in tasks that were never launched. Resuming it under
// --parallel must do nothing — same as serial's `if (earlyStopped) break` —
// not launch the held-in stragglers. ──────────────────────────────────────

test("ab --parallel resume: earlyStopped partial with pending held-in tasks launches nothing, matching serial's counted set", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, HELD_IN_7, ["ho0"])
  const root = setupCandidate(paths, "project-global", "v1")
  const partialPath = path.join(root, "candidates", "v1", "ab-verdict.partial.json")

  // First run: candidate loses every task (futility fires once 4 held-in
  // tasks are consumed, minTasksBeforeStop=4), but hi6 throws — simulating a
  // mid-run crash — so the process aborts leaving a partial on disk with
  // earlyStopped: true (already latched by the time hi6 is reached) and hi6
  // itself absent from taskResults (never completed → "pending").
  const crashFake: RunOneTaskFn = async (_p, task, _m, _v, harnessMd) => {
    if (task === "hi6") throw new Error("simulated crash mid-run")
    const isCandidate = harnessMd.includes("candidate sys")
    return res({ reward: CAND_LOSES(task, isCandidate), turns: 3 })
  }
  await expect(
    quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          minTasksBeforeStop: 4,
          parallel: true,
          enforceResources: true,
          cpuBudget: 100,
          memBudget: 1_000_000,
        } as CmdAbArgs,
        crashFake,
        fakeExec,
      ),
    ),
  ).rejects.toThrow()

  expect(fs.existsSync(partialPath)).toBe(true)
  const partial = JSON.parse(fs.readFileSync(partialPath, "utf-8")) as Record<string, unknown>
  expect(partial["earlyStopped"]).toBe(true)
  const partialTr = partial["taskResults"] as Record<string, unknown>
  expect(partialTr["hi6"]).toBeUndefined() // never completed — pending

  // Second run: --resume --parallel against that partial. No task (held-in
  // straggler or held-out) may be launched — the phase must do nothing, per
  // serial's entry-guard semantics.
  const resumeState = freshState()
  const resumeFake = scriptedFake({ outcome: CAND_LOSES, state: resumeState })
  await quiet(() =>
    cmdAb(
      paths,
      {
        layer: "project-global",
        candidate: "v1",
        k: 1,
        minTasksBeforeStop: 4,
        parallel: true,
        enforceResources: true,
        cpuBudget: 100,
        memBudget: 1_000_000,
        resume: true,
      } as CmdAbArgs,
      resumeFake,
      fakeExec,
    ),
  )

  expect(resumeState.launched).toEqual([]) // zero new task launches, incl. hi6

  const resumedVerdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  expect(resumedVerdict["earlyStopped"]).toBe(true)

  // Ground truth: an uninterrupted serial run over the same scripted outcomes
  // stops at exactly hi0..hi3 (see the equivalence test above). The resumed
  // parallel verdict's counted set must match it exactly — not include hi6.
  const serialState = freshState()
  const serial = await runAb(false, {}, serialState)
  expect(countedKeys(resumedVerdict)).toEqual(countedKeys(serial))
  expect(countedKeys(resumedVerdict)).toEqual(["hi0", "hi1", "hi2", "hi3"])
})

// ── oauth-parallel freshness gate, Task 2 part B: args.canLaunch → schedule()
// ─────────────────────────────────────────────────────────────────────────
// cli.ts's main() computes the launch-guard (buildOauthParallelCanLaunch) and
// sets it as internal-only wiring on CmdAbArgs.canLaunch BEFORE calling
// cmdAb — this test pins that cmd-ab.ts threads whatever is on
// `args.canLaunch` straight through as schedule()'s 4th param for BOTH phases
// (held-in and held-out), unchanged (undefined by default — byte-identical
// to before this gate existed). Placed LAST so its mock.module of
// scheduler.ts (restored in finally) can't bleed into the real-schedule
// --parallel tests above even if a restore is imperfect.
test("ab --parallel: args.canLaunch (when set) is threaded into EVERY schedule() call (both phases); absent by default", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["hi0"], ["ho0"])
  setupCandidate(paths, "project-global", "v1")

  const capturedCanLaunches: unknown[] = []
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      capturedCanLaunches.push(a[3])
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const marker = () => true
  const fake: RunOneTaskFn = async () => res({ reward: 1 })
  try {
    await quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          parallel: true,
          enforceResources: true,
          cpuBudget: 100,
          memBudget: 1_000_000,
          canLaunch: marker,
        } as CmdAbArgs,
        fake,
        fakeExec,
      ),
    )
  } finally {
    restoreScheduler()
  }

  // Both phases (held-in + held-out) call schedule() — every call must get
  // the exact same marker.
  expect(capturedCanLaunches.length).toBeGreaterThanOrEqual(1)
  for (const c of capturedCanLaunches) expect(c).toBe(marker)
})

test("ab --parallel: args.canLaunch absent by default — every schedule() call gets undefined (unbounded, byte-identical)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["hi0"], ["ho0"])
  setupCandidate(paths, "project-global", "v1")

  const capturedCanLaunches: unknown[] = []
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      capturedCanLaunches.push(a[3])
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const fake: RunOneTaskFn = async () => res({ reward: 1 })
  try {
    await quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          parallel: true,
          enforceResources: true,
          cpuBudget: 100,
          memBudget: 1_000_000,
        } as CmdAbArgs,
        fake,
        fakeExec,
      ),
    )
  } finally {
    restoreScheduler()
  }

  expect(capturedCanLaunches.length).toBeGreaterThanOrEqual(1)
  for (const c of capturedCanLaunches) expect(c).toBeUndefined()
})

// ── host-pressure gate, plan S3: args.pressureGate → schedule()'s 5th arg AND
// PRESSURE_POLL_SEC * 1000 → schedule()'s 6th arg (pausePollMs), for BOTH
// phases. The gate closure is ONE shared per-command sensor (cli.ts's
// buildPressureGate builds it once), so every schedule() call gets the exact
// same gate reference and the same poll cadence. ────────────────────────────
test("ab --parallel: args.pressureGate + PRESSURE_POLL_SEC*1000 reach EVERY schedule() call as the 5th and 6th args", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["hi0"], ["ho0"])
  setupCandidate(paths, "project-global", "v1")

  const capturedPauseGates: unknown[] = []
  const capturedPausePollMs: unknown[] = []
  mock.module("../src/bench/scheduler.ts", () => ({
    schedule: (...a: unknown[]) => {
      capturedPauseGates.push(a[4])
      capturedPausePollMs.push(a[5])
      return (realSchedule as (...x: unknown[]) => unknown)(...a)
    },
    AsyncMutex: realAsyncMutex,
    DEFAULT_BUDGET: realDefaultBudget,
  }))

  const gate = () => false
  const fake: RunOneTaskFn = async () => res({ reward: 1 })
  try {
    await quiet(() =>
      cmdAb(
        paths,
        {
          layer: "project-global",
          candidate: "v1",
          k: 1,
          parallel: true,
          enforceResources: true,
          cpuBudget: 100,
          memBudget: 1_000_000,
          pressureGate: gate,
        } as CmdAbArgs,
        fake,
        fakeExec,
      ),
    )
  } finally {
    restoreScheduler()
  }

  expect(capturedPauseGates.length).toBeGreaterThanOrEqual(1)
  for (const g of capturedPauseGates) expect(g).toBe(gate)
  for (const ms of capturedPausePollMs) expect(ms).toBe(PRESSURE_POLL_SEC * 1000)
})

// ── W1a: time-to-resolve — verdict speed block, agentElapsedSec preference,
// postStop exclusion, and old-shape --resume compatibility ─────────────────

test("cmdAb: verdict speed block reports paired agent-phase elapsed stats over held-in AND held-out", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["t1", "t2"], ["h1"])
  const root = setupCandidate(paths, "project-global", "v1")

  // t1: candidate faster (10 < 20). t2: candidate slower (30 > 10). h1 (held-
  // out): a tie (5 == 5). Both arms always pass, so every run-pair qualifies.
  const elapsedByTaskArm: Record<string, { candidate: number; active: number }> = {
    t1: { candidate: 10, active: 20 },
    t2: { candidate: 30, active: 10 },
    h1: { candidate: 5, active: 5 },
  }
  const fake: RunOneTaskFn = async (_p, task, _m, _v, harnessMd) => {
    const isCandidateArm = harnessMd.includes("candidate sys")
    const e = elapsedByTaskArm[task]!
    return res({ reward: 1, agentElapsedSec: isCandidateArm ? e.candidate : e.active })
  }

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1 }, fake, fakeExec))

  const verdict = readAbVerdict(root, "v1")!
  const speedHi = verdict.speed!.heldIn!
  expect(speedHi.nPairs).toBe(2)
  expect(speedHi.nTasks).toBe(2)
  expect(speedHi.medianCandidate).toBe(20) // median([10,30])
  expect(speedHi.medianActive).toBe(15) // median([20,10])
  // median over PER-PAIR ratios ([10/20, 30/10] → 1.75) — deliberately NOT
  // the ratio of pooled medians (20/15 ≈ 1.333); this fixture discriminates.
  expect(speedHi.medianRatio).toBeCloseTo(1.75, 4)
  expect(speedHi.fasterB).toBe(1) // t1: candidate faster
  expect(speedHi.slowerC).toBe(1) // t2: active faster
  expect(speedHi.signTestP).toBeCloseTo(mcnemarExactOneSided(1, 1), 9)

  const speedHo = verdict.speed!.heldOut!
  expect(speedHo.nPairs).toBe(1)
  expect(speedHo.medianRatio).toBeCloseTo(1.0, 9) // tie
})

test("cmdAb: candidateElapsed/activeElapsed prefer agentElapsedSec over elapsed when both are present", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  writeTaskTomls(tbRoot, ["t1"])
  const paths = fakeBenchPaths(dir, tbRoot)
  const root = setupCandidate(paths, "project-global", "v1")

  // Both arms return a large, easily-distinguished elapsed AND agentElapsedSec
  // — the pushed value must be the agentElapsedSec one, never the full-
  // lifecycle elapsed (which would dilute the signal with infra noise).
  const fake: RunOneTaskFn = async () => res({ reward: 1, agentElapsedSec: 7, elapsed: 999 })

  await quiet(() => cmdAb(paths, { layer: "project-global", candidate: "v1", tasks: ["t1"], k: 1 }, fake, fakeExec))

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  const tr = verdict["taskResults"] as Record<string, { candidateElapsed?: number[]; activeElapsed?: number[] }>
  expect(tr["t1"]!.candidateElapsed).toEqual([7])
  expect(tr["t1"]!.activeElapsed).toEqual([7])
})

test("cmdAb --parallel: postStop entries excluded from the speed block too (not just reward counts)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, HELD_IN_7, ["ho0"])
  const root = setupCandidate(paths, "project-global", "v1")

  // hi4/hi5/hi6 (the postStop-tagged tasks under this exact shuffle — see
  // SHUFFLE_DELAYS/CAND_LOSES's header comment above) get BOTH arms passing
  // with a real, distinguishable elapsed pair — they WOULD contribute a
  // speed pair if counted. hi0-hi3 keep the candidate-always-loses reward
  // pattern that drives the futility stop (already excluded from speed via
  // the reward rule, independent of postStop).
  const postStopTasks = new Set(["hi4", "hi5", "hi6"])
  const outcome = (t: string, isCand: boolean): number => (postStopTasks.has(t) ? 1 : isCand ? 0 : 1)
  const elapsedFor = (t: string, isCand: boolean): number | undefined =>
    postStopTasks.has(t) ? (isCand ? 5 : 10) : undefined

  const state = freshState()
  const started = new Set<string>()
  let inflight = 0
  const fake: RunOneTaskFn = async (_p, task, _m, _v, harnessMd) => {
    if (!started.has(task)) {
      started.add(task)
      state.launched.push(task)
    }
    state.seen.push(task)
    inflight++
    state.maxConcurrent = Math.max(state.maxConcurrent, inflight)
    try {
      const d = SHUFFLE_DELAYS[task] ?? 0
      if (d > 0) await new Promise((r) => setTimeout(r, d))
      const isCandidate = harnessMd.includes("candidate sys")
      const overrides: Partial<RunTaskResult> = { reward: outcome(task, isCandidate), turns: 3 }
      const e = elapsedFor(task, isCandidate)
      if (e !== undefined) overrides.agentElapsedSec = e
      return res(overrides)
    } finally {
      inflight--
    }
  }

  await quiet(() =>
    cmdAb(
      paths,
      {
        layer: "project-global",
        candidate: "v1",
        k: 1,
        minTasksBeforeStop: 4,
        parallel: true,
        enforceResources: true,
        cpuBudget: 100,
        memBudget: 1_000_000,
      } as CmdAbArgs,
      fake,
      fakeExec,
    ),
  )

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  const tr = verdict["taskResults"] as Record<string, { postStop?: boolean }>
  for (const t of ["hi4", "hi5", "hi6"]) expect(tr[t]!.postStop).toBe(true)
  // If hi4-hi6 had been counted, they'd form 3 real pairs — instead the
  // speed block sees none (byte-identical to the reward exclusion).
  expect(verdict["speed"]).toEqual({ heldIn: null, heldOut: null })
})

test("cmdAb --resume: old-shape partial entries (no elapsed arrays) simply drop out of speed stats", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(dir, tbRoot)
  writeSplitsFile(paths, ["hi0", "hi1"], ["ho1"])
  const root = setupCandidate(paths, "project-global", "v1")
  const partialPath = path.join(root, "candidates", "v1", "ab-verdict.partial.json")

  // First run: complete hi0 (both pass, real elapsed pair), then crash on
  // hi1 — leaves a NEW-shape partial (candidateElapsed/activeElapsed present)
  // for hi0 only, matching the driver-mismatch resume test's crash technique.
  const crashingFake: RunOneTaskFn = async (_p, task, _m, _v, harnessMd) => {
    if (task === "hi1") throw new Error("simulated crash mid-run")
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: 1, turns: 3, agentElapsedSec: isCandidateArm ? 5 : 10 })
  }
  await expect(
    quiet(() =>
      cmdAb(paths, { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999 }, crashingFake, fakeExec),
    ),
  ).rejects.toThrow("simulated crash mid-run")
  expect(fs.existsSync(partialPath)).toBe(true)

  // Downgrade hi0's entry to the PRE-W1a shape by stripping the elapsed
  // arrays cmd-ab.ts just wrote — simulating a partial produced before this
  // feature existed, which --resume must still tolerate.
  const partial = JSON.parse(fs.readFileSync(partialPath, "utf-8")) as Record<string, unknown>
  const tr = partial["taskResults"] as Record<string, Record<string, unknown>>
  expect(tr["hi0"]!["candidateElapsed"]).toBeDefined() // sanity: our own code did write it
  delete tr["hi0"]!["candidateElapsed"]
  delete tr["hi0"]!["activeElapsed"]
  fs.writeFileSync(partialPath, JSON.stringify(partial))

  // Resume: complete hi1 (both pass, its OWN real elapsed pair) + held-out.
  const resumingFake: RunOneTaskFn = async (_p, task, _m, _v, harnessMd) => {
    const isCandidateArm = harnessMd.includes("candidate sys")
    return res({ reward: 1, turns: 3, agentElapsedSec: isCandidateArm ? 7 : 14 })
  }
  await quiet(() =>
    cmdAb(
      paths,
      { layer: "project-global", candidate: "v1", k: 1, minTasksBeforeStop: 999, resume: true },
      resumingFake,
      fakeExec,
    ),
  )

  const verdict = readAbVerdict(root, "v1")! as unknown as Record<string, unknown>
  const finalTr = verdict["taskResults"] as Record<string, { candidateElapsed?: number[] }>
  // hi0's stripped-old-shape entry survived --resume verbatim — no crash, no
  // backfill — and stays elapsed-less.
  expect(finalTr["hi0"]!.candidateElapsed).toBeUndefined()
  // hi1 (freshly run post-resume) DOES carry a real pair.
  expect(finalTr["hi1"]!.candidateElapsed).toEqual([7])
  // Speed stats reflect ONLY the elapsed-having pair (hi1) — hi0 dropped out.
  const speed = verdict["speed"] as { heldIn: { nPairs: number; nTasks: number } | null }
  expect(speed.heldIn).not.toBeNull()
  expect(speed.heldIn!.nPairs).toBe(1)
  expect(speed.heldIn!.nTasks).toBe(1)
})
