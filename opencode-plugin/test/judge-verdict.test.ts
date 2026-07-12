import { test, expect } from "bun:test"
import { runJudge } from "../src/judge.ts"
import type { HarnessHost } from "../src/host.ts"

// Token-free: a fake host returns the judge's INLINE reply from runTextAgent
// (the new mechanism — the judge replies with the JSON verdict as its
// message, no staging file). Exercises runJudge's verdict-parse/return path
// (incl. the reasoning-length cap) without caring how the host produced the
// text (that's host-opencode.test.ts's job).

function fakeHost(replyText: string | null): HarnessHost {
  return {
    platform: "fake",
    projectRoot: "/unused",
    log: async () => {},
    notify: async () => {},
    showScorePrompt: async () => {},
    runTextAgent: async () => replyText,
    runTaskAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  }
}

test("runJudge parses the inline verdict and caps an overlong reasoning string to 500 chars", async () => {
  const reply = JSON.stringify({ passed: true, confidence: 0.9, reasoning: "x".repeat(600) })
  const verdict = await runJudge(fakeHost(reply), "/unused", "sess-cap", "summary", 3, [])
  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning.length).toBe(500)
  expect(verdict!.passed).toBe(true)
  expect(verdict!.confidence).toBe(0.9)
})

test("runJudge passes a short reasoning string through unchanged", async () => {
  const reply = JSON.stringify({ passed: false, confidence: 0.4, reasoning: "too short to trigger the cap" })
  const verdict = await runJudge(fakeHost(reply), "/unused", "sess-short", "summary", 1, [])
  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning).toBe("too short to trigger the cap")
  expect(verdict!.passed).toBe(false)
})

test("runJudge tolerates a fenced reply and returns null on a garbage reply", async () => {
  const wrapped = 'Verdict:\n```json\n{"passed":true,"confidence":0.7,"reasoning":"ok"}\n```'
  expect((await runJudge(fakeHost(wrapped), "/unused", "s1", "s", 1, []))?.passed).toBe(true)
  expect(await runJudge(fakeHost("I could not decide."), "/unused", "s2", "s", 1, [])).toBeNull()
})

test("runJudge returns null when the host's runTextAgent itself returns null (session-create failure, etc.)", async () => {
  expect(await runJudge(fakeHost(null), "/unused", "s3", "s", 1, [])).toBeNull()
})
