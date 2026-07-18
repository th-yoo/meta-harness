/**
 * bench-traj-replay.test.ts — TDD for src/bench/traj-replay.ts's
 * `extractShellCommands` (task-5-brief.md's W3 env-fidelity spot-check
 * helper).
 *
 * Written FIRST, failing (the module doesn't exist yet) — see this task's
 * report for the red→green sequence.
 */
import { test, expect } from "bun:test"
import { extractShellCommands, SHELL_TOOLS } from "../src/bench/traj-replay.ts"
import { MAX_ARGS_CHARS } from "../src/bench/drivers/claude-code.ts"
import type { TrajEvent } from "../src/harness-store.ts"

// ── ordered tool-event extraction ───────────────────────────────────────

test("extractShellCommands: opencode-style bash events extracted verbatim, in order", () => {
  const events: TrajEvent[] = [
    { t: "tool", tool: "bash", args: "echo hi", output: "hi", error: false },
    { t: "tool", tool: "bash", args: "pwd", output: "/app", error: false },
  ]
  const result = extractShellCommands(events)
  expect(result.commands).toEqual(["echo hi", "pwd"])
  expect(result.truncated).toEqual([])
})

test("extractShellCommands: claude-code-style Bash events — command pulled out of the JSON-stringified input", () => {
  const events: TrajEvent[] = [
    {
      t: "tool",
      tool: "Bash",
      args: JSON.stringify({ command: "echo hello && pwd", description: "greet" }),
      output: "hello\n/app",
      error: false,
    },
  ]
  const result = extractShellCommands(events)
  expect(result.commands).toEqual(["echo hello && pwd"])
  expect(result.truncated).toEqual([])
})

// ── text/error events skipped ───────────────────────────────────────────

test("extractShellCommands: text and error events are skipped entirely (no commands, no comment lines)", () => {
  const events: TrajEvent[] = [
    { t: "text", text: "thinking about it" },
    { t: "tool", tool: "bash", args: "echo ok", output: "ok", error: false },
    { t: "error", text: "boom" },
  ]
  const result = extractShellCommands(events)
  expect(result.commands).toEqual(["echo ok"])
  expect(result.truncated).toEqual([])
})

// ── non-shell tools annotated as comments ───────────────────────────────

test("extractShellCommands: non-shell tools rendered as '# <tool>: <args>' comment lines, not executable", () => {
  const events: TrajEvent[] = [
    { t: "tool", tool: "read", args: "/app/main.py", output: "...", error: false },
    { t: "tool", tool: "bash", args: "cat /app/main.py", output: "...", error: false },
  ]
  const result = extractShellCommands(events)
  expect(result.commands).toEqual(["# read: /app/main.py", "cat /app/main.py"])
})

test("extractShellCommands: SHELL_TOOLS documents the accepted shell-tool names — lowercase opencode 'bash', capitalized claude-code 'Bash'", () => {
  expect(SHELL_TOOLS.has("bash")).toBe(true)
  expect(SHELL_TOOLS.has("Bash")).toBe(true)
  expect(SHELL_TOOLS.has("read")).toBe(false)
  expect(SHELL_TOOLS.has("Read")).toBe(false)
})

// ── truncation guard: exact-cap-length args flagged, under-cap not ─────

test("extractShellCommands: a shell command's args at EXACTLY the cap length is flagged truncated and NOT emitted as an executable line", () => {
  const cappedArgs = "x".repeat(MAX_ARGS_CHARS)
  const events: TrajEvent[] = [{ t: "tool", tool: "bash", args: cappedArgs, output: "", error: false }]
  const result = extractShellCommands(events)
  expect(result.truncated).toEqual([0])
  // must not be emitted as a bare executable line — the raw capped text
  // must not appear verbatim as commands[0] (it's wrapped as a comment).
  expect(result.commands[0]).not.toBe(cappedArgs)
  expect(result.commands[0].startsWith("#")).toBe(true)
})

test("extractShellCommands: args ONE CHAR UNDER the cap is not flagged truncated and IS emitted verbatim", () => {
  const underCapArgs = "x".repeat(MAX_ARGS_CHARS - 1)
  const events: TrajEvent[] = [{ t: "tool", tool: "bash", args: underCapArgs, output: "", error: false }]
  const result = extractShellCommands(events)
  expect(result.truncated).toEqual([])
  expect(result.commands).toEqual([underCapArgs])
})

test("extractShellCommands: truncated indices are into the ORIGINAL events array (text/error events shift the index)", () => {
  const cappedArgs = "y".repeat(MAX_ARGS_CHARS)
  const events: TrajEvent[] = [
    { t: "text", text: "preamble" },
    { t: "tool", tool: "bash", args: "echo fine", output: "", error: false },
    { t: "tool", tool: "bash", args: cappedArgs, output: "", error: false },
  ]
  const result = extractShellCommands(events)
  // event index 2 is the truncated one (index 0 is text, skipped).
  expect(result.truncated).toEqual([2])
  expect(result.commands).toEqual(["echo fine", result.commands[1]])
  expect(result.commands[1]!.startsWith("#")).toBe(true)
})

// ── empty events -> empty result ────────────────────────────────────────

test("extractShellCommands: empty events array returns empty commands and truncated arrays", () => {
  const result = extractShellCommands([])
  expect(result.commands).toEqual([])
  expect(result.truncated).toEqual([])
})
