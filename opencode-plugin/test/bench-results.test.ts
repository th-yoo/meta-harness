import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { resumeCarryForward } from "../src/bench/results.ts"
import { BenchError } from "../src/bench/util.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-results-"))
}

function quiet<T>(fn: () => T): T {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    return fn()
  } finally {
    errSpy.mockRestore()
  }
}

// ── cross-driver resume guard (final-review fix 1) ────────────────────────

test("resumeCarryForward: prior results file's driver mismatches expectedDriver -> dies with an actionable message", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  let thrown: unknown
  quiet(() => {
    try {
      resumeCarryForward(resultsFile, true, "claude-code")
    } catch (e) {
      thrown = e
    }
  })
  expect(thrown).toBeInstanceOf(BenchError)
  const msg = (thrown as Error).message
  expect(msg).toContain("opencode")
  expect(msg).toContain("claude-code")
  // Actionable — must point at the fix (a per-driver --results-file).
  expect(msg).toContain("--results-file")
})

test("resumeCarryForward: prior results file's driver matches expectedDriver -> proceeds, carries forward", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "claude-code",
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  const { taskAgg, doneTasks } = quiet(() => resumeCarryForward(resultsFile, true, "claude-code"))
  expect(doneTasks.has("a")).toBe(true)
  expect(taskAgg.a?.rewards).toEqual([1])
})

test("resumeCarryForward: prior results file has no driver field (legacy pre-driver file) -> warns and proceeds", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  let taskAgg, doneTasks
  try {
    ;({ taskAgg, doneTasks } = resumeCarryForward(resultsFile, true, "claude-code"))
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.toLowerCase().includes("driver"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  expect(doneTasks!.has("a")).toBe(true)
  expect(taskAgg!.a?.rewards).toEqual([1])
})

test("resumeCarryForward: no results file / resume=false -> untouched by the driver check (starts fresh)", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "does-not-exist.json")
  const { taskAgg, doneTasks } = resumeCarryForward(resultsFile, true, "claude-code")
  expect(doneTasks.size).toBe(0)
  expect(Object.keys(taskAgg).length).toBe(0)
})
