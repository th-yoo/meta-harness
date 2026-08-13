import { describe, it, expect } from "bun:test"
import { handleUserPromptSubmit } from "../src/core/prompt.ts"
import { INITIAL_STATE } from "../src/types.ts"
import type { CcGateState, CoreDeps, RoundOutcome } from "../src/types.ts"

describe("handleUserPromptSubmit", () => {
  const fakeDeps: CoreDeps = {
    runCheck: async () => ({ code: 0, out: "" }),
    now: () => 5000,
    hostname: () => "test-host",
    log: () => undefined,
  }

  const validConfigRaw = JSON.stringify({ check: "npm test" })

  function gatingState(overrides: Partial<CcGateState> = {}): CcGateState {
    return {
      v: 1,
      edited: true,
      gating: true,
      round: 1,
      outcomes: ["accepted"] as RoundOutcome[],
      cycleStartedAt: 1000,
      failStreak: 0,
      updatedAt: 999,
      ...overrides,
    }
  }

  // ── Task 1 (fix-them-serialized-teacup plan): skipped-Stop boundary ──────
  // A queued prompt eats the Stop boundary — `edited:true, gating:false` at
  // prompt time means edits went unmeasured across this prompt boundary.
  // State is UNCHANGED (still the same reference): the marker is emitted,
  // not a measurement, so `edited` must survive for the next real Stop to
  // still measure the edits cumulatively.

  it("not gating + edited:true + readable config: SAME state reference, but a skippedStop sensor line is now emitted", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: true }

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.state).toBe(state) // same reference, not just deep-equal — marker, not measurement
    expect(result.sensor).toBeDefined()
    const sensor = result.sensor!
    expect(sensor.skippedStop).toBe(true)
    expect(sensor.rounds).toEqual([])
    expect(sensor.accepted).toBe(true)
    expect(sensor.gateExhausted).toBe(false)
    expect(sensor.interrupted).toBe(false)
    expect(sensor.durationMs).toBe(0)
    expect(sensor.sessionID).toBe("sess-1")
    expect(sensor.check).toBe("npm test")
  })

  it("not gating + edited:false: no sensor line (nothing unmeasured to report)", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: false }

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.state).toBe(state)
    expect(result.sensor).toBeUndefined()
  })

  it("not gating + edited:true but config missing: no sensor line (config unreadable)", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: true }

    const result = handleUserPromptSubmit(state, "sess-1", undefined, fakeDeps)

    expect(result.state).toBe(state)
    expect(result.sensor).toBeUndefined()
  })

  it("not gating + edited:true but config malformed: no sensor line", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: true }

    const result = handleUserPromptSubmit(state, "sess-1", "{not json", fakeDeps)

    expect(result.state).toBe(state)
    expect(result.sensor).toBeUndefined()
  })

  it("not gating: edited:true is preserved (NOT cleared) across an ordinary prompt", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: true }

    const result = handleUserPromptSubmit(state, "sess-1", undefined, fakeDeps)

    expect(result.state.edited).toBe(true)
    expect(result.state).toBe(state)
  })

  it("gating + valid config: resets state to INITIAL_STATE (edited cleared)", () => {
    const state = gatingState()

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.state).toEqual(INITIAL_STATE)
    expect(result.state).not.toBe(INITIAL_STATE) // fresh object, not shared reference
  })

  it("gating + valid config: sensor line reflects interrupted-preemption shape", () => {
    const state = gatingState({ cycleStartedAt: 1000, outcomes: ["accepted", "verify-failed"] })

    const result = handleUserPromptSubmit(state, "sess-42", validConfigRaw, fakeDeps)

    expect(result.sensor).toBeDefined()
    const sensor = result.sensor!
    expect(sensor.sessionID).toBe("sess-42")
    expect(sensor.check).toBe("npm test")
    expect(sensor.accepted).toBe(true)
    expect(sensor.gateExhausted).toBe(true)
    expect(sensor.interrupted).toBe(true)
    expect(sensor.marker).toBe(false)
    expect(sensor.rounds).toEqual(["accepted", "verify-failed"])
    expect(sensor.rounds).toBe(state.outcomes) // no extra entry appended, same array
  })

  it("gating + valid config: durationMs computed from deps.now() - cycleStartedAt", () => {
    const state = gatingState({ cycleStartedAt: 1000 })
    const deps: CoreDeps = { ...fakeDeps, now: () => 7500 }

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, deps)

    expect(result.sensor!.durationMs).toBe(6500)
  })

  it("gating + valid config: check value is threaded from parsed config", () => {
    const state = gatingState()
    const configRaw = JSON.stringify({ check: "bun test ./special" })

    const result = handleUserPromptSubmit(state, "sess-1", configRaw, fakeDeps)

    expect(result.sensor!.check).toBe("bun test ./special")
  })

  it("gating + undefined config: resets state, NO sensor", () => {
    const state = gatingState()

    const result = handleUserPromptSubmit(state, "sess-1", undefined, fakeDeps)

    expect(result.state).toEqual(INITIAL_STATE)
    expect(result.sensor).toBeUndefined()
  })

  it("gating + malformed config (bad JSON): resets state, NO sensor", () => {
    const state = gatingState()

    const result = handleUserPromptSubmit(state, "sess-1", "{not json", fakeDeps)

    expect(result.state).toEqual(INITIAL_STATE)
    expect(result.sensor).toBeUndefined()
  })

  it("gating + malformed config (missing required check field): resets state, NO sensor", () => {
    const state = gatingState()
    const configRaw = JSON.stringify({ rounds: 3 })

    const result = handleUserPromptSubmit(state, "sess-1", configRaw, fakeDeps)

    expect(result.state).toEqual(INITIAL_STATE)
    expect(result.sensor).toBeUndefined()
  })

  it("gating with edited:true also fully resets (edited cleared, not just gating)", () => {
    const state = gatingState({ edited: true })

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.state.edited).toBe(false)
    expect(result.state).toEqual(INITIAL_STATE)
  })

  it("gating + valid config: empty outcomes array threads through unchanged", () => {
    const state = gatingState({ outcomes: [] })

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.sensor!.rounds).toEqual([])
  })
})

// -- A1 cycle-tagging: interrupted closes the cycle and carries tags ------

describe("A1 cycle tagging on prompt paths", () => {
  const deps: CoreDeps = {
    runCheck: async () => ({ code: 0, out: "" }),
    now: () => 5000,
    hostname: () => "test-host",
    log: () => undefined,
  }
  const cfgRaw = JSON.stringify({ check: "npm test" })

  it("interrupted line carries derived booleans (cycle closes for good)", () => {
    const state: CcGateState = {
      v: 1, edited: true, gating: true, round: 1,
      outcomes: ["verify-failed"], cycleStartedAt: 1000, failStreak: 0,
      updatedAt: 999,
      touchedPaths: ["/repo/src/a.ts"],
    }
    const { state: next, sensor } = handleUserPromptSubmit(state, "s", cfgRaw, deps)
    expect(sensor?.interrupted).toBe(true)
    expect(sensor?.implOnly).toBe(true)
    expect(sensor?.sameTurnCoEdit).toBe(false)
    expect(next.touchedPaths).toBeUndefined()
    expect(JSON.stringify(sensor)).not.toContain("a.ts")
  })

  it("skippedStop diagnostic line NEVER carries the tag fields", () => {
    const state: CcGateState = {
      v: 1, edited: true, gating: false, round: 0,
      outcomes: [], cycleStartedAt: 0, failStreak: 0, updatedAt: 0,
      touchedPaths: ["/repo/src/a.ts"],
    }
    const { sensor } = handleUserPromptSubmit(state, "s", cfgRaw, deps)
    expect(sensor?.skippedStop).toBe(true)
    expect("implOnly" in (sensor as object)).toBe(false)
    expect("sameTurnCoEdit" in (sensor as object)).toBe(false)
  })

  it("interrupted with no recorded paths -> fields absent", () => {
    const state: CcGateState = {
      v: 1, edited: true, gating: true, round: 1,
      outcomes: ["verify-failed"], cycleStartedAt: 1000, failStreak: 0,
      updatedAt: 999,
    }
    const { sensor } = handleUserPromptSubmit(state, "s", cfgRaw, deps)
    expect(sensor?.interrupted).toBe(true)
    expect("implOnly" in (sensor as object)).toBe(false)
  })
})
