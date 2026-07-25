import { test, expect } from "bun:test"
import { liftFutility, guardFutility, designCheck } from "../../minimal/futility.ts"

// ── designCheck: pre-spend design viability ─────────────────────────────────

test("R10 replay: k=10 vs baseline 3/10 is a viable design (not futile at launch)", () => {
  const d = designCheck(10, 3, 10)
  expect(d.futile).toBe(false)
  expect(d.reason).toBeNull()
})

test("R7 replay: k=10 vs baseline 6/10 is futile AT LAUNCH — even 10/10 gives p≈0.087", () => {
  // The R7 incident: arm ran to 8/10 while mathematically dead from attempt 0.
  const d = designCheck(10, 6, 10)
  expect(d.futile).toBe(true)
  expect(d.bestCaseP).toBeCloseTo(0.087, 3)
  expect(d.reason).not.toBeNull()
  expect(d.reason!).toContain("6/10")
})

// ── liftFutility: mid-arm curtailment ───────────────────────────────────────

test("R10 replay: all-pass sequence never curtailed at any prefix", () => {
  // R10 went 10/10 vs baseline 3/10 — futility must not have fired anywhere.
  for (let done = 0; done <= 10; done++) {
    const v = liftFutility({ pass: done, fail: 0, k: 10 }, 3, 10)
    expect(v.futile).toBe(false)
    expect(v.reason).toBeNull()
  }
})

test("mid-arm death: 0 pass / 5 fail of k=10 vs baseline 3/10 → best case 5/10 is futile", () => {
  const v = liftFutility({ pass: 0, fail: 5, k: 10 }, 3, 10)
  expect(v.futile).toBe(true)
  expect(v.reason).not.toBeNull()
  expect(v.reason!).toContain("5/10")
})

test("recoverable low point NOT stopped: 0 pass / 3 fail vs baseline 1/10 — best 7/10 still certifies", () => {
  // fisher(7,3,1,9) = 0.0198 <= 0.05: the bound respects the BEST case, not the current one.
  const v = liftFutility({ pass: 0, fail: 3, k: 10 }, 1, 10)
  expect(v.futile).toBe(false)
  expect(v.bestCaseP).toBeCloseTo(0.0198, 3)
})

test("no-lift-possible branch: best-case rate <= baseline rate → futile regardless of p", () => {
  // 5 pass / 4 fail of k=10 → best 6/10, below baseline 9/10.
  const v = liftFutility({ pass: 5, fail: 4, k: 10 }, 9, 10)
  expect(v.futile).toBe(true)
  expect(v.reason).not.toBeNull()
})

test("alpha respected: same state futile at alpha=0.01 but not at 0.05", () => {
  // best case 7/10 vs 1/10 → p = 0.0198: between the two thresholds.
  const s = { pass: 0, fail: 3, k: 10 }
  expect(liftFutility(s, 1, 10, 0.05).futile).toBe(false)
  expect(liftFutility(s, 1, 10, 0.01).futile).toBe(true)
})

// ── guardFutility: first valid fail is final ────────────────────────────────

test("guardFutility: zero valid fails → not futile", () => {
  const v = guardFutility(0)
  expect(v.futile).toBe(false)
  expect(v.bestCaseP).toBe(0)
  expect(v.reason).toBeNull()
})

test("guardFutility: one valid fail → futile with reason (guard verdict already REGRESSED)", () => {
  // The v9 incident: guard arm ran 3 trials after trial 1's fail had decided it.
  const v = guardFutility(1)
  expect(v.futile).toBe(true)
  expect(v.bestCaseP).toBe(1)
  expect(v.reason).not.toBeNull()
  expect(v.reason!.toLowerCase()).toContain("fail")
})
