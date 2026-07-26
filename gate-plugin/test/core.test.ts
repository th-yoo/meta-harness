import { test, expect } from "bun:test"
import { parseGateConfig } from "../src/core.ts"

test("parseGateConfig: minimal valid config gets defaults", () => {
  const c = parseGateConfig(`{"check": "bun test"}`)
  expect(c).toEqual({ check: "bun test", rounds: 2, marker: false, sensor: ".meta-harness/gate-outcomes.ndjson" })
})
test("parseGateConfig: explicit fields respected", () => {
  const c = parseGateConfig(`{"check": "make verify", "rounds": 1, "marker": true, "sensor": "out.ndjson"}`)
  expect(c).toEqual({ check: "make verify", rounds: 1, marker: true, sensor: "out.ndjson" })
})
test("parseGateConfig: missing check → undefined", () => {
  expect(parseGateConfig(`{"rounds": 3}`)).toBeUndefined()
})
test("parseGateConfig: malformed JSON → undefined", () => {
  expect(parseGateConfig(`{nope`)).toBeUndefined()
})
test("parseGateConfig: non-string check → undefined", () => {
  expect(parseGateConfig(`{"check": 42}`)).toBeUndefined()
})
