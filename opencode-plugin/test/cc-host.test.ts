import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { ClaudeCodeHost, type CCTaskSpawnFn, MH_CHILD_ENV } from "../src/adapters/claude-code/cc-host.ts"
import { promptHumanScore } from "../src/score.ts"
import type { WorkerStagingPaths, WorkerArgs } from "../src/adapters/claude-code/daemon-seat.ts"

let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-host-"))
  process.env["META_HARNESS_HOME"] = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
})

test("platform + projectRoot", () => {
  const host = new ClaudeCodeHost("/some/project")
  expect(host.platform).toBe("claude-code")
  expect(host.projectRoot).toBe("/some/project")
})

test("score-inversion seam: setPendingScore then takePendingScore consumes once", () => {
  const host = new ClaudeCodeHost("/p")
  host.setPendingScore("s1", { passed: true, note: "nice" })
  expect(host.takePendingScore("s1")).toEqual({ passed: true, note: "nice" })
  // consumed — a second take is empty
  expect(host.takePendingScore("s1")).toBeUndefined()
})

test("promptHumanScore returns the staged verdict WITHOUT prompting (the inversion)", async () => {
  const host = new ClaudeCodeHost("/p")
  let prompted = false
  // spy: showScorePrompt must NOT be called when a verdict is staged
  host.showScorePrompt = async () => { prompted = true }
  host.setPendingScore("s2", { passed: false, note: "regression" })

  const result = await promptHumanScore(host, "s2")
  expect(result).toEqual({ passed: false, note: "regression" })
  expect(prompted).toBe(false)
})

// ── runTaskAgent (detached proposer/promoter/curator transport, Task L8 /
// daemon carrier migration T3) ───────────────────────────────────────────
//
// Hermetic: NO real `claude`/bun worker is ever spawned — every test injects
// a fake CCTaskSpawnFn. Post-T3 the transport is `[process.execPath,
// proposer-worker.ts, argsFilePath]`, not a `claude -p` argv — a caller must
// also supply `system` + `stagingPaths` (the daemon worker's argsfile
// requires both) or the call returns null before ever spawning.

/** Minimal valid WorkerStagingPaths ("propose", non-playbook) — enough to
 * exercise the argsfile-required guard without depending on T4's real
 * staging-path construction. */
function stagingPathsFixture(): WorkerStagingPaths {
  return {
    kind: "propose",
    playbookMode: false,
    system: "/tmp/system.md",
    tools: "/tmp/tools.md",
    diagnosis: "/tmp/diagnosis.json",
    ops: "/tmp/ops.json",
    agentConfig: "/tmp/agentConfig.json",
    envPolicy: "/tmp/envPolicy.json",
    provenance: "/tmp/provenance.json",
  }
}

test("runTaskAgent: detached [process.execPath, proposer-worker.ts, argsfile], cwd=project, no MH_CHILD env, returns {id}, unref'd, argsfile written under ccRuntimeDir()", async () => {
  const calls: { argv: string[]; opts: { cwd: string; env: Record<string, string> } }[] = []
  let unrefs = 0
  const spawnFn: CCTaskSpawnFn = (argv, opts) => {
    calls.push({ argv, opts })
    return { unref() { unrefs++ } }
  }
  const host = new ClaudeCodeHost("/some/project", { taskSpawnFn: spawnFn })

  const task = await host.runTaskAgent({
    title: "[meta-harness] project-role v3",
    prompt: "propose stuff",
    model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    system: "you are the proposer",
    stagingPaths: stagingPathsFixture(),
    timeoutMs: 20 * 60 * 1000,
  })

  expect(task).not.toBeNull()
  expect(typeof task!.id).toBe("string")
  expect(task!.id.length).toBeGreaterThan(0)
  expect(calls.length).toBe(1)
  const { argv, opts } = calls[0]!
  // argv: [process.execPath, <abs path to proposer-worker.ts>, argsFilePath] —
  // NEVER a bare "bun" (the documented launchd-PATH outage).
  expect(argv.length).toBe(3)
  expect(argv[0]).toBe(process.execPath)
  expect(argv[1]).toContain("proposer-worker.ts")
  expect(path.isAbsolute(argv[1]!)).toBe(true)
  const argsFilePath = argv[2]!
  expect(argsFilePath).toContain(path.join("runtime", "cc", "proposer-args"))
  expect(argsFilePath.endsWith(`${task!.id}.json`)).toBe(true)
  // the argsfile itself carries the WorkerArgs the worker will read
  const written = JSON.parse(fs.readFileSync(argsFilePath, "utf-8")) as WorkerArgs
  expect(written.kind).toBe("propose")
  expect(written.prompt).toBe("propose stuff")
  expect(written.systemPrompt).toBe("you are the proposer")
  expect(written.model).toBe("claude-opus-4-8")
  expect(written.artifactId).toBe(task!.id)
  expect(written.timeoutMs).toBe(20 * 60 * 1000)
  // cwd is the PROJECT (diagnostic only now — worker is toolless)
  expect(opts.cwd).toBe("/some/project")
  // MH_CHILD sentinel is NO LONGER set — the daemon worker has no CC session
  // of its own to self-trigger this project's hooks for.
  expect(opts.env[MH_CHILD_ENV]).toBeUndefined()
  // parent env inherited (PATH etc.)
  expect(opts.env["PATH"]).toBeDefined()
  // detached: unref called so the short-lived hook can exit
  expect(unrefs).toBe(1)
})

test("runTaskAgent: no model given -> argsfile model falls back to the bare DEFAULT_PROPOSER_MODEL id", async () => {
  const calls: { argv: string[] }[] = []
  const spawnFn: CCTaskSpawnFn = (argv) => { calls.push({ argv }); return { unref() {} } }
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  const task = await host.runTaskAgent({
    title: "t", prompt: "p",
    system: "s", stagingPaths: stagingPathsFixture(),
  })
  expect(task).not.toBeNull()
  const written = JSON.parse(fs.readFileSync(calls[0]!.argv[2]!, "utf-8")) as WorkerArgs
  // "anthropic/claude-opus-5" (harness-store's DEFAULT_PROPOSER_MODEL), bare id
  expect(written.model).toBe("claude-opus-5")
})

test("runTaskAgent: missing system/stagingPaths (caller not yet migrated) -> null, warn, spawnFn NEVER called", async () => {
  let spawnCalls = 0
  const spawnFn: CCTaskSpawnFn = () => { spawnCalls++; return { unref() {} } }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }

  const task = await host.runTaskAgent({ title: "t", prompt: "p" })

  expect(task).toBeNull()
  expect(spawnCalls).toBe(0)
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("missing system/stagingPaths"))).toBe(true)
})

test("runTaskAgent: non-anthropic proposerModel -> null, actionable log, spawnFn NEVER called (exit-0 safe)", async () => {
  let spawnCalls = 0
  const spawnFn: CCTaskSpawnFn = () => { spawnCalls++; return { unref() {} } }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }

  const task = await host.runTaskAgent({
    title: "t", prompt: "p",
    system: "s", stagingPaths: stagingPathsFixture(),
    model: { providerID: "openrouter", modelID: "x/y" },
  })

  expect(task).toBeNull()
  expect(spawnCalls).toBe(0)
  const warn = logs.find((l) => l.level === "warn" && l.msg.includes("openrouter"))
  expect(warn).toBeDefined()
  expect(warn!.msg).toContain("anthropic")
})

test("runTaskAgent: unrecognized model spec -> warns, falls back to the default proposer model, still spawns", async () => {
  const calls: { argv: string[] }[] = []
  const spawnFn: CCTaskSpawnFn = (argv) => { calls.push({ argv }); return { unref() {} } }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }

  const task = await host.runTaskAgent({
    title: "t", prompt: "p", model: "anthropic/claude-x",
    system: "s", stagingPaths: stagingPathsFixture(),
  })

  expect(task).not.toBeNull()
  const written = JSON.parse(fs.readFileSync(calls[0]!.argv[2]!, "utf-8")) as WorkerArgs
  expect(written.model).toBe("claude-opus-5")
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unrecognized model spec"))).toBe(true)
})

test("runTaskAgent: never throws even if the spawn itself throws (returns null)", async () => {
  const spawnFn: CCTaskSpawnFn = () => { throw new Error("spawn EMFILE") }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }
  const task = await host.runTaskAgent({
    title: "t", prompt: "p",
    system: "s", stagingPaths: stagingPathsFixture(),
  })
  expect(task).toBeNull()
  expect(logs.some((l) => l.level === "warn")).toBe(true)
})

test("exec runs a shell command in projectRoot", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-host-exec-"))
  try {
    const host = new ClaudeCodeHost(proj)
    const { stdout, exitCode } = await host.exec("echo hello-cc")
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe("hello-cc")
  } finally {
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test("log appends to the runtime logfile (best-effort durability)", () => {
  const host = new ClaudeCodeHost("/p")
  host.log("info", "hello-log-marker")
  const logFile = path.join(home, "runtime", "cc", "hook.log")
  expect(fs.readFileSync(logFile, "utf-8")).toContain("hello-log-marker")
})

// ── runTextAgent (judge transport, Task L7 — daemon-carried) ──────────────
//
// Hermetic: NO real daemon is ever reached — every test injects fake
// {ensure, call, close} deps via the ClaudeCodeHost constructor's
// `judgeDeps` option (donor pattern: test/p2-a4-review.test.ts).
import type { DaemonOutcome } from "@th-yoo/cc-api-daemon"
import { DEFAULT_JUDGE_MODEL } from "../src/adapters/claude-code/daemon-seat.ts"
import type { JudgeDeps } from "../src/adapters/claude-code/cc-host.ts"

type OkOutcome = Extract<DaemonOutcome, { kind: "ok" }>

function okOutcome(over: Partial<OkOutcome> = {}): DaemonOutcome {
  return {
    kind: "ok",
    text: "the judge verdict text",
    model: DEFAULT_JUDGE_MODEL,
    canonicalModel: DEFAULT_JUDGE_MODEL,
    sessionId: "sess-ok",
    ...over,
  }
}

/** Captured inputs of the fake daemon-client trio for one runTextAgent call. */
interface JudgeCapture {
  ensures: number
  prompt?: string
  model?: string
  callOpts?: { isolation: { systemPrompt: string; title: string }; budgetMs?: number; maxTokens?: number }
  closed: string[]
}

function hostWithJudgeDeps(
  outcome: DaemonOutcome | (() => DaemonOutcome),
  over: JudgeDeps = {},
): { host: ClaudeCodeHost; logs: { level: string; msg: string }[]; cap: JudgeCapture } {
  const cap: JudgeCapture = { ensures: 0, closed: [] }
  const deps: JudgeDeps = {
    ensure: (async () => { cap.ensures++ }) as JudgeDeps["ensure"],
    call: (async (prompt: string, model: string, _env: unknown, opts: unknown) => {
      cap.prompt = prompt
      cap.model = model
      cap.callOpts = opts as JudgeCapture["callOpts"]
      return typeof outcome === "function" ? outcome() : outcome
    }) as JudgeDeps["call"],
    close: (async (sessionId: string) => { cap.closed.push(sessionId) }) as JudgeDeps["close"],
    ...over,
  }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/some/project", { judgeDeps: deps })
  host.log = (level, msg) => { logs.push({ level, msg }) }
  return { host, logs, cap }
}

test("runTextAgent: happy path — prompt/model/isolation/budgetMs threaded, text returned, session closed", async () => {
  const { host, cap } = hostWithJudgeDeps(okOutcome({ model: "claude-sonnet-4-5" }))

  const text = await host.runTextAgent({
    title: "[meta-harness] judge sess-1",
    system: "you are the judge",
    prompt: "judge this session",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  })

  expect(text).toBe("the judge verdict text")
  expect(cap.ensures).toBe(1)
  expect(cap.prompt).toBe("judge this session")
  expect(cap.model).toBe("claude-sonnet-4-5") // "anthropic/" prefix STRIPPED
  // Isolation carries the system prompt + title (no CC harness, no hooks,
  // no CLAUDE.md — the contamination class the migration closes).
  expect(cap.callOpts!.isolation.systemPrompt).toBe("you are the judge")
  expect(cap.callOpts!.isolation.title).toBe("[meta-harness] judge sess-1")
  // budgetMs is EXPLICIT (90s default) — omitting it would silently regress
  // to daemonCall's internal 36s default.
  expect(cap.callOpts!.budgetMs).toBe(90_000)
  // close-not-release: the served session is closed after the call.
  expect(cap.closed).toEqual(["sess-ok"])
})

test("runTextAgent: model undefined -> DEFAULT_JUDGE_MODEL substituted (daemon hard-requires a model)", async () => {
  const { host, cap } = hostWithJudgeDeps(okOutcome())
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBe("the judge verdict text")
  expect(cap.model).toBe(DEFAULT_JUDGE_MODEL)
})

test("runTextAgent: agent-lane model -> NO maxTokens in call opts (daemon hard-rejects it on the agent lane)", async () => {
  const { host, cap } = hostWithJudgeDeps(okOutcome())
  await host.runTextAgent({ title: "t", system: "s", prompt: "p" }) // default = opus = agent lane
  expect(cap.callOpts!.maxTokens).toBeUndefined()
})

test("runTextAgent: api-lane (haiku) model -> judge maxTokens cap passed, computed off the SAME effective model", async () => {
  const { host, cap } = hostWithJudgeDeps(okOutcome({ model: "claude-haiku-4-5" }))
  await host.runTextAgent({
    title: "t", system: "s", prompt: "p",
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  })
  expect(cap.model).toBe("claude-haiku-4-5")
  expect(cap.callOpts!.maxTokens).toBe(4096)
})

test("runTextAgent: timeoutMs override is passed through as budgetMs", async () => {
  const { host, cap } = hostWithJudgeDeps(okOutcome())
  await host.runTextAgent({ title: "t", system: "s", prompt: "p", timeoutMs: 12_345 })
  expect(cap.callOpts!.budgetMs).toBe(12_345)
})

test("runTextAgent: a malformed model spec (not {providerID,modelID}) is ignored — warns, falls back to default, still proceeds", async () => {
  const { host, logs, cap } = hostWithJudgeDeps(okOutcome())
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p", model: "anthropic/claude-x" })
  expect(text).toBe("the judge verdict text")
  expect(cap.model).toBe(DEFAULT_JUDGE_MODEL)
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unrecognized model spec"))).toBe(true)
})

test("runTextAgent: non-anthropic judgeModel -> null, actionable log, daemon NEVER touched", async () => {
  const { host, logs, cap } = hostWithJudgeDeps(okOutcome())

  const text = await host.runTextAgent({
    title: "t", system: "s", prompt: "p",
    model: { providerID: "openrouter", modelID: "google/gemini-2.5-flash" },
  })

  expect(text).toBeNull()
  expect(cap.ensures).toBe(0)
  expect(cap.prompt).toBeUndefined()
  const warning = logs.find((l) => l.level === "warn" && l.msg.includes("openrouter"))
  expect(warning).toBeDefined()
  expect(warning!.msg).toContain("anthropic")
  expect(warning!.msg.toLowerCase()).toContain("judgemodel")
})

test("runTextAgent: daemon unreachable (ensure throws) -> null + warn, never throws", async () => {
  const { host, logs } = hostWithJudgeDeps(okOutcome(), {
    ensure: (async () => { throw new Error("no daemon and spawn failed") }) as JudgeDeps["ensure"],
  })
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unexpected failure"))).toBe(true)
})

test("runTextAgent: no-call outcome -> null + warn, close NOT called (no session was created)", async () => {
  const { host, logs, cap } = hostWithJudgeDeps({ kind: "no-call" })
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("no-call"))).toBe(true)
  expect(cap.closed).toEqual([])
})

test("runTextAgent: call-consumed outcome -> null + warn", async () => {
  const { host, logs } = hostWithJudgeDeps({ kind: "call-consumed" })
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("call-consumed"))).toBe(true)
})

test("runTextAgent: model-proof failure -> null + warn, session STILL closed", async () => {
  const { host, logs, cap } = hostWithJudgeDeps(okOutcome({ model: "claude-haiku-4-5", canonicalModel: "claude-haiku-4-5" }))
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" }) // requested default opus, served haiku
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("does not prove"))).toBe(true)
  expect(cap.closed).toEqual(["sess-ok"])
})

test("runTextAgent: max_tokens truncation -> null + warn, session STILL closed", async () => {
  const { host, logs, cap } = hostWithJudgeDeps(okOutcome({ stopReason: "max_tokens" }))
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("truncated"))).toBe(true)
  expect(cap.closed).toEqual(["sess-ok"])
})

test("runTextAgent: close failure never overrides the decided outcome", async () => {
  const { host } = hostWithJudgeDeps(okOutcome(), {
    close: (async () => { throw new Error("socket gone") }) as JudgeDeps["close"],
  })
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBe("the judge verdict text")
})

test("runTextAgent: never throws even if call itself throws", async () => {
  const { host, logs } = hostWithJudgeDeps(okOutcome(), {
    call: (async () => { throw new Error("wire EPIPE") }) as JudgeDeps["call"],
  })
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unexpected failure"))).toBe(true)
})

// ── defaultWorkerSpawn stderr capture (stderr-blindness fix, 2026-08-15) ───
import { defaultWorkerSpawn } from "../src/adapters/claude-code/cc-host.ts"

test("defaultWorkerSpawn: detached child stderr lands in ccRuntimeDir()/worker-logs/proposer-worker.log", async () => {
  // META_HARNESS_HOME is a per-test tmpdir (beforeEach), so ccRuntimeDir()
  // resolves under it — hermetic.
  const child = defaultWorkerSpawn(
    [process.execPath, "-e", "console.error('mh-stderr-probe-line')"],
    { cwd: os.tmpdir(), env: { ...process.env } as Record<string, string> },
  )
  await child.exited
  const logPath = path.join(home, "runtime", "cc", "worker-logs", "proposer-worker.log")
  // Append is async at the OS level only in ordering, not visibility: after
  // exited resolves the child has flushed and closed its dup.
  const deadline = Date.now() + 5_000
  let content = ""
  while (Date.now() < deadline) {
    try { content = fs.readFileSync(logPath, "utf-8") } catch { /* not yet */ }
    if (content.includes("mh-stderr-probe-line")) break
    await new Promise((r) => setTimeout(r, 50))
  }
  expect(content).toContain("mh-stderr-probe-line")
})
