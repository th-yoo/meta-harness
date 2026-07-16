import { test, expect } from "bun:test"
import { validateParallel, buildOauthParallelCanLaunch } from "../src/bench/cli.ts"

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

// ── Task 2 part C: oauth+parallel now REQUIRES an explicit --max-agent-timeout
// ─────────────────────────────────────────────────────────────────────────
// The freshness math (both here and the scheduler launch-guard it feeds,
// Task 2 part A/B) is only exact if every task is capped at a known
// duration. An unset/0 --max-agent-timeout means "no cap" (each task runs
// its own declared task.toml timeout, up to ~1800s) — which could exceed the
// 900s floor the calc assumed and cross expiry mid-run. So the fresh-ALLOW
// branch now demands an explicit non-zero cap; key-auth/serial are
// unaffected (checked below too).

test("validateParallel: no key + FRESH oauth token but NO --max-agent-timeout — throws naming the requirement (Task 2 part C)", () => {
  withoutKey(() => {
    const fresh = Date.now() + 10 * 60 * 60 * 1000
    expect(() => validateParallel({ parallel: true, enforceResources: true }, MODEL, () => fresh)).toThrow(
      /--max-agent-timeout/,
    )
  })
})

test("validateParallel: no key + FRESH oauth token + explicit maxAgentTimeout: 0 — still throws (0 counts as unset)", () => {
  withoutKey(() => {
    const fresh = Date.now() + 10 * 60 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, maxAgentTimeout: 0 }, MODEL, () => fresh),
    ).toThrow(/--max-agent-timeout/)
  })
})

test("validateParallel: no key + FRESH oauth token WITH explicit --max-agent-timeout — allows (Task 2 part C)", () => {
  withoutKey(() => {
    const fresh = Date.now() + 10 * 60 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, maxAgentTimeout: 600 }, MODEL, () => fresh),
    ).not.toThrow()
  })
})

test("validateParallel: key present + no --max-agent-timeout — unaffected by the Task 2 part C requirement", () => {
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

test("validateParallel: serial (no --parallel) + no --max-agent-timeout — unaffected by the Task 2 part C requirement", () => {
  withoutKey(() => {
    expect(() => validateParallel({ parallel: false }, MODEL, () => null)).not.toThrow()
  })
})

// ── buildOauthParallelCanLaunch (Task 2 part B: the scheduler launch-guard's
// predicate construction) ───────────────────────────────────────────────────
// Pure unit tests of the predicate-BUILDING logic cli.ts's main() wires into
// CmdRunArgs/CmdAbArgs's `canLaunch` field (threaded straight into
// scheduler.ts's `schedule()`), hermetic via the same injectable `readExpiry`
// seam validateParallel itself uses.

test("buildOauthParallelCanLaunch: serial (no --parallel) — returns undefined, never calls readExpiry", () => {
  withoutKey(() => {
    let called = false
    const canLaunch = buildOauthParallelCanLaunch({ parallel: false }, MODEL, () => {
      called = true
      return Date.now() + 1000
    })
    expect(canLaunch).toBeUndefined()
    expect(called).toBe(false)
  })
})

test("buildOauthParallelCanLaunch: key present — returns undefined regardless of oauth freshness", () => {
  const prev = process.env["ANTHROPIC_API_KEY"]
  process.env["ANTHROPIC_API_KEY"] = "sk-test-parallel"
  try {
    const canLaunch = buildOauthParallelCanLaunch({ parallel: true, maxAgentTimeout: 600 }, MODEL, () => 1)
    expect(canLaunch).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"]
    else process.env["ANTHROPIC_API_KEY"] = prev
  }
})

test("buildOauthParallelCanLaunch: no key + no oauth credential (readExpiry -> null) — returns undefined", () => {
  withoutKey(() => {
    const canLaunch = buildOauthParallelCanLaunch({ parallel: true, maxAgentTimeout: 600 }, MODEL, () => null)
    expect(canLaunch).toBeUndefined()
  })
})

test("buildOauthParallelCanLaunch: oauth+parallel — returns a function whose value tracks the token's remaining TTL vs maxAgentTimeout+margin", () => {
  withoutKey(() => {
    // maxAgentTimeout=600s -> needed = 600s + 300s margin = 900s = 15min.
    const expiresAt = Date.now() + 20 * 60 * 1000 // 20min out — outlives needed (15min) for now
    const canLaunch = buildOauthParallelCanLaunch({ parallel: true, maxAgentTimeout: 600 }, MODEL, () => expiresAt)
    expect(canLaunch).toBeInstanceOf(Function)
    expect(canLaunch!()).toBe(true)

    // A token that can no longer outlive one more task + margin must gate closed.
    const almostExpired = Date.now() + 10 * 60 * 1000 // 10min out — less than the 15min needed
    const closingCanLaunch = buildOauthParallelCanLaunch(
      { parallel: true, maxAgentTimeout: 600 },
      MODEL,
      () => almostExpired,
    )
    expect(closingCanLaunch!()).toBe(false)
  })
})

test("buildOauthParallelCanLaunch: maxAgentTimeout unset — falls back to the same 900s default validateParallel's neededMs calc uses", () => {
  withoutKey(() => {
    // fallback needed = 900s + 300s margin = 1200s = 20min.
    const justUnder = Date.now() + 19 * 60 * 1000 // 19min out — under the 20min fallback need
    const canLaunch = buildOauthParallelCanLaunch({ parallel: true }, MODEL, () => justUnder)
    expect(canLaunch!()).toBe(false)

    const justOver = Date.now() + 21 * 60 * 1000 // 21min out — over the 20min fallback need
    const canLaunch2 = buildOauthParallelCanLaunch({ parallel: true }, MODEL, () => justOver)
    expect(canLaunch2!()).toBe(true)
  })
})
