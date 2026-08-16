import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { claudeCodeDriver, normalizeEvents, EXECUTION_TOOLS } from "../src/bench/drivers/claude-code.ts"
import { AUTH_ERROR_RE } from "../src/bench/agent-run.ts"
import { BenchError } from "../src/bench/util.ts"
import type { ExecResult } from "../src/bench/exec.ts"

// TDD RED inputs — real captured claude-code 2.1.207 stream-json (pinned
// version per task-B4-report.md), sanitized. See task-B5-report.md for the
// exact capture commands + sanitization. These are the parser's ground
// truth per task-B5-brief.md, overriding the brief's own shape sketch where
// they disagree (documented in drivers/claude-code.ts's file header).
const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "drivers", "claude-code")

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8")
}

function ok(stdout: string, rc = 0): ExecResult {
  return { rc, stdout, stderr: "", timedOut: false }
}

// ── EXECUTION_TOOLS ──────────────────────────────────────────────────────

test("EXECUTION_TOOLS is exactly {Bash, Task} (CC's capitalized tool names)", () => {
  expect([...EXECUTION_TOOLS].sort()).toEqual(["Bash", "Task"])
})

// ── parseOutput: success fixture ────────────────────────────────────────

test("parseOutput: success fixture — turnCount from result.num_turns, one clean Bash call, non-empty events", () => {
  const result = claudeCodeDriver.parseOutput(fixture("success.ndjson"))
  expect(result.turnCount).toBe(2) // real result event: num_turns:2
  expect(result.toolUsage).toEqual({ Bash: { calls: 1, errors: 0 } })
  expect(result.events.length).toBeGreaterThan(0)
  const toolEvent = result.events.find((e) => e.t === "tool")
  expect(toolEvent).toMatchObject({ t: "tool", tool: "Bash", error: false })
  expect(toolEvent!.output).toContain("hello")
})

// ── parseOutput: tool-error fixture ─────────────────────────────────────

test("parseOutput: tool-error fixture — Bash tool_result is_error:true counted as a tool error", () => {
  const result = claudeCodeDriver.parseOutput(fixture("tool-error.ndjson"))
  expect(result.toolUsage).toEqual({ Bash: { calls: 1, errors: 1 } })
  const toolEvent = result.events.find((e) => e.t === "tool")
  expect(toolEvent!.error).toBe(true)
  expect(toolEvent!.output).toContain("No such file or directory")
})

test("parseOutput: a non-execution tool's is_error:true is NOT counted as an error", () => {
  const ndjson = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/nope" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "not found", is_error: true }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done" }),
  ].join("\n")
  const result = claudeCodeDriver.parseOutput(ndjson)
  expect(result.toolUsage).toEqual({ Read: { calls: 1, errors: 0 } })
})

// ── normalizeEvents: caps ───────────────────────────────────────────────

test("normalizeEvents: args/output truncated at 300/800 chars", () => {
  const bigArgs = "a".repeat(400)
  const bigOut = "b".repeat(900)
  const ndjson = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: bigArgs } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: bigOut, is_error: false }] },
    }),
  ].join("\n")
  const events = normalizeEvents(ndjson)
  expect(events).toHaveLength(1)
  expect(events[0]!.args!.length).toBe(300)
  expect(events[0]!.output!.length).toBe(800)
})

test("normalizeEvents: caps at maxEvents (synthetic oversized stream)", () => {
  const lines = Array.from({ length: 500 }, (_, i) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `t${i}` }] } }),
  ).join("\n")
  expect(normalizeEvents(lines).length).toBe(400)
  expect(normalizeEvents(lines, 3).length).toBe(3)
})

test("normalizeEvents: blank text blocks skipped", () => {
  const ndjson = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } }),
  ].join("\n")
  expect(normalizeEvents(ndjson)).toEqual([{ t: "text", text: "hello" }])
})

test("normalizeEvents: a failed result event emits a t:error event; a successful one does not", () => {
  const failed = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" })
  expect(normalizeEvents(failed)).toEqual([{ t: "error", text: "Invalid API key" }])
  const ok_ = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "all good" })
  expect(normalizeEvents(ok_)).toEqual([])
})

// ── turnCount fallback (documented, not exercised by any real fixture) ──

test("parseOutput: falls back to counting assistant-with-text events when result.num_turns is absent", () => {
  const ndjson = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
    // no "result" event at all
  ].join("\n")
  expect(claudeCodeDriver.parseOutput(ndjson).turnCount).toBe(2)
})

// ── classifyAttempt: auth fixture (REAL capture — proves the AUTH_ERROR_RE
//    "authentication_failed" gap and the tool_use-vs-assistant activity fix) ─

test("classifyAttempt: auth-error fixture (REAL, 'Not logged in') classifies as auth, not transient/done", () => {
  const out = fixture("auth-error.txt")
  expect(claudeCodeDriver.classifyAttempt(ok(out, 1))).toBe("auth")
})

test("AUTH_ERROR_RE: matches the real captured auth-error fixture's structured error field", () => {
  expect(AUTH_ERROR_RE.test(fixture("auth-error.txt"))).toBe(true)
})

test("classifyAttempt: transient fixture (SYNTHETIC, overloaded) classifies as transient", () => {
  const out = fixture("transient.txt")
  expect(claudeCodeDriver.classifyAttempt(ok(out, 1))).toBe("transient")
})

test("classifyAttempt: success fixture classifies as done even though tool_result carries an is_error inside it is absent", () => {
  expect(claudeCodeDriver.classifyAttempt(ok(fixture("success.ndjson"), 0))).toBe("done")
})

test("classifyAttempt: tool-error fixture (top-level is_error:false) still classifies as done — a mid-run tool failure the agent narrated is not an attempt-level failure", () => {
  expect(claudeCodeDriver.classifyAttempt(ok(fixture("tool-error.ndjson"), 0))).toBe("done")
})

test("classifyAttempt: a mid-run error AFTER real tool_use activity is 'done', not retried (hadActivity suppresses auth/transient)", () => {
  const out = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "unauthorized: mid-run crash" }),
  ].join("\n")
  expect(claudeCodeDriver.classifyAttempt(ok(out, 1))).toBe("done")
})

// ── modelArg ─────────────────────────────────────────────────────────────

test("modelArg: strips the anthropic/ prefix", () => {
  expect(claudeCodeDriver.modelArg("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
})

test("modelArg: dies with an actionable message on a non-anthropic slug", () => {
  expect(() => claudeCodeDriver.modelArg("openai/gpt-4")).toThrow(BenchError)
  try {
    claudeCodeDriver.modelArg("openai/gpt-4")
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as Error).message).toContain('supports anthropic/* models only, got "openai/gpt-4"')
  }
})

// ── buildArgv ────────────────────────────────────────────────────────────

test("buildArgv: contains the translated model + instruction + stream-json flags", () => {
  const argv = claudeCodeDriver.buildArgv({ model: "claude-sonnet-4-6", variant: "", instruction: "do the thing" })
  expect(argv).toEqual([
    "claude",
    "-p",
    "do the thing",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-sonnet-4-6",
    "--dangerously-skip-permissions",
  ])
})

test("buildArgv: dies on a non-empty variant — CC has no variant concept", () => {
  expect(() => claudeCodeDriver.buildArgv({ model: "m", variant: "v2", instruction: "x" })).toThrow(BenchError)
})

// ── driver shape ─────────────────────────────────────────────────────────

test("claudeCodeDriver: id, harness, versionArgv", () => {
  expect(claudeCodeDriver.id).toBe("claude-code")
  expect(claudeCodeDriver.harness).toEqual({ kind: "workspace-file", filename: "CLAUDE.md" })
  expect(claudeCodeDriver.versionArgv).toEqual(["claude", "--version"])
})

// final-review fix 5: claude-code's auth remediation must be CC-appropriate
// (a claude-code CLI command / ANTHROPIC_API_KEY), never opencode's wording.
test("claudeCodeDriver: authHint is CC-appropriate, not opencode's", () => {
  expect(claudeCodeDriver.authHint).toBeDefined()
  expect(claudeCodeDriver.authHint).toContain("claude")
  expect(claudeCodeDriver.authHint).toContain("ANTHROPIC_API_KEY")
  expect(claudeCodeDriver.authHint).not.toContain("opencode")
  expect(claudeCodeDriver.authHint).not.toContain("auth.json")
})

// ── zero-activity "success" = provider failure (tune-mjcf 2026-08-17) ────
// Live burn: 4 consecutive agent attempts finished rc 0 in 32-43s with
// turns=0 (OAuth usage window exhausted mid-run — CC exits "successfully"
// with a limit-reached result and NO tool_use). The old classifier returned
// "done" and each empty attempt was recorded as reward=0, silently costing
// -1 vs anchor per trial. A bench attempt that never invoked a single tool
// cannot have done task work: classify as transient (bounded retries make
// the cause visible; persistent exhaustion still terminates via
// MAX_ATTEMPTS).
test("classifyAttempt: rc 0 with a result event but ZERO tool_use classifies as transient, never done", () => {
  const out = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 0,
      result: "5-hour limit reached · resets 9am",
    }),
  ].join("\n")
  expect(claudeCodeDriver.classifyAttempt(ok(out, 0))).toBe("transient")
})

test("classifyAttempt: completely empty rc-0 stdout classifies as transient, never done", () => {
  expect(claudeCodeDriver.classifyAttempt(ok("", 0))).toBe("transient")
})
