/**
 * sensor-checkpoint.test.ts — TDD for scripts/sensor-checkpoint.ts: the
 * pre-registered 08-13 cadence checkpoint reader (sensor spec §5).
 *
 * Written FIRST, failing (the script does not exist yet).
 *
 * The counting rule under test is the USER RULING recorded 2026-08-11 in
 * the spec's §5 checkpoint block, BEFORE any events/day number was
 * computed: one event toward the >=25/day bar = one pass line with a
 * DISTINCT (baseSha, headSha) pair within that calendar day. Repeat
 * reviews of an unchanged main diff collapse to one event per day. Skip
 * lines never count. This module locks the computation so the 08-13
 * reading is mechanical.
 *
 * All fixture lines are synthetic — never a real stream.
 */
import { test, expect, describe } from "bun:test"
import {
  computeCheckpoint,
  CADENCE_BAR,
  SENSOR_EFFECTIVE_BOUNDARY_TS,
  type SensorStreamLine,
} from "../../scripts/sensor-checkpoint.ts"

const DAY = 24 * 60 * 60 * 1000
// anchor on a local-noon ts so +/-1h never crosses local midnight
const T0 = new Date(2026, 7, 6, 12, 0, 0).getTime()

function pass(ts: number, baseSha: string, headSha: string): SensorStreamLine {
  return { ts, findingsCount: 1, baseSha, headSha, host: "test" }
}
function skip(ts: number, reason: string): SensorStreamLine {
  return { ts, skipped: true, reason, host: "test" }
}

describe("computeCheckpoint — the ruled distinct-(baseSha,headSha) counting", () => {
  test("repeat reviews of an unchanged diff collapse to ONE event that day; raw count still reported", () => {
    const lines = [pass(T0, "a1", "b1"), pass(T0 + 1000, "a1", "b1"), pass(T0 + 2000, "a1", "b1")]
    const r = computeCheckpoint(lines, T0 - 1, T0 + DAY)
    expect(r.ruledEvents).toBe(1)
    expect(r.rawPassLines).toBe(3)
  })

  test("distinct pairs the same day each count", () => {
    const lines = [pass(T0, "a1", "b1"), pass(T0 + 1000, "a1", "b2"), pass(T0 + 2000, "a2", "b2")]
    expect(computeCheckpoint(lines, T0 - 1, T0 + DAY).ruledEvents).toBe(3)
  })

  test("the SAME pair on two calendar days counts once per day (ruling: distinctness is per calendar day)", () => {
    const lines = [pass(T0, "a1", "b1"), pass(T0 + DAY, "a1", "b1")]
    expect(computeCheckpoint(lines, T0 - 1, T0 + 2 * DAY).ruledEvents).toBe(2)
  })

  test("skip lines never count, but are tallied by reason", () => {
    const lines = [skip(T0, "debounce"), skip(T0 + 1, "debounce"), skip(T0 + 2, "warm-lane-busy"), pass(T0 + 3, "a", "b")]
    const r = computeCheckpoint(lines, T0 - 1, T0 + DAY)
    expect(r.ruledEvents).toBe(1)
    expect(r.skipsByReason).toEqual({ debounce: 2, "warm-lane-busy": 1 })
  })

  test("lines outside [since, until] are excluded", () => {
    const lines = [pass(T0 - DAY, "x", "y"), pass(T0, "a", "b"), pass(T0 + 3 * DAY, "p", "q")]
    const r = computeCheckpoint(lines, T0 - 1, T0 + DAY)
    expect(r.ruledEvents).toBe(1)
    expect(r.rawPassLines).toBe(1)
  })

  test("a pass line missing its sha pair cannot enter the ruled count — reported separately, never silently dropped or counted", () => {
    const malformed = { ts: T0, findingsCount: 2, host: "test" } as SensorStreamLine
    const r = computeCheckpoint([malformed, pass(T0 + 1, "a", "b")], T0 - 1, T0 + DAY)
    expect(r.ruledEvents).toBe(1)
    expect(r.malformedPassLines).toBe(1)
  })

  test("eventsPerDay divides by calendar days spanned by the window, inclusive; bar verdict at >=25", () => {
    // 7-day window, 30 distinct events -> 30/7 < 25 -> bar not met
    const lines: SensorStreamLine[] = []
    for (let i = 0; i < 30; i++) lines.push(pass(T0 + (i % 7) * DAY + i * 1000, `a${i}`, `b${i}`))
    // window end at noon+1min of day 7 — inside day 7, past every fixture ts
    const r = computeCheckpoint(lines, T0, T0 + 6 * DAY + 60_000)
    expect(r.spanDays).toBe(7)
    expect(r.ruledEvents).toBe(30)
    expect(r.eventsPerDay).toBeCloseTo(30 / 7, 10)
    expect(r.barMet).toBe(false)
  })

  test("bar met at exactly 25/day", () => {
    const lines: SensorStreamLine[] = []
    for (let i = 0; i < 25; i++) lines.push(pass(T0 + i * 60_000, `a${i}`, `b${i}`))
    // window stays inside ONE local calendar day (T0 is local noon)
    const r = computeCheckpoint(lines, T0, T0 + 25 * 60_000)
    expect(r.spanDays).toBe(1)
    expect(r.eventsPerDay).toBe(25)
    expect(r.barMet).toBe(true)
  })

  test("empty stream -> zeros, bar not met, no division by zero", () => {
    const r = computeCheckpoint([], T0, T0 + DAY)
    expect(r.ruledEvents).toBe(0)
    expect(r.eventsPerDay).toBe(0)
    expect(r.barMet).toBe(false)
  })
})

describe("constants", () => {
  test("bar and boundary pinned to the pre-registration", () => {
    expect(CADENCE_BAR).toBe(25)
    expect(SENSOR_EFFECTIVE_BOUNDARY_TS).toBe(1785996709580)
  })
})
