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

test("acceptance BEFORE a rejection does not count as a local retry", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    await api.checkAndCommit([5,5]);
    await api.checkAndCommit([9,9]);
  `)
  expect(result.status).toBe("completed")
  expect(rt.meter.localRetries).toBe(0)
  expect(rt.meter.gateRejections).toBe(1)
})

test("only rejections followed by an acceptance count", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    await api.checkAndCommit([1]);
    await api.checkAndCommit([5,5]);
    await api.checkAndCommit([2]);
  `)
  expect(result.status).toBe("completed")
  expect(rt.meter.localRetries).toBe(1)
  expect(rt.meter.gateRejections).toBe(2)
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

test("commit iff gate ok; steering flows back to the guest in-turn", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    let v = await api.checkAndCommit([1, 2, 3]);            // sum 6 → reject
    if (!v.ok) {
      api.log("steer: " + v.steering.summary);
      v = await api.checkAndCommit([1, 2, 3, 4]);           // sum 10 → accept
    }
  `)
  expect(result.status).toBe("completed")
  expect(rt.getCommitted()).toEqual([1, 2, 3, 4])
  expect(result.logs[0]).toContain("sum is 6")
  expect(rt.meter.gateRejections).toBe(1)
  expect(rt.meter.localRetries).toBe(1)
})

test("a never-passing guest commits nothing (fail-closed)", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`await api.checkAndCommit([1]); await api.checkAndCommit([2]);`)
  expect(rt.getCommitted()).toBe(null)
  expect(rt.meter.gateRejections).toBe(2)
  expect(rt.meter.localRetries).toBe(0)
})

test("guest holds no commit capability and cannot reach host state", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    api.log(String(typeof api.commit));                     // undefined
    api.log(String(typeof globalThis.process));             // worker global, NOT host state
    if (typeof api.commit === "function") api.commit([4, 6]);
  `)
  expect(result.status).toBe("completed")
  expect(result.logs[0]).toBe("undefined")
  expect(rt.getCommitted()).toBe(null)
})

test("last gate-ACCEPTED claim wins; later rejections do not un-commit", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`
    await api.checkAndCommit([5, 5]);      // accept
    await api.checkAndCommit([9, 9]);      // reject — must not clobber
  `)
  expect(rt.getCommitted()).toEqual([5, 5])
})

test("the committed value is a clone, not a live reference into guest data", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`
    const claim = [5, 5];
    await api.checkAndCommit(claim);
    claim[0] = 999;  // Bun structured-clone semantics PIN, not runtime logic:
                     // trivially true today; guards a future in-process fast path
  `)
  expect(rt.getCommitted()).toEqual([5, 5])
})
