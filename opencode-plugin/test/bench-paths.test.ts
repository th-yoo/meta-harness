import { test, expect } from "bun:test"
import { requiredApiKeyVar, useKeyOnlyForParallel } from "../src/bench/paths.ts"
import { BenchError } from "../src/bench/util.ts"

test("requiredApiKeyVar derives provider key", () => {
  expect(requiredApiKeyVar("anthropic/claude-haiku-4-5")).toBe("ANTHROPIC_API_KEY")
  expect(requiredApiKeyVar("openrouter/gemini-2.5-flash")).toBe("OPENROUTER_API_KEY")
  expect(() => requiredApiKeyVar("no-slash-model")).toThrow(/provider/i)
})

test("useKeyOnlyForParallel: keyOnly ONLY when parallel AND an API key is present (oauth+parallel → oauth mount)", () => {
  const M = "anthropic/claude-haiku-4-5"
  // parallel + key → keyOnly (no shared rw credential mount)
  expect(useKeyOnlyForParallel(true, M, { ANTHROPIC_API_KEY: "sk-x" })).toBe(true)
  // parallel + NO key → false → default oauth mount (the freshness-gated path)
  expect(useKeyOnlyForParallel(true, M, {})).toBe(false)
  // serial → false regardless of key (unchanged: default oauth); short-circuits
  // so it never derives/throws on the model provider
  expect(useKeyOnlyForParallel(false, M, { ANTHROPIC_API_KEY: "sk-x" })).toBe(false)
  expect(useKeyOnlyForParallel(false, "no-slash-model", {})).toBe(false)
})

test("requiredApiKeyVar: throws BenchError (not a generic Error) on an underivable provider", () => {
  expect(() => requiredApiKeyVar("no-slash-model")).toThrow(BenchError)
})

test("requiredApiKeyVar: hyphenated provider prefixes become underscored env var names", () => {
  expect(requiredApiKeyVar("some-provider/some-model")).toBe("SOME_PROVIDER_API_KEY")
})
