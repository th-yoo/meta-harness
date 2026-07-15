import { test, expect, spyOn } from "bun:test"
import { main } from "../src/bench/cli.ts"

// cli.ts argv parsing for the P6c1 subcommands (run/judge-audit). These
// never reach a real podman/opencode call: missing-required-flag cases
// return rc 2 before any subcommand body runs, and the "no --tasks/--all"
// case dies inside selectTasks's own validation BEFORE touching the
// filesystem (see tasks.ts's selectTasks) — no live tb-root needed.

test("cli main: unknown flag on run -> rc 2", async () => {
  expect(await main(["run", "--not-a-real-flag"])).toBe(2)
})

test("cli main: run with no --tasks/--task-file/--all -> rc 1 (BenchError from selectTasks)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--layers", "none"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("Specify --tasks"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: run --layers with an invalid choice -> rc 2", async () => {
  expect(await main(["run", "--layers", "bogus", "--all"])).toBe(2)
})

// ── --driver (task-B3-brief.md) ───────────────────────────────────────────

test("cli main: run --driver with an unknown id -> rc 2", async () => {
  expect(await main(["run", "--driver", "nope", "--all"])).toBe(2)
})

test("cli main: run --driver opencode (only known id) parses fine and falls through to normal flow (rc 1, no tasks)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--driver", "opencode", "--layers", "none"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("Specify --tasks"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

// ── --enforce-resources (Task 2) ──────────────────────────────────────────

test("cli main: run --enforce-resources parses fine and falls through to normal flow (rc 1, no tasks)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--enforce-resources", "--layers", "none"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("Specify --tasks"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: judge-audit missing --layer/--candidate -> rc 2", async () => {
  expect(await main(["judge-audit"])).toBe(2)
  expect(await main(["judge-audit", "--layer", "project-global"])).toBe(2)
})

test("cli main: judge-audit with a nonexistent candidate -> rc 1 (BenchError)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["judge-audit", "--layer", "project-global", "--candidate", "v999999"])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: judge-audit unknown flag -> rc 2", async () => {
  expect(await main(["judge-audit", "--layer", "project-global", "--candidate", "v1", "--nope"])).toBe(2)
})
