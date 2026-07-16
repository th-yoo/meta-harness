import { test, expect, spyOn } from "bun:test"
import { main } from "../src/bench/cli.ts"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

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

// ── --parallel gate (Task 6, cli.ts's validateParallel) ───────────────────

test("cli: run --parallel without --enforce-resources dies (rc 1)", async () => {
  const prev = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--parallel"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("--enforce-resources"))).toBe(true)
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
  }
})

test("cli: run --parallel without ANTHROPIC_API_KEY (anthropic model) dies naming the var — genuinely no oauth credential either", async () => {
  // validateParallel's oauth-parallel freshness gate (Task 1) falls through to
  // reading the REAL host's oauth credential when no key is set — main() has
  // no injection seam for that. Point HOME at a fixture with no `.claude` dir
  // so this stays hermetic/deterministic (this dev box has real oauth creds
  // in ~/.claude, which would otherwise let a fresh token through here).
  const prev = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  const prevHome = process.env["HOME"]
  process.env["HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cli-noauth-"))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--parallel", "--enforce-resources"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("ANTHROPIC_API_KEY"))).toBe(true)
  } finally {
    errSpy.mockRestore()
    if (prevHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = prevHome
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
  }
})

test("cli: run --cpu-budget without --parallel dies (rc 1)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--cpu-budget", "2"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("--parallel"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

// ── --cpu-budget/--mem-budget validation (final-review fix: NaN defeats the
// scheduler's fit checks and hangs schedule()/packPreview() forever — reject
// non-finite/non-positive values at parse time, before any of that runs) ───

test("cli: run --cpu-budget abc (non-numeric) -> rc 2", async () => {
  expect(await main(["run", "--cpu-budget", "abc", "--all"])).toBe(2)
})

test("cli: run --mem-budget -5 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--mem-budget", "-5", "--all"])).toBe(2)
})

test("cli: run --cpu-budget 0 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--cpu-budget", "0", "--all"])).toBe(2)
})

test("cli: run --mem-budget Infinity (non-finite) -> rc 2", async () => {
  expect(await main(["run", "--mem-budget", "Infinity", "--all"])).toBe(2)
})

test("cli: task-load --cpu-budget abc (non-numeric) -> rc 2", async () => {
  expect(await main(["task-load", "--cpu-budget", "abc", "--all"])).toBe(2)
})

test("cli: task-load --mem-budget -5 (non-positive) -> rc 2", async () => {
  expect(await main(["task-load", "--mem-budget", "-5", "--all"])).toBe(2)
})

// ── --min-cpus/--min-mem-mb (resource floor under --enforce-resources) ────
// Same numeric-parse+validate pattern as --cpu-budget/--mem-budget above
// (parseBudgetNum: rejects non-finite/non-positive values at parse time).

test("cli: run --min-cpus 4 --min-mem-mb 8192 parses fine and falls through to normal flow (rc 1, no tasks)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--min-cpus", "4", "--min-mem-mb", "8192", "--layers", "none"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("Specify --tasks"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli: run --min-cpus abc (non-numeric) -> rc 2", async () => {
  expect(await main(["run", "--min-cpus", "abc", "--all"])).toBe(2)
})

test("cli: run --min-cpus -1 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--min-cpus", "-1", "--all"])).toBe(2)
})

test("cli: run --min-cpus 0 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--min-cpus", "0", "--all"])).toBe(2)
})

test("cli: run --min-mem-mb abc (non-numeric) -> rc 2", async () => {
  expect(await main(["run", "--min-mem-mb", "abc", "--all"])).toBe(2)
})

test("cli: run --min-mem-mb -1 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--min-mem-mb", "-1", "--all"])).toBe(2)
})

test("cli: run --min-mem-mb 0 (non-positive) -> rc 2", async () => {
  expect(await main(["run", "--min-mem-mb", "0", "--all"])).toBe(2)
})

test("cli: run --min-mem-mb Infinity (non-finite) -> rc 2", async () => {
  expect(await main(["run", "--min-mem-mb", "Infinity", "--all"])).toBe(2)
})

test("cli: run --parallel --enforce-resources with the key set parses, falls through to normal flow (rc 1, no tasks)", async () => {
  const prev = process.env["ANTHROPIC_API_KEY"]
  process.env["ANTHROPIC_API_KEY"] = "sk-test-parallel"
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["run", "--parallel", "--enforce-resources", "--layers", "none"])
    expect(rc).toBe(1)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("Specify --tasks"))).toBe(true)
  } finally {
    errSpy.mockRestore()
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
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
