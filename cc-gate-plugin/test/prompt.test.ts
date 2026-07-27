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

  it("not gating: returns the SAME state reference, no sensor", () => {
    const state: CcGateState = { ...INITIAL_STATE, edited: true }

    const result = handleUserPromptSubmit(state, "sess-1", validConfigRaw, fakeDeps)

    expect(result.state).toBe(state) // same reference, not just deep-equal
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
