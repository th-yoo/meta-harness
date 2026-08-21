/** Re-proves poc/code-mode-gate's cost and parity claims THROUGH the worker
 * boundary: same fixture, same hypotheses, real verifier. Classic arm = one
 * round trip per step (the standard agent loop); composed arm = one program.
 * If these numbers drift from the PoC's (5 trips vs 1; >3x tokens; rejection
 * absorbed in-turn), the isolation layer broke the economics. */
import { test, expect } from "bun:test"
import { ComposedRuntime } from "./runtime.ts"
import { mergeFitVerifier } from "./verifiers/merge-fit.ts"

const U = [1.0, 2.3, 2.9, 5.1, 7.8]
const HONEST = U.map((u) => 100 + 40 * u)
const SHIFTED = [...HONEST.slice(1), HONEST[HONEST.length - 1]! + 40]
const CONTEXT = 4000

const mkRt = () =>
  new ComposedRuntime<number[]>({
    contextTokens: CONTEXT,
    tools: {
      readSeries: () => ({ rows: 1500, cols: 2 }),
      detectAnchors: () => U,
      sampleStats: () => ({ min: 0.4, max: 9.9 }),
    },
    verifier: mergeFitVerifier(U),
  })

const lit = (xs: number[]) => JSON.stringify(xs)

async function runClassic() {
  const rt = mkRt()
  await rt.runTurn(`await api.tools.readSeries();`)
  await rt.runTurn(`await api.tools.detectAnchors();`)
  await rt.runTurn(`await api.tools.sampleStats();`)
  await rt.runTurn(`await api.checkAndCommit(${lit(SHIFTED)});`) // turn ends on rejection
  await rt.runTurn(`await api.checkAndCommit(${lit(HONEST)});`)
  return rt
}

async function runComposed() {
  const rt = mkRt()
  await rt.runTurn(`
    await api.tools.readSeries();
    await api.tools.detectAnchors();
    await api.tools.sampleStats();
    let v = await api.checkAndCommit(${lit(SHIFTED)});
    if (!v.ok) {
      // steering is OPTIONAL on Verdict — only "residual" rejections carry it.
      // The ?. pattern is the one real guests must use.
      api.log("gate: " + v.reason + " | " + (v.steering ? v.steering.summary : "no steering"));
      v = await api.checkAndCommit(${lit(HONEST)});
    }
  `)
  return rt
}

test("correctness parity: both arms commit the identical verifier-accepted claim", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.getCommitted()).toEqual(HONEST)
  expect(composed.getCommitted()).toEqual(HONEST)
})

test("cost arithmetic: 5 trips vs 1; identical work; >3x token ratio", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.meter.roundTrips).toBe(5)
  expect(composed.meter.roundTrips).toBe(1)
  expect(classic.meter.toolCalls).toBe(composed.meter.toolCalls)
  expect(classic.meter.gateChecks).toBe(composed.meter.gateChecks)
  expect(composed.meter.approxTokens * 3).toBeLessThan(classic.meter.approxTokens)
})

test("anti-thrash: the rejection is absorbed in-turn only in the composed arm", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.meter.gateRejections).toBe(1)
  expect(composed.meter.gateRejections).toBe(1)
  expect(classic.meter.localRetries).toBe(0)
  expect(composed.meter.localRetries).toBe(1)
})
