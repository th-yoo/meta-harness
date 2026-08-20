import { test, expect } from "bun:test"
import { join } from "node:path"
import { readSeriesFile } from "../src/bench/series-source.ts"
import { detectPeaks } from "../src/bench/series-peaks.ts"
import { FIT_FAMILY, conditioningCheck } from "../src/bench/reval-fit.ts"

const FIXTURE_DIR = join(import.meta.dir, "../../term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps")

test("TS pipeline reproduces the probe's D3 result on the real fixture: n=17 persistent peaks", () => {
  const { xs, ys } = readSeriesFile(join(FIXTURE_DIR, "graphene.dat"), FIXTURE_DIR)
  expect(xs.length).toBe(3565) // the EU-comma fixture variant
  const peaks = detectPeaks(ys)
  expect(peaks.length).toBe(17) // probe verdict D3 — a different count is a port bug, not a tune target
})

test("real-fixture constellation is irregular in both family variables (attack = transfer risk, not live)", () => {
  const { xs, ys } = readSeriesFile(join(FIXTURE_DIR, "graphene.dat"), FIXTURE_DIR)
  const px = detectPeaks(ys).map((i) => xs[i]!)
  for (const m of FIT_FAMILY) {
    const us = px.map(m.u).sort((a, b) => a - b)
    const d = us.slice(1).map((v, i) => v - us[i]!)
    const mean = d.reduce((s, v) => s + v, 0) / d.length
    const cv = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length) / mean
    expect(cv).toBeGreaterThan(0.15) // probe D3: CV 1.374 (x), 1.861 (1/x)
    // honest synthetic claim over this real geometry is accepted by the check
    const claim = us.map((u) => 10 + 2 * u)
    expect(conditioningCheck(us, claim).ok).toBe(true)
  }
})
