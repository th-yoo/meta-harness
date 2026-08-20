import { test, expect } from "bun:test"
import { join } from "node:path"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { parseSeries, readSeriesFile } from "../src/bench/series-source.ts"

test("parseSeries reads plain-decimal tab-separated rows", () => {
  const { xs, ys } = parseSeries("5800.0\t5591.99\n5800.87\t5591.68\nnot a row\n")
  expect(xs).toEqual([5800.0, 5800.87])
  expect(ys).toEqual([5591.99, 5591.68])
})

test("parseSeries reads EU decimal commas (the raman-fitting-audit fixture variant)", () => {
  const { xs, ys } = parseSeries("47183,554644\t19261,547207\n")
  expect(xs[0]).toBeCloseTo(47183.554644, 6)
  expect(ys[0]).toBeCloseTo(19261.547207, 6)
})

test("readSeriesFile reads a contained file and refuses escapes loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "series-src-"))
  mkdirSync(join(root, "env"))
  writeFileSync(join(root, "env", "data.dat"), "1\t10\n2\t20\n")
  writeFileSync(join(root, "outside.dat"), "1\t10\n")
  const ok = readSeriesFile(join(root, "env", "data.dat"), join(root, "env"))
  expect(ok.xs).toEqual([1, 2])
  expect(() => readSeriesFile(join(root, "outside.dat"), join(root, "env"))).toThrow("escapes root")
})
