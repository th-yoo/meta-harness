import { test, expect } from "bun:test"
import { validateParallel } from "../src/bench/cli.ts"

// Direct unit tests of validateParallel's oauth-parallel freshness gate
// (Task 1 of the oauth-parallel design). These inject `readExpiry` (the
// function's optional 3rd param) so they never touch the real ~/.claude or
// Keychain — hermetic by construction, unlike a `main()` integration test
// which would fall through to the real default reader.
//
// Safety model (see agent-auth.ts's header + this task's brief): a
// concurrent-container refresh-token race only fires if a container's oauth
// token actually refreshes during the --parallel window (~8h access-token
// expiry). If the token can't even outlive one task's max timeout + the
// ~5min refresh buffer (OAUTH_PARALLEL_MARGIN_MS), refuse to start.

const MODEL = "anthropic/claude-sonnet-4-6" // -> requiredApiKeyVar === ANTHROPIC_API_KEY

function withoutKey<T>(fn: () => T): T {
  const prev = process.env["ANTHROPIC_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
  }
}

test("validateParallel: no key + fresh oauth token (10h out) — allows, no throw", () => {
  withoutKey(() => {
    const fresh = Date.now() + 10 * 60 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, maxAgentTimeout: 600 }, MODEL, () => fresh),
    ).not.toThrow()
  })
})

test("validateParallel: no key + stale oauth token (2min out, maxAgentTimeout 600s) — throws naming re-login", () => {
  withoutKey(() => {
    const stale = Date.now() + 2 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, maxAgentTimeout: 600 }, MODEL, () => stale),
    ).toThrow(/re-login/i)
  })
})

test("validateParallel: no key + stale oauth token — message names remaining and needed minutes", () => {
  withoutKey(() => {
    const stale = Date.now() + 2 * 60 * 1000 // ~2min remaining
    try {
      validateParallel({ parallel: true, enforceResources: true, maxAgentTimeout: 600 }, MODEL, () => stale)
      throw new Error("should have thrown")
    } catch (e) {
      const msg = (e as Error).message
      // needed = (600s max-agent-timeout + 300s margin) = 900s = 15min
      expect(msg).toMatch(/2\s*min/i)
      expect(msg).toMatch(/15\s*min/i)
      expect(msg).toMatch(/claude|opencode auth login/i)
      expect(msg).toContain("ANTHROPIC_API_KEY")
    }
  })
})

test("validateParallel: no key + stale token, maxAgentTimeout unspecified — falls back to the 900s per-task default", () => {
  withoutKey(() => {
    // needed = (900s default + 300s margin) = 1200s = 20min; 19min left is stale.
    const stale = Date.now() + 19 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true }, MODEL, () => stale),
    ).toThrow(/20\s*min/i)
  })
})

test("validateParallel: no key + no oauth credential (readExpiry -> null) — throws the existing key-required error", () => {
  withoutKey(() => {
    expect(() => validateParallel({ parallel: true, enforceResources: true }, MODEL, () => null)).toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })
})

test("validateParallel: key present — allows regardless of oauth freshness", () => {
  const prev = process.env["ANTHROPIC_API_KEY"]
  process.env["ANTHROPIC_API_KEY"] = "sk-test-parallel"
  try {
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true }, MODEL, () => Date.now() + 1000),
    ).not.toThrow()
  } finally {
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
  }
})

test("validateParallel: serial (no --parallel) — unchanged, never calls readExpiry", () => {
  withoutKey(() => {
    let called = false
    expect(() =>
      validateParallel({ parallel: false }, MODEL, () => {
        called = true
        return null
      }),
    ).not.toThrow()
    expect(called).toBe(false)
  })
})
