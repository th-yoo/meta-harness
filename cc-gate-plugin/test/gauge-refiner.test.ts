import { test, expect } from "bun:test"
import { buildRefinerPrompt, parseRefinerOutput } from "../src/gauge/refiner.ts"

// --- buildRefinerPrompt ---

test("buildRefinerPrompt embeds the raw user prompt and demands JSON-only output", () => {
  const p = buildRefinerPrompt("fix the token expiry check in auth.ts")
  expect(p).toContain("fix the token expiry check in auth.ts")
  expect(p.toLowerCase()).toContain("json")
  expect(p).toContain("exit 0")
})

// --- parseRefinerOutput ---

const VALID = JSON.stringify({
  goalSummary: "token expiry uses <= not <",
  criteria: ["expiry comparison is exclusive", "existing auth tests pass"],
  check: "bun test test/auth.test.ts",
  confidence: 0.8,
})

test("valid JSON parses to a gauge derivation", () => {
  const g = parseRefinerOutput(VALID)!
  expect(g.goalSummary).toBe("token expiry uses <= not <")
  expect(g.criteria).toEqual(["expiry comparison is exclusive", "existing auth tests pass"])
  expect(g.check).toBe("bun test test/auth.test.ts")
  expect(g.confidence).toBe(0.8)
})

test("markdown-fenced JSON is unwrapped", () => {
  const fenced = "```json\n" + VALID + "\n```"
  expect(parseRefinerOutput(fenced)!.check).toBe("bun test test/auth.test.ts")
})

test("null / empty / whitespace check normalizes to null", () => {
  const mk = (check: unknown) =>
    JSON.stringify({ goalSummary: "g", criteria: ["c"], check, confidence: 0.5 })
  expect(parseRefinerOutput(mk(null))!.check).toBeNull()
  expect(parseRefinerOutput(mk(""))!.check).toBeNull()
  expect(parseRefinerOutput(mk("   "))!.check).toBeNull()
  expect(parseRefinerOutput(mk(42))!.check).toBeNull()
})

test("confidence clamps to [0,1] and defaults to 0.5 when missing/invalid", () => {
  const mk = (confidence: unknown) =>
    JSON.stringify({ goalSummary: "g", criteria: ["c"], check: null, confidence })
  expect(parseRefinerOutput(mk(1.7))!.confidence).toBe(1)
  expect(parseRefinerOutput(mk(-2))!.confidence).toBe(0)
  expect(parseRefinerOutput(mk("high"))!.confidence).toBe(0.5)
  expect(parseRefinerOutput(mk(undefined))!.confidence).toBe(0.5)
})

test("garbage / non-object / missing fields → undefined", () => {
  expect(parseRefinerOutput("not json at all")).toBeUndefined()
  expect(parseRefinerOutput("[]")).toBeUndefined()
  expect(parseRefinerOutput(`{"criteria": ["c"], "check": null}`)).toBeUndefined() // no goalSummary
  expect(parseRefinerOutput(`{"goalSummary": "g", "check": null}`)).toBeUndefined() // no criteria
  expect(parseRefinerOutput(`{"goalSummary": "g", "criteria": [], "check": null}`)).toBeUndefined() // empty criteria
  expect(parseRefinerOutput(`{"goalSummary": "g", "criteria": [1, 2], "check": null}`)).toBeUndefined() // non-string criteria
})

test("prose around a JSON object is tolerated (first { to last })", () => {
  const chatty = "Here is the gauge:\n" + VALID + "\nHope this helps!"
  expect(parseRefinerOutput(chatty)!.goalSummary).toBe("token expiry uses <= not <")
})
