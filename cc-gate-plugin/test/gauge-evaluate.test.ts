import { test, expect } from "bun:test"
import { evaluateGauge } from "../src/gauge/evaluate.ts"
import type { GaugeFile } from "../src/gauge/files.ts"

const BASE: GaugeFile = {
  v: 1,
  sessionID: "s",
  n: 2,
  ts: 1000,
  model: "haiku",
  derivationMs: 900,
  goalSummary: "g",
  criteria: ["c"],
  check: "some-check",
  confidence: 0.7,
}

const ok = async () => ({ code: 0, out: "" })
const fail = async () => ({ code: 1, out: "nope" })
const notFound = async () => ({ code: 127, out: "command not found" })
const timeout = async () => ({ code: 124, out: "[timed out]" })
const boom = async () => {
  throw new Error("spawn failed")
}

test("passing check: executable, pass, no would-block, agrees with accepting floor", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, ok)
  expect(g).toEqual({
    present: true,
    executable: true,
    pass: true,
    wouldBlock: false,
    agreesWithFloor: true,
    derivationMs: 900,
    confidence: 0.7,
    model: "haiku",
    n: 2,
  })
})

test("failing check: would-block; disagrees with accepting floor (the M3 shape)", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, fail)
  expect(g.pass).toBe(false)
  expect(g.wouldBlock).toBe(true)
  expect(g.agreesWithFloor).toBe(false)
})

test("failing check agrees with a failing floor", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: false }, fail)
  expect(g.agreesWithFloor).toBe(true)
})

test("floor did not run → agreesWithFloor undefined", async () => {
  const g = await evaluateGauge(BASE, { ran: false }, fail)
  expect(g.agreesWithFloor).toBeUndefined()
  expect(g.wouldBlock).toBe(true)
})

test("null check → not executable, nothing evaluated", async () => {
  const g = await evaluateGauge({ ...BASE, check: null }, { ran: true, accepted: true }, ok)
  expect(g.executable).toBe(false)
  expect(g.pass).toBeUndefined()
  expect(g.wouldBlock).toBeUndefined()
  expect(g.agreesWithFloor).toBeUndefined()
})

test("exit 127/126 (unrunnable command) → executable false", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, notFound)
  expect(g.executable).toBe(false)
  expect(g.pass).toBeUndefined()
})

test("timeout (124) counts as executable + failing (would block)", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, timeout)
  expect(g.executable).toBe(true)
  expect(g.pass).toBe(false)
  expect(g.wouldBlock).toBe(true)
})

test("unsafe derived check is REFUSED: never run, reason recorded", async () => {
  let ran = false
  const spy = async () => {
    ran = true
    return { code: 0, out: "" }
  }
  const g = await evaluateGauge(
    { ...BASE, check: "rm -rf build && bun test" },
    { ran: true, accepted: true },
    spy,
  )
  expect(ran).toBe(false)
  expect(g.executable).toBe(false)
  expect(g.refused).toBe("destructive-command")
  expect(g.pass).toBeUndefined()
})

test("safe derived check carries no refusal", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, ok)
  expect(g.refused).toBeUndefined()
})

test("runCheck throw → executable false, never throws out", async () => {
  const g = await evaluateGauge(BASE, { ran: true, accepted: true }, boom)
  expect(g.present).toBe(true)
  expect(g.executable).toBe(false)
})
