import { test, expect } from "bun:test"
import { parseGateConfig } from "../src/config.ts"

test("parseGateConfig: minimal valid config gets ALL defaults", () => {
  const c = parseGateConfig(`{"check": "bun test"}`)
  expect(c).toEqual({
    check: "bun test",
    rounds: 2,
    marker: false,
    sensor: ".km/gate-outcomes.ndjson",
    checkTimeoutMs: 300_000,
  })
})

test("parseGateConfig: explicit fields respected (incl. checkTimeoutMs)", () => {
  const c = parseGateConfig(
    `{"check": "make verify", "rounds": 1, "marker": true, "sensor": "out.ndjson", "checkTimeoutMs": 5000}`
  )
  expect(c).toEqual({
    check: "make verify",
    rounds: 1,
    marker: true,
    sensor: "out.ndjson",
    checkTimeoutMs: 5000,
  })
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

test("parseGateConfig: empty-string check → undefined", () => {
  expect(parseGateConfig(`{"check": ""}`)).toBeUndefined()
})

test("parseGateConfig: undefined raw → undefined", () => {
  expect(parseGateConfig(undefined)).toBeUndefined()
})

test("parseGateConfig: unknown fields ignored", () => {
  const c = parseGateConfig(
    `{"check": "bun test", "foo": "bar", "nested": {"key": "value"}}`
  )
  expect(c).toEqual({
    check: "bun test",
    rounds: 2,
    marker: false,
    sensor: ".km/gate-outcomes.ndjson",
    checkTimeoutMs: 300_000,
  })
  expect(c).not.toHaveProperty("foo")
  expect(c).not.toHaveProperty("nested")
})

test("parseGateConfig: non-object JSON → undefined", () => {
  expect(parseGateConfig(`"just a string"`)).toBeUndefined()
  expect(parseGateConfig(`42`)).toBeUndefined()
  expect(parseGateConfig(`true`)).toBeUndefined()
  expect(parseGateConfig(`null`)).toBeUndefined()
  expect(parseGateConfig(`[]`)).toBeUndefined()
})

test("parseGateConfig: marker === true only (marker: false → default false, marker: 1 → default false)", () => {
  const c1 = parseGateConfig(`{"check": "cmd", "marker": true}`)
  expect(c1!.marker).toBe(true)

  const c2 = parseGateConfig(`{"check": "cmd", "marker": false}`)
  expect(c2!.marker).toBe(false) // explicitly false, not default

  const c3 = parseGateConfig(`{"check": "cmd", "marker": 1}`)
  expect(c3!.marker).toBe(false) // strict === true check, so 1 defaults to false

  const c4 = parseGateConfig(`{"check": "cmd"}`)
  expect(c4!.marker).toBe(false) // default
})

test("parseGateConfig: rounds defaults to 2, but respects 0 and 1", () => {
  const c0 = parseGateConfig(`{"check": "cmd", "rounds": 0}`)
  expect(c0!.rounds).toBe(0)

  const c1 = parseGateConfig(`{"check": "cmd", "rounds": 1}`)
  expect(c1!.rounds).toBe(1)

  const c2 = parseGateConfig(`{"check": "cmd", "rounds": 5}`)
  expect(c2!.rounds).toBe(5)

  const cDefault = parseGateConfig(`{"check": "cmd"}`)
  expect(cDefault!.rounds).toBe(2)
})

test("parseGateConfig: checkTimeoutMs respects value and defaults to 300_000", () => {
  const c1 = parseGateConfig(`{"check": "cmd", "checkTimeoutMs": 1000}`)
  expect(c1!.checkTimeoutMs).toBe(1000)

  const c2 = parseGateConfig(`{"check": "cmd", "checkTimeoutMs": 60000}`)
  expect(c2!.checkTimeoutMs).toBe(60000)

  const cDefault = parseGateConfig(`{"check": "cmd"}`)
  expect(cDefault!.checkTimeoutMs).toBe(300_000)
})

test("parseGateConfig: sensor respects custom value and defaults to .km/gate-outcomes.ndjson", () => {
  const c1 = parseGateConfig(`{"check": "cmd", "sensor": "custom.ndjson"}`)
  expect(c1!.sensor).toBe("custom.ndjson")

  const c2 = parseGateConfig(`{"check": "cmd", "sensor": "/absolute/path.ndjson"}`)
  expect(c2!.sensor).toBe("/absolute/path.ndjson")

  const cDefault = parseGateConfig(`{"check": "cmd"}`)
  expect(cDefault!.sensor).toBe(".km/gate-outcomes.ndjson")
})
