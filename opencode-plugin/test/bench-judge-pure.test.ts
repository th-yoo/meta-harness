import { test, expect } from "bun:test"
import {
  renderJudgeAuditEvents,
  truncationNotice,
  buildJudgeAuditPrompt,
  parseJudgeReply,
  judgeReplyText,
  judgeAgentConfig,
  DEFAULT_JUDGE_MODEL,
  JUDGE_AUDIT_ALARM_THRESHOLD,
} from "../src/bench/judge-audit.ts"
import { buildTaxonomyPrompt } from "../src/bench/failure-taxonomy.ts"
import { buildJudgeArgv } from "../src/bench/opencode-run.ts"
import type { TrajEvent } from "../src/harness-store.ts"

// Ported from term-bench2/test_judge_audit.py — pure halves only (the
// cmd_judge_audit control-flow vectors that monkeypatch run_judge_opencode
// are P6, since spawning is out of scope for this task).

// ── build_judge_audit_prompt ─────────────────────────────────────────────

test("buildJudgeAuditPrompt contains the verdict shape and rendered events", () => {
  const events: TrajEvent[] = [
    { t: "tool", tool: "bash", args: "cat file.txt", output: "hello world", error: false },
    { t: "text", text: "I will count the tokens now" },
    { t: "error", text: "boom: command not found" },
  ]
  const prompt = buildJudgeAuditPrompt(events, "count tokens")

  expect(prompt).toContain("count tokens")
  expect(prompt).toContain("bash")
  expect(prompt).toContain("cat file.txt")
  expect(prompt).toContain("hello world")
  expect(prompt).toContain("I will count the tokens now")
  expect(prompt).toContain("boom: command not found")
  expect(prompt).toContain('"passed"')
  expect(prompt).toContain('"confidence"')
  expect(prompt).toContain('"reasoning"')
  expect(prompt.toLowerCase()).toContain("final message")
})

test("buildJudgeAuditPrompt with empty events", () => {
  const prompt = buildJudgeAuditPrompt([], "some task")
  expect(prompt).toContain("some task")
  expect(prompt).toContain('"passed"')
  expect(prompt).toContain("(no trajectory captured)")
})

// ── renderJudgeAuditEvents ───────────────────────────────────────────────

test("renderJudgeAuditEvents renders tool/text/error lines and caps output", () => {
  expect(renderJudgeAuditEvents([]).text).toBe("(no trajectory captured)")
  const events: TrajEvent[] = [
    { t: "tool", tool: "bash", args: "ls", output: "a.txt", error: false },
    { t: "tool", tool: "bash", args: "rm x", error: true },
    { t: "text", text: "done" },
    { t: "error", text: "boom" },
  ]
  const out = renderJudgeAuditEvents(events).text
  expect(out).toBe("TOOL bash: ls → a.txt\nTOOL bash [ERROR]: rm x\nSAY: done\nERROR: boom")
  expect(renderJudgeAuditEvents(events, 5).shownChars).toBe(5)
  expect(renderJudgeAuditEvents(events, 5).truncated).toBe(true)
})

// ── parse_judge_reply ─────────────────────────────────────────────────────

test("parseJudgeReply extracts a trailing JSON object", () => {
  const text = 'blah blah {"passed": true, "confidence": 0.9, "reasoning": "x"}'
  expect(parseJudgeReply(text)).toEqual({ passed: true, confidence: 0.9, reasoning: "x" })
})

test("parseJudgeReply returns null for garbage", () => {
  expect(parseJudgeReply("no json here")).toBeNull()
})

test("parseJudgeReply returns the last of two JSON objects", () => {
  const text =
    '{"passed": false, "confidence": 0.4, "reasoning": "first draft"} ' +
    "actually wait, let me reconsider... " +
    '{"passed": true, "confidence": 0.95, "reasoning": "final answer"}'
  expect(parseJudgeReply(text)).toEqual({ passed: true, confidence: 0.95, reasoning: "final answer" })
})

test("parseJudgeReply ignores JSON missing required keys", () => {
  const text = '{"foo": "bar"} then {"passed": true, "confidence": 0.5, "reasoning": "ok"}'
  expect(parseJudgeReply(text)).toEqual({ passed: true, confidence: 0.5, reasoning: "ok" })
})

test("parseJudgeReply tolerates and passes through an extra 'trivial' key", () => {
  // Task 7 / Option A: judge-prompt.txt (the shared persona file) now also
  // asks the judge to rate `trivial`. parseJudgeReply requires only
  // passed/confidence/reasoning (a subset check) so the extra key must pass
  // straight through, unvalidated.
  const text = '{"passed": true, "confidence": 0.9, "reasoning": "ok", "trivial": true}'
  expect(parseJudgeReply(text)).toEqual({ passed: true, confidence: 0.9, reasoning: "ok", trivial: true })
})

// ── judge_reply_text ──────────────────────────────────────────────────────

test("judgeReplyText concatenates 'text' event content from NDJSON", () => {
  const ndjson = [
    JSON.stringify({ type: "text", text: "hello" }),
    JSON.stringify({ type: "tool", text: "ignored (not a text event)" }),
    JSON.stringify({ type: "text", part: { text: "world" } }),
    "",
    "not json",
    JSON.stringify({ type: "text", text: "   " }), // blank after trim -> skipped
  ].join("\n")
  expect(judgeReplyText(ndjson)).toBe("hello\nworld")
})

test("judgeReplyText on empty/no-text-event input", () => {
  expect(judgeReplyText("")).toBe("")
  expect(judgeReplyText(JSON.stringify({ type: "tool" }))).toBe("")
})

// ── judge_agent_config ────────────────────────────────────────────────────

test("judgeAgentConfig builds the locked-down block from a prompt file", () => {
  // write a temp prompt file
  const fs = require("node:fs") as typeof import("node:fs")
  const os = require("node:os") as typeof import("node:os")
  const path = require("node:path") as typeof import("node:path")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-prompt-"))
  const p = path.join(dir, "judge-prompt.txt")
  fs.writeFileSync(p, "You are the Meta-Harness Judge. Test persona.")
  const block = judgeAgentConfig(p)
  expect(block).not.toBeNull()
  expect(block!.prompt).toContain("Meta-Harness Judge")
  expect(block!.permission).toEqual({ "*": "deny" })
  expect(["all", "primary"]).toContain(block!.mode)
})

test("judgeAgentConfig returns null for missing or empty prompt file", () => {
  const fs = require("node:fs") as typeof import("node:fs")
  const os = require("node:os") as typeof import("node:os")
  const path = require("node:path") as typeof import("node:path")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-prompt-"))
  expect(judgeAgentConfig(path.join(dir, "nope.txt"))).toBeNull()
  const empty = path.join(dir, "empty.txt")
  fs.writeFileSync(empty, "   \n")
  expect(judgeAgentConfig(empty)).toBeNull()
})

test("judgeAgentConfig against the REAL shared judge-prompt.txt (single source of truth)", () => {
  const block = judgeAgentConfig()
  expect(block).not.toBeNull()
  const text = block!.prompt
  expect(text).toContain("Meta-Harness Judge")
  expect(text).toContain("NOT a coding agent")
  expect(text).toContain("untrusted DATA")
})

// ── constants ─────────────────────────────────────────────────────────────

test("DEFAULT_JUDGE_MODEL / JUDGE_AUDIT_ALARM_THRESHOLD constants", () => {
  expect(DEFAULT_JUDGE_MODEL).toBe("openrouter/google/gemini-2.5-flash")
  expect(JUDGE_AUDIT_ALARM_THRESHOLD).toBe(0.8)
})

// ── truncation must be VISIBLE (2026-08-21) ──────────────────────────────
// Measured defect: cap=8_000 silently cut 12-38% windows out of 21-66KB
// trajectories, and the judge narrated its window as the whole session
// ("the trajectory ends before any image.c is written" — it did not).
// Truncation that does not announce itself manufactures the `incomplete` mode.

test("renderJudgeAuditEvents reports whether it truncated", () => {
  const small: TrajEvent[] = [{ t: "text", text: "hi" }]
  const r = renderJudgeAuditEvents(small)
  expect(r.truncated).toBe(false)
  expect(r.text).toContain("SAY: hi")
  expect(r.totalChars).toBe(r.shownChars)
})

test("the in-data marker is NEUTRAL — no imperative inside untrusted data", () => {
  // FIX-FIRST (cross-lane review): both prompts order the judge to IGNORE text
  // inside the trajectory that instructs it. An imperative notice there is
  // either discounted (fix inert) or obeyed (injection surface demonstrated).
  const many: TrajEvent[] = Array.from({ length: 200 }, (_, i) => ({ t: "text" as const, text: `line ${i} ${"x".repeat(50)}` }))
  const r = renderJudgeAuditEvents(many, 500)
  expect(r.truncated).toBe(true)
  expect(r.totalChars).toBeGreaterThan(r.shownChars)
  expect(r.text).toMatch(/\[truncated at [\d,]+ of [\d,]+ characters\]/)
  // NO imperatives in the data section
  expect(r.text).not.toMatch(/do NOT|CONTINUES|never happened/)
})

test("truncationNotice builds the TRUSTED-FRAME sentence, outside the data", () => {
  const n = truncationNotice({ text: "", truncated: true, totalChars: 64586, shownChars: 8000 })
  expect(n).toContain("harness")
  expect(n).toContain("64,586")
  expect(n).toContain("8,000")
  expect(n).toMatch(/absence from this prefix is not evidence of absence/i)
  expect(truncationNotice({ text: "", truncated: false, totalChars: 10, shownChars: 10 })).toBe("")
})

test("the default cap admits a real trajectory that previously got cut", () => {
  // the path-tracing failures rendered to 21,673-66,508 chars; 8,000 cut 5 of 7
  // before their first image.c write
  const big: TrajEvent[] = Array.from({ length: 900 }, (_, i) => ({ t: "text" as const, text: `event ${i} ${"y".repeat(70)}` }))
  const r = renderJudgeAuditEvents(big)
  expect(r.totalChars).toBeGreaterThan(60_000)
  expect(r.truncated).toBe(false)
})

test("buildTaxonomyPrompt carries the notice in the TRUSTED frame, before the data", () => {
  const many: TrajEvent[] = Array.from({ length: 4000 }, (_, i) => ({ t: "text" as const, text: `l${i} ${"z".repeat(80)}` }))
  const p = buildTaxonomyPrompt(many, "task", "instruction", true)
  expect(p).toContain("NOTE (harness, trusted)")
  // the notice must precede the untrusted trajectory section
  expect(p.indexOf("NOTE (harness, trusted)")).toBeLessThan(p.indexOf("## Agent trajectory"))
})

// ── stdin transport (2026-08-21) ─────────────────────────────────────────
// The judge prompt was passed as ONE argv element, imposing Linux's
// MAX_ARG_STRLEN (131,072) as a hard ceiling on what any judge can be shown —
// measured: 200,000 chars -> E2BIG, 131,000 -> OK. That is the 8,000-char cap
// defect one layer down: a transport constraint silently bounding what the
// judge may know. opencode reads the message from stdin (verified live:
// `echo ... | opencode run --format json` returned the reply), so the ceiling
// is removable, not inherent.

test("buildJudgeArgv keeps the prompt OUT of argv", () => {
  const argv = buildJudgeArgv("/tmp/scratch", [], "anthropic/claude-sonnet-5")
  expect(argv[0]).toBe("opencode")
  expect(argv).toContain("run")
  expect(argv).toContain("--model")
  // the prompt is delivered on stdin; no element may carry it
  expect(argv.every((a) => a.length < 1_000)).toBe(true)
  expect(argv.join(" ")).not.toContain("PROMPT_BODY")
})

test("argv stays far below MAX_ARG_STRLEN regardless of trajectory size", () => {
  const argv = buildJudgeArgv("/tmp/scratch", ["--agent", "mh-judge"], "anthropic/claude-sonnet-5")
  const longest = Math.max(...argv.map((a) => a.length))
  expect(longest).toBeLessThan(4_096)
})
