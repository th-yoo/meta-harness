import { test, expect } from "bun:test"
import { parseSensorLines, aggregate, notable, type SensorLine } from "../src/scan.ts"

function line(overrides: Partial<SensorLine> = {}): SensorLine {
  return {
    ts: 1000,
    sessionID: "s1",
    check: "npm test",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 1000,
    host: "test-host",
    app: "claude-code",
    ...overrides,
  }
}

// ── parseSensorLines ────────────────────────────────────────────────────────

test("parseSensorLines: parses well-formed ndjson", () => {
  const l1 = line({ sessionID: "a" })
  const l2 = line({ sessionID: "b" })
  const text = `${JSON.stringify(l1)}\n${JSON.stringify(l2)}\n`
  const result = parseSensorLines(text)
  expect(result).toEqual([l1, l2])
})

test("parseSensorLines: skips blank lines", () => {
  const l1 = line({ sessionID: "a" })
  const text = `\n${JSON.stringify(l1)}\n\n\n`
  expect(parseSensorLines(text)).toEqual([l1])
})

test("parseSensorLines: skips malformed JSON lines without throwing", () => {
  const l1 = line({ sessionID: "a" })
  const text = `{not valid json\n${JSON.stringify(l1)}\n`
  expect(() => parseSensorLines(text)).not.toThrow()
  expect(parseSensorLines(text)).toEqual([l1])
})

test("parseSensorLines: skips lines missing required fields", () => {
  const l1 = line({ sessionID: "a" })
  const partial = JSON.stringify({ ts: 1, sessionID: "bad" }) // missing most fields
  const text = `${partial}\n${JSON.stringify(l1)}\n`
  expect(parseSensorLines(text)).toEqual([l1])
})

test("parseSensorLines: skips lines with wrong-typed fields", () => {
  const bad = { ...line(), durationMs: "not-a-number" }
  const text = `${JSON.stringify(bad)}\n`
  expect(parseSensorLines(text)).toEqual([])
})

test("parseSensorLines: empty text -> empty array", () => {
  expect(parseSensorLines("")).toEqual([])
})

// ── Task 1 (fix-them-serialized-teacup plan): skippedStop exclusion ────────

test("parseSensorLines: excludes skippedStop lines entirely (not just from a downstream count) — keeps the volume contest/threshold from being skewed by queued-prompt multiplicity", () => {
  const real = line({ sessionID: "real" })
  const skipped = line({ sessionID: "skipped", rounds: [], skippedStop: true })
  const text = `${JSON.stringify(real)}\n${JSON.stringify(skipped)}\n`
  expect(parseSensorLines(text)).toEqual([real])
})

test("parseSensorLines: repeated skippedStop lines in one session all drop out, not just the first", () => {
  const skipped = line({ sessionID: "s1", rounds: [], skippedStop: true })
  const text = Array.from({ length: 3 }, () => JSON.stringify(skipped)).join("\n") + "\n"
  expect(parseSensorLines(text)).toEqual([])
})

// ── aggregate ────────────────────────────────────────────────────────────────

test("aggregate: empty input", () => {
  expect(aggregate([])).toEqual({
    total: 0,
    cleanAccepts: 0,
    fixCycles: 0,
    exhausted: 0,
    interrupted: 0,
    medianDurationMs: 0,
  })
})

test("aggregate: cleanAccepts requires rounds === ['accepted'] exactly", () => {
  const a = aggregate([
    line({ rounds: ["accepted"] }),
    line({ rounds: ["verify-failed", "accepted"] }), // not clean — two rounds
    line({ rounds: [] }),
  ])
  expect(a.cleanAccepts).toBe(1)
})

test("aggregate: fixCycles requires both verify-failed AND accepted present", () => {
  const a = aggregate([
    line({ rounds: ["verify-failed", "accepted"] }),
    line({ rounds: ["verify-failed", "verify-failed"] }), // no accepted -> not a fix cycle
    line({ rounds: ["accepted"] }), // no verify-failed -> not a fix cycle
  ])
  expect(a.fixCycles).toBe(1)
})

test("aggregate: counts exhausted and interrupted independently", () => {
  const a = aggregate([
    line({ gateExhausted: true }),
    line({ interrupted: true }),
    line({ gateExhausted: true, interrupted: true }),
  ])
  expect(a.exhausted).toBe(2)
  expect(a.interrupted).toBe(2)
  expect(a.total).toBe(3)
})

test("aggregate: medianDurationMs — odd count", () => {
  const a = aggregate([line({ durationMs: 100 }), line({ durationMs: 300 }), line({ durationMs: 200 })])
  expect(a.medianDurationMs).toBe(200)
})

test("aggregate: medianDurationMs — even count averages the middle two", () => {
  const a = aggregate([
    line({ durationMs: 100 }),
    line({ durationMs: 200 }),
    line({ durationMs: 300 }),
    line({ durationMs: 400 }),
  ])
  expect(a.medianDurationMs).toBe(250)
})

// ── notable ──────────────────────────────────────────────────────────────────

test("notable: prioritizes exhausted and interrupted sessions", () => {
  const exhausted = line({ sessionID: "e1", gateExhausted: true, durationMs: 10 })
  const interrupted = line({ sessionID: "i1", interrupted: true, durationMs: 10 })
  const normal = line({ sessionID: "n1", durationMs: 9999 })
  const result = notable([normal, exhausted, interrupted], 5)
  expect(result.map((l) => l.sessionID).sort()).toEqual(["e1", "i1", "n1"].sort())
  expect(result[0]!.sessionID === "e1" || result[0]!.sessionID === "i1").toBe(true)
})

test("notable: fills remaining slots with longest-duration sessions", () => {
  const lines = [
    line({ sessionID: "short", durationMs: 100 }),
    line({ sessionID: "long", durationMs: 9000 }),
    line({ sessionID: "medium", durationMs: 500 }),
  ]
  const result = notable(lines, 2)
  expect(result.map((l) => l.sessionID)).toEqual(["long", "medium"])
})

test("notable: caps output at k", () => {
  const lines = Array.from({ length: 10 }, (_, i) => line({ sessionID: `s${i}`, gateExhausted: true }))
  expect(notable(lines, 5)).toHaveLength(5)
})

test("notable: default k is 5", () => {
  const lines = Array.from({ length: 10 }, (_, i) => line({ sessionID: `s${i}`, durationMs: i }))
  expect(notable(lines)).toHaveLength(5)
})

test("notable: empty input", () => {
  expect(notable([])).toEqual([])
})
