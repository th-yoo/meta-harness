import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { ClaudeCodeHost, type CCChildProcess, type CCSpawnFn, type CCTaskSpawnFn, MH_CHILD_ENV } from "../src/adapters/claude-code/cc-host.ts"
import { promptHumanScore } from "../src/score.ts"

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

// ── runTaskAgent (detached proposer/promoter/curator transport, Task L8) ────
//
// Hermetic: NO real `claude` binary — every test injects a fake CCTaskSpawnFn.

test("runTaskAgent: detached claude -p with scoped --allowedTools, cwd=project, MH_CHILD env, returns {id}, unref'd", async () => {
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
  })

  expect(task).not.toBeNull()
  expect(typeof task!.id).toBe("string")
  expect(task!.id.length).toBeGreaterThan(0)
  expect(calls.length).toBe(1)
  const { argv, opts } = calls[0]!
  // argv: claude -p <prompt> --model <id> --allowedTools <scoped> --session-id <uuid>
  expect(argv.slice(0, 5)).toEqual(["claude", "-p", "propose stuff", "--model", "claude-opus-4-8"])
  const at = argv.indexOf("--allowedTools")
  expect(at).toBeGreaterThan(0)
  expect(argv.slice(at + 1, at + 6)).toEqual(["Read", "Grep", "Glob", "Write", "Bash"])
  // --session-id carries the returned id (comes AFTER the variadic allowedTools)
  const sid = argv.indexOf("--session-id")
  expect(sid).toBeGreaterThan(at)
  expect(argv[sid + 1]).toBe(task!.id)
  // cwd is the PROJECT (child needs the repo + store)
  expect(opts.cwd).toBe("/some/project")
  // MH_CHILD sentinel present so the child's own hooks self-exit
  expect(opts.env[MH_CHILD_ENV]).toBe("1")
  // parent env inherited (PATH etc.)
  expect(opts.env["PATH"]).toBeDefined()
  // detached: unref called so the short-lived hook can exit
  expect(unrefs).toBe(1)
})

test("runTaskAgent: omits --model when no model is given (child uses its default)", async () => {
  const calls: string[][] = []
  const spawnFn: CCTaskSpawnFn = (argv) => { calls.push(argv); return { unref() {} } }
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  await host.runTaskAgent({ title: "t", prompt: "p" })
  expect(calls[0]!).not.toContain("--model")
})

test("runTaskAgent: non-anthropic proposerModel -> null, actionable log, spawnFn NEVER called (exit-0 safe)", async () => {
  let spawnCalls = 0
  const spawnFn: CCTaskSpawnFn = () => { spawnCalls++; return { unref() {} } }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }

  const task = await host.runTaskAgent({
    title: "t", prompt: "p",
    model: { providerID: "openrouter", modelID: "x/y" },
  })

  expect(task).toBeNull()
  expect(spawnCalls).toBe(0)
  const warn = logs.find((l) => l.level === "warn" && l.msg.includes("openrouter"))
  expect(warn).toBeDefined()
  expect(warn!.msg).toContain("anthropic")
})

test("runTaskAgent: unrecognized model spec -> warns, omits --model, still spawns", async () => {
  const calls: string[][] = []
  const spawnFn: CCTaskSpawnFn = (argv) => { calls.push(argv); return { unref() {} } }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }

  const task = await host.runTaskAgent({ title: "t", prompt: "p", model: "anthropic/claude-x" })

  expect(task).not.toBeNull()
  expect(calls[0]!).not.toContain("--model")
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unrecognized model spec"))).toBe(true)
})

test("runTaskAgent: never throws even if the spawn itself throws (returns null)", async () => {
  const spawnFn: CCTaskSpawnFn = () => { throw new Error("spawn EMFILE") }
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost("/p", { taskSpawnFn: spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }
  const task = await host.runTaskAgent({ title: "t", prompt: "p" })
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

// ---------------------------------------------------------------------------
// resolveClaudeArgv — the darwin/launchd PATH fix (hook.log 2026-08-02..05:
// "Executable not found in $PATH: claude", 4/4 daily failures on yoo-mac).
// Bare "claude" resolves via the PATH captured at PROCESS START (Bun), which
// in launchd/cron contexts lacks ~/.local/bin. The REAL default spawns
// resolve argv[0] at spawn time; injected test spawns still see "claude".
// ---------------------------------------------------------------------------
import { resolveClaudeArgv } from "../src/adapters/claude-code/cc-host.ts"

const REST = ["-p", "x", "--session-id", "s"]
const noWhich = (_n: string) => null
const noExists = (_p: string) => false

test("resolveClaudeArgv: KKAMAK_CLAUDE_BIN override wins over which and probes", () => {
  const out = resolveClaudeArgv(["claude", ...REST], { KKAMAK_CLAUDE_BIN: "/opt/x/claude", HOME: "/h" },
    { which: (_n) => "/from/which/claude", exists: (_p) => true })
  expect(out).toEqual(["/opt/x/claude", ...REST])
})

test("resolveClaudeArgv: which() hit is used when no override", () => {
  const out = resolveClaudeArgv(["claude", ...REST], { HOME: "/h" },
    { which: (n) => (n === "claude" ? "/from/which/claude" : null), exists: noExists })
  expect(out).toEqual(["/from/which/claude", ...REST])
})

test("resolveClaudeArgv: which() miss falls to well-known probes, HOME-anchored first", () => {
  const probed: string[] = []
  const out = resolveClaudeArgv(["claude", ...REST], { HOME: "/Users/u" },
    { which: noWhich, exists: (p) => { probed.push(p); return p === "/Users/u/.local/bin/claude" } })
  expect(out).toEqual(["/Users/u/.local/bin/claude", ...REST])
  expect(probed[0]).toBe("/Users/u/.local/bin/claude")
})

test("resolveClaudeArgv: everything misses -> bare argv unchanged (original error surfaces)", () => {
  const argv = ["claude", ...REST]
  expect(resolveClaudeArgv(argv, { HOME: "/h" }, { which: noWhich, exists: noExists })).toEqual(argv)
})

test("resolveClaudeArgv: non-claude argv[0] is never touched", () => {
  const argv = ["/already/resolved/claude", ...REST]
  expect(resolveClaudeArgv(argv, {}, { which: (_n) => "/x/claude", exists: (_p) => true })).toEqual(argv)
})

test("resolveClaudeArgv: missing HOME skips the HOME probe without throwing", () => {
  const probed: string[] = []
  const out = resolveClaudeArgv(["claude", ...REST], {},
    { which: noWhich, exists: (p) => { probed.push(p); return false } })
  expect(out[0]).toBe("claude")
  expect(probed.every((p) => !p.startsWith("undefined"))).toBe(true)
})
