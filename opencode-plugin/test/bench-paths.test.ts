import { test, expect } from "bun:test"
import { requiredApiKeyVar } from "../src/bench/paths.ts"
import { BenchError } from "../src/bench/util.ts"

test("requiredApiKeyVar derives provider key", () => {
  expect(requiredApiKeyVar("anthropic/claude-haiku-4-5")).toBe("ANTHROPIC_API_KEY")
  expect(requiredApiKeyVar("openrouter/gemini-2.5-flash")).toBe("OPENROUTER_API_KEY")
  expect(() => requiredApiKeyVar("no-slash-model")).toThrow(/provider/i)
})

test("requiredApiKeyVar: throws BenchError (not a generic Error) on an underivable provider", () => {
  expect(() => requiredApiKeyVar("no-slash-model")).toThrow(BenchError)
})

test("requiredApiKeyVar: hyphenated provider prefixes become underscored env var names", () => {
  expect(requiredApiKeyVar("some-provider/some-model")).toBe("SOME_PROVIDER_API_KEY")
})
