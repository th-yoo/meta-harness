import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { resumeCarryForward, writeRunResults, type RunResultsMeta } from "../src/bench/results.ts"
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

// ── resourceEnforcement coalescing resume guard (task-3-brief.md) ─────────
//
// Mirrors the driver guard above, but with NO "legacy warn and proceed"
// case: an absent `resourceEnforcement` key coalesces to `false` and is
// compared exactly like a present `false` — mixing rewards measured under
// different resource-ceiling regimes in one results file is always a hard
// die, never a warn.

test("resumeCarryForward: pre-feature file (no resourceEnforcement field) + flag off -> carries forward", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  const { doneTasks } = resumeCarryForward(resultsFile, true, "opencode", false)
  expect(doneTasks.size).toBeGreaterThan(0)
})

test("resumeCarryForward: pre-feature file (no resourceEnforcement field) + flag ON -> dies (regime mismatch)", () => {
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
      resumeCarryForward(resultsFile, true, "opencode", true)
    } catch (e) {
      thrown = e
    }
  })
  expect(thrown).toBeInstanceOf(BenchError)
  expect((thrown as Error).message).toMatch(/resource/i)
})

test("resumeCarryForward: stamped resourceEnforcement=true file + flag on -> carries forward", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      resourceEnforcement: true,
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  const { doneTasks } = resumeCarryForward(resultsFile, true, "opencode", true)
  expect(doneTasks.size).toBeGreaterThan(0)
})

test("resumeCarryForward: stamped resourceEnforcement=true file + flag off -> dies (regime mismatch)", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      resourceEnforcement: true,
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  let thrown: unknown
  quiet(() => {
    try {
      resumeCarryForward(resultsFile, true, "opencode", false)
    } catch (e) {
      thrown = e
    }
  })
  expect(thrown).toBeInstanceOf(BenchError)
  expect((thrown as Error).message).toMatch(/resource/i)
})

// ── writeRunResults: resourceEnforcement omitted (not `false`) when off ──
//
// The Interfaces contract (task-3-brief.md) is explicit: callers pass
// `args.enforceResources || undefined`, and this must be OMITTED from the
// written JSON when off — not written as a literal `false` — so a flag-off
// results file is byte-identical to every pre-feature file's shape.

function baseMeta(overrides: Partial<RunResultsMeta> = {}): RunResultsMeta {
  return {
    label: "run",
    model: "m",
    variant: "",
    harness: {},
    k: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    taskAgg: {},
    status: "complete",
    driver: "opencode",
    maxAgentTimeout: 600,
    timeoutRecording: false,
    ...overrides,
  }
}

test("writeRunResults: resourceEnforcement undefined -> key OMITTED entirely from the written JSON", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  writeRunResults(resultsFile, baseMeta({ resourceEnforcement: undefined }))

  const raw = fs.readFileSync(resultsFile, "utf-8")
  const parsed = JSON.parse(raw) as Record<string, unknown>
  expect(Object.prototype.hasOwnProperty.call(parsed, "resourceEnforcement")).toBe(false)
  expect(raw).not.toContain("resourceEnforcement")
})

test("writeRunResults: resourceEnforcement=true -> present and true in the written JSON", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  writeRunResults(resultsFile, baseMeta({ resourceEnforcement: true }))

  const parsed = JSON.parse(fs.readFileSync(resultsFile, "utf-8")) as Record<string, unknown>
  expect(parsed["resourceEnforcement"]).toBe(true)
})

// ── budget-identity provenance (Loop-3 T6) ────────────────────────────────

test("writeRunResults: stamps maxAgentTimeout + timeoutRecording into the written JSON", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  writeRunResults(resultsFile, baseMeta({ maxAgentTimeout: 900, timeoutRecording: true }))

  const parsed = JSON.parse(fs.readFileSync(resultsFile, "utf-8")) as Record<string, unknown>
  expect(parsed["maxAgentTimeout"]).toBe(900)
  expect(parsed["timeoutRecording"]).toBe(true)
})

test("resumeCarryForward: 4th param omitted (legacy call site) defaults to flag-off — matches a pre-feature file", () => {
  const dir = tmpDir()
  const resultsFile = path.join(dir, "run-results.json")
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      driver: "opencode",
      tasks: { a: { rewards: [1], elapsed: [1.0], turns: [2], errors: [] } },
    }),
  )

  const { doneTasks } = resumeCarryForward(resultsFile, true, "opencode")
  expect(doneTasks.size).toBeGreaterThan(0)
})
