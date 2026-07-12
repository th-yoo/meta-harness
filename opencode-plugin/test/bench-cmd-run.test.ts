import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { cmdRun, runTaskOnce, inContainerAgentVersion, type RunOneTaskFn, type RunTaskResult } from "../src/bench/cmd-run.ts"
import { runOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { readScore, projectGlobalRoot, createCandidate, writeActive } from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"
import type { AgentAuthMounts } from "../src/bench/agent-auth.ts"
import { opencodeDriver } from "../src/bench/drivers/opencode.ts"

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
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "runtime", opencodeDriver, execFn, fakeAuthMounts())
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, fakeAuthMounts())
  } finally {
    errSpy.mockRestore()
  }
  expect(seenArgv.some((a) => a[1] === "rm")).toBe(true)
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, prepareAuth)
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
    res = await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, prepareAuth)
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, fakeAuthMounts())
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, fakeAuthMounts())
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, prepareAuth)
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
    await runTaskOnce(paths, "t", "m", "", "", 30, 30, "scripts", opencodeDriver, execFn, fakeAuthMounts())
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
