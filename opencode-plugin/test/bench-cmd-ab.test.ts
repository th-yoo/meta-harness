import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdAb, type CmdAbArgs } from "../src/bench/cmd-ab.ts"
import type { RunOneTaskFn, RunTaskResult } from "../src/bench/cmd-run.ts"
import {
  readScore,
  readAbVerdict,
  abAccepted,
  projectGlobalRoot,
  createCandidate,
  writeActive,
} from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"

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

// ── split-based mode + the held-out-never-recorded invariant ─────────────

function writeSplitsFile(paths: BenchPaths, heldIn: string[], heldOut: string[]): void {
  writeTaskTomls(paths.tbRoot, [...heldIn, ...heldOut])
  fs.mkdirSync(path.dirname(paths.splitsFile), { recursive: true })
  fs.writeFileSync(
    paths.splitsFile,
    JSON.stringify({ schemaVersion: 1, seed: 1, source: "x", folds: [heldOut, heldIn], activeFold: 0, rotatedAt: null }),
  )
}

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
