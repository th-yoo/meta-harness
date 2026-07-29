import { test, expect } from "bun:test"
import { buildRefinerPrompt, parseRefinerOutput } from "../src/gauge/refiner.ts"

// --- buildRefinerPrompt ---

test("buildRefinerPrompt embeds the raw user prompt and demands JSON-only output", () => {
  const p = buildRefinerPrompt("fix the token expiry check in auth.ts", "bun test")
  expect(p).toContain("fix the token expiry check in auth.ts")
  expect(p.toLowerCase()).toContain("json")
  expect(p).toContain("exit 0")
})

test("buildRefinerPrompt embeds the floorCheck 2nd arg verbatim", () => {
  const p = buildRefinerPrompt("do something", "cd cc-gate-plugin && bun test")
  expect(p).toContain("cd cc-gate-plugin && bun test")
})

test('buildRefinerPrompt renders "(none armed)" when floorCheck is ""', () => {
  const p = buildRefinerPrompt("do something", "")
  expect(p).toContain("(none armed)")
  expect(p).not.toContain("cd cc-gate-plugin")
})

test("buildRefinerPrompt lists all five class literals", () => {
  const p = buildRefinerPrompt("do something", "")
  expect(p).toContain('"A1"|"A2"|"B"|"C"|"D"')
})

// --- parseRefinerOutput ---

const VALID = JSON.stringify({
  goalSummary: "token expiry uses <= not <",
  class: "C",
  reason: null,
  criteria: ["expiry comparison is exclusive", "existing auth tests pass"],
  check: "bun test test/auth.test.ts",
  horizon: "single-turn",
  confidence: 0.8,
})

test("valid JSON parses to a gauge derivation", () => {
  const g = parseRefinerOutput(VALID)!
  expect(g.goalSummary).toBe("token expiry uses <= not <")
  expect(g.class).toBe("C")
  expect(g.reason).toBeNull()
  expect(g.criteria).toEqual(["expiry comparison is exclusive", "existing auth tests pass"])
  expect(g.check).toBe("bun test test/auth.test.ts")
  expect(g.horizon).toBe("single-turn")
  expect(g.confidence).toBe(0.8)
})

test("markdown-fenced JSON is unwrapped", () => {
  const fenced = "```json\n" + VALID + "\n```"
  expect(parseRefinerOutput(fenced)!.check).toBe("bun test test/auth.test.ts")
})

test("null / empty / whitespace check normalizes to null", () => {
  const mk = (check: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check, confidence: 0.5 })
  expect(parseRefinerOutput(mk(null))!.check).toBeNull()
  expect(parseRefinerOutput(mk(""))!.check).toBeNull()
  expect(parseRefinerOutput(mk("   "))!.check).toBeNull()
  expect(parseRefinerOutput(mk(42))!.check).toBeNull()
})

test("confidence clamps to [0,1] and defaults to 0.5 when missing/invalid", () => {
  const mk = (confidence: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "A1", criteria: ["c"], check: null, confidence })
  expect(parseRefinerOutput(mk(1.7))!.confidence).toBe(1)
  expect(parseRefinerOutput(mk(-2))!.confidence).toBe(0)
  expect(parseRefinerOutput(mk("high"))!.confidence).toBe(0.5)
  expect(parseRefinerOutput(mk(undefined))!.confidence).toBe(0.5)
})

test("garbage / non-object / missing fields → undefined", () => {
  expect(parseRefinerOutput("not json at all")).toBeUndefined()
  expect(parseRefinerOutput("[]")).toBeUndefined()
  expect(parseRefinerOutput(`{"class": "C", "criteria": ["c"], "check": null}`)).toBeUndefined() // no goalSummary
  expect(parseRefinerOutput(`{"goalSummary": "g", "class": "C", "check": null}`)).toBeUndefined() // no criteria
  expect(
    parseRefinerOutput(`{"goalSummary": "g", "class": "C", "criteria": [], "check": null}`),
  ).toBeUndefined() // empty criteria
  expect(
    parseRefinerOutput(`{"goalSummary": "g", "class": "C", "criteria": [1, 2], "check": null}`),
  ).toBeUndefined() // non-string criteria
})

test("prose around a JSON object is tolerated (first { to last })", () => {
  const chatty = "Here is the gauge:\n" + VALID + "\nHope this helps!"
  expect(parseRefinerOutput(chatty)!.goalSummary).toBe("token expiry uses <= not <")
})

// --- v2: class (new: missing/invalid → undefined; M0 miss) ---

test("missing class → undefined (M0 miss)", () => {
  const noClass = JSON.stringify({ goalSummary: "g", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(noClass)).toBeUndefined()
})

test("invalid/unknown class literal → undefined (M0 miss)", () => {
  const badClass = JSON.stringify({
    goalSummary: "g",
    class: "E",
    criteria: ["c"],
    check: null,
    confidence: 0.5,
  })
  expect(parseRefinerOutput(badClass)).toBeUndefined()

  const numericClass = JSON.stringify({
    goalSummary: "g",
    class: 1,
    criteria: ["c"],
    check: null,
    confidence: 0.5,
  })
  expect(parseRefinerOutput(numericClass)).toBeUndefined()
})

test("each of the five class literals parses", () => {
  const classes = ["A1", "A2", "B", "C", "D"] as const
  for (const cls of classes) {
    const j = JSON.stringify({ goalSummary: "g", class: cls, criteria: ["c"], check: null, confidence: 0.5 })
    expect(parseRefinerOutput(j)!.class).toBe(cls)
  }
})

// --- v2: horizon normalization ---

test("horizon: valid literals pass through", () => {
  const mk = (horizon: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, horizon, confidence: 0.5 })
  expect(parseRefinerOutput(mk("single-turn"))!.horizon).toBe("single-turn")
  expect(parseRefinerOutput(mk("multi-turn"))!.horizon).toBe("multi-turn")
})

test("horizon: invalid literal ('weekly') normalizes to null", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "C",
    criteria: ["c"],
    check: null,
    horizon: "weekly",
    confidence: 0.5,
  })
  expect(parseRefinerOutput(j)!.horizon).toBeNull()
})

test("horizon: missing/null normalizes to null", () => {
  const j = JSON.stringify({ goalSummary: "g", class: "A1", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(j)!.horizon).toBeNull()
})

// --- v2: reason trim/null ---

test("reason: non-empty string trims whitespace", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "A1",
    criteria: ["c"],
    check: null,
    reason: "  no-eval-needed  ",
    confidence: 0.5,
  })
  expect(parseRefinerOutput(j)!.reason).toBe("no-eval-needed")
})

test("reason: missing / null / empty / non-string → null", () => {
  const mk = (reason: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, reason, confidence: 0.5 })
  expect(parseRefinerOutput(mk(null))!.reason).toBeNull()
  expect(parseRefinerOutput(mk(""))!.reason).toBeNull()
  expect(parseRefinerOutput(mk("   "))!.reason).toBeNull()
  expect(parseRefinerOutput(mk(7))!.reason).toBeNull()
  const noReason = JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(noReason)!.reason).toBeNull()
})

// --- v2: shape-only — does NOT enforce check-iff-C (that's validate's job) ---

test("non-C class with a check present: parse keeps the raw check untouched", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "A2",
    criteria: ["c"],
    check: "bun test",
    confidence: 0.5,
  })
  const g = parseRefinerOutput(j)!
  expect(g.class).toBe("A2")
  expect(g.check).toBe("bun test")
})
