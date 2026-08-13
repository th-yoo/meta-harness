import { test, expect } from "bun:test"
import { handleStop } from "../src/core/stop.ts"
import { INITIAL_STATE } from "../src/types.ts"
import type { CcGateState, CoreDeps, StopInput } from "../src/types.ts"
import { HYGIENE_MARKER } from "../../minimal/session2.ts"

const input: StopInput = { session_id: "sess-1", cwd: "/repo" }

function gateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ check: "bun test", rounds: 2, marker: false, ...overrides })
}

/** Fake deps with a controllable, call-recording runCheck. */
function fakeDeps(opts: {
  results?: Array<{ code: number; out: string } | Error>
  nowValues?: number[]
} = {}): CoreDeps & { calls: string[]; logs: string[] } {
  const results = opts.results ?? []
  const nowValues = opts.nowValues ?? []
  let resultIdx = 0
  let nowIdx = 0
  const calls: string[] = []
  const logs: string[] = []

  return {
    calls,
    logs,
    runCheck: async (cmd: string) => {
      calls.push(cmd)
      const r = results[resultIdx] ?? { code: 0, out: "" }
      resultIdx++
      if (r instanceof Error) throw r
      return r
    },
    now: () => {
      const v = nowValues[nowIdx] ?? nowIdx * 1000
      nowIdx++
      return v
    },
    hostname: () => "test-host",
    log: (msg: string) => {
      logs.push(msg)
    },
  }
}

test("fast path: no edits, not gating -> allow, runCheck never called, no sensor, no crash on undefined raw", async () => {
  const deps = fakeDeps()
  const result = await handleStop(INITIAL_STATE, input, undefined, deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.sensor).toBeUndefined()
  expect(deps.calls).toEqual([])
  expect(result.state).toBe(INITIAL_STATE)
})

test("edited, no gate.json (raw undefined) -> allow, edited preserved", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps()
  const result = await handleStop(state, input, undefined, deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.sensor).toBeUndefined()
  expect(result.state.edited).toBe(true)
  expect(deps.calls).toEqual([])
})

test("edited, invalid gate.json -> allow", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps()
  const result = await handleStop(state, input, "{not valid json", deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.sensor).toBeUndefined()
  expect(result.state.edited).toBe(true)
  expect(deps.calls).toEqual([])
})

test("gating but config removed mid-cycle -> cycle reset, no sensor, edited preserved", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    gating: true,
    round: 1,
    outcomes: ["verify-failed"],
    cycleStartedAt: 500,
    failStreak: 0,
  }
  const deps = fakeDeps()
  const result = await handleStop(state, input, undefined, deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.sensor).toBeUndefined()
  expect(result.state).toEqual({ ...INITIAL_STATE, edited: true })
  expect(deps.calls).toEqual([])
})

test("check passes -> allow, sensor has all 12 fields (checkMs joins as Task 2's 12th key), rounds ['accepted'], state deep-equals INITIAL_STATE", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 0, out: "" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.state).toEqual(INITIAL_STATE)
  expect(result.sensor).toBeDefined()
  const sensorKeys = Object.keys(result.sensor!).sort()
  expect(sensorKeys).toEqual(
    ["ts", "sessionID", "check", "accepted", "gateExhausted", "rounds", "interrupted", "marker", "durationMs", "host", "app", "checkMs"].sort(),
  )
  expect(result.sensor!.rounds).toEqual(["accepted"])
  expect(result.sensor!.accepted).toBe(true)
  expect(result.sensor!.gateExhausted).toBe(false)
  expect(result.sensor!.sessionID).toBe("sess-1")
  expect(result.sensor!.check).toBe("bun test")
  // Task 2 (fix-them-serialized-teacup plan): one round ran -> one entry.
  expect(result.sensor!.checkMs).toHaveLength(1)
  expect(typeof result.sensor!.checkMs![0]).toBe("number")
})

test("marker:true + accept -> allow-with-marker with HYGIENE_MARKER verbatim; sensor marker:true", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 0, out: "" }] })
  const result = await handleStop(state, input, gateJson({ marker: true }), deps)

  expect(result.decision).toEqual({ kind: "allow-with-marker", marker: HYGIENE_MARKER })
  expect(result.sensor!.marker).toBe(true)
})

test("marker:true + EXHAUSTED -> no marker (allow-exhausted only); sensor marker:false", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [
      { code: 1, out: "fail1" },
      { code: 1, out: "fail2" },
      { code: 1, out: "fail3" },
    ],
  })

  // round 1 -> block
  let result = await handleStop(state, input, gateJson({ marker: true, rounds: 2 }), deps)
  expect(result.decision.kind).toBe("block")
  state = result.state

  // round 2 -> block
  result = await handleStop(state, input, gateJson({ marker: true, rounds: 2 }), deps)
  expect(result.decision.kind).toBe("block")
  state = result.state

  // round 3 -> exhausted
  result = await handleStop(state, input, gateJson({ marker: true, rounds: 2 }), deps)
  expect(result.decision.kind).toBe("allow-exhausted")
  expect(result.sensor!.marker).toBe(false)
  expect(result.sensor!.gateExhausted).toBe(true)
})

test("check fails round 1 of default 2 -> block, evidence contains check output tail, state {gating:true, round:1, outcomes:['verify-failed']}, no sensor", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 1, out: "boom output" }] })
  const result = await handleStop(state, input, gateJson({ rounds: 2 }), deps)

  expect(result.decision.kind).toBe("block")
  if (result.decision.kind === "block") {
    expect(result.decision.evidence).toContain("boom output")
    expect(result.decision.round).toBe(1)
    expect(result.decision.roundsMax).toBe(2)
  }
  expect(result.state.gating).toBe(true)
  expect(result.state.round).toBe(1)
  expect(result.state.outcomes).toEqual(["verify-failed"])
  expect(result.sensor).toBeUndefined()
})

test("second consecutive fail -> block round 2", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 1, out: "fail1" }, { code: 1, out: "fail2" }] })

  const first = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  state = first.state

  const second = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(second.decision.kind).toBe("block")
  if (second.decision.kind === "block") {
    expect(second.decision.round).toBe(2)
  }
  expect(second.state.gating).toBe(true)
  expect(second.state.round).toBe(2)
  expect(second.state.outcomes).toEqual(["verify-failed", "verify-failed"])
  expect(second.sensor).toBeUndefined()
})

test("third fail (rounds:2) -> allow-exhausted; sensor rounds all verify-failed, gateExhausted:true, interrupted:false; state reset", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [
      { code: 1, out: "fail1" },
      { code: 1, out: "fail2" },
      { code: 1, out: "fail3" },
    ],
  })

  state = (await handleStop(state, input, gateJson({ rounds: 2 }), deps)).state
  state = (await handleStop(state, input, gateJson({ rounds: 2 }), deps)).state
  const third = await handleStop(state, input, gateJson({ rounds: 2 }), deps)

  expect(third.decision.kind).toBe("allow-exhausted")
  expect(third.sensor!.rounds).toEqual(["verify-failed", "verify-failed", "verify-failed"])
  expect(third.sensor!.gateExhausted).toBe(true)
  expect(third.sensor!.interrupted).toBe(false)
  expect(third.state).toEqual(INITIAL_STATE)
})

test("fail then pass -> sensor rounds ['verify-failed','accepted'], durationMs spans invocations (cycleStartedAt from first Stop)", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [{ code: 1, out: "fail1" }, { code: 0, out: "" }],
    nowValues: [1000, 5000],
  })

  const first = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(first.state.cycleStartedAt).toBe(1000)
  state = first.state

  const second = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(second.decision).toEqual({ kind: "allow" })
  expect(second.sensor!.rounds).toEqual(["verify-failed", "accepted"])
  // durationMs = deps.now() at accept (5000) - cycleStartedAt from FIRST Stop (1000)
  expect(second.sensor!.durationMs).toBe(4000)
  expect(second.state).toEqual(INITIAL_STATE)
})

test("runCheck rejects -> allow, no sensor, cycle fields unchanged, failStreak incremented, deps.log called", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    gating: true,
    round: 1,
    outcomes: ["verify-failed"],
    cycleStartedAt: 42,
  }
  const deps = fakeDeps({ results: [new Error("spawn failed")] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.sensor).toBeUndefined()
  expect(result.state.gating).toBe(true)
  expect(result.state.round).toBe(1)
  expect(result.state.outcomes).toEqual(["verify-failed"])
  expect(result.state.cycleStartedAt).toBe(42)
  expect(result.state.failStreak).toBe(1)
  expect(deps.logs.length).toBeGreaterThan(0)
})

test("failStreak accumulates across two rejections then a third -> disarm allow-exhausted, state full reset, no sensor", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [new Error("boom1"), new Error("boom2"), new Error("boom3")],
  })

  const first = await handleStop(state, input, gateJson(), deps)
  expect(first.state.failStreak).toBe(1)
  state = first.state

  const second = await handleStop(state, input, gateJson(), deps)
  expect(second.state.failStreak).toBe(2)
  state = second.state

  const third = await handleStop(state, input, gateJson(), deps)
  expect(third.decision.kind).toBe("allow-exhausted")
  if (third.decision.kind === "allow-exhausted") {
    expect(third.decision.message).toContain("disabled")
  }
  expect(third.state).toEqual(INITIAL_STATE)
  expect(third.sensor).toBeUndefined()
})

test("failStreak resets after a completed check run (reject once, then fail-block -> streak back to 0)", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [new Error("boom1"), { code: 1, out: "fail-after-reject" }],
  })

  const first = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(first.state.failStreak).toBe(1)
  state = first.state

  const second = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(second.decision.kind).toBe("block")
  expect(second.state.failStreak).toBe(0)
  expect(second.state.gating).toBe(true)
  expect(second.state.round).toBe(1)
})

test("multi-session isolation: two independent state objects don't interfere", async () => {
  const stateA: CcGateState = { ...INITIAL_STATE, edited: true }
  const stateB: CcGateState = { ...INITIAL_STATE, edited: true }
  const depsA = fakeDeps({ results: [{ code: 1, out: "a-fail" }] })
  const depsB = fakeDeps({ results: [{ code: 0, out: "" }] })

  const resultA = await handleStop(stateA, { session_id: "a", cwd: "/repo" }, gateJson(), depsA)
  const resultB = await handleStop(stateB, { session_id: "b", cwd: "/repo" }, gateJson(), depsB)

  expect(resultA.decision.kind).toBe("block")
  expect(resultB.decision).toEqual({ kind: "allow" })
  expect(stateA).toEqual({ ...INITIAL_STATE, edited: true })
  expect(stateB).toEqual({ ...INITIAL_STATE, edited: true })
})

test("handleStop is pure: two calls sharing an input state object resolve independently (real compare-and-swap coverage lives in state.test.ts)", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }

  const slowDeps: CoreDeps = {
    runCheck: async (_cmd: string) => {
      await new Promise((r) => setTimeout(r, 10))
      return { code: 0, out: "" }
    },
    now: () => 1000,
    hostname: () => "test-host",
    log: () => undefined,
  }

  const p1 = handleStop(state, input, gateJson(), slowDeps)
  const p2 = handleStop(state, input, gateJson(), slowDeps)

  const [r1, r2] = await Promise.all([p1, p2])
  expect(r1.decision).toEqual({ kind: "allow" })
  expect(r2.decision).toEqual({ kind: "allow" })
})

test("runCheck receives cfg.check verbatim", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 0, out: "" }] })
  await handleStop(state, input, gateJson({ check: "make verify --strict" }), deps)

  expect(deps.calls).toEqual(["make verify --strict"])
})

// ── checkMs (Task 2, fix-them-serialized-teacup plan): per-round check ────
// timing — deps.now() wrapped tightly around each runSingleRound call.

test("checkMs accumulates across invocations: fail, fail, accept -> 3 entries; reset (dropped) on the next cycle", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [
      { code: 1, out: "fail1" },
      { code: 1, out: "fail2" },
      { code: 0, out: "" },
    ],
  })

  const first = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(first.decision.kind).toBe("block")
  expect(first.state.checkMs).toHaveLength(1)
  state = first.state

  const second = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(second.decision.kind).toBe("block")
  expect(second.state.checkMs).toHaveLength(2)
  state = second.state

  const third = await handleStop(state, input, gateJson({ rounds: 2 }), deps)
  expect(third.decision).toEqual({ kind: "allow" })
  expect(third.sensor!.checkMs).toHaveLength(3)
  expect(third.sensor!.checkMs!.every((n) => typeof n === "number")).toBe(true)
  // Reset drops checkMs entirely — INITIAL_STATE never declares the key.
  expect(third.state).toEqual(INITIAL_STATE)
  expect(third.state.checkMs).toBeUndefined()
})

test("checkMs: legacy state without the field still accumulates correctly (state.checkMs ?? [])", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    gating: true,
    round: 1,
    outcomes: ["verify-failed"],
    cycleStartedAt: 500,
    // deliberately no `checkMs` key at all — exactly a pre-Task-2 persisted file.
  }
  const deps = fakeDeps({ results: [{ code: 1, out: "fail again" }] })
  const result = await handleStop(state, input, gateJson({ rounds: 3 }), deps)

  expect(result.decision.kind).toBe("block")
  expect(result.state.checkMs).toHaveLength(1)
})

test("checkMs: exhausted line carries the full per-round array (3 rounds -> 3 entries)", async () => {
  let state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({
    results: [
      { code: 1, out: "fail1" },
      { code: 1, out: "fail2" },
      { code: 1, out: "fail3" },
    ],
  })

  state = (await handleStop(state, input, gateJson({ rounds: 2 }), deps)).state
  state = (await handleStop(state, input, gateJson({ rounds: 2 }), deps)).state
  const third = await handleStop(state, input, gateJson({ rounds: 2 }), deps)

  expect(third.decision.kind).toBe("allow-exhausted")
  expect(third.sensor!.checkMs).toHaveLength(3)
})

test("checkMs: runCheck rejects (internal error) does NOT add an entry — no round consumed", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    gating: true,
    round: 1,
    outcomes: ["verify-failed"],
    cycleStartedAt: 42,
  }
  const deps = fakeDeps({ results: [new Error("spawn failed")] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.decision).toEqual({ kind: "allow" })
  expect(result.state.checkMs).toBeUndefined()
})

// ── rawOut threading into the block decision (composition design) ────────

test("block decision carries rawOut from the failing check", async () => {
  const state = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 1, out: "the raw tail" }] })
  const r = await handleStop(state, { session_id: "s", cwd: "/w" }, `{"check":"c","rounds":2}`, deps)
  expect(r.decision.kind).toBe("block")
  if (r.decision.kind === "block") expect(r.decision.rawOut).toBe("the raw tail")
})

// -- A1 cycle-tagging: cycle-closing lines carry derived booleans ---------

test("accepted line carries implOnly for an impl-only cycle; no raw path on the line", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    touchedPaths: ["/repo/src/a.ts", "/repo/src/b.ts"],
  }
  const deps = fakeDeps({ results: [{ code: 0, out: "ok" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.sensor?.implOnly).toBe(true)
  expect(result.sensor?.sameTurnCoEdit).toBe(false)
  // privacy line: serialized sensor line must not contain any touched path
  const json = JSON.stringify(result.sensor)
  expect(json).not.toContain("/repo/src/a.ts")
  expect(json).not.toContain("a.ts")
})

test("exhausted line carries sameTurnCoEdit for a co-edit cycle", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    gating: true,
    round: 2,
    outcomes: ["verify-failed", "verify-failed"],
    cycleStartedAt: 1000,
    touchedPaths: ["/repo/src/a.ts", "/repo/test/a.test.ts"],
  }
  const deps = fakeDeps({ results: [{ code: 1, out: "boom" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.decision.kind).toBe("allow-exhausted")
  expect(result.sensor?.sameTurnCoEdit).toBe(true)
  expect(result.sensor?.implOnly).toBe(false)
})

test("no touched paths -> fields ABSENT on the accepted line", async () => {
  const state: CcGateState = { ...INITIAL_STATE, edited: true }
  const deps = fakeDeps({ results: [{ code: 0, out: "ok" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.sensor).toBeDefined()
  expect("implOnly" in (result.sensor as object)).toBe(false)
  expect("sameTurnCoEdit" in (result.sensor as object)).toBe(false)
})

test("truncated set -> fields ABSENT even with paths present", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    touchedPaths: ["/repo/src/a.ts"],
    touchedTruncated: true,
  }
  const deps = fakeDeps({ results: [{ code: 0, out: "ok" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect("implOnly" in (result.sensor as object)).toBe(false)
})

test("testPathPattern override in gate.json reclassifies", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    touchedPaths: ["/repo/checks/a.ts", "/repo/src/b.ts"],
  }
  const deps = fakeDeps({ results: [{ code: 0, out: "ok" }] })
  const result = await handleStop(
    state, input, gateJson({ testPathPattern: "/checks/" }), deps)

  expect(result.sensor?.sameTurnCoEdit).toBe(true)
})

test("cycle-tag state resets with the cycle: accepted result state is INITIAL", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    touchedPaths: ["/repo/src/a.ts"],
  }
  const deps = fakeDeps({ results: [{ code: 0, out: "ok" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.state.touchedPaths).toBeUndefined()
  expect(result.state.touchedTruncated).toBeUndefined()
})

test("block (mid-cycle) preserves touchedPaths for the cycle's later rounds", async () => {
  const state: CcGateState = {
    ...INITIAL_STATE,
    edited: true,
    touchedPaths: ["/repo/src/a.ts"],
  }
  const deps = fakeDeps({ results: [{ code: 1, out: "fail" }] })
  const result = await handleStop(state, input, gateJson(), deps)

  expect(result.decision.kind).toBe("block")
  expect(result.state.touchedPaths).toEqual(["/repo/src/a.ts"])
})
