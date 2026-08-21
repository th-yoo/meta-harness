import { test, expect } from "bun:test"
import { mergeFitVerifier } from "./verifiers/merge-fit.ts"
import { sourceRecountVerifier } from "./verifiers/source-recount.ts"

const U = [1.0, 2.3, 2.9, 5.1, 7.8]
const HONEST = U.map((u) => 100 + 40 * u)
const SHIFTED = [...HONEST.slice(1), HONEST[HONEST.length - 1]! + 40]

test("merge-fit: honest accepted, shifted rejected with worst-first residual steering", () => {
  const verify = mergeFitVerifier(U)
  expect(verify(HONEST).ok).toBe(true)
  const v = verify(SHIFTED)
  expect(v.ok).toBe(false)
  expect(v.steering).toBeDefined()
  const detail = v.steering!.detail
  expect(detail.length).toBe(U.length)
  // worst-first ordering
  for (let i = 1; i < detail.length; i++) {
    expect(Math.abs(detail[i - 1]!.residual)).toBeGreaterThanOrEqual(Math.abs(detail[i]!.residual))
  }
  expect(v.steering!.summary).toContain("anchor")
})

test("merge-fit: partial coverage fails closed without fabricated steering detail", () => {
  const v = mergeFitVerifier(U)(HONEST.slice(0, 3))
  expect(v.ok).toBe(false)
  expect(v.steering).toBeUndefined()
})

test("source-recount: correct counts accepted; wrong counts rejected with actuals as steering", () => {
  const text = "alpha beta\ngamma delta epsilon\n"
  const verify = sourceRecountVerifier(text)
  expect(verify({ lines: 2, words: 5 }).ok).toBe(true)
  const v = verify({ lines: 3, words: 4 })
  expect(v.ok).toBe(false)
  expect(v.steering!.detail).toEqual({ lines: 2, words: 5 })
  expect(v.steering!.summary).toContain("lines")
})

test("both verifiers satisfy the same Verdict/steering contract (shape witness)", () => {
  // Contract-shape check ONLY. Vocabulary/agnosticism enforcement lives in
  // Task 7's derived guard — this test must not claim it.
  const mv = mergeFitVerifier(U)(SHIFTED)
  const rv = sourceRecountVerifier("a b\n")({ lines: 9, words: 9 })
  expect(mv.ok).toBe(false)
  expect(rv.ok).toBe(false)
  expect(typeof mv.steering!.summary).toBe("string")
  expect(typeof rv.steering!.summary).toBe("string")
})
