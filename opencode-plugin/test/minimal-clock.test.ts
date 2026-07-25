import { test, expect } from "bun:test"
import { assessSkew, clockPreflight } from "../../minimal/clock.ts"

// Clock-skew preflight (darwin podman VM): after a mac sleep the VM clock ran
// ~17h BEHIND the host — containers failed TLS to api.anthropic.com with
// "certificate is not yet valid" and every agent died 0-turn (two trials
// lost, 2026-07-23). All io is injected so tests never spawn podman.

test("assessSkew: in-sync clocks pass", () => {
  const r = assessSkew(1_000_000, 1_000_000)
  expect(r.skewSec).toBe(0)
  expect(r.ok).toBe(true)
})

test("assessSkew: 17h-behind VM detected (skew negative, not ok)", () => {
  const host = 1_753_000_000
  const r = assessSkew(host, host - 17 * 3600)
  expect(r.skewSec).toBe(-17 * 3600)
  expect(r.ok).toBe(false)
})

test("assessSkew: forward skew (vm ahead) also caught", () => {
  const host = 1_753_000_000
  const r = assessSkew(host, host + 3600)
  expect(r.skewSec).toBe(3600)
  expect(r.ok).toBe(false)
})

test("assessSkew: default threshold is 60s — 59 ok, 61 not", () => {
  const host = 1_753_000_000
  expect(assessSkew(host, host + 59).ok).toBe(true)
  expect(assessSkew(host, host - 59).ok).toBe(true)
  expect(assessSkew(host, host + 61).ok).toBe(false)
  expect(assessSkew(host, host - 61).ok).toBe(false)
})

test("clockPreflight: null vm epoch fails open (linux / no machine)", async () => {
  const r = await clockPreflight({
    hostEpoch: () => 1_753_000_000,
    vmEpoch: async () => null,
    resync: async () => {
      throw new Error("resync must not run when vm clock is unreadable")
    },
  })
  expect(r).toEqual({ skewSec: 0, ok: true, action: "none" })
})

test("clockPreflight: within threshold takes no action", async () => {
  const r = await clockPreflight({
    hostEpoch: () => 1_753_000_000,
    vmEpoch: async () => 1_753_000_010,
    resync: async () => {
      throw new Error("resync must not run when clocks agree")
    },
  })
  expect(r.ok).toBe(true)
  expect(r.action).toBe("none")
  expect(r.skewSec).toBe(10)
})

test("clockPreflight: resync success re-reads vm clock and reports resynced", async () => {
  const host = 1_753_000_000
  let synced = false
  const r = await clockPreflight({
    hostEpoch: () => host,
    vmEpoch: async () => (synced ? host : host - 17 * 3600),
    resync: async () => {
      synced = true
      return true
    },
  })
  expect(r.ok).toBe(true)
  expect(r.action).toBe("resynced")
  // skewSec reports the skew that WAS corrected (the pre-resync reading).
  expect(r.skewSec).toBe(-17 * 3600)
})

test("clockPreflight: resync returning false blocks", async () => {
  const host = 1_753_000_000
  const r = await clockPreflight({
    hostEpoch: () => host,
    vmEpoch: async () => host - 17 * 3600,
    resync: async () => false,
  })
  expect(r.ok).toBe(false)
  expect(r.action).toBe("blocked")
  expect(r.skewSec).toBe(-17 * 3600)
})

test("clockPreflight: resync that claims success but leaves skew blocks", async () => {
  const host = 1_753_000_000
  const r = await clockPreflight({
    hostEpoch: () => host,
    vmEpoch: async () => host - 17 * 3600, // never actually corrected
    resync: async () => true,
  })
  expect(r.ok).toBe(false)
  expect(r.action).toBe("blocked")
})
