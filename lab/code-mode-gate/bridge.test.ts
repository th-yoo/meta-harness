import { test, expect } from "bun:test"
import { runGuest } from "./bridge.ts"
import { DEFAULT_LIMITS } from "./types.ts"

const noopCb = () => ({
  onToolCall: () => undefined as unknown,
  onGateCall: () => ({ ok: true }),
  onLog: (_: string) => {},
})

test("a trivial guest completes and its logs reach the host", async () => {
  const logs: string[] = []
  const out = await runGuest(`api.log("hello"); api.log("world");`, [], DEFAULT_LIMITS, {
    ...noopCb(),
    onLog: (m) => logs.push(m),
  })
  expect(out.status).toBe("completed")
  expect(logs).toEqual(["hello", "world"])
})

test("a guest syntax/runtime error completes with guestError, not a hang", async () => {
  const out = await runGuest(`throw new Error("boom");`, [], DEFAULT_LIMITS, noopCb())
  expect(out.status).toBe("completed")
  expect(out.status === "completed" && out.guestError).toContain("boom")
})

test("an infinite loop is killed by the watchdog with code timeout", async () => {
  const out = await runGuest(`for(;;){}`, [], { ...DEFAULT_LIMITS, timeoutMs: 300 }, noopCb())
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("timeout")
}, 10_000)

test("log flood beyond maxOutputBytes fails with output_limit_exceeded", async () => {
  const out = await runGuest(
    `for (let i = 0; i < 10000; i++) api.log("x".repeat(100));`,
    [],
    { ...DEFAULT_LIMITS, maxOutputBytes: 1024 },
    noopCb(),
  )
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("output_limit_exceeded")
})

test("a tool STILL IN FLIGHT when the watchdog fires: clean timeout, no unhandled rejection", async () => {
  // the settled-recheck-after-await race: the handler resumes on a
  // terminated worker and must not postMessage into it
  const out = await runGuest(
    `await api.tools.slow();`,
    ["slow"],
    { ...DEFAULT_LIMITS, timeoutMs: 200 },
    { ...noopCb(), onToolCall: () => new Promise(() => {}) }, // never resolves
  )
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("timeout")
  await new Promise((r) => setTimeout(r, 100)) // give a leaked rejection time to surface as a test failure
}, 10_000)

test("a THROWING tool rejects the guest's await; guest catches; turn survives", async () => {
  // the real unknown-tool/tool-error path: bridge catch → result{ok:false} →
  // shell reject → guest catch
  const logs: string[] = []
  const out = await runGuest(
    `try { await api.tools.boom(); } catch (e) { api.log("caught:" + e.message); }`,
    ["boom"],
    DEFAULT_LIMITS,
    { ...noopCb(), onToolCall: () => { throw new Error("boom") }, onLog: (m) => logs.push(m) },
  )
  expect(out.status).toBe("completed")
  expect(logs).toEqual(["caught:boom"])
})

test("more concurrent un-awaited calls than maxPendingCalls → pending_limit_exceeded", async () => {
  const out = await runGuest(
    `await Promise.all([api.tools.slow(), api.tools.slow(), api.tools.slow()]);`,
    ["slow"],
    { ...DEFAULT_LIMITS, maxPendingCalls: 2 },
    { ...noopCb(), onToolCall: () => new Promise((r) => setTimeout(r, 200)) },
  )
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("pending_limit_exceeded")
})

test("a bad guest-shell URL yields structured guest_error, never a raw throw", async () => {
  const out = await runGuest(
    `api.log("unreached");`,
    [],
    { ...DEFAULT_LIMITS, timeoutMs: 3000 },
    noopCb(),
    new URL("./no-such-shell.ts", import.meta.url),
  )
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("guest_error")
}, 10_000)
