import { test, expect } from "bun:test"
import { fitAffine, deriveDelta, EPS } from "../src/bench/reval-fit.ts"
import { enumerateAutomorphisms, conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../src/bench/reval-fit.ts"
import { mergeCheck } from "../src/bench/reval-fit.ts"

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

const usIr = [1.0, 2.3, 2.9, 5.1, 7.8]

test("mergeCheck accepts an honest full-coverage claim on irregular anchors", () => {
  const r = mergeCheck(usIr, truthOf(usIr))
  expect(r.ok).toBe(true)
  expect(r.b).toBeCloseTo(40, 6)
  expect(r.delta).toBeCloseTo(12, 6) // |40| * 0.6 / 2
})

test("mergeCheck rejects partial coverage — claimant never selects the graded subset (spec §6.5)", () => {
  const r = mergeCheck(usIr, truthOf(usIr).slice(0, 3))
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("coverage")
})

test("mergeCheck rejects n < 3", () => {
  const r = mergeCheck([1.0, 2.3], [140, 192])
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("insufficient-anchors")
})

test("mergeCheck rejects coincident anchors fail-closed instead of throwing", () => {
  const r = mergeCheck([1, 2, 2, 4, 5], [140, 180, 180, 260, 300])
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("coincident-anchors")
})

test("mergeCheck rejects degenerate geometry fail-closed (probe T2)", () => {
  const us = [1, 2, 3, 4, 5]
  const r = mergeCheck(us, truthOf(us))
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("degenerate-constellation")
})

test("mergeCheck rejects a shifted claim on irregular anchors via residuals (probe T4)", () => {
  const truth = truthOf(usIr)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  const r = mergeCheck(usIr, shifted)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("residual")
})

test("DOCUMENTED BOUNDARY (probe T6): an invented consistent (a,b) PASSES — the merge checks pairing, never truth", () => {
  // Spec §6 scope paragraph: this is deception, rejectable only by an outside
  // prior (§8.8). This test pins the boundary so nobody mistakes it for a bug.
  const invented = usIr.map((u) => 7 + 3 * u)
  expect(mergeCheck(usIr, invented).ok).toBe(true)
})
