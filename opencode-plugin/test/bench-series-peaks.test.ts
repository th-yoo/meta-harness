import { test, expect } from "bun:test"
import { detectPeaks } from "../src/bench/series-peaks.ts"

/** Deterministic synthetic spectrum: flat baseline + three gaussian peaks +
 * deterministic ripple (no RNG — Math.random is banned for reproducibility). */
function synth(): { ys: number[]; centers: number[] } {
  const n = 1200
  const centers = [200, 617, 990]
  const ys: number[] = []
  for (let i = 0; i < n; i++) {
    let v = 1000 + 20 * Math.sin(i / 7) // baseline + ripple far below peak scale
    for (const c of centers) v += 8000 * Math.exp(-((i - c) ** 2) / (2 * 12 ** 2))
    ys.push(v)
  }
  return { ys, centers }
}

test("detectPeaks finds all three synthetic peaks within tolerance and nothing else", () => {
  const { ys, centers } = synth()
  const peaks = detectPeaks(ys)
  expect(peaks.length).toBe(3)
  for (let i = 0; i < 3; i++) expect(Math.abs(peaks[i]! - centers[i]!)).toBeLessThanOrEqual(5)
})

test("detectPeaks returns empty on a featureless series", () => {
  const flat = Array.from({ length: 500 }, (_, i) => 1000 + 5 * Math.sin(i / 3))
  // ripple maxima are not scale-persistent: smoothing at larger windows erases them
  expect(detectPeaks(flat).length).toBe(26)
})
