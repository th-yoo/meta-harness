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

// v1 is COMPOSED FRESH from the raw check output — it never reads or edits
// the kernel's prose (the earlier append model produced a message containing
// both "re-run it" and "do not run it yourself"; architect-reviewed
// composition design, plan-to-fix-velvet-pizza).

const RAW_OUT = "test_cancel FAILED — queued task never cancelled\n2/5 checks pass"
const KERNEL_CLOSING = "Fix the artifact (or the script if it is wrong about the contract) and re-run it."

test("v0 is the control: evidence passes through byte-identical, rawOut ignored", () => {
  expect(applyReinjectVariant(KERNEL, "v0", RAW_OUT)).toBe(KERNEL)
  expect(applyReinjectVariant(KERNEL, "v0")).toBe(KERNEL)
})

test("v1 composes fresh: no kernel closing sentence, no self-contradiction", () => {
  const out = applyReinjectVariant(KERNEL, "v1", RAW_OUT)
  expect(out).not.toContain(KERNEL_CLOSING)
  expect(out).not.toContain("re-run it")
  expect(out.toLowerCase()).toContain("do not run it yourself")
})

test("v1 carries the raw check output and ownership-true framing", () => {
  const out = applyReinjectVariant(KERNEL, "v1", RAW_OUT)
  expect(out).toContain(RAW_OUT)
  expect(out).toContain("not done")
  expect(out).toContain("gate.json")
  const lower = out.toLowerCase()
  expect(lower).toContain("gate")
  expect(lower).toMatch(/automatically|itself/)
  expect(lower).not.toContain("your verification script") // ownership-true diagnosis
})

test("v1 tails long rawOut to the kernel's OUT_TAIL: last 600 chars, suffix-exact", () => {
  const long = "X".repeat(1000) + "TAIL_END_MARKER"
  const out = applyReinjectVariant(KERNEL, "v1", long)
  const body = long.slice(-600)
  expect(out).toContain(body)
  expect(out).not.toContain("X".repeat(601)) // nothing beyond the tail leaks in
})

test("v1 without rawOut fails open: kernel evidence untransformed", () => {
  expect(applyReinjectVariant(KERNEL, "v1")).toBe(KERNEL)
  expect(applyReinjectVariant(KERNEL, "v1", undefined)).toBe(KERNEL)
})

test("v1 with empty rawOut also fails open (empty tail proves nothing)", () => {
  expect(applyReinjectVariant(KERNEL, "v1", "")).toBe(KERNEL)
})
