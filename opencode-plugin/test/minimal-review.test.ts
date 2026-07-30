import { test, expect } from "bun:test"
import {
  layer1Checks,
  computeVerdict,
  reviewBullet,
  reviewLoop,
  type ReviewChecks,
  type ReviewResult,
} from "../../minimal/review.ts"

const GOOD_BULLET =
  "When a check you ran contradicts the specification, do not declare the task done until you have re-read the requirement and verified the artifact against it with external evidence."

function allPassChecks(over: Partial<ReviewChecks> = {}): ReviewChecks {
  return {
    category: { pass: true, category: "verification-design", quote: "verified the artifact against it" },
    domain_swap: { pass: true, swapped_bullet: GOOD_BULLET },
    behavior_level: { pass: true, restatement: "the agent re-reads the requirement before claiming done" },
    duplicate: { pass: true, match: "none" },
    ...over,
  }
}

// --- layer 1: deterministic checks ---

test("layer1 passes a clean When-form bullet", () => {
  const r = layer1Checks(GOOD_BULLET, "sparql-university")
  expect(r.pass).toBe(true)
  expect(r.violations).toEqual([])
})

test("layer1 passes the hard-gate form", () => {
  const r = layer1Checks("Do not declare a task complete until every stated requirement has been verified.", "sparql-university")
  expect(r.pass).toBe(true)
})

test("layer1 fails a bullet over 60 words", () => {
  const long = "When " + Array(70).fill("word").join(" ")
  const r = layer1Checks(long, "sparql-university")
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("60")
})

test("layer1 fails a bullet in neither trigger nor hard-gate form", () => {
  const r = layer1Checks("Always verify requirements carefully before finishing.", "sparql-university")
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("form")
})

test("layer1 fails on task-id fragment leakage", () => {
  const r = layer1Checks(
    "When cancelling in-flight async operations, do not issue a second cancellation until cleanup finishes.",
    "cancel-async-tasks",
  )
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("leak")
})

test("layer1 fails on path-like or file-extension tokens", () => {
  const r = layer1Checks("When editing run.py, do not skip the tests until they pass.", "sparql-university")
  expect(r.pass).toBe(false)
})

test("layer1 allows plain prose word/word slashes (not path-like)", () => {
  // 2026-07-30 live false-positive: "filters/qualifies" tripped the slash rule
  const r = layer1Checks(
    "When one value both filters/qualifies rows and populates an output field, derive the output binding independently of the filter.",
  )
  expect(r.violations.join(" ")).not.toContain("path-like")
})

test("layer1 allows and/or in prose", () => {
  const r = layer1Checks("When a step can fail and/or block, do not retry until the cause is known.")
  expect(r.violations.join(" ")).not.toContain("path-like")
})

test("layer1 still fails on anchored paths", () => {
  const r = layer1Checks("When editing ./config, do not skip the tests until they pass.")
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("path-like")
})

test("layer1 still fails on multi-segment paths", () => {
  const r = layer1Checks("When touching scripts/build/run, do not skip the tests until they pass.")
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("path-like")
})

test("layer1 still fails on non-word slash sides", () => {
  const r = layer1Checks("When touching src_lib/main2, do not skip the tests until they pass.")
  expect(r.pass).toBe(false)
  expect(r.violations.join(" ")).toContain("path-like")
})

test("layer1 fails on backtick-quoted literals", () => {
  const r = layer1Checks("When you see `verify.sh` fail, do not proceed until it passes.", "sparql-university")
  expect(r.pass).toBe(false)
})

// --- verdict conjunction (computed in code, never trusted from the model) ---

test("verdict passes only when layer1 and every rubric check pass", () => {
  const l1 = { pass: true, violations: [] }
  const v = computeVerdict(l1, allPassChecks())
  expect(v.verdict).toBe("pass")
  expect(v.violations).toEqual([])
})

test("verdict fails when any single rubric check fails, naming the check", () => {
  const l1 = { pass: true, violations: [] }
  const v = computeVerdict(l1, allPassChecks({ domain_swap: { pass: false, swapped_bullet: "" } }))
  expect(v.verdict).toBe("fail")
  expect(v.violations.join(" ")).toContain("domain_swap")
})

test("verdict fails on layer1 alone with rubric absent", () => {
  const v = computeVerdict({ pass: false, violations: ["over 60 words"] }, null)
  expect(v.verdict).toBe("fail")
  expect(v.violations).toContain("over 60 words")
})

// --- reviewBullet: layer1 short-circuit + rubric via injected call ---

test("reviewBullet skips the LLM call when layer1 fails", async () => {
  let called = false
  const r = await reviewBullet({
    bullet: "Always be careful.",
    reason: "x",
    harness: "(none)",
    rejected: "(none)",
    taskId: "sparql-university",
    call: () => {
      called = true
      return JSON.stringify({ checks: allPassChecks(), confidence: 0.9 })
    },
  })
  expect(r.verdict).toBe("fail")
  expect(called).toBe(false)
})

test("reviewBullet parses a pretty-printed rubric reply and passes", async () => {
  const reply =
    "analysis...\n" +
    JSON.stringify({ checks: allPassChecks(), confidence: 0.85 }, null, 2) +
    "\ntrailing"
  const r = await reviewBullet({
    bullet: GOOD_BULLET,
    reason: "x",
    harness: "(none)",
    rejected: "(none)",
    taskId: "sparql-university",
    call: () => reply,
  })
  expect(r.verdict).toBe("pass")
  expect(r.confidence).toBe(0.85)
})

// --- reviewLoop control ---

function proposal(bulletText: string, reason = "diagnosis-x") {
  return {
    action: "propose",
    reason,
    bullet: { text: bulletText, evidence: ["r.json#a2"] },
    predictions: { falsify_if: "no lift" },
  }
}

function passResult(): ReviewResult {
  return { verdict: "pass", violations: [], layer1: { pass: true, violations: [] }, checks: allPassChecks(), confidence: 0.9 }
}
function failResult(msg = "domain_swap: unwritable"): ReviewResult {
  return { verdict: "fail", violations: [msg], layer1: { pass: true, violations: [] }, checks: null, confidence: null }
}

test("loop stages the original bullet when the first review passes", async () => {
  const out = await reviewLoop({
    proposal: proposal(GOOD_BULLET),
    rounds: 1,
    review: async () => passResult(),
    revise: async () => {
      throw new Error("revise must not be called")
    },
  })
  expect(out.staged).toBe(true)
  expect(out.final.bullet!.text).toBe(GOOD_BULLET)
  expect(out.trail.length).toBe(1)
})

test("loop stages the revised bullet on fail-then-pass, preserving the diagnosis", async () => {
  const revised = proposal(GOOD_BULLET + " Revised.", "diagnosis-x")
  let round = 0
  const out = await reviewLoop({
    proposal: proposal("bad bullet"),
    rounds: 1,
    review: async () => (round++ === 0 ? failResult() : passResult()),
    revise: async () => revised,
  })
  expect(out.staged).toBe(true)
  expect(out.final.bullet!.text).toBe(GOOD_BULLET + " Revised.")
  expect(out.final.reason).toBe("diagnosis-x")
  expect(out.trail.length).toBe(2)
})

test("loop coerces abstain when the revision also fails review", async () => {
  const out = await reviewLoop({
    proposal: proposal("bad bullet"),
    rounds: 1,
    review: async () => failResult(),
    revise: async () => proposal("still bad"),
  })
  expect(out.staged).toBe(false)
  expect(out.final.action).toBe("abstain")
  expect(out.final.reason).toContain("review-fail")
  expect(out.trail.length).toBe(2)
})

test("loop honors an abstain returned by the revision call", async () => {
  let reviews = 0
  const out = await reviewLoop({
    proposal: proposal("bad bullet"),
    rounds: 1,
    review: async () => {
      reviews++
      return failResult()
    },
    revise: async () => ({ action: "abstain", reason: "domain-only fixable" }),
  })
  expect(out.staged).toBe(false)
  expect(out.final.action).toBe("abstain")
  expect(out.final.reason).toBe("domain-only fixable")
  expect(reviews).toBe(1)
})
