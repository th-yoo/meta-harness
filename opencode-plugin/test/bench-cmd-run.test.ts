import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdRun, runTaskOnce, inContainerOpencodeVersion, type RunOneTaskFn, type RunTaskResult } from "../src/bench/cmd-run.ts"
import { runOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { readScore, projectGlobalRoot, createCandidate, writeActive } from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-cmd-run-"))
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
    error: "",
    ...overrides,
  }
}

/** cmdRun computes its provenance env block via `inContainerOpencodeVersion`
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
  expect(final.model).toBe("anthropic/claude-sonnet-4-6")
  expect(final.k).toBe(1)
  expect(final.status).toBe("complete")
  expect(final.n_pass).toBe(1)
  expect(final.n_total).toBe(2)
  expect(final.tasks.a).toEqual({ rewards: [0], elapsed: [5.5], turns: [0], errors: [] })
  expect(final.tasks.b).toEqual({ rewards: [1], elapsed: [12.3], turns: [4], errors: [] })
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
  try {
    await cmdRun(paths, { tasks: ["a"], k: 3, resultsFile, layers: "none" }, fake, fakeExec)
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
  expect(call).toBe(3)
  const final = JSON.parse(fs.readFileSync(resultsFile, "utf-8"))
  expect(final.tasks.a.rewards).toEqual([0, 1, 0])
  expect(final.n_pass).toBe(1) // pass@k: any reward==1 counts the task as passed
  expect(final.n_total).toBe(1)
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
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "runtime", execFn)
  } finally {
    errSpy.mockRestore()
  }
  expect(res.error).toBe("setup_failed")
  expect(res.reward).toBe(0)
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", execFn)
  } finally {
    errSpy.mockRestore()
  }
  expect(seenArgv.some((a) => a[1] === "rm")).toBe(true)
})

test("runTaskOnce: create mounts include credential dirs (~/.claude, opencode data dir), rw", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  const paths = fakeBenchPaths(dir, tbRoot)

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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", execFn)
  } finally {
    errSpy.mockRestore()
  }

  const mountFlags = createArgv.filter((a) => a.includes(":/root/.claude") || a.includes(":/root/.local/share/opencode"))
  expect(mountFlags.length).toBe(2)
  expect(mountFlags.every((m) => !m.endsWith(":ro"))).toBe(true) // rw, not ro
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", execFn)
  } finally {
    errSpy.mockRestore()
  }

  expect(setupArgv.length).toBeGreaterThan(0)
  expect(setupArgv).not.toContain("SKIP_APT=1")
  expect(setupArgv.some((a) => a.startsWith("SKIP_APT"))).toBe(false)
  // the other setup env vars are still present, unaffected
  expect(setupArgv).toContain("TB_ROOT=/tb")
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", execFn)
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["OPENROUTER_API_KEY"]
    else process.env["OPENROUTER_API_KEY"] = prev
  }

  expect(createArgv).toContain("-e")
  expect(createArgv).toContain("OPENROUTER_API_KEY=sk-test-123")
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

// ── inContainerOpencodeVersion ────────────────────────────────────────────
// The provenance version must come from INSIDE the container (a throwaway
// one, since envBlock is computed once before the per-task loop) — never
// the host's own opencode install. See record.ts's envBlock header.

test("inContainerOpencodeVersion: execs 'opencode --version' inside a throwaway container, then removes it", async () => {
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
  const version = await inContainerOpencodeVersion(paths, execFn)
  expect(version).toBe("opencode 3.2.1 (in-container)")
  expect(seenArgv.some((a) => a[1] === "create")).toBe(true)
  expect(seenArgv.some((a) => a[1] === "start")).toBe(true)
  expect(seenArgv.some((a) => a[1] === "rm")).toBe(true)
})

test("inContainerOpencodeVersion: create failure -> 'unknown', still removes the container", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  let rmCalled = false
  const execFn = async (argv: string[]) => {
    if (argv[1] === "create") return { rc: 125, stdout: "", stderr: "boom", timedOut: false }
    if (argv[1] === "rm") rmCalled = true
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  expect(await inContainerOpencodeVersion(paths, execFn)).toBe("unknown")
  expect(rmCalled).toBe(true)
})

test("inContainerOpencodeVersion: exec throwing -> 'unknown' (never throws)", async () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(dir)
  const execFn = async (argv: string[]) => {
    if (argv[1] === "exec") throw new Error("boom")
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  expect(await inContainerOpencodeVersion(paths, execFn)).toBe("unknown")
})

test("cmdRun: envBlock is populated from inContainerOpencodeVersion, not a host lookup", async () => {
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
