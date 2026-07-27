import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readPositions, writePositionsAtomic, positionsPath, type Positions } from "../src/positions.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-crank-positions-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test("positionsPath: nests under <root>/km-crank/positions.json", () => {
  expect(positionsPath(dir)).toBe(path.join(dir, "km-crank", "positions.json"))
})

test("readPositions: missing file -> empty positions, does not throw", () => {
  expect(() => readPositions(dir)).not.toThrow()
  expect(readPositions(dir)).toEqual({ files: {}, lastRunTs: 0 })
})

test("readPositions: corrupt JSON -> empty positions, does not throw", () => {
  fs.mkdirSync(path.join(dir, "km-crank"), { recursive: true })
  fs.writeFileSync(positionsPath(dir), "{not valid json")
  expect(() => readPositions(dir)).not.toThrow()
  expect(readPositions(dir)).toEqual({ files: {}, lastRunTs: 0 })
})

test("readPositions: wrong-shape JSON -> empty positions", () => {
  fs.mkdirSync(path.join(dir, "km-crank"), { recursive: true })
  fs.writeFileSync(positionsPath(dir), JSON.stringify({ nonsense: true }))
  expect(readPositions(dir)).toEqual({ files: {}, lastRunTs: 0 })
})

test("readPositions: drops malformed per-file entries but keeps well-formed ones", () => {
  fs.mkdirSync(path.join(dir, "km-crank"), { recursive: true })
  fs.writeFileSync(
    positionsPath(dir),
    JSON.stringify({
      files: { "/a/sensor.ndjson": { offset: 42 }, "/b/sensor.ndjson": { offset: "bad" }, "/c/sensor.ndjson": "bad" },
      lastRunTs: 123,
    }),
  )
  expect(readPositions(dir)).toEqual({
    files: { "/a/sensor.ndjson": { offset: 42 } },
    lastRunTs: 123,
  })
})

test("writePositionsAtomic + readPositions: roundtrip", () => {
  const positions: Positions = {
    files: { "/repo/.km/gate-outcomes.ndjson": { offset: 1234 } },
    lastRunTs: 999,
  }
  writePositionsAtomic(positions, dir)
  expect(readPositions(dir)).toEqual(positions)
})

test("writePositionsAtomic: creates the km-crank/ directory if absent", () => {
  expect(fs.existsSync(path.join(dir, "km-crank"))).toBe(false)
  writePositionsAtomic({ files: {}, lastRunTs: 1 }, dir)
  expect(fs.existsSync(positionsPath(dir))).toBe(true)
})

test("writePositionsAtomic: no leftover tmp files after a successful write", () => {
  writePositionsAtomic({ files: {}, lastRunTs: 1 }, dir)
  const entries = fs.readdirSync(path.join(dir, "km-crank"))
  expect(entries).toEqual(["positions.json"])
})

test("writePositionsAtomic: overwrite replaces prior contents wholesale", () => {
  writePositionsAtomic({ files: { "/x": { offset: 1 } }, lastRunTs: 1 }, dir)
  writePositionsAtomic({ files: { "/y": { offset: 2 } }, lastRunTs: 2 }, dir)
  expect(readPositions(dir)).toEqual({ files: { "/y": { offset: 2 } }, lastRunTs: 2 })
})
