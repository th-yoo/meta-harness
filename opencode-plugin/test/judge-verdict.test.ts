import { test, expect } from "bun:test"
import { runJudge } from "../src/judge.ts"

// Token-free: a fake client returns the judge's INLINE reply in the
// session.prompt response `parts` (the new mechanism — the judge replies with
// the JSON verdict as its message, no staging file). Exercises runJudge's
// text-extraction + verdict-parse/return path (incl. the reasoning-length cap).

function fakeClient(replyText: string): any {
  return {
    session: {
      create: async () => ({ data: { id: "judge-session-1" } }),
      prompt: async () => ({
        data: { info: {}, parts: [{ type: "text", text: replyText }] },
      }),
    },
  }
}

test("runJudge parses the inline verdict and caps an overlong reasoning string to 500 chars", async () => {
  const reply = JSON.stringify({ passed: true, confidence: 0.9, reasoning: "x".repeat(600) })
  const verdict = await runJudge(fakeClient(reply), "/unused", "sess-cap", "summary", 3, [])
  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning.length).toBe(500)
  expect(verdict!.passed).toBe(true)
  expect(verdict!.confidence).toBe(0.9)
})

test("runJudge passes a short reasoning string through unchanged", async () => {
  const reply = JSON.stringify({ passed: false, confidence: 0.4, reasoning: "too short to trigger the cap" })
  const verdict = await runJudge(fakeClient(reply), "/unused", "sess-short", "summary", 1, [])
  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning).toBe("too short to trigger the cap")
  expect(verdict!.passed).toBe(false)
})

test("runJudge tolerates a fenced reply and returns null on a garbage reply", async () => {
  const wrapped = 'Verdict:\n```json\n{"passed":true,"confidence":0.7,"reasoning":"ok"}\n```'
  expect((await runJudge(fakeClient(wrapped), "/unused", "s1", "s", 1, []))?.passed).toBe(true)
  expect(await runJudge(fakeClient("I could not decide."), "/unused", "s2", "s", 1, [])).toBeNull()
})
