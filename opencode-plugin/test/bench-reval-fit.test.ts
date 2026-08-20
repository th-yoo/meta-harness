import { test, expect } from "bun:test"
import { fitAffine, deriveDelta, EPS } from "../src/bench/reval-fit.ts"

test("fitAffine recovers exact affine relation", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const cs = us.map((u) => 100 + 40 * u)
  const f = fitAffine(us, cs)
  expect(Math.abs(f.a - 100)).toBeLessThan(1e-9)
  expect(Math.abs(f.b - 40)).toBeLessThan(1e-9)
  expect(f.rms).toBeLessThan(1e-9)
})

test("fitAffine reports large rms on a shifted assignment over irregular anchors", () => {
  // probe T4: truth shifted by one index on an irregular constellation
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(fitAffine(us, shifted).rms).toBeGreaterThan(10)
})

test("fitAffine on constant us degrades to mean without dividing by zero", () => {
  const f = fitAffine([2, 2, 2], [5, 6, 7])
  expect(f.b).toBe(0)
  expect(Math.abs(f.a - 6)).toBeLessThan(1e-9)
})

test("deriveDelta is |b| * min spacing / 2 (spec D4)", () => {
  // sorted spacings of [1, 2.3, 2.9, 5.1, 7.8] -> min 0.6; b=40 -> delta 12
  expect(deriveDelta([1.0, 2.3, 2.9, 5.1, 7.8], 40)).toBeCloseTo(12, 9)
  // unsorted input must give the same answer
  expect(deriveDelta([7.8, 1.0, 5.1, 2.9, 2.3], -40)).toBeCloseTo(12, 9)
})

test("deriveDelta rejects degenerate spacing", () => {
  expect(() => deriveDelta([1], 40)).toThrow(RangeError)
  expect(() => deriveDelta([1, 1, 2], 40)).toThrow(RangeError)
})
