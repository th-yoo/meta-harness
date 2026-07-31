// test/check-runner.test.ts — direct unit tests for the timeout-guarded
// check runner extracted from hook-cli.ts (Phase 3 Task 1).
import { describe, expect, test } from "bun:test"
import { runCheck, MAX_OUTPUT_BYTES } from "../src/check-runner"

describe("runCheck", () => {
  test("exit 0 resolves with code 0, out captured, ms > 0", async () => {
    const res = await runCheck("echo hi", process.cwd(), 5000)
    expect(res.code).toBe(0)
    expect(res.out).toContain("hi")
    expect(res.ms).toBeGreaterThan(0)
  })

  test("nonzero exit code passes through", async () => {
    const res = await runCheck("exit 3", process.cwd(), 5000)
    expect(res.code).toBe(3)
  })

  test("timeout: SIGTERM kills a long-running command, resolves within grace, nonzero code, ms ~ elapsed", async () => {
    const res = await runCheck("echo hi; sleep 30", process.cwd(), 500)
    expect(res.code).not.toBe(0)
    expect(res.ms).toBeGreaterThanOrEqual(400)
    expect(res.ms).toBeLessThan(10_000)
  }, 15_000)

  test("output larger than MAX_OUTPUT_BYTES is capped", async () => {
    const res = await runCheck(`head -c ${MAX_OUTPUT_BYTES + 1000} /dev/zero | tr '\\0' 'x'`, process.cwd(), 5000)
    expect(res.out.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
  })
})
