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

// ── runTextAgent (judge transport, Task L7) ───────────────────────────────
//
// Hermetic: NO real `claude` binary is ever spawned — every test injects a
// fake CCSpawnFn via the ClaudeCodeHost constructor's `spawnFn` option.

/** A completed child process whose stdout is the given text and whose
 * `exited` promise resolves immediately to `exitCode`. */
function completedProc(stdoutText: string, exitCode = 0): CCChildProcess {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdoutText))
        controller.close()
      },
    }),
    exited: Promise.resolve(exitCode),
    kill() { /* already exited — no-op, matches real Bun.spawn semantics */ },
  }
}

/** A child process that hangs until `.kill()` is called — simulates a stuck
 * `claude -p` so the timeout-kill path can be exercised without a real
 * timer-length wait. `killed()` reports whether kill() has fired. */
function hangingProc(): { proc: CCChildProcess; killed: () => boolean } {
  let killedFlag = false
  let closeController!: ReadableStreamDefaultController<Uint8Array>
  let resolveExited!: (n: number) => void
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { closeController = c },
  })
  const exited = new Promise<number>((res) => { resolveExited = res })
  return {
    proc: {
      stdout,
      exited,
      kill() {
        killedFlag = true
        closeController.close()
        resolveExited(143) // SIGTERM-ish, matches exec.ts's signal-death convention
      },
    },
    killed: () => killedFlag,
  }
}

const OK_RESULT = JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  result: "the judge verdict text", num_turns: 1, total_cost_usd: 0.0123, session_id: "s1",
})

function hostWithSpawn(spawnFn: CCSpawnFn, projectRoot = "/some/project"): { host: ClaudeCodeHost; logs: { level: string; msg: string }[] } {
  const logs: { level: string; msg: string }[] = []
  const host = new ClaudeCodeHost(projectRoot, { spawnFn })
  host.log = (level, msg) => { logs.push({ level, msg }) }
  return { host, logs }
}

test("runTextAgent: argv is claude -p <prompt> --system-prompt <system> --output-format json --model <modelID> --disallowedTools <verified list>; stdin ignored; cwd outside the project", async () => {
  let capturedArgv: string[] | undefined
  let capturedOpts: { cwd: string; stdin: "ignore" } | undefined
  const spawnFn: CCSpawnFn = (argv, opts) => {
    capturedArgv = argv
    capturedOpts = opts
    return completedProc(OK_RESULT)
  }
  const { host } = hostWithSpawn(spawnFn, "/some/project")

  const text = await host.runTextAgent({
    title: "[meta-harness] judge sess-1",
    system: "you are the judge",
    prompt: "judge this session",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  })

  expect(text).toBe("the judge verdict text")
  expect(capturedArgv).toEqual([
    "claude", "-p", "judge this session",
    "--system-prompt", "you are the judge",
    "--output-format", "json",
    "--model", "claude-sonnet-4-5", // "anthropic/" prefix STRIPPED
    "--disallowedTools",
    "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "WebFetch", "WebSearch", "NotebookEdit",
  ])
  expect(capturedOpts!.stdin).toBe("ignore")
  // Isolation: cwd must be OUTSIDE the project (so project .claude/settings.json
  // hooks — cwd-scoped — can never fire for the judge process).
  expect(capturedOpts!.cwd).not.toBe("/some/project")
  expect(capturedOpts!.cwd.startsWith("/some/project")).toBe(false)
  expect(capturedOpts!.cwd).toContain(path.join("runtime", "cc", "judge"))
})

test("runTextAgent: scratch cwd is cleaned up after the call (no leaked tmp dirs)", async () => {
  let seenCwd: string | undefined
  const spawnFn: CCSpawnFn = (_argv, opts) => { seenCwd = opts.cwd; return completedProc(OK_RESULT) }
  const { host } = hostWithSpawn(spawnFn)
  await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(seenCwd).toBeDefined()
  expect(fs.existsSync(seenCwd!)).toBe(false)
})

test("runTextAgent: omits --model when no model is given (lets claude use its default)", async () => {
  let capturedArgv: string[] | undefined
  const spawnFn: CCSpawnFn = (argv) => { capturedArgv = argv; return completedProc(OK_RESULT) }
  const { host } = hostWithSpawn(spawnFn)
  await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(capturedArgv).not.toContain("--model")
})

test("runTextAgent: a malformed model spec (not {providerID,modelID}) is ignored — warns, omits --model, still proceeds", async () => {
  let capturedArgv: string[] | undefined
  const spawnFn: CCSpawnFn = (argv) => { capturedArgv = argv; return completedProc(OK_RESULT) }
  const { host, logs } = hostWithSpawn(spawnFn)

  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p", model: "anthropic/claude-x" })

  expect(text).toBe("the judge verdict text")
  expect(capturedArgv).not.toContain("--model")
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("unrecognized model spec"))).toBe(true)
})

test("runTextAgent: non-anthropic judgeModel -> null, actionable log, spawnFn NEVER called", async () => {
  let spawnCalls = 0
  const spawnFn: CCSpawnFn = () => { spawnCalls++; return completedProc(OK_RESULT) }
  const { host, logs } = hostWithSpawn(spawnFn)

  const text = await host.runTextAgent({
    title: "t", system: "s", prompt: "p",
    model: { providerID: "openrouter", modelID: "google/gemini-2.5-flash" },
  })

  expect(text).toBeNull()
  expect(spawnCalls).toBe(0)
  const warning = logs.find((l) => l.level === "warn" && l.msg.includes("openrouter"))
  expect(warning).toBeDefined()
  expect(warning!.msg).toContain("anthropic")
  expect(warning!.msg.toLowerCase()).toContain("judgemodel")
})

test("runTextAgent: reply extraction from a canned --output-format json result", async () => {
  const spawnFn: CCSpawnFn = () => completedProc(OK_RESULT)
  const { host } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBe("the judge verdict text")
})

test("runTextAgent: is_error in the JSON result -> null + warn log", async () => {
  const errJson = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "", total_cost_usd: 0 })
  const spawnFn: CCSpawnFn = () => completedProc(errJson)
  const { host, logs } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("is_error"))).toBe(true)
})

test("runTextAgent: non-zero exit code -> null + warn log", async () => {
  const spawnFn: CCSpawnFn = () => completedProc("", 1)
  const { host, logs } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("exited 1"))).toBe(true)
})

test("runTextAgent: unparseable JSON stdout -> null + warn log", async () => {
  const spawnFn: CCSpawnFn = () => completedProc("not json at all")
  const { host, logs } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("could not parse"))).toBe(true)
})

test("runTextAgent: logs total_cost_usd at debug level on success", async () => {
  const spawnFn: CCSpawnFn = () => completedProc(OK_RESULT)
  const { host, logs } = hostWithSpawn(spawnFn)
  await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(logs.some((l) => l.level === "debug" && l.msg.includes("0.0123"))).toBe(true)
})

test("runTextAgent: timeout kills the child and returns null (makes timeoutMs real for CC)", async () => {
  const { proc, killed } = hangingProc()
  const spawnFn: CCSpawnFn = () => proc
  const { host, logs } = hostWithSpawn(spawnFn)

  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p", timeoutMs: 20 })

  expect(text).toBeNull()
  expect(killed()).toBe(true)
  expect(logs.some((l) => l.level === "warn" && l.msg.includes("timed out"))).toBe(true)
})

test("runTextAgent: default timeout is used when timeoutMs is omitted (proc completes well within it)", async () => {
  // Not a timing assertion (that would be flaky) — just proves the call
  // succeeds end-to-end without an explicit timeoutMs.
  const spawnFn: CCSpawnFn = () => completedProc(OK_RESULT)
  const { host } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBe("the judge verdict text")
})

test("runTextAgent: never throws even if spawnFn itself throws", async () => {
  const spawnFn: CCSpawnFn = () => { throw new Error("spawn EMFILE") }
  const { host, logs } = hostWithSpawn(spawnFn)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(logs.some((l) => l.level === "warn")).toBe(true)
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
