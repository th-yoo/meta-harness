import { test, expect } from "bun:test"
import * as path from "node:path"
import { buildJudgePrompt } from "../src/judge.ts"
import type { TrajEvent } from "../src/harness-store.ts"

// Token-free: exercises buildJudgePrompt's rendering directly — no opencode
// session, no LLM call. runJudge (the LLM-spawning half) is intentionally NOT
// covered here.

const worktree = "/wt"
const stagingPath = "/wt/.meta-harness/staging/judge-x.json"

const traj: TrajEvent[] = [
  { t: "text", text: "Implementing the token counter now." },
  { t: "tool", tool: "bash", args: "npm test", output: "12 passed", error: false },
  { t: "tool", tool: "bash", args: "npm run build", output: "Error: cannot find module 'foo'", error: true },
]

function render(): string {
  return buildJudgePrompt("count tokens", 4, traj, stagingPath, worktree)
}

test("buildJudgePrompt includes the staging file's RELATIVE path", () => {
  const prompt = render()
  const rel = path.relative(worktree, stagingPath)
  expect(prompt).toContain(rel)
  expect(prompt).not.toContain(stagingPath) // must not leak the absolute path
})

test("buildJudgePrompt includes the verdict JSON shape", () => {
  const prompt = render()
  expect(prompt).toContain(`"passed"`)
  expect(prompt).toContain(`"confidence"`)
  expect(prompt).toContain(`"reasoning"`)
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

test("buildJudgePrompt includes a skepticism instruction", () => {
  const prompt = render()
  expect(prompt.toLowerCase()).toContain("skeptical")
})

test("buildJudgePrompt includes the task summary and turn count", () => {
  const prompt = render()
  expect(prompt).toContain("count tokens")
  expect(prompt).toContain("4")
})

test("buildJudgePrompt with an empty trajectory still renders without throwing", () => {
  const prompt = buildJudgePrompt("no-op task", 0, [], stagingPath, worktree)
  expect(prompt).toContain("no-op task")
  expect(prompt).toContain("(no trajectory captured)")
})
