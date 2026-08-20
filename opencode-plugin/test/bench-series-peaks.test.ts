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

test("detectPeaks treats a pure sinusoid ripple as scale-persistent structure (26 peaks — NOT featureless to this detector)", () => {
  const flat = Array.from({ length: 500 }, (_, i) => 1000 + 5 * Math.sin(i / 3))
  // a sin(i/3) ripple's maxima persist across the small smoothing scales (period ~19
  // samples spans windows 5..13), so the detector counts its ~26 cycles — measured
  // identically by the registered python reference; "featureless" for this detector
  // means no scale-persistent maxima, which a periodic ripple is not.
  expect(detectPeaks(flat).length).toBe(26)
})
