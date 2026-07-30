// test/check-output.test.ts — pure parser + session join for the Phase 1
// check-output sidecar (emitter: cc-gate-plugin/src/sidecar.ts; shape
// re-declared locally per the standalone-package rule, same as scan.ts).
import { test, expect } from "bun:test"
import { parseCheckOutputRecords, joinBySession, type CheckOutputRecord } from "../src/check-output.ts"

function rec(over: Partial<CheckOutputRecord>): CheckOutputRecord {
  return {
    ts: 1000, sessionID: "s1", round: 1, roundsMax: 2,
    check: "bun test", excerpt: "FAIL", ...over,
  }
}

test("parses valid ndjson lines, skips blank/malformed/wrong-shape lines", () => {
  const text = [
    JSON.stringify(rec({})),
    "",
    "not json {",
    JSON.stringify({ ts: 2, sessionID: "s2" }), // missing required fields
    JSON.stringify(rec({ sessionID: "s2", ts: 2000, elidedChars: 7 })),
  ].join("\n")
  const out = parseCheckOutputRecords(text)
  expect(out.length).toBe(2)
  expect(out[0]!.sessionID).toBe("s1")
  expect(out[1]!).toMatchObject({ sessionID: "s2", elidedChars: 7 })
})

test("empty text parses to empty array, never throws", () => {
  expect(parseCheckOutputRecords("")).toEqual([])
})

test("joinBySession groups only requested sessions, sorted ts DESC", () => {
  const records = [
    rec({ sessionID: "a", ts: 1, round: 1 }),
    rec({ sessionID: "a", ts: 3, round: 2 }),
    rec({ sessionID: "b", ts: 2 }),
    rec({ sessionID: "zzz-not-requested", ts: 9 }),
  ]
  const m = joinBySession(["a", "b", "c"], records)
  expect([...m.keys()].sort()).toEqual(["a", "b"])
  expect(m.get("a")!.map((r) => r.ts)).toEqual([3, 1])
  expect(m.get("b")!.length).toBe(1)
  expect(m.has("c")).toBe(false)
})
