import { test, expect } from "bun:test"
import { fitAffine, deriveDelta, EPS } from "../src/bench/reval-fit.ts"
import { enumerateAutomorphisms, conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../src/bench/reval-fit.ts"

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

// -- derived automorphisms ---------------------------------------------------

test("equal-spaced constellation has the mirror automorphism (finite translations never survive the boundaries)", () => {
  const auts = enumerateAutomorphisms([1, 2, 3, 4, 5])
  // translations of a FINITE arithmetic sequence always push a boundary
  // element outside tolerance, so only the mirror survives
  expect(auts).toEqual([[4, 3, 2, 1, 0]])
})

test("SYMMETRIC irregular constellation has the mirror automorphism (probe T10 geometry)", () => {
  const auts = enumerateAutomorphisms([1, 2, 6, 10, 11])
  expect(auts).toContainEqual([4, 3, 2, 1, 0])
})

test("asymmetric irregular constellation has NO automorphisms", () => {
  expect(enumerateAutomorphisms([1.0, 2.3, 2.9, 5.1, 7.8])).toEqual([])
})

// -- conditioning check: the regression floor (probe T1, T2, T3, T10) --------

const truthOf = (us: number[]) => us.map((u) => 100 + 40 * u)

test("T1 floor: identity shift on equal-spaced constellation is REJECTED", () => {
  const us = [1, 2, 3, 4, 5]
  const truth = truthOf(us)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(conditioningCheck(us, shifted).ok).toBe(false)
})

test("T2 floor: honest claim on degenerate (equal-spaced) geometry is REJECTED fail-closed", () => {
  const us = [1, 2, 3, 4, 5]
  expect(conditioningCheck(us, truthOf(us)).ok).toBe(false)
})

test("T3 floor: honest claim on irregular geometry is ACCEPTED with wide margin", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const r = conditioningCheck(us, truthOf(us))
  expect(r.ok).toBe(true)
  expect(r.R).toBeGreaterThan(R_THRESHOLD_PLACEHOLDER * 100)
})

test("T10 floor: reversal on SYMMETRIC irregular constellation is REJECTED (derived mirror alternate)", () => {
  const us = [1, 2, 6, 10, 11]
  const reversed = [...truthOf(us)].reverse()
  expect(conditioningCheck(us, reversed).ok).toBe(false)
})

test("n < 3 is rejected outright", () => {
  expect(conditioningCheck([1, 2], [140, 180]).ok).toBe(false)
})
