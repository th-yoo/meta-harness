import { test, expect } from "bun:test"
import { parseSensorLines, aggregate, notable, newLineCount, type SensorLine } from "../src/scan.ts"

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

// ── Task 1 (fix-them-serialized-teacup plan, round-2 review): skippedStop
// passes THROUGH the parser (restored, so trial-verdict.ts's rule-7 filter
// is reachable in the real production path); only the volume-contest
// counting site (newLineCount) discounts it. ───────────────────────────────

test("parseSensorLines: skippedStop lines pass through like any other optional field (NOT dropped by the parser)", () => {
  const real = line({ sessionID: "real" })
  const skipped = line({ sessionID: "skipped", rounds: [], skippedStop: true })
  const text = `${JSON.stringify(real)}\n${JSON.stringify(skipped)}\n`
  expect(parseSensorLines(text)).toEqual([real, skipped])
})

test("parseSensorLines: repeated skippedStop lines in one session all pass through, not just the first", () => {
  const skipped = line({ sessionID: "s1", rounds: [], skippedStop: true })
  const text = Array.from({ length: 3 }, () => JSON.stringify(skipped)).join("\n") + "\n"
  expect(parseSensorLines(text)).toEqual([skipped, skipped, skipped])
})

// ── newLineCount: the narrow, single-consumer discount ─────────────────────

test("newLineCount: counts every line except skippedStop ones", () => {
  const lines = [
    line({ sessionID: "a" }),
    line({ sessionID: "b", rounds: [], skippedStop: true }),
    line({ sessionID: "c" }),
    line({ sessionID: "d", rounds: [], skippedStop: true }),
  ]
  expect(newLineCount(lines)).toBe(2)
})

test("newLineCount: empty input -> 0", () => {
  expect(newLineCount([])).toBe(0)
})

test("newLineCount: all-real input counts every line", () => {
  const lines = [line({ sessionID: "a" }), line({ sessionID: "b" })]
  expect(newLineCount(lines)).toBe(2)
})

test("newLineCount: all-skipped-stop input counts zero", () => {
  const lines = [
    line({ sessionID: "a", rounds: [], skippedStop: true }),
    line({ sessionID: "a", rounds: [], skippedStop: true }),
  ]
  expect(newLineCount(lines)).toBe(0)
})

// ── Phase 3 Task 4 (5th pre-data amendment): newLineCount also discounts
// prompt-check lines, alongside skippedStop ─────────────────────────────────

test("newLineCount: counts every line except skippedStop AND promptCheck ones", () => {
  const lines = [
    line({ sessionID: "a" }),
    line({ sessionID: "b", rounds: [], skippedStop: true }),
    line({ sessionID: "c" }),
    line({ sessionID: "d", rounds: [], promptCheck: true }),
  ]
  expect(newLineCount(lines)).toBe(2)
})

test("newLineCount: all-prompt-check input counts zero", () => {
  const lines = [
    line({ sessionID: "a", rounds: [], promptCheck: true }),
    line({ sessionID: "a", rounds: [], promptCheck: true }),
  ]
  expect(newLineCount(lines)).toBe(0)
})

// ── aggregate(): skippedStop lines don't misclassify into any sub-counter
// (round-2 review: "verify the rest" — cleanAccepts was already checked) ───

test("aggregate: a skippedStop line (rounds:[], gateExhausted:false, interrupted:false) contributes to NO sub-counter except total/medianDurationMs", () => {
  const a = aggregate([
    line({ sessionID: "real", rounds: ["accepted"] }), // clean
    line({ sessionID: "skip", rounds: [], skippedStop: true, gateExhausted: false, interrupted: false, durationMs: 0 }),
  ])
  expect(a.cleanAccepts).toBe(1) // only the real clean line
  expect(a.fixCycles).toBe(0)
  expect(a.exhausted).toBe(0)
  expect(a.interrupted).toBe(0)
  // total/medianDurationMs are NOT filtered by aggregate() — scoped
  // out-of-scope for this fix, same pre-existing shape as gauge-only lines.
  expect(a.total).toBe(2)
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
