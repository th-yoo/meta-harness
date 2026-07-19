import { test, expect } from "bun:test"
import { validateParallel, buildOauthParallelCanLaunch, buildPressureGate } from "../src/bench/cli.ts"
import type { HostPressure, CreateHostPressureOpts } from "../src/bench/host-pressure.ts"

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

// ── --no-oauth-gate (operator escape hatch): the host rotates the oauth token
// automatically during active CC/opencode use (within ~5min of expiry, under a
// proper-lockfile on ~/.claude), so an operator who keeps a session active can
// assert freshness themselves. The flag makes oauth behave like key-auth for
// GATING only (no freshness reject, no part-C cap requirement, no launch
// guard); the no-credential-at-all reject stays — nothing could auth anyway. ──

test("validateParallel: no key + STALE token + noOauthGate — allows (freshness reject skipped)", () => {
  withoutKey(() => {
    const stale = Date.now() + 2 * 60 * 1000
    expect(() =>
      validateParallel(
        { parallel: true, enforceResources: true, maxAgentTimeout: 600, noOauthGate: true },
        MODEL,
        () => stale,
      ),
    ).not.toThrow()
  })
})

test("validateParallel: no key + fresh token + NO --max-agent-timeout + noOauthGate — allows (part C skipped)", () => {
  withoutKey(() => {
    const fresh = Date.now() + 10 * 60 * 60 * 1000
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, noOauthGate: true }, MODEL, () => fresh),
    ).not.toThrow()
  })
})

test("validateParallel: no key + NO oauth credential + noOauthGate — still throws (nothing could auth)", () => {
  withoutKey(() => {
    expect(() =>
      validateParallel({ parallel: true, enforceResources: true, noOauthGate: true }, MODEL, () => null),
    ).toThrow(/ANTHROPIC_API_KEY/)
  })
})

test("validateParallel: noOauthGate still requires --enforce-resources under --parallel", () => {
  withoutKey(() => {
    expect(() => validateParallel({ parallel: true, noOauthGate: true }, MODEL, () => null)).toThrow(
      /--enforce-resources/,
    )
  })
})

test("buildOauthParallelCanLaunch: noOauthGate — returns undefined (unbounded launches), never calls readExpiry", () => {
  withoutKey(() => {
    let called = false
    const canLaunch = buildOauthParallelCanLaunch(
      { parallel: true, maxAgentTimeout: 600, noOauthGate: true },
      MODEL,
      () => {
        called = true
        return Date.now() + 1000
      },
    )
    expect(canLaunch).toBeUndefined()
    expect(called).toBe(false)
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

// ── buildPressureGate (plan S3: the host-pressure launch-gate builder cli.ts's
// main() wires into CmdRunArgs/CmdAbArgs's internal-only `pressureGate` field,
// threaded straight into scheduler.ts's `schedule()` pauseGate param) ─────────
// Hermetic via an injected sensor factory (the same builder-test stance as
// buildOauthParallelCanLaunch's `readExpiry` seam) — these never create a real
// createHostPressure and so never sample the actual host.

/** A fake HostPressure whose `underPressure()` returns `val` and counts its
 * own calls — the injectable sensor for buildPressureGate's tests. */
function fakeSensor(val: boolean): HostPressure & { calls: number } {
  const s = {
    calls: 0,
    underPressure(): boolean {
      s.calls++
      return val
    },
    state(): string {
      return val ? "pressured" : "normal"
    },
  }
  return s
}

test("buildPressureGate: --host-pressure absent — returns undefined, never creates a sensor", () => {
  let created = 0
  const gate = buildPressureGate({}, () => {
    created++
    return fakeSensor(false)
  })
  expect(gate).toBeUndefined()
  expect(created).toBe(0)
})

test("buildPressureGate: `on` — returns a gate that calls the sensor and can return true", () => {
  const sensor = fakeSensor(true)
  let created = 0
  const gate = buildPressureGate({ hostPressure: "on" }, (_opts: CreateHostPressureOpts) => {
    created++
    return sensor
  })
  expect(created).toBe(1) // ONE sensor per command invocation
  expect(gate).toBeInstanceOf(Function)
  expect(gate!()).toBe(true) // pressured → gate pauses
  expect(sensor.calls).toBe(1)
  expect(gate!()).toBe(true)
  expect(sensor.calls).toBe(2)
})

test("buildPressureGate: `on` — a calm sensor gates false (launches proceed)", () => {
  const sensor = fakeSensor(false)
  const gate = buildPressureGate({ hostPressure: "on" }, () => sensor)
  expect(gate!()).toBe(false)
  expect(sensor.calls).toBe(1)
})

test("buildPressureGate: `observe` — samples the sensor (for logging) but the gate is ALWAYS false", () => {
  const sensor = fakeSensor(true) // host IS under pressure...
  const gate = buildPressureGate({ hostPressure: "observe" }, () => sensor)
  expect(gate).toBeInstanceOf(Function)
  expect(gate!()).toBe(false) // ...but observe never pauses
  expect(sensor.calls).toBe(1) // it still sampled (state-change logging happens inside underPressure)
  expect(gate!()).toBe(false)
  expect(sensor.calls).toBe(2)
})

test("buildPressureGate: ONE sensor is shared across every call of the returned gate (ab's two phases)", () => {
  let created = 0
  const sensor = fakeSensor(true)
  const gate = buildPressureGate({ hostPressure: "on" }, () => {
    created++
    return sensor
  })
  gate!()
  gate!()
  gate!()
  expect(created).toBe(1) // the sensor is built once, not per gate call
  expect(sensor.calls).toBe(3)
})
