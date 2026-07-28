import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { shadowEvaluateAtStop } from "../src/gauge/shadow.ts"
import { gaugeDir, writeGaugeFile, type GaugeFile } from "../src/gauge/files.ts"
import { parseGateConfig } from "../src/config.ts"
import type { SensorLine } from "../src/types.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-shadow-"))
}

const CFG = parseGateConfig(`{"check": "floor-check", "gauge": true}`)!

function pendingGauge(repo: string, over: Partial<GaugeFile> = {}): void {
  writeGaugeFile(gaugeDir(repo), {
    v: 1,
    sessionID: "sid-1",
    n: 1,
    ts: 500,
    model: "haiku",
    derivationMs: 800,
    goalSummary: "g",
    criteria: ["c"],
    check: "gauge-check",
    confidence: 0.6,
    ...over,
  })
}

function floorLine(over: Partial<SensorLine> = {}): SensorLine {
  return {
    ts: 2000,
    sessionID: "sid-1",
    check: "floor-check",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 10,
    host: "h",
    app: "claude-code",
    ...over,
  }
}

const deps = { now: () => 3000, hostname: () => "h", log: () => {} }
const passCheck = async () => ({ code: 0, out: "" })
const failCheck = async () => ({ code: 1, out: "" })

test("no pending gauge → sensor line passes through untouched", async () => {
  const repo = mkRepo()
  const line = floorLine()
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, line, passCheck, deps)
  expect(out).toBe(line)
})

test("pending gauge + accepting floor line → gauge field attached, pending consumed", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  expect(out.gauge).toMatchObject({
    present: true,
    executable: true,
    pass: false,
    wouldBlock: true,
    agreesWithFloor: false, // the M3 shape: floor accepted, gauge disagrees
    n: 1,
  })
  // consumed: pending renamed to .done.json with eval embedded
  const done = JSON.parse(
    fs.readFileSync(path.join(gaugeDir(repo), "sid-1-1.done.json"), "utf-8"),
  )
  expect(done.eval.pass).toBe(false)
})

test("exhausted floor line counts as NOT accepted for agreement", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const line = floorLine({ accepted: true, gateExhausted: true, rounds: ["verify-failed", "verify-failed", "verify-failed"] })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, line, failCheck, deps))!
  expect(out.gauge!.agreesWithFloor).toBe(true) // both say not-done
})

test("interrupted line → no gauge eval, pending kept for the next cycle", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const line = floorLine({ interrupted: true })
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, line, passCheck, deps)
  expect(out).toBe(line)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-1-1.json"))).toBe(true)
})

test("no floor line + pending gauge → gauge-only line with rounds:[] marker", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, failCheck, deps))!
  expect(out.rounds).toEqual([])
  expect(out.accepted).toBe(true)
  expect(out.gateExhausted).toBe(false)
  expect(out.interrupted).toBe(false)
  expect(out.durationMs).toBe(0)
  expect(out.host).toBe("h")
  expect(out.gauge).toMatchObject({ present: true, pass: false, wouldBlock: true })
  expect(out.gauge!.agreesWithFloor).toBeUndefined() // floor never ran
})

test("no floor line + no pending gauge → undefined (nothing to log)", async () => {
  const repo = mkRepo()
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, passCheck, deps)
  expect(out).toBeUndefined()
})

test("evaluator IO failure is swallowed: sensor line survives un-gauged", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const boom = async () => {
    throw new Error("spawn dead")
  }
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), boom, deps))!
  // runCheck throw → executable:false inside the gauge field, line still emitted
  expect(out.gauge).toMatchObject({ present: true, executable: false })
})
