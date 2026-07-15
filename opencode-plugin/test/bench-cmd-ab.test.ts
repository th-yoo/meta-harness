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
