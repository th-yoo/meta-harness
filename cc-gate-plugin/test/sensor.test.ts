import { describe, it, expect } from "bun:test"
import { buildSensorLine } from "../src/core/sensor.ts"
import type { CoreDeps, RoundOutcome, SensorLine } from "../src/types.ts"

describe("buildSensorLine", () => {
  // Fake deps for testing
  const fakeDeps: CoreDeps = {
    runCheck: async () => ({ code: 0, out: "" }),
    now: () => 1234567890,
    hostname: () => "test-host",
    log: () => undefined,
  }

  // Expected field set from SensorLine interface
  const expectedKeys = [
    "ts",
    "sessionID",
    "check",
    "accepted",
    "gateExhausted",
    "rounds",
    "interrupted",
    "marker",
    "durationMs",
    "host",
    "app",
  ]

  it("returns object with exactly SensorLine field set (no extras, none missing)", () => {
    const testRounds: RoundOutcome[] = ["accepted"]
    const args = {
      sessionID: "sess-123",
      check: "npm test",
      accepted: true,
      gateExhausted: false,
      rounds: testRounds,
      interrupted: false,
      marker: true,
      durationMs: 5000,
    }

    const result = buildSensorLine(fakeDeps, args)
    const resultKeys = Object.keys(result).sort()

    expect(resultKeys).toEqual(expectedKeys.sort())
  })

  it("threads ts value from deps.now()", () => {
    const testDeps: CoreDeps = {
      ...fakeDeps,
      now: () => 9876543210,
    }

    const result = buildSensorLine(testDeps, {
      sessionID: "sess-123",
      check: "npm test",
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 1000,
    })

    expect(result.ts).toBe(9876543210)
  })

  it("threads host value from deps.hostname()", () => {
    const testDeps: CoreDeps = {
      ...fakeDeps,
      hostname: () => "custom-machine",
    }

    const result = buildSensorLine(testDeps, {
      sessionID: "sess-123",
      check: "npm test",
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 1000,
    })

    expect(result.host).toBe("custom-machine")
  })

  it("sets app to literal 'claude-code'", () => {
    const result = buildSensorLine(fakeDeps, {
      sessionID: "sess-123",
      check: "npm test",
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 1000,
    })

    expect(result.app).toBe("claude-code")
    expect(typeof result.app).toBe("string")
  })

  it("threads all args values verbatim", () => {
    const testRounds: RoundOutcome[] = [
      "accepted",
      "verify-failed",
    ]

    const args = {
      sessionID: "my-session-id",
      check: "bun test",
      accepted: true,
      gateExhausted: true,
      rounds: testRounds,
      interrupted: true,
      marker: false,
      durationMs: 42000,
    }

    const result = buildSensorLine(fakeDeps, args)

    expect(result.sessionID).toBe(args.sessionID)
    expect(result.check).toBe(args.check)
    expect(result.accepted).toBe(args.accepted)
    expect(result.gateExhausted).toBe(args.gateExhausted)
    expect(result.rounds).toBe(args.rounds) // Same reference
    expect(result.interrupted).toBe(args.interrupted)
    expect(result.marker).toBe(args.marker)
    expect(result.durationMs).toBe(args.durationMs)
  })

  it("JSON.stringify round-trips correctly", () => {
    const testRounds: RoundOutcome[] = ["accepted", "verify-failed"]
    const args = {
      sessionID: "sess-abc",
      check: "npm verify",
      accepted: false,
      gateExhausted: true,
      rounds: testRounds,
      interrupted: false,
      marker: true,
      durationMs: 15000,
    }

    const result = buildSensorLine(fakeDeps, args)
    const json = JSON.stringify(result)
    const parsed = JSON.parse(json) as SensorLine

    expect(parsed.ts).toBe(result.ts)
    expect(parsed.sessionID).toBe(result.sessionID)
    expect(parsed.check).toBe(result.check)
    expect(parsed.accepted).toBe(result.accepted)
    expect(parsed.gateExhausted).toBe(result.gateExhausted)
    expect(parsed.rounds).toEqual(result.rounds)
    expect(parsed.interrupted).toBe(result.interrupted)
    expect(parsed.marker).toBe(result.marker)
    expect(parsed.durationMs).toBe(result.durationMs)
    expect(parsed.host).toBe(result.host)
    expect(parsed.app).toBe(result.app)
  })

  it("handles empty rounds array", () => {
    const result = buildSensorLine(fakeDeps, {
      sessionID: "sess-empty",
      check: "no-op",
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 0,
    })

    expect(result.rounds).toEqual([])
    expect(Array.isArray(result.rounds)).toBe(true)
  })

  it("preserves boolean false values correctly", () => {
    const result = buildSensorLine(fakeDeps, {
      sessionID: "sess-false",
      check: "test",
      accepted: false,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 1000,
    })

    expect(result.accepted).toBe(false)
    expect(result.gateExhausted).toBe(false)
    expect(result.interrupted).toBe(false)
    expect(result.marker).toBe(false)
  })

  it("preserves large duration values", () => {
    const result = buildSensorLine(fakeDeps, {
      sessionID: "sess-long",
      check: "long-test",
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 300000,
    })

    expect(result.durationMs).toBe(300000)
  })
})
