import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { runJudge } from "../src/judge.ts"

// Token-free: pre-seeds the staging file runJudge polls for so waitForFile
// resolves on its first (immediate) existsSync check — no real LLM call.
// Exercises only the verdict-validation/return path, specifically the
// reasoning-length cap (D3 review follow-up on D2).

function fakeClient(): any {
  return {
    session: {
      create: async () => ({ data: { id: "judge-session-1" } }),
      prompt: async () => ({}),
    },
  }
}

test("runJudge caps an overlong reasoning string to 500 chars", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-verdict-"))
  const sessionID = "sess-cap"
  const stagingPath = path.join(worktree, ".meta-harness", "staging", `judge-${sessionID}.json`)
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true })
  fs.writeFileSync(
    stagingPath,
    JSON.stringify({ passed: true, confidence: 0.9, reasoning: "x".repeat(600) }),
  )

  const verdict = await runJudge(fakeClient(), worktree, sessionID, "summary", 3, [])

  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning.length).toBe(500)
  expect(verdict!.passed).toBe(true)
  expect(verdict!.confidence).toBe(0.9)

  fs.rmSync(worktree, { recursive: true, force: true })
})

test("runJudge passes a short reasoning string through unchanged", async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-verdict-"))
  const sessionID = "sess-short"
  const stagingPath = path.join(worktree, ".meta-harness", "staging", `judge-${sessionID}.json`)
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true })
  fs.writeFileSync(
    stagingPath,
    JSON.stringify({ passed: false, confidence: 0.4, reasoning: "too short to trigger the cap" }),
  )

  const verdict = await runJudge(fakeClient(), worktree, sessionID, "summary", 1, [])

  expect(verdict).not.toBeNull()
  expect(verdict!.reasoning).toBe("too short to trigger the cap")
  expect(verdict!.passed).toBe(false)

  fs.rmSync(worktree, { recursive: true, force: true })
})
