import { test, expect, spyOn } from "bun:test"
import { main } from "../src/bench/cli.ts"

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
