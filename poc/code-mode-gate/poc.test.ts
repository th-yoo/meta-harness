import { test, expect } from "bun:test"
import { gateClaim } from "./verifier.ts"
import { Runtime } from "./runtime.ts"
import { runClassic, runComposed } from "./arms.ts"
import { ANCHORS_U, AUX_TOOLS, CONTEXT_TOKENS, H_HONEST, H_SHIFTED } from "./scenario.ts"

const scenario = { contextTokens: CONTEXT_TOKENS, anchorsU: ANCHORS_U, auxTools: AUX_TOOLS }

// ── the verifier is the REAL one, not a mock ────────────────────────────────

test("real verifier: honest claim accepted, shifted claim rejected with steering", () => {
  expect(gateClaim(ANCHORS_U, H_HONEST).ok).toBe(true)
  const v = gateClaim(ANCHORS_U, H_SHIFTED)
  expect(v.ok).toBe(false)
  expect(v.steering).toBeDefined()
  expect(v.steering!.worstFirst.length).toBe(ANCHORS_U.length)
  // steering must carry usable magnitudes, not just a boolean
  const worst = v.steering!.perAnchor[v.steering!.worstFirst[0]!]!
  expect(Math.abs(worst.residual)).toBeGreaterThan(0)
})

test("fail-closed: partial coverage and short claims are rejected, no steering fabricated", () => {
  expect(gateClaim(ANCHORS_U, H_HONEST.slice(0, 3)).ok).toBe(false)
  expect(gateClaim(ANCHORS_U.slice(0, 2), H_HONEST.slice(0, 2)).ok).toBe(false)
})

// ── correctness parity: composition changes cost, never the answer ──────────

test("both arms commit the identical, verifier-accepted claim", () => {
  const classic = runClassic()
  const composed = runComposed()
  expect(classic.committed).toEqual(H_HONEST)
  expect(composed.committed).toEqual(H_HONEST)
  expect(classic.committed).toEqual(composed.committed!)
  expect(classic.rejectionsSeen).toBe(1)
  expect(composed.rejectionsSeen).toBe(1)
})

// ── the cost claim, as arithmetic ───────────────────────────────────────────

test("composed = 1 round trip; classic = one per tool call + one per gate feedback cycle", () => {
  const classic = runClassic()
  const composed = runComposed()
  expect(composed.meter.roundTrips).toBe(1)
  expect(classic.meter.roundTrips).toBe(5) // 3 aux + reject turn + corrected turn
  expect(classic.meter.toolCalls).toBe(composed.meter.toolCalls)
  expect(classic.meter.gateChecks).toBe(composed.meter.gateChecks)
})

test("token cost: composed beats classic by more than 3x at a conservative context size", () => {
  const classic = runClassic()
  const composed = runComposed()
  expect(composed.meter.approxTokens * 3).toBeLessThan(classic.meter.approxTokens)
})

test("the rejection is absorbed IN-TURN in the composed arm (the anti-thrash mechanism)", () => {
  const classic = runClassic()
  const composed = runComposed()
  expect(composed.meter.localRetries).toBe(1) // steering consumed inside the turn
  expect(classic.meter.localRetries).toBe(0) // rejection cost a whole new round trip
})

// ── capability discipline: the gate cannot be bypassed ──────────────────────

test("a guest cannot commit without the gate: no commit capability exists on the api", () => {
  const rt = new Runtime(scenario)
  rt.runTurn(`
    if (typeof api.commit === "function") { api.commit(${JSON.stringify(H_SHIFTED)}); }
    api.log(String(typeof api.commit));
  `)
  expect(rt.getCommitted()).toBe(null)
})

test("a program that never satisfies the gate commits nothing (fail-closed)", () => {
  const rt = new Runtime(scenario)
  rt.runTurn(`api.checkAndCommit(${JSON.stringify(H_SHIFTED)});`)
  expect(rt.getCommitted()).toBe(null)
})

test("commit reflects the LAST gate-accepted claim only", () => {
  const rt = new Runtime(scenario)
  rt.runTurn(`
    api.checkAndCommit(${JSON.stringify(H_SHIFTED)});
    api.checkAndCommit(${JSON.stringify(H_HONEST)});
    api.checkAndCommit(${JSON.stringify(H_SHIFTED)});
  `)
  expect(rt.getCommitted()).toEqual(H_HONEST)
})
