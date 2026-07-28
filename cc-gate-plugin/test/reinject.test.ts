// §4.4 mechanism experiment: reinject wording. Pre-registration §4b in
// docs/superpowers/specs/2026-07-28-kkamak-scorecard-preregistration.md
//
// The shared kernel ends its block message with "…and re-run it." That is
// right for term-bench2 (the agent owns verify.sh) and wrong for kkamak,
// where the GATE runs the check — the agent re-running it raises a
// permission prompt and stalls the fix loop (SM2 dogfood finding).
import { test, expect } from "bun:test"
import { pickReinjectVariant, applyReinjectVariant, REINJECT_VARIANTS } from "../src/reinject.ts"

const KERNEL = "not done: your verification script fails:\nfoo\nFix the artifact (or the script if it is wrong about the contract) and re-run it."

// ── assignment ───────────────────────────────────────────────────────────

test("assignment is DETERMINISTIC per session — same id always same arm", () => {
  for (const id of ["a", "b", "session-123", "7f3e-aaaa"]) {
    expect(pickReinjectVariant(id)).toBe(pickReinjectVariant(id))
  }
})

test("assignment splits roughly evenly across many sessions (within-workload randomisation)", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `session-${i}-${i * 7919}`)
  const v1 = ids.filter((id) => pickReinjectVariant(id) === "v1").length
  // Both arms must actually accumulate; a wildly skewed hash would starve one.
  expect(v1).toBeGreaterThan(140)
  expect(v1).toBeLessThan(260)
})

test("env override forces a variant (escape hatch), invalid value ignored", () => {
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v0" })).toBe("v0")
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v1" })).toBe("v1")
  const natural = pickReinjectVariant("any")
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "nonsense" })).toBe(natural)
})

test("both variants exist and are exactly the pre-registered pair", () => {
  expect([...REINJECT_VARIANTS]).toEqual(["v0", "v1"])
})

// ── wording ──────────────────────────────────────────────────────────────

test("v0 is the control: evidence passes through byte-identical", () => {
  expect(applyReinjectVariant(KERNEL, "v0")).toBe(KERNEL)
})

test("v1 appends the do-not-re-run clause, preserving the original evidence", () => {
  const out = applyReinjectVariant(KERNEL, "v1")
  expect(out.startsWith(KERNEL)).toBe(true)
  expect(out.toLowerCase()).toContain("do not run it yourself")
  expect(out.length).toBeGreaterThan(KERNEL.length)
})

test("v1 states WHO runs the check — the actionable part of the clause", () => {
  const out = applyReinjectVariant(KERNEL, "v1").toLowerCase()
  expect(out).toContain("gate")
  expect(out).toMatch(/automatically|itself/)
})

test("v1 is idempotent — a re-blocked cycle never stacks the clause twice", () => {
  const once = applyReinjectVariant(KERNEL, "v1")
  expect(applyReinjectVariant(once, "v1")).toBe(once)
})

test("empty or whitespace evidence is left alone (nothing to append to)", () => {
  expect(applyReinjectVariant("", "v1")).toBe("")
  expect(applyReinjectVariant("   ", "v1")).toBe("   ")
})
