import { test, expect } from "bun:test"
import {
  renderJudgeAuditEvents,
  truncationNotice,
  applyTrajCap,
  buildJudgeAuditPrompt,
  parseJudgeReply,
  judgeReplyText,
  judgeAgentConfig,
  DEFAULT_JUDGE_MODEL,
  JUDGE_AUDIT_ALARM_THRESHOLD,
} from "../src/bench/judge-audit.ts"
import { buildTaxonomyPrompt } from "../src/bench/failure-taxonomy.ts"
import { runJudgeOpencode } from "../src/bench/opencode-run.ts"
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
  const tiny = renderJudgeAuditEvents(events, 5)
  expect(tiny.truncated).toBe(true)
  // pathological cap (< marker length): disclosure wins over the bound, and the
  // standing invariant is shownChars === text.length, not shownChars <= cap
  expect(tiny.shownChars).toBe(tiny.text.length)
  expect(tiny.text.trim()).toMatch(/^\[truncated at 5 of \d+ characters\]$/)
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
  // #4: the earlier regex had two dead alternatives (the notice text is
  // lowercase "do not"); assert against the ACTUAL notice sentence instead.
  expect(r.text).not.toContain("do not conclude that work you cannot see never happened")
  expect(r.text).not.toMatch(/\bNOTE \(harness/)
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

// ── prompt transport (stdin, not argv) ───────────────────────────────────
// `opencode run`'s message positional defaults to [] and the CLI reads the
// message from stdin whenever stdin is not a TTY — verified against the
// installed binary 2026-08-21 with a bad provider (so no model call): a
// piped prompt reaches session creation, an empty stdin exits with "You must
// provide a message or a command". Delivering it on stdin removes Linux's
// MAX_ARG_STRLEN ceiling (131,072 BYTES per argv element; a 200,000-char
// element THROWS E2BIG out of Bun.spawn, which is why the interim guard had
// to skip judges). The transport itself is proven against real subprocesses
// in bench-exec-stdin.test.ts.

const okReply = { rc: 0, stdout: '{"type":"text","part":{"text":"ok"}}', stderr: "", timedOut: false }

test("the judge prompt travels on stdin and appears nowhere in argv", async () => {
  const prompt = "JUDGE_PROMPT_SENTINEL trajectory evidence"
  let seenArgv: string[] = []
  let seenOpts: { timeoutSec?: number; stdin?: string } | undefined
  const execFn = async (argv: string[], opts?: { timeoutSec?: number; stdin?: string }) => {
    seenArgv = argv
    seenOpts = opts
    return okReply
  }
  await runJudgeOpencode(prompt, "anthropic/claude-sonnet-5", 1, 1, execFn as any)
  expect(seenOpts?.stdin).toBe(prompt)
  expect(seenArgv.some((a) => a.includes("JUDGE_PROMPT_SENTINEL"))).toBe(false)
  // and the argv is still a well-formed judge invocation
  expect(seenArgv.slice(0, 2)).toEqual(["opencode", "run"])
  expect(seenArgv).toContain("--model")
})

test("a prompt past the argv ceiling reaches the judge instead of being skipped", async () => {
  let called = 0
  let delivered = ""
  const execFn = async (_argv: string[], opts?: { stdin?: string }) => {
    called++
    delivered = opts?.stdin ?? ""
    return okReply
  }
  const big = "x".repeat(400_000) // >3x MAX_ARG_STRLEN
  const out = await runJudgeOpencode(big, "anthropic/claude-sonnet-5", 1, 1, execFn as any)
  expect(called).toBe(1)
  expect(delivered.length).toBe(big.length)
  expect(out).toBe("ok")
})

test("a prompt whose CHAR count is under the argv ceiling but whose BYTE count is over still transits", async () => {
  // 50,000 chars / 150,000 bytes: the case a char-denominated bound waves
  // through and a byte-denominated one skips. stdin has neither bound.
  const prompt = "日".repeat(50_000)
  expect(prompt.length).toBeLessThan(131_072)
  expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(131_072)
  let delivered = ""
  const execFn = async (_argv: string[], opts?: { stdin?: string }) => {
    delivered = opts?.stdin ?? ""
    return okReply
  }
  const out = await runJudgeOpencode(prompt, "anthropic/claude-sonnet-5", 1, 1, execFn as any)
  expect(delivered).toBe(prompt)
  expect(out).toBe("ok")
})


// ── invariants and boundaries (fresh-context review, findings 7 and 8) ──

test("shownChars === text.length on EVERY path, including empty events", () => {
  const empty = renderJudgeAuditEvents([])
  expect(empty.shownChars).toBe(empty.text.length)
  expect(empty.totalChars).toBe(empty.text.length)
  expect(empty.truncated).toBe(false)
  const small = renderJudgeAuditEvents([{ t: "text", text: "hi" }])
  expect(small.shownChars).toBe(small.text.length)
  const big = applyTrajCap("z".repeat(5_000), 1_000)
  expect(big.shownChars).toBe(big.text.length)
})

test("a normal truncation does NOT exceed the cap (marker room reserved)", () => {
  const r = applyTrajCap("z".repeat(50_000), 1_000)
  expect(r.text.length).toBeLessThanOrEqual(1_000)
  expect(r.totalChars).toBe(50_000)
})

test("the exactly-at-cap boundary is not truncated; one over is", () => {
  const at = applyTrajCap("z".repeat(1_000), 1_000)
  expect(at.truncated).toBe(false)
  expect(at.text.length).toBe(1_000)
  const over = applyTrajCap("z".repeat(1_001), 1_000)
  expect(over.truncated).toBe(true)
})

test("buildJudgeAuditPrompt: truncation notice AND amended evidence rule", () => {
  // finding 3: this prompt's truncation path was entirely untested
  // finding 2: its rules block claimed the trajectory is COMPLETE evidence
  const many: TrajEvent[] = Array.from({ length: 6000 }, (_, i) => ({ t: "text" as const, text: `e${i} ${"w".repeat(80)}` }))
  const p = buildJudgeAuditPrompt(many, "task note")
  expect(p).toContain("NOTE (harness, trusted)")
  expect(p.indexOf("NOTE (harness, trusted)")).toBeLessThan(p.indexOf("## Trajectory (tool calls"))
  expect(p.replace(/\s+/g, " ")).toContain("COMPLETE unless a truncation NOTE appears above")
  expect(p.replace(/\s+/g, " ")).not.toContain("your COMPLETE and ONLY evidence")
})
