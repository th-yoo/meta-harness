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
  // Explicit env: this asserts the two-arm split, so it must not inherit a
  // host that has KKAMAK_REINJECT_V2=1 set (activation makes it three-arm).
  const v1 = ids.filter((id) => pickReinjectVariant(id, {}) === "v1").length
  // Both arms must actually accumulate; a wildly skewed hash would starve one.
  expect(v1).toBeGreaterThan(140)
  expect(v1).toBeLessThan(260)
})

test("env override forces a variant (escape hatch), invalid value ignored", () => {
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v0" })).toBe("v0")
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v1" })).toBe("v1")
  // Both sides take the same explicit env, so the comparison stays about the
  // invalid override alone — not about which arms the host happens to enable.
  const natural = pickReinjectVariant("any", {})
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "nonsense" })).toBe(natural)
})

test("variant list is the pre-registered pair plus the env-gated v2 arm", () => {
  expect([...REINJECT_VARIANTS]).toEqual(["v0", "v1", "v2"])
})

// ── v2 arm gating (Gauntlet Loop F — amendment pending, env kill switch) ─

test("without KKAMAK_REINJECT_V2 the live 50/50 assignment is unchanged: v2 never assigned", () => {
  const ids = Array.from({ length: 400 }, (_, i) => `session-${i}-${i * 7919}`)
  for (const id of ids) {
    const arm = pickReinjectVariant(id, {})
    expect(arm).not.toBe("v2")
    // and the choice is byte-identical to the pre-v2 hash rule's domain
    expect(["v0", "v1"]).toContain(arm)
  }
})

test("with KKAMAK_REINJECT_V2=1 all three arms accumulate, deterministically per session", () => {
  const env = { KKAMAK_REINJECT_V2: "1" }
  const ids = Array.from({ length: 600 }, (_, i) => `session-${i}-${i * 7919}`)
  const counts = { v0: 0, v1: 0, v2: 0 }
  for (const id of ids) {
    const arm = pickReinjectVariant(id, env)
    expect(pickReinjectVariant(id, env)).toBe(arm) // deterministic
    counts[arm]++
  }
  // Every arm must actually accumulate; a starved arm would kill the trial.
  expect(counts.v0).toBeGreaterThan(120)
  expect(counts.v1).toBeGreaterThan(120)
  expect(counts.v2).toBeGreaterThan(120)
})

test("only the exact value '1' opens the third arm", () => {
  for (const v of ["0", "true", "yes", ""]) {
    const ids = Array.from({ length: 200 }, (_, i) => `s-${i}`)
    expect(ids.some((id) => pickReinjectVariant(id, { KKAMAK_REINJECT_V2: v }) === "v2")).toBe(false)
  }
})

test("forced 'v2' wins even without the gate flag (KKAMAK_REINJECT always wins)", () => {
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v2" })).toBe("v2")
  expect(pickReinjectVariant("any", { KKAMAK_REINJECT: "v2", KKAMAK_REINJECT_V2: "1" })).toBe("v2")
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

// ── v2 wording (Loop F: biggest-gap headline first, then v1's body) ──────

test("v2 leads with the biggest-gap line, then v1's composed body in order", () => {
  const out = applyReinjectVariant(KERNEL, "v2", RAW_OUT)
  // Headline is the FIRST line and names the first failure-matching line.
  expect(out.startsWith("biggest gap: test_cancel FAILED — queued task never cancelled\n")).toBe(true)
  // Then the v1 body, in order: framing, raw output, ownership sentence.
  const iFraming = out.indexOf("not done: the repository's completion check failed:")
  const iRaw = out.indexOf(RAW_OUT)
  const iOwn = out.indexOf("Do not run it yourself")
  expect(iFraming).toBeGreaterThan(0)
  expect(iRaw).toBeGreaterThan(iFraming)
  expect(iOwn).toBeGreaterThan(iRaw)
  // Never the kernel's bench-context closing.
  expect(out).not.toContain("re-run it")
})

test("v2 gap extraction: first /error|fail|✗|assert/i line wins, trimmed", () => {
  const raw = "collecting…\n  ✗ assert queue drained\nother noise"
  const out = applyReinjectVariant(KERNEL, "v2", raw)
  expect(out.split("\n")[0]).toBe("biggest gap: ✗ assert queue drained")
})

test("v2 gap extraction: no failure-shaped line -> last non-empty line", () => {
  const raw = "step one ok\nstep two ok\n2/5 checks pass\n\n"
  const out = applyReinjectVariant(KERNEL, "v2", raw)
  expect(out.split("\n")[0]).toBe("biggest gap: 2/5 checks pass")
})

test("v2 gap line is capped at 200 chars", () => {
  const raw = "ERROR " + "y".repeat(500)
  const out = applyReinjectVariant(KERNEL, "v2", raw)
  const head = out.split("\n")[0]!
  expect(head.startsWith("biggest gap: ERROR ")).toBe(true)
  expect(head.length).toBe("biggest gap: ".length + 200)
})

test("v2 tails long rawOut to OUT_TAIL like v1: last 600 chars, suffix-exact", () => {
  const long = "X".repeat(1000) + "TAIL_END_MARKER"
  const out = applyReinjectVariant(KERNEL, "v2", long)
  expect(out).toContain(long.slice(-600))
  expect(out).not.toContain("X".repeat(601)) // nothing beyond the tail leaks in
})

test("v2 without rawOut fails open exactly like v1: kernel evidence untransformed", () => {
  expect(applyReinjectVariant(KERNEL, "v2")).toBe(KERNEL)
  expect(applyReinjectVariant(KERNEL, "v2", undefined)).toBe(KERNEL)
  expect(applyReinjectVariant(KERNEL, "v2", "")).toBe(KERNEL)
})

test("v2 is deterministic: same rawOut, same message", () => {
  expect(applyReinjectVariant(KERNEL, "v2", RAW_OUT)).toBe(applyReinjectVariant(KERNEL, "v2", RAW_OUT))
})
