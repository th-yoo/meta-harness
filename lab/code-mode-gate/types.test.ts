import { test, expect } from "bun:test"
import { DEFAULT_LIMITS, approxTokensOf, newMeter } from "./types.ts"

test("default limits mirror the reference implementation's shape", () => {
  // Cited: openclaw/openclaw src/agents/code-mode-runtime.ts —
  // DEFAULT_TIMEOUT_MS / DEFAULT_MAX_OUTPUT_BYTES / DEFAULT_MAX_PENDING_TOOL_CALLS.
  // This pin only detects one copy drifting from the other; the citation is
  // what carries the external claim.
  expect(DEFAULT_LIMITS).toEqual({ timeoutMs: 10_000, maxPendingCalls: 16, maxOutputBytes: 65_536 })
})

test("approxTokensOf is the ceil-quarter floor model", () => {
  expect(approxTokensOf("")).toBe(0)
  expect(approxTokensOf("abcd")).toBe(1)
  expect(approxTokensOf("abcde")).toBe(2)
})

test("a fresh meter is all zeros", () => {
  expect(newMeter()).toEqual({
    roundTrips: 0, toolCalls: 0, gateChecks: 0, gateRejections: 0, localRetries: 0, approxTokens: 0,
  })
})
