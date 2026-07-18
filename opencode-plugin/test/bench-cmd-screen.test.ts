import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import type { CmdRunArgs } from "../src/bench/cmd-run.ts"
import {
  cmdScreen,
  rankScreens,
  type CmdScreenArgs,
  type ScreenEntry,
  type ScreenResultsLike,
} from "../src/bench/cmd-screen.ts"
import { main } from "../src/bench/cli.ts"
import { BenchError } from "../src/bench/util.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-cmd-screen-"))
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

function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      errSpy.mockRestore()
      logSpy.mockRestore()
    })
}

function completeResults(overrides: Partial<ScreenResultsLike> = {}): ScreenResultsLike {
  return {
    n_pass: 0,
    n_total: 0,
    tasks: {},
    status: "complete",
    ...overrides,
  }
}

function writeResultsFile(file: string, results: ScreenResultsLike): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
}

// ── rankScreens (pure) ──────────────────────────────────────────────────

test("rankScreens: orders by nPass desc", () => {
  const entries: ScreenEntry[] = [
    { candidate: "v1", results: completeResults({ n_pass: 1, n_total: 3, tasks: {} }) },
    { candidate: "v2", results: completeResults({ n_pass: 3, n_total: 3, tasks: {} }) },
    { candidate: "v3", results: completeResults({ n_pass: 2, n_total: 3, tasks: {} }) },
  ]
  const ranked = rankScreens(entries)
  expect(ranked.map((r) => r.candidate)).toEqual(["v2", "v3", "v1"])
})

test("rankScreens: tie on nPass -> passElapsed asc decides", () => {
  const entries: ScreenEntry[] = [
    {
      candidate: "slow",
      results: completeResults({
        n_pass: 1,
        n_total: 1,
        tasks: { t1: { rewards: [1], elapsed: [20], turns: [3], errors: [""] } },
      }),
    },
    {
      candidate: "fast",
      results: completeResults({
        n_pass: 1,
        n_total: 1,
        tasks: { t1: { rewards: [1], elapsed: [5], turns: [3], errors: [""] } },
      }),
    },
  ]
  const ranked = rankScreens(entries)
  expect(ranked.map((r) => r.candidate)).toEqual(["fast", "slow"])
  expect(ranked[0]!.passElapsed).toBe(5)
  expect(ranked[1]!.passElapsed).toBe(20)
})

test("rankScreens: passElapsed sums ONLY passing tasks — a real (nonzero-elapsed) fail and a setup_failed (0-elapsed) task are both excluded from the sum", () => {
  const entries: ScreenEntry[] = [
    {
      candidate: "v1",
      results: completeResults({
        n_pass: 1,
        n_total: 3,
        tasks: {
          t1: { rewards: [1], elapsed: [10], turns: [5], errors: [""] }, // pass, counted
          t2: { rewards: [0], elapsed: [50], turns: [8], errors: [""] }, // real fail, nonzero elapsed — excluded
          t3: { rewards: [0], elapsed: [0.0], turns: [0], errors: ["setup_failed"] }, // setup_failed — excluded
        },
      }),
    },
  ]
  const ranked = rankScreens(entries)
  // Summing ALL tasks would give 60 (10+50+0); passing-only gives 10.
  expect(ranked[0]!.passElapsed).toBe(10)
  expect(ranked[0]!.missingElapsed).toBe(false)
})

test("rankScreens: a passing task with missing/empty elapsed is excluded from the sum but flips missingElapsed, and complete-data candidates rank ahead on an exact tie", () => {
  const entries: ScreenEntry[] = [
    {
      candidate: "incomplete",
      results: completeResults({
        n_pass: 2,
        n_total: 2,
        tasks: {
          t1: { rewards: [1], elapsed: [10], turns: [3], errors: [""] },
          t2: { rewards: [1], elapsed: [], turns: [3], errors: [""] }, // passed but no elapsed reading
        },
      }),
    },
    {
      candidate: "complete",
      results: completeResults({
        n_pass: 2,
        n_total: 2,
        tasks: {
          t1: { rewards: [1], elapsed: [10], turns: [3], errors: [""] },
          t2: { rewards: [1], elapsed: [0], turns: [3], errors: [""] }, // passed, elapsed present (zero-but-present)
        },
      }),
    },
  ]
  const ranked = rankScreens(entries)
  // Both sum to passElapsed=10 (missing entry contributes 0, same as an
  // explicit 0) — an exact tie, broken by data completeness.
  expect(ranked[0]!.passElapsed).toBe(10)
  expect(ranked[1]!.passElapsed).toBe(10)
  expect(ranked.map((r) => r.candidate)).toEqual(["complete", "incomplete"])
  expect(ranked[0]!.missingElapsed).toBe(false)
  expect(ranked[1]!.missingElapsed).toBe(true)
})

test("rankScreens: error rows always sort last, even behind a genuine 0-pass candidate", () => {
  const entries: ScreenEntry[] = [
    { candidate: "broken", error: "podman create failed: exit 1" },
    { candidate: "zero-pass", results: completeResults({ n_pass: 0, n_total: 2, tasks: {} }) },
    { candidate: "winner", results: completeResults({ n_pass: 2, n_total: 2, tasks: {} }) },
  ]
  const ranked = rankScreens(entries)
  expect(ranked.map((r) => r.candidate)).toEqual(["winner", "zero-pass", "broken"])
  expect(ranked[2]!.error).toBe("podman create failed: exit 1")
})

test("rankScreens: a results file that never reached status:complete is treated as an error row", () => {
  const entries: ScreenEntry[] = [
    { candidate: "partial", results: { n_pass: 1, n_total: 2, tasks: {}, status: "in_progress" } },
  ]
  const ranked = rankScreens(entries)
  expect(ranked[0]!.error).toBeDefined()
  expect(ranked[0]!.nPass).toBe(-1)
})

// ── cmdScreen: error isolation ───────────────────────────────────────────

test("cmdScreen: one candidate's BenchError doesn't abort the sweep — recorded as an error row, others still ranked", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  fs.mkdirSync(paths.termBenchDir, { recursive: true })

  const calls: string[] = []
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    calls.push(args.resultsFile!)
    if (args.pin?.[0] === "project-global=v2") {
      throw new BenchError("simulated podman create failure")
    }
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: 1, n_total: 1, tasks: {} }))
  }

  await quiet(() =>
    cmdScreen(
      paths,
      { layer: "project-global", candidates: ["v1", "v2", "v3"], all: true } as CmdScreenArgs,
      runFn,
    ),
  )

  // All three candidates were attempted (the failure of v2 didn't stop v3).
  expect(calls.length).toBe(3)

  const ranking = JSON.parse(
    fs.readFileSync(path.join(paths.termBenchDir, "results", "screens", "ranking.json"), "utf-8"),
  ) as { ranking: { candidate: string; error?: string }[] }
  const v2 = ranking.ranking.find((r) => r.candidate === "v2")
  expect(v2?.error).toContain("simulated podman create failure")
  const v1 = ranking.ranking.find((r) => r.candidate === "v1")
  const v3 = ranking.ranking.find((r) => r.candidate === "v3")
  expect(v1?.error).toBeUndefined()
  expect(v3?.error).toBeUndefined()
})

test("cmdScreen: a non-BenchError from runFn propagates (not swallowed)", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  fs.mkdirSync(paths.termBenchDir, { recursive: true })
  const runFn = async (): Promise<void> => {
    throw new TypeError("bug, not an operator-facing BenchError")
  }
  await expect(
    quiet(() => cmdScreen(paths, { layer: "project-global", candidates: ["v1"], all: true } as CmdScreenArgs, runFn)),
  ).rejects.toThrow(TypeError)
})

// ── cmdScreen: skip-if-complete resume ───────────────────────────────────

test("cmdScreen: a candidate with a pre-existing status:complete results file is skipped (free resume) and its data still ranks", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  const outDir = path.join(paths.termBenchDir, "results", "screens")
  writeResultsFile(
    path.join(outDir, "v1.json"),
    completeResults({ n_pass: 5, n_total: 5, tasks: { t1: { rewards: [1], elapsed: [3], turns: [2], errors: [""] } } }),
  )

  const calls: string[] = []
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    calls.push(args.resultsFile!)
    if (args.pin?.[0] === "project-global=v1") {
      throw new Error("v1 must never be re-run — it already has a complete results file")
    }
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: 2, n_total: 5, tasks: {} }))
  }

  await quiet(() =>
    cmdScreen(paths, { layer: "project-global", candidates: ["v1", "v2"], all: true } as CmdScreenArgs, runFn),
  )

  // Only v2 was actually run.
  expect(calls).toEqual([path.join(outDir, "v2.json")])

  const ranking = JSON.parse(fs.readFileSync(path.join(outDir, "ranking.json"), "utf-8")) as {
    ranking: { candidate: string; nPass: number }[]
  }
  const v1 = ranking.ranking.find((r) => r.candidate === "v1")
  expect(v1?.nPass).toBe(5)
})

test("cmdScreen: a results file NOT stamped status:complete (crashed partial) is NOT treated as resumable — the candidate is re-run", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  const outDir = path.join(paths.termBenchDir, "results", "screens")
  writeResultsFile(path.join(outDir, "v1.json"), { n_pass: 1, n_total: 5, tasks: {}, status: "in_progress" })

  let ran = false
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    ran = true
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: 5, n_total: 5, tasks: {} }))
  }

  await quiet(() => cmdScreen(paths, { layer: "project-global", candidates: ["v1"], all: true } as CmdScreenArgs, runFn))
  expect(ran).toBe(true)
})

// ── cmdScreen: arg threading (parallel + budget + min-agent-timeout) ────

test("cmdScreen: threads --parallel/--enforce-resources/--min-cpus/--cpu-budget/--mem-budget/--host-pressure and the min-agent-timeout floor into EVERY candidate's cmdRun call", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  const captured: CmdRunArgs[] = []
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    captured.push(args)
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: 1, n_total: 1, tasks: {} }))
  }
  const canLaunch = () => true
  const pressureGate = () => false

  await quiet(() =>
    cmdScreen(
      paths,
      {
        layer: "project-global",
        candidates: ["v1", "v2"],
        all: true,
        parallel: true,
        enforceResources: true,
        minCpus: 2,
        cpuBudget: 8,
        memBudget: 4096,
        hostPressure: "on",
        canLaunch,
        pressureGate,
        minAgentTimeout: 1800,
      } as CmdScreenArgs,
      runFn,
    ),
  )

  expect(captured.length).toBe(2)
  for (const [i, candidate] of ["v1", "v2"].entries()) {
    const a = captured[i]!
    expect(a.pin).toEqual([`project-global=${candidate}`])
    expect(a.k).toBe(1)
    expect(a.parallel).toBe(true)
    expect(a.enforceResources).toBe(true)
    expect(a.minCpus).toBe(2)
    expect(a.cpuBudget).toBe(8)
    expect(a.memBudget).toBe(4096)
    expect(a.hostPressure).toBe("on")
    expect(a.canLaunch).toBe(canLaunch)
    expect(a.pressureGate).toBe(pressureGate)
    expect(a.minAgentTimeout).toBe(1800)
    expect(a.resultsFile).toBe(path.join(paths.termBenchDir, "results", "screens", `${candidate}.json`))
  }
})

test("cmdScreen: --min-agent-timeout defaults to 3600 and is stamped into ranking.json", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  const captured: CmdRunArgs[] = []
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    captured.push(args)
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: 1, n_total: 1, tasks: {} }))
  }
  await quiet(() => cmdScreen(paths, { layer: "project-global", candidates: ["v1"], all: true } as CmdScreenArgs, runFn))

  expect(captured[0]!.minAgentTimeout).toBe(3600)
  const ranking = JSON.parse(
    fs.readFileSync(path.join(paths.termBenchDir, "results", "screens", "ranking.json"), "utf-8"),
  ) as { minAgentTimeout: number }
  expect(ranking.minAgentTimeout).toBe(3600)
})

// ── cmdScreen: never writes the store, never emits a verdict, prints ADVANCE ──

test("cmdScreen: prints an ADVANCE hint naming the top candidate's follow-up `bench ab ... --k 5`, and writes no ab-verdict.json anywhere under termBenchDir", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  const runFn = async (_p: BenchPaths, args: CmdRunArgs): Promise<void> => {
    const n = args.pin?.[0] === "project-global=v2" ? 3 : 1
    writeResultsFile(args.resultsFile!, completeResults({ n_pass: n, n_total: 3, tasks: {} }))
  }

  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let printed = ""
  try {
    await cmdScreen(paths, { layer: "project-global", candidates: ["v1", "v2"], all: true } as CmdScreenArgs, runFn)
    // Read the recorded calls BEFORE mockRestore() — Bun's mockRestore also
    // clears .mock.calls history, not just the implementation.
    printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n")
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }

  expect(printed).toContain("ADVANCE: v2 → bench ab project-global v2")
  expect(printed).toContain("--k 5")
  expect(printed).toContain("--min-agent-timeout 3600")

  // No verdict file anywhere — a screen never emits one.
  const found: string[] = []
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (entry.includes("ab-verdict")) found.push(p)
    }
  }
  walk(paths.termBenchDir)
  expect(found).toEqual([])
})

test("cmdScreen: --candidates entries must look like vN", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  await expect(
    quiet(() =>
      cmdScreen(paths, { layer: "project-global", candidates: ["bogus"], all: true } as CmdScreenArgs, async () => {}),
    ),
  ).rejects.toThrow(BenchError)
})

test("cmdScreen: role layer without --agent dies", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  await expect(
    quiet(() =>
      cmdScreen(paths, { layer: "project-role", candidates: ["v1"], all: true } as CmdScreenArgs, async () => {}),
    ),
  ).rejects.toThrow(BenchError)
})

test("cmdScreen: no candidates dies", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "tb"), path.join(dir, "tb-root"))
  await expect(
    quiet(() =>
      cmdScreen(paths, { layer: "project-global", candidates: [], all: true } as CmdScreenArgs, async () => {}),
    ),
  ).rejects.toThrow(BenchError)
})

// ── cli.ts: parseScreenArgs / `screen` dispatch ──────────────────────────

test("cli main: screen missing --layer/--candidates -> rc 2", async () => {
  expect(await main(["screen", "--all"])).toBe(2)
  expect(await main(["screen", "--layer", "project-global"])).toBe(2) // candidates still missing
})

test("cli main: screen with an unknown --layer choice -> rc 2", async () => {
  expect(await main(["screen", "--layer", "bogus-layer", "--candidates", "v1", "--all"])).toBe(2)
})

test("cli main: screen unknown flag -> rc 2", async () => {
  expect(
    await main(["screen", "--layer", "project-global", "--candidates", "v1", "--not-a-real-flag"]),
  ).toBe(2)
})

test("cli main: screen --candidates v1,bogus splits on comma (cmdScreen validates each token individually)", async () => {
  // If the comma-split didn't happen, cmdScreen would see ONE candidate
  // "v1,bogus" and die naming that whole string. If it split correctly, it
  // dies naming just "bogus" (the second, invalid token) — this distinguishes
  // the two without ever reaching cmdRun/podman.
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["screen", "--layer", "project-global", "--candidates", "v1,bogus", "--all"])
    expect(rc).toBe(1)
    const errOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n")
    expect(errOutput).toContain("got 'bogus'")
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: screen role layer without --agent -> rc 1 (BenchError)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["screen", "--layer", "project-role", "--candidates", "v1", "--all"])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: screen --parallel without --enforce-resources -> rc 1 (shared validateParallel gate)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "screen",
      "--layer",
      "project-global",
      "--candidates",
      "v1",
      "--all",
      "--parallel",
    ])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: screen --host-pressure observe parses fine and falls through to cmdScreen (rc 1, invalid candidate format — never touches podman)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "screen",
      "--layer",
      "project-global",
      "--candidates",
      "bogus",
      "--all",
      "--host-pressure",
      "observe",
    ])
    // rc 1 (a BenchError from cmdScreen's own candidate-format validation),
    // not rc 2 — proves --host-pressure parsed and the run reached cmdScreen.
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})
