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

// ── comment lines must be newline-safe (review fix 1) ───────────────────
// opencode bash args are raw unescaped strings — a multi-line command
// (heredoc etc.) interpolated into a `#`-prefixed line would embed literal
// newlines, so in an sh replay only the first physical line stays commented
// and the rest executes live. Every comment entry must contain NO raw
// newline (newlines rendered as escaped "\n" text instead).

test("extractShellCommands: multi-line bash args at exact cap — the truncated-comment entry contains no raw newline", () => {
  const body = "cat <<EOF > /tmp/x\nrm -rf /important\nEOF\n"
  const cappedMultiline = body + "z".repeat(MAX_ARGS_CHARS - body.length)
  expect(cappedMultiline.length).toBe(MAX_ARGS_CHARS)
  const events: TrajEvent[] = [{ t: "tool", tool: "bash", args: cappedMultiline, output: "", error: false }]
  const result = extractShellCommands(events)
  expect(result.truncated).toEqual([0])
  expect(result.commands).toHaveLength(1)
  const entry = result.commands[0]!
  expect(entry.startsWith("#")).toBe(true)
  // the core guarantee: no raw newline anywhere in the comment entry, so
  // splitting a replay script on real newlines can never surface an
  // uncommented executable fragment of it.
  expect(entry.includes("\n")).toBe(false)
  expect(entry.includes("\r")).toBe(false)
})

test("extractShellCommands: multi-line args on a NON-shell tool — the annotation comment contains no raw newline", () => {
  const events: TrajEvent[] = [
    { t: "tool", tool: "write", args: "/tmp/f.txt\nline two\nline three", output: "", error: false },
  ]
  const result = extractShellCommands(events)
  expect(result.commands).toHaveLength(1)
  const entry = result.commands[0]!
  expect(entry.startsWith("# write:")).toBe(true)
  expect(entry.includes("\n")).toBe(false)
})

// ── non-shell tool at exact cap (review fix 2) ──────────────────────────

test("extractShellCommands: a NON-shell tool at exactly MAX_ARGS_CHARS is flagged truncated but still rendered as a '# <tool>: ...' comment", () => {
  const cappedArgs = "p".repeat(MAX_ARGS_CHARS)
  const events: TrajEvent[] = [{ t: "tool", tool: "read", args: cappedArgs, output: "", error: false }]
  const result = extractShellCommands(events)
  expect(result.truncated).toEqual([0])
  expect(result.commands).toHaveLength(1)
  expect(result.commands[0]!.startsWith("# read:")).toBe(true)
})

// ── empty events -> empty result ────────────────────────────────────────

test("extractShellCommands: empty events array returns empty commands and truncated arrays", () => {
  const result = extractShellCommands([])
  expect(result.commands).toEqual([])
  expect(result.truncated).toEqual([])
})
