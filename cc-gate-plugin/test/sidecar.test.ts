// test/sidecar.test.ts — pure excerpt-capping + fail-open append for the
// Phase 1 check-output sidecar (evidence-only; spec
// docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildCheckOutputRecord, appendCheckOutput } from "../src/sidecar.ts"

const BASE = { ts: 1000, sessionID: "s1", round: 1, roundsMax: 2, check: "bun test" }

test("short rawText passes through uncapped, no elidedChars field", () => {
  const rec = buildCheckOutputRecord({ ...BASE, rawText: "FAIL: expected 2 got 3" })
  expect(rec.excerpt).toBe("FAIL: expected 2 got 3")
  expect("elidedChars" in rec).toBe(false)
  expect(rec).toMatchObject(BASE)
})

test("rawText at exactly 8192 chars is NOT elided", () => {
  const rec = buildCheckOutputRecord({ ...BASE, rawText: "x".repeat(8192) })
  expect(rec.excerpt.length).toBe(8192)
  expect("elidedChars" in rec).toBe(false)
})

test("long rawText keeps head 2048 + tail 6144 with splice marker + elidedChars", () => {
  const rawText = "H".repeat(2048) + "M".repeat(5000) + "T".repeat(6144)
  const rec = buildCheckOutputRecord({ ...BASE, rawText })
  expect(rec.excerpt.startsWith("H".repeat(2048))).toBe(true)
  expect(rec.excerpt.endsWith("T".repeat(6144))).toBe(true)
  expect(rec.excerpt).toContain("[kkamak sidecar: 5000 chars elided]")
  expect(rec.elidedChars).toBe(5000)
})

test("appendCheckOutput appends one ndjson line, mkdir -p as needed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-"))
  try {
    const rec = buildCheckOutputRecord({ ...BASE, rawText: "boom" })
    appendCheckOutput(dir, rec, () => {})
    appendCheckOutput(dir, { ...rec, round: 2 }, () => {})
    const lines = fs
      .readFileSync(path.join(dir, ".km", "check-output.ndjson"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ ...BASE, excerpt: "boom" })
    expect(lines[1].round).toBe(2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("appendCheckOutput swallows write failure and logs (fail-open)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-"))
  try {
    // Make the sidecar PATH a directory so appendFileSync fails (EISDIR).
    fs.mkdirSync(path.join(dir, ".km", "check-output.ndjson"), { recursive: true })
    const logs: string[] = []
    const rec = buildCheckOutputRecord({ ...BASE, rawText: "boom" })
    expect(() => appendCheckOutput(dir, rec, (m) => logs.push(m))).not.toThrow()
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("check-output")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("F1: sidecar module lives outside every MECHANISM_PATH", () => {
  // Documentation-grade guard: the sidecar seam must stay out of the
  // calibration-covered paths (roadmap constraint F1).
  const rel = "cc-gate-plugin/src/sidecar.ts"
  for (const p of ["cc-gate-plugin/src/core", "cc-gate-plugin/vendor"]) {
    expect(rel.startsWith(p)).toBe(false)
  }
})
