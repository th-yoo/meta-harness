import { test, expect } from "bun:test"
import { ComposedRuntime } from "./runtime.ts"
import type { Verifier } from "./types.ts"

/** Toy verifier for runtime tests: accepts arrays summing to 10. */
const sumTo10: Verifier<number[], { sum: number }> = (claim) => {
  const sum = claim.reduce((s, x) => s + x, 0)
  return sum === 10
    ? { ok: true }
    : { ok: false, reason: "bad-sum", steering: { summary: `sum is ${sum}, need 10`, detail: { sum } } }
}

const mkRuntime = () =>
  new ComposedRuntime<number[], { sum: number }>({
    contextTokens: 1000,
    tools: {
      double: (args) => (args as number) * 2,
      slowEcho: async (args) => {
        await new Promise((r) => setTimeout(r, 5))
        return args
      },
    },
    verifier: sumTo10,
  })

test("tool calls round-trip through the worker and are metered", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    const a = await api.tools.double(3);
    const b = await api.tools.slowEcho(4);
    api.log("a=" + a + " b=" + b);
  `)
  expect(result.status).toBe("completed")
  expect(result.logs).toEqual(["a=6 b=4"])
  expect(rt.meter.toolCalls).toBe(2)
  expect(rt.meter.roundTrips).toBe(1)
})

test("a throwing tool surfaces to the guest as a catchable rejection and is metered", async () => {
  // NOTE: api.tools only stubs KNOWN names, so "unknown tool" is unreachable
  // through the api surface — runtime.ts's unknown-tool guard defends against
  // forged protocol messages only (guests share the worker's global scope and
  // could postMessage directly; see README trust-boundary note). The REACHABLE
  // error path is a tool that throws host-side.
  const rt = new ComposedRuntime<number[], { sum: number }>({
    contextTokens: 10,
    tools: { boom: () => { throw new Error("boom") } },
    verifier: sumTo10,
  })
  const result = await rt.runTurn(`
    try { await api.tools.boom(); } catch (e) { api.log("caught:" + e.message); }
  `)
  expect(result.status).toBe("completed")
  expect(result.logs).toEqual(["caught:boom"])
  expect(rt.meter.toolCalls).toBe(1)
})

test("token accounting: contextTokens plus program size, once per turn", async () => {
  const rt = mkRuntime()
  const src = `api.log("x");`
  await rt.runTurn(src)
  expect(rt.meter.approxTokens).toBe(1000 + Math.ceil(src.length / 4))
  await rt.runTurn(src)
  expect(rt.meter.roundTrips).toBe(2)
  expect(rt.meter.approxTokens).toBe(2 * (1000 + Math.ceil(src.length / 4)))
})

test("limits pass through: a tight timeout kills a spinning guest", async () => {
  const rt = new ComposedRuntime<number[], { sum: number }>({
    contextTokens: 10,
    tools: {},
    verifier: sumTo10,
    limits: { timeoutMs: 300 },
  })
  const result = await rt.runTurn(`for(;;){}`)
  expect(result.status).toBe("failed")
  expect(result.status === "failed" && result.code).toBe("timeout")
}, 10_000)
