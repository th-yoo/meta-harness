import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { runOpencode, runJudgeOpencode } from "../src/bench/opencode-run.ts"
import { TRANSIENT_MARK, TIMEOUT_MARK, REALWORK_RE, TRANSIENT_RE, AUTH_ERROR_RE, AUTH_FAIL_MARK } from "../src/bench/agent-run.ts"
import { normalizeEvents, EXECUTION_TOOLS, opencodeDriver } from "../src/bench/drivers/opencode.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import type { ExecResult } from "../src/bench/exec.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-opencode-run-"))
}

function fakeBenchPaths(tbRoot: string): BenchPaths {
  const termBenchDir = path.join(tbRoot, "..", "term-bench2")
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

function ok(stdout: string, rc = 0): ExecResult {
  return { rc, stdout, stderr: "", timedOut: false }
}

// ── normalizeEvents ──────────────────────────────────────────────────────

test("normalizeEvents: tool_use event -> compact tool event, args/output capped", () => {
  const line = JSON.stringify({
    type: "tool_use",
    part: { tool: "bash", state: { input: "echo hi", output: "hi", status: "completed", metadata: { exit: 0 } } },
  })
  const events = normalizeEvents(line)
  expect(events).toEqual([{ t: "tool", tool: "bash", args: "echo hi", output: "hi", error: false }])
})

test("normalizeEvents: tool_use with error status flags error:true", () => {
  const line = JSON.stringify({
    type: "tool_use",
    part: { tool: "bash", state: { input: "false", output: "", status: "error", metadata: { exit: 1 } } },
  })
  expect(normalizeEvents(line)[0]).toEqual({ t: "tool", tool: "bash", args: "false", output: "", error: true })
})

test("normalizeEvents: tool_use with nonzero exit (no explicit error status) also flags error", () => {
  const line = JSON.stringify({
    type: "tool_use",
    part: { tool: "bash", state: { input: "x", output: "", status: "completed", metadata: { exit: 2 } } },
  })
  expect(normalizeEvents(line)[0]!.error).toBe(true)
})

test("normalizeEvents: non-string args/output are JSON-stringified", () => {
  const line = JSON.stringify({
    type: "tool_use",
    part: { tool: "edit", state: { input: { path: "a.txt" }, output: { ok: true } } },
  })
  const ev = normalizeEvents(line)[0]!
  expect(ev.args).toBe('{"path":"a.txt"}')
  expect(ev.output).toBe('{"ok":true}')
})

test("normalizeEvents: args/output truncated at 300/800 chars", () => {
  const bigArgs = "a".repeat(400)
  const bigOut = "b".repeat(900)
  const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { input: bigArgs, output: bigOut } } })
  const ev = normalizeEvents(line)[0]!
  expect(ev.args!.length).toBe(300)
  expect(ev.output!.length).toBe(800)
})

test("normalizeEvents: text event kept, blank text skipped", () => {
  const lines = [JSON.stringify({ type: "text", text: "hello" }), JSON.stringify({ type: "text", text: "   " })].join("\n")
  expect(normalizeEvents(lines)).toEqual([{ t: "text", text: "hello" }])
})

test("normalizeEvents: text via part.text fallback", () => {
  const line = JSON.stringify({ type: "text", part: { text: "from part" } })
  expect(normalizeEvents(line)).toEqual([{ t: "text", text: "from part" }])
})

test("normalizeEvents: error event extracts data.message, falls back to name, then stringifies", () => {
  const withMessage = JSON.stringify({ type: "error", error: { data: { message: "boom" }, name: "Fallback" } })
  expect(normalizeEvents(withMessage)).toEqual([{ t: "error", text: "boom" }])
  const withNameOnly = JSON.stringify({ type: "error", error: { name: "SomeError" } })
  expect(normalizeEvents(withNameOnly)).toEqual([{ t: "error", text: "SomeError" }])
})

test("normalizeEvents: step_finish and unparseable/non-object lines are dropped", () => {
  const lines = [
    "not json at all",
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    "{not valid json",
    JSON.stringify({ type: "text", text: "kept" }),
  ].join("\n")
  expect(normalizeEvents(lines)).toEqual([{ t: "text", text: "kept" }])
})

test("normalizeEvents: caps at maxEvents", () => {
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: "text", text: `t${i}` })).join("\n")
  expect(normalizeEvents(lines, 3).length).toBe(3)
})

// ── EXECUTION_TOOLS ──────────────────────────────────────────────────────

test("EXECUTION_TOOLS is exactly {bash, task}", () => {
  expect([...EXECUTION_TOOLS].sort()).toEqual(["bash", "task"])
})

// ── runOpencode ──────────────────────────────────────────────────────────

test("runOpencode: happy path parses turns + toolUsage + events, logs 'opencode done in ... turns=N'", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "mytask"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "mytask", "instruction.md"), "do the thing")
  const paths = fakeBenchPaths(tbRoot)

  const ndjson = [
    JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "completed", metadata: { exit: 0 } } } }),
    JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "error", metadata: { exit: 1 } } } }),
    JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "error" } } }), // not an execution tool -> no error counted
    JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } }), // not counted (reason != stop)
    JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
    JSON.stringify({ type: "text", text: "done" }),
  ].join("\n")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result
  try {
    result = await runOpencode(paths, "mh-container-1", "mytask", "anthropic/claude-x", "", 60, "", async () => ok(ndjson))
  } finally {
    errSpy.mockRestore()
  }

  expect(result.turnCount).toBe(1)
  expect(result.toolUsage).toEqual({ bash: { calls: 2, errors: 1 }, read: { calls: 1, errors: 0 } })
  expect(result.events.some((e) => e.t === "text" && e.text === "done")).toBe(true)
})

test("runOpencode: timeout returns {0,{},[]} immediately, logs the TIMEOUT_MARK line, no retry", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return { rc: 124, stdout: "", stderr: "", timedOut: true }
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result
  try {
    result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(TIMEOUT_MARK) && m.includes("30s"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  expect(result).toEqual({
    turnCount: 0,
    toolUsage: {},
    events: [],
    timedOut: true,
    agentElapsedSec: expect.any(Number),
  })
  expect(calls).toBe(1) // no retry after a timeout
})

test("runOpencode: transient provider error retries (logs TRANSIENT_MARK), then succeeds", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    if (calls === 1) {
      return ok('{"type":"error","error":{"name":"Overloaded"}}', 1)
    }
    return ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }))
  }
  const sleeps: number[] = []
  const sleepFn = async (s: number) => {
    sleeps.push(s)
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result
  try {
    result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, sleepFn)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(2)
  expect(sleeps).toEqual([5]) // min(30, 5*1)
  expect(result.turnCount).toBe(1)
})

test("runOpencode: exhausts MAX_ATTEMPTS(4) on persistent transient errors, still returns parsed (empty) result", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return ok('{"type":"error","error":{"name":"Overloaded"}}', 1)
  }
  const sleepFn = async () => {}

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, sleepFn)
    expect(result.turnCount).toBe(0)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(4)
})

// ── auth-error fail-fast (expired-oauth 401 must NOT be retried as transient) ─

test.each([
  ["401", '{"type":"error","error":{"data":{"message":"401 Unauthorized"}}}'],
  ["authentication_error", '{"type":"error","error":{"name":"authentication_error"}}'],
  ["invalid api key", '{"type":"error","error":{"data":{"message":"invalid api key provided"}}}'],
  ["oauth", '{"type":"error","error":{"data":{"message":"oauth token rejected"}}}'],
])("runOpencode: auth error (%s) fails fast — no retry, 0 turns, logs AUTH_FAIL_MARK not TRANSIENT_MARK", async (_label, out) => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return ok(out, 1)
  }
  const sleeps: number[] = []
  const sleepFn = async (s: number) => {
    sleeps.push(s)
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result
  try {
    result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, sleepFn)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(true)
    expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(false)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(1) // no retry — auth can never recover
  expect(sleeps).toEqual([]) // no backoff
  expect(result.turnCount).toBe(0)
})

test("runOpencode: auth error takes precedence over transient even if TRANSIENT_RE would also match", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    // Carries BOTH an auth marker and a transient marker ("timeout") — auth
    // must win, never be logged/retried as transient.
    return ok('{"type":"error","error":{"data":{"message":"unauthorized: connection timeout"}}}', 1)
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result
  try {
    result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(true)
    expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(false)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(1)
  expect(result.turnCount).toBe(0)
})

test("runOpencode: genuine transient error (unchanged) never logs AUTH_FAIL_MARK", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    if (calls < 4) return ok('{"type":"error","error":{"name":"Overloaded"}}', 1)
    return ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }))
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(true)
    expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(false)
    expect(result.turnCount).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
  expect(calls).toBe(4)
})

test("AUTH_ERROR_RE: matches known auth-failure text", () => {
  for (const s of ["401", "authentication_error", "invalid api key", "token expired", "unauthorized"]) {
    expect(AUTH_ERROR_RE.test(s)).toBe(true)
  }
})

test("AUTH_ERROR_RE: does not false-positive on benign task output", () => {
  for (const s of ["reward=1", "403 lines processed"]) {
    expect(AUTH_ERROR_RE.test(s)).toBe(false)
  }
})

test("AUTH_ERROR_RE: filesystem 'Permission denied' is not an auth signal", () => {
  // "Permission denied" is what bash/ssh/chmod print — the weakest auth
  // signal and the only one likely in non-provider output. Real credential
  // failures always carry 401/unauthorized/token_expired/invalid api key.
  for (const s of [
    "bash: ./solve.sh: Permission denied",
    "mkdir: cannot create directory '/x': Permission denied",
    "permission_denied",
  ]) {
    expect(AUTH_ERROR_RE.test(s)).toBe(false)
  }
})

test("runOpencode: top-level 'Permission denied' failure is not misreported as an auth failure", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return ok('{"type":"error","error":{"data":{"message":"exec /root/agent.sh: Permission denied"}}}', 1)
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(AUTH_FAIL_MARK))).toBe(false)
    expect(result.turnCount).toBe(0)
  } finally {
    errSpy.mockRestore()
  }
})

test("marker constants: AUTH_FAIL_MARK is distinct from TRANSIENT_MARK and does not match REALWORK_RE", () => {
  expect(AUTH_FAIL_MARK).not.toBe(TRANSIENT_MARK)
  expect(REALWORK_RE.test(AUTH_FAIL_MARK)).toBe(false)
})

// final-review fix 5: opencode's own auth remediation must be unchanged
// (byte-identical wording to the old hardcoded runAgent message) now that
// it's driver-selected instead of hardcoded for every driver.
test("opencodeDriver: authHint preserves the original opencode-specific remediation wording", () => {
  expect(opencodeDriver.authHint).toBeDefined()
  expect(opencodeDriver.authHint).toContain("auth.json")
  expect(opencodeDriver.authHint).toContain("opencode auth login")
})

test("runOpencode: instruction.md missing dies (BenchError)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(tbRoot)
  await expect(runOpencode(paths, "c1", "no-such-task", "m", "", 30, "", async () => ok(""))).rejects.toThrow()
})

test("runOpencode: harnessMd is cp'd into the container as /app/AGENTS.md (via buildCpToArgv, not stdin)", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  const seenArgv: string[][] = []
  let capturedHostFile: string | undefined
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    seenArgv.push(argv)
    if (argv[1] === "cp") capturedHostFile = argv[2]
    return ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }))
  }

  await runOpencode(paths, "my-container", "t", "m", "", 30, "hello harness", execFn)

  const cpCall = seenArgv.find((a) => a[1] === "cp")
  expect(cpCall).toEqual(["podman", "cp", capturedHostFile!, "my-container:/app/AGENTS.md"])
  expect(fs.existsSync(capturedHostFile!)).toBe(false) // scratch cleaned up after use
})

test("runOpencode: never passes --pure", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let seenArgv: string[] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    seenArgv = argv
    return ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }))
  }
  await runOpencode(paths, "c1", "t", "anthropic/claude-x", "high", 30, "", execFn)
  expect(seenArgv).not.toContain("--pure")
  expect(seenArgv).toContain("--variant")
  expect(seenArgv).toContain("high")
})

// ── runJudgeOpencode ─────────────────────────────────────────────────────

test("runJudgeOpencode: returns concatenated text on success", async () => {
  const execFn = async () => ok(JSON.stringify({ type: "text", text: "the verdict" }))
  const result = await runJudgeOpencode("prompt", "judge-model", 90, 3, execFn)
  expect(result).toBe("the verdict")
})

test("runJudgeOpencode: timeout with attempts remaining retries, then null if never succeeds", async () => {
  let calls = 0
  // The prompt rides on stdin now, so EVERY attempt must carry it — a retry
  // that re-invokes the CLI with an empty stdin gets "You must provide a
  // message or a command" and the judge silently degrades to null. The
  // per-attempt payload is only observable here: the three transport tests in
  // bench-judge-pure.test.ts all run with maxAttempts=1.
  const stdins: (string | undefined)[] = []
  const execFn = async (_argv: string[], opts?: { stdin?: string }): Promise<ExecResult> => {
    calls++
    stdins.push(opts?.stdin)
    return { rc: 0, stdout: "", stderr: "", timedOut: true }
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: string | null
  try {
    result = await runJudgeOpencode("p", "m", 5, 2, execFn, async () => {})
  } finally {
    errSpy.mockRestore()
  }
  expect(result).toBeNull()
  expect(calls).toBe(2)
  expect(stdins).toEqual(["p", "p"])
})

test("runJudgeOpencode: blank reply text -> null", async () => {
  const execFn = async () => ok(JSON.stringify({ type: "text", text: "   " }))
  expect(await runJudgeOpencode("p", "m", 5, 1, execFn)).toBeNull()
})

test("runJudgeOpencode: transient error retries then succeeds, logs 'judge transient provider error'", async () => {
  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    if (calls === 1) return ok('{"type":"error","error":{"name":"rate limited"}}', 1)
    return ok(JSON.stringify({ type: "text", text: "ok verdict" }))
  }
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let result: string | null
  try {
    result = await runJudgeOpencode("p", "m", 90, 3, execFn, async () => {})
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(`judge ${TRANSIENT_MARK}`))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  expect(result).toBe("ok verdict")
})

// ── marker-string producer/consumer contract ─────────────────────────────
// retry-provider.ts's REALWORK_RE / TRANSIENT_MARK are imported (not
// redeclared) from this module — see test/bench-retry-provider.test.ts for
// the wiring assertion. Here we verify the log lines THIS module actually
// emits are matched by those same constants.

test("marker contract: the timeout log line matches REALWORK_RE", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let messages: string[] = []
  try {
    await runOpencode(paths, "c1", "t", "m", "", 900, "", async () => ({ rc: 124, stdout: "", stderr: "", timedOut: true }))
    messages = errSpy.mock.calls.map((c) => String(c[0]))
  } finally {
    errSpy.mockRestore()
  }
  expect(messages.some((m) => REALWORK_RE.test(m))).toBe(true)
  // claude-code-style timeout log line (substring match, per doc comment):
  expect(REALWORK_RE.test("  agent timed out after 30s")).toBe(true)
})

test("marker contract: the 'opencode done ... turns=N' log line matches REALWORK_RE when turns>=1", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let messages: string[] = []
  try {
    await runOpencode(paths, "c1", "t", "m", "", 900, "", async () => ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } })))
    messages = errSpy.mock.calls.map((c) => String(c[0]))
  } finally {
    errSpy.mockRestore()
  }
  const doneLine = messages.find((m) => m.includes("opencode done"))
  expect(doneLine).toBeDefined()
  expect(REALWORK_RE.test(doneLine!)).toBe(true)
})

test("marker contract: the transient-retry log line contains TRANSIENT_MARK verbatim", async () => {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  fs.mkdirSync(path.join(tbRoot, "t"), { recursive: true })
  fs.writeFileSync(path.join(tbRoot, "t", "instruction.md"), "x")
  const paths = fakeBenchPaths(tbRoot)

  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    if (calls === 1) return ok('{"type":"error","error":{"name":"Overloaded"}}', 1)
    return ok(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }))
  }

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let messages: string[] = []
  try {
    await runOpencode(paths, "c1", "t", "m", "", 30, "", execFn, async () => {})
    messages = errSpy.mock.calls.map((c) => String(c[0]))
  } finally {
    errSpy.mockRestore()
  }
  expect(messages.some((m) => m.includes(TRANSIENT_MARK))).toBe(true)
  // and REALWORK_RE must NOT match a transient-retry line on its own (would
  // wrongly signal "provider up" mid-retry — the caller only scans the FULL
  // stream, but this documents the regex's precision).
  const transientLine = messages.find((m) => m.includes(TRANSIENT_MARK))!
  expect(REALWORK_RE.test(transientLine)).toBe(false)
})

test("TRANSIENT_RE matches Python's verbatim pattern set", () => {
  for (const s of ["Overloaded", "unexpected server error", "rate limit", "ratelimit", "429", "503", "Timeout", "connection reset", "temporarily unavailable", "APICallError"]) {
    expect(TRANSIENT_RE.test(s)).toBe(true)
  }
  expect(TRANSIENT_RE.test("some other message")).toBe(false)
})
