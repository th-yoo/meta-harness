import { test, expect } from "bun:test"
import { buildJudgePrompt, parseVerdict } from "../src/judge.ts"
import { DEFAULT_TRAJ_CAP } from "../src/traj-cap.ts"
import type { TrajEvent } from "../src/harness-store.ts"

// Token-free: exercises buildJudgePrompt's rendering + parseVerdict directly —
// no opencode session, no LLM call. runJudge (the LLM-spawning half) is
// intentionally NOT covered here.

const traj: TrajEvent[] = [
  { t: "text", text: "Implementing the token counter now." },
  { t: "tool", tool: "bash", args: "npm test", output: "12 passed", error: false },
  { t: "tool", tool: "bash", args: "npm run build", output: "Error: cannot find module 'foo'", error: true },
]

function render(): string {
  return buildJudgePrompt("count tokens", 4, traj)
}

test("buildJudgePrompt instructs an INLINE reply (no file/tool) with the verdict JSON shape", () => {
  const prompt = render()
  expect(prompt).toContain(`"passed"`)
  expect(prompt).toContain(`"confidence"`)
  expect(prompt).toContain(`"reasoning"`)
  expect(prompt.toLowerCase()).toContain("reply with only the json")
  // No file-write / bash heredoc mechanism any more.
  expect(prompt).not.toContain("ENDOFVERDICT")
  expect(prompt).not.toContain("cat >")
})

test("buildJudgePrompt renders the trajectory — text, tool calls, args/output, and errors", () => {
  const prompt = render()
  expect(prompt).toContain("Implementing the token counter now.")
  expect(prompt).toContain("npm test")
  expect(prompt).toContain("12 passed")
  expect(prompt).toContain("npm run build")
  expect(prompt).toContain("cannot find module 'foo'")
  expect(prompt).toContain("[ERROR]")
})

test("buildJudgePrompt includes the task summary, turn count, and untrusted-data reminder", () => {
  const prompt = render()
  expect(prompt).toContain("count tokens")
  expect(prompt).toContain("4")
  expect(prompt).toContain("untrusted DATA")
})

test("buildJudgePrompt with an empty trajectory still renders without throwing", () => {
  const prompt = buildJudgePrompt("no-op task", 0, [])
  expect(prompt).toContain("no-op task")
  expect(prompt).toContain("(no trajectory captured)")
})

// ── parseVerdict (reads the judge's inline reply) ──────────────────────────

test("parseVerdict extracts a bare JSON verdict — trivial absent defaults to false", () => {
  const v = parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"file created and verified"}`)
  expect(v).toEqual({ passed: true, confidence: 0.9, reasoning: "file created and verified", trivial: false })
})

test("parseVerdict parses trivial:true when present", () => {
  const v = parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"just said hi","trivial":true}`)
  expect(v?.trivial).toBe(true)
})

test("parseVerdict parses trivial:false when explicitly present", () => {
  const v = parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"real work","trivial":false}`)
  expect(v?.trivial).toBe(false)
})

test("parseVerdict defaults trivial to false when the key is a non-boolean", () => {
  expect(parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"x","trivial":"yes"}`)?.trivial).toBe(false)
  expect(parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"x","trivial":1}`)?.trivial).toBe(false)
  expect(parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"x","trivial":null}`)?.trivial).toBe(false)
})

test("a verdict without a trivial key is still a fully valid verdict (back-compat)", () => {
  const v = parseVerdict(`{"passed":false,"confidence":0.3,"reasoning":"errored and unrecovered"}`)
  expect(v).not.toBeNull()
  expect(v?.passed).toBe(false)
  expect(v?.trivial).toBe(false)
})

test("parseVerdict tolerates prose + markdown fences around the JSON", () => {
  const v = parseVerdict('Here is my verdict:\n```json\n{"passed":false,"confidence":0.8,"reasoning":"never recovered"}\n```\n')
  expect(v?.passed).toBe(false)
  expect(v?.confidence).toBe(0.8)
})

test("parseVerdict returns the LAST valid verdict when several JSON objects appear", () => {
  const v = parseVerdict('{"passed":false,"confidence":0.1,"reasoning":"first"} then {"passed":true,"confidence":0.7,"reasoning":"final"}')
  expect(v?.passed).toBe(true)
  expect(v?.reasoning).toBe("final")
})

test("parseVerdict rejects objects missing keys / wrong types, and garbage", () => {
  expect(parseVerdict("no json here")).toBeNull()
  expect(parseVerdict(`{"foo":"bar"}`)).toBeNull()
  expect(parseVerdict(`{"passed":"yes","confidence":0.5,"reasoning":"x"}`)).toBeNull()   // passed not boolean
  expect(parseVerdict(`{"passed":true,"confidence":2,"reasoning":"x"}`)).toBeNull()      // confidence out of range
})

test("parseVerdict caps reasoning at 500 chars", () => {
  const long = "x".repeat(600)
  const v = parseVerdict(`{"passed":true,"confidence":1,"reasoning":"${long}"}`)
  expect(v?.reasoning.length).toBe(500)
})

test("JUDGE_SYSTEM_PROMPT loads from the shared judge-prompt.txt (single source with runner.py)", async () => {
  const { JUDGE_SYSTEM_PROMPT } = await import("../src/judge.ts")
  expect(JUDGE_SYSTEM_PROMPT).toContain("Meta-Harness Judge")
  expect(JUDGE_SYSTEM_PROMPT).toContain("NOT a coding agent")
  expect(JUDGE_SYSTEM_PROMPT).toContain("untrusted DATA")
  // must be the real file, not the tiny inline fallback
  const fs = await import("node:fs")
  const path = await import("node:path")
  const onDisk = fs.readFileSync(path.join(import.meta.dir, "..", "src", "judge-prompt.txt"), "utf-8").trim()
  expect(JUDGE_SYSTEM_PROMPT).toBe(onDisk)
})

// ── truncation must announce itself here too (2026-08-21) ────────────────
// judge.ts's renderTrajEvents carried the SAME cap=8_000 bare-string defect as
// judge-audit's renderJudgeAuditEvents. This is the SCORING path, and its
// rubric says "using ONLY the evidence in the Trajectory" — an explicit
// invitation to make ABSENCE claims about a window. Measured on the taxonomy
// side: an 8,000-char window flipped every one of 8 classifications.

test("buildJudgePrompt announces truncation to the scoring judge", () => {
  const many: TrajEvent[] = Array.from({ length: 4000 }, (_, i) => ({
    t: "text" as const,
    text: `step ${i} ${"q".repeat(80)}`,
  }))
  const p = buildJudgePrompt("summary", 12, many)
  expect(p).toContain("NOTE (harness, trusted)")
  expect(p.indexOf("NOTE (harness, trusted)")).toBeLessThan(p.indexOf("## Trajectory"))
  // #4 (was vacuous: asserted a literal no revision ever contained). The real
  // check: the notice's imperative sentence must appear ONCE, in the frame,
  // and never inside the trajectory section.
  const dataStart = p.indexOf("## Trajectory")
  expect(p.slice(dataStart)).not.toContain("do not conclude that work you cannot see never happened")
  expect(p.slice(0, dataStart)).toContain("do not conclude that work you cannot see never happened")
})

test("a short trajectory carries no truncation notice", () => {
  const few: TrajEvent[] = [{ t: "text", text: "hello" }]
  const p = buildJudgePrompt("summary", 1, few)
  expect(p).not.toContain("NOTE (harness, trusted)")
  expect(p).toContain("SAY: hello")
})

test("the scoring judge's cap IS the shared constant (identity, not magnitude)", () => {
  // #5 (was overclaiming: a hardcoded 100_000 would have passed). Assert the
  // boundary sits exactly at DEFAULT_TRAJ_CAP, which only the shared constant
  // can satisfy.
  const line = "y".repeat(99) + "\n"
  const under: TrajEvent[] = [{ t: "text", text: "y".repeat(DEFAULT_TRAJ_CAP - 10) }]
  const over: TrajEvent[] = [{ t: "text", text: "y".repeat(DEFAULT_TRAJ_CAP + 10) }]
  expect(buildJudgePrompt("s", 1, under)).not.toContain("NOTE (harness, trusted)")
  expect(buildJudgePrompt("s", 1, over)).toContain("NOTE (harness, trusted)")
  expect(line.length).toBe(100)
})
