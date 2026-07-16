import { test, expect, spyOn } from "bun:test"
import { main } from "../src/bench/cli.ts"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// cli.ts argv parsing for the P6c2 `ab` subcommand. Missing-required-flag
// cases return rc 2 before cmdAb's body runs; the nonexistent-candidate
// case dies inside cmdAb's own validation before touching tbRoot.

test("cli main: ab missing --layer/--candidate -> rc 2", async () => {
  expect(await main(["ab", "--all"])).toBe(2)
  expect(await main(["ab", "--layer", "project-global"])).toBe(2) // candidate still missing
})

test("cli main: ab with an unknown --layer choice -> rc 2", async () => {
  expect(await main(["ab", "--layer", "bogus-layer", "--candidate", "v1", "--all"])).toBe(2)
})

test("cli main: ab unknown flag -> rc 2", async () => {
  expect(await main(["ab", "--layer", "project-global", "--candidate", "v1", "--not-a-real-flag"])).toBe(2)
})

test("cli main: ab with valid flags but a nonexistent candidate -> rc 1 (BenchError)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main(["ab", "--layer", "project-global", "--candidate", "v999999", "--all"])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

// ── --driver (task-B3-brief.md) ───────────────────────────────────────────

test("cli main: ab --driver with an unknown id -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--driver", "nope"]),
  ).toBe(2)
})

test("cli main: ab --driver opencode (only known id) parses fine and falls through to normal flow (rc 1, nonexistent candidate)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "ab",
      "--layer",
      "project-global",
      "--candidate",
      "v999999",
      "--all",
      "--driver",
      "opencode",
    ])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

// ── --enforce-resources (Task 2) ──────────────────────────────────────────

test("cli main: ab --enforce-resources parses fine and falls through to normal flow (rc 1, nonexistent candidate)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "ab",
      "--layer",
      "project-global",
      "--candidate",
      "v999999",
      "--all",
      "--enforce-resources",
    ])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

// ── --cpu-budget/--mem-budget validation (final-review fix: NaN defeats the
// scheduler's fit checks and hangs schedule()/packPreview() forever — reject
// non-finite/non-positive values at parse time, before any of that runs) ───

test("cli main: ab --cpu-budget abc (non-numeric) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--cpu-budget", "abc"]),
  ).toBe(2)
})

test("cli main: ab --mem-budget -5 (non-positive) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--mem-budget", "-5"]),
  ).toBe(2)
})

// ── --min-cpus/--min-mem-mb (resource floor under --enforce-resources) ────
// Same numeric-parse+validate pattern as --cpu-budget/--mem-budget above.

test("cli main: ab --min-cpus 4 --min-mem-mb 8192 parses fine and falls through to normal flow (rc 1, nonexistent candidate)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "ab",
      "--layer",
      "project-global",
      "--candidate",
      "v999999",
      "--all",
      "--min-cpus",
      "4",
      "--min-mem-mb",
      "8192",
    ])
    expect(rc).toBe(1)
  } finally {
    errSpy.mockRestore()
  }
})

test("cli main: ab --min-cpus abc (non-numeric) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--min-cpus", "abc"]),
  ).toBe(2)
})

test("cli main: ab --min-cpus -1 (non-positive) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--min-cpus", "-1"]),
  ).toBe(2)
})

test("cli main: ab --min-mem-mb 0 (non-positive) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--min-mem-mb", "0"]),
  ).toBe(2)
})

test("cli main: ab --min-mem-mb Infinity (non-finite) -> rc 2", async () => {
  expect(
    await main(["ab", "--layer", "project-global", "--candidate", "v1", "--all", "--min-mem-mb", "Infinity"]),
  ).toBe(2)
})

test("cli main: ab --parallel without ANTHROPIC_API_KEY (anthropic model) dies naming the var — oauth refresh-token race guard (D4)", async () => {
  // CONFIRMED hazard (Anthropic claude-code #22600, #48786): the oauth refresh
  // token is SINGLE-USE — one container's refresh rotates it server-side at the
  // ~8h access-token expiry and invalidates every other container sharing the rw
  // credential mount. `ab --parallel` is the LONG-SWEEP path that will cross that
  // expiry, so its key-gate must fire exactly like `run --parallel`'s. (Guard is
  // validateParallel, cli.ts — shared by run+ab; only run's path was tested.)
  //
  // validateParallel's oauth-parallel freshness gate (Task 1) falls through to
  // the REAL host's oauth credential when no key is set — main() has no
  // injection seam for that. Point HOME at a fixture with no `.claude` dir so
  // this stays hermetic/deterministic regardless of the dev box's real oauth
  // state (this scenario is "genuinely no auth at all").
  const prev = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  const prevHome = process.env["HOME"]
  process.env["HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cli-ab-noauth-"))
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rc = await main([
      "ab", "--layer", "project-global", "--candidate", "v1", "--all",
      "--parallel", "--enforce-resources",
    ])
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
