import { test, expect } from "bun:test"
import { buildJudgePrompt, parseVerdict } from "../src/judge.ts"
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

test("parseVerdict extracts a bare JSON verdict", () => {
  const v = parseVerdict(`{"passed":true,"confidence":0.9,"reasoning":"file created and verified"}`)
  expect(v).toEqual({ passed: true, confidence: 0.9, reasoning: "file created and verified" })
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
