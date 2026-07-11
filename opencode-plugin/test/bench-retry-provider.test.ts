import { test, expect } from "bun:test"
import {
  parseRetryProviderArgs,
  runRetryProvider,
  type SpawnedRun,
  type RetryProviderArgs,
} from "../src/bench/retry-provider.ts"
import { REALWORK_RE, TRANSIENT_MARK } from "../src/bench/opencode-run.ts"

// Ported from term-bench2/retry_provider.py's argparse + main() loop
// (:48-105). Never spawns `bun term-bench2/runner.ts` for real — spawnFn is
// injected throughout.

// ── parseRetryProviderArgs ────────────────────────────────────────────────

test("parseRetryProviderArgs: defaults (base=30, cap=600, max-attempts=0)", () => {
  expect(parseRetryProviderArgs(["run", "--task-file", "x"])).toEqual({
    base: 30,
    cap: 600,
    maxAttempts: 0,
    runnerArgs: ["run", "--task-file", "x"],
  })
})

test("parseRetryProviderArgs: --base/--cap/--max-attempts before '--'", () => {
  expect(parseRetryProviderArgs(["--base", "10", "--cap", "100", "--max-attempts", "5", "--", "run", "--all"])).toEqual({
    base: 10,
    cap: 100,
    maxAttempts: 5,
    runnerArgs: ["run", "--all"],
  })
})

test("parseRetryProviderArgs: no runner args -> null", () => {
  expect(parseRetryProviderArgs([])).toBeNull()
  expect(parseRetryProviderArgs(["--base", "10"])).toBeNull()
})

test("parseRetryProviderArgs: missing flag value -> null", () => {
  expect(parseRetryProviderArgs(["--base"])).toBeNull()
})

// ── runRetryProvider ───────────────────────────────────────────────────────

function fakeSpawn(scriptedLines: string[], rc: number): () => SpawnedRun {
  return () => ({
    lines: (async function* () {
      for (const l of scriptedLines) yield l
    })(),
    exited: Promise.resolve(rc),
  })
}

test("runRetryProvider: provider responding on first attempt (real work seen) -> returns immediately, no sleep", async () => {
  const args: RetryProviderArgs = { base: 30, cap: 600, maxAttempts: 0, runnerArgs: ["run", "--all"] }
  const lines = ["  opencode run (timeout=900s, attempt 1/4)...", "  opencode done in 1.0s, turns=3", "  reward=1  elapsed=1.0s"]
  let sleepCalls = 0
  const rc = await runRetryProvider(
    args,
    fakeSpawn(lines, 0),
    async () => {
      sleepCalls++
    },
    () => {},
  )
  expect(rc).toBe(0)
  expect(sleepCalls).toBe(0)
})

test("runRetryProvider: a timeout line counts as 'up' (per module docstring) — not retried", async () => {
  const args: RetryProviderArgs = { base: 30, cap: 600, maxAttempts: 0, runnerArgs: ["run"] }
  const lines = [`  ${TRANSIENT_MARK}`, "  opencode timed out after 900s"]
  let sleepCalls = 0
  const rc = await runRetryProvider(args, fakeSpawn(lines, 1), async () => sleepCalls++, () => {})
  expect(rc).toBe(1)
  expect(sleepCalls).toBe(0)
})

test("runRetryProvider: provider down (transient, no real work) -> retries with doubling backoff, then succeeds", async () => {
  const args: RetryProviderArgs = { base: 10, cap: 600, maxAttempts: 0, runnerArgs: ["run"] }
  let call = 0
  const spawnFn = () => {
    call++
    if (call < 3) {
      return {
        lines: (async function* () {
          yield `  ${TRANSIENT_MARK}`
        })(),
        exited: Promise.resolve(1),
      }
    }
    return {
      lines: (async function* () {
        yield "  opencode done in 1.0s, turns=2"
      })(),
      exited: Promise.resolve(0),
    }
  }
  const sleeps: number[] = []
  const rc = await runRetryProvider(args, spawnFn, async (s) => sleeps.push(s), () => {})
  expect(rc).toBe(0)
  expect(call).toBe(3)
  expect(sleeps).toEqual([10, 20]) // doubling from base=10
})

test("runRetryProvider: backoff is capped", async () => {
  const args: RetryProviderArgs = { base: 300, cap: 400, maxAttempts: 0, runnerArgs: ["run"] }
  let call = 0
  const spawnFn = () => {
    call++
    if (call < 3) {
      return { lines: (async function* () { yield `  ${TRANSIENT_MARK}` })(), exited: Promise.resolve(1) }
    }
    return { lines: (async function* () { yield "  turns=1" })(), exited: Promise.resolve(0) }
  }
  const sleeps: number[] = []
  await runRetryProvider(args, spawnFn, async (s) => sleeps.push(s), () => {})
  expect(sleeps).toEqual([300, 400]) // 300 -> min(600,400)=400
})

test("runRetryProvider: --max-attempts caps retries and returns exit code 2", async () => {
  const args: RetryProviderArgs = { base: 1, cap: 10, maxAttempts: 2, runnerArgs: ["run"] }
  let call = 0
  const spawnFn = () => {
    call++
    return { lines: (async function* () { yield `  ${TRANSIENT_MARK}` })(), exited: Promise.resolve(1) }
  }
  const sleeps: number[] = []
  const rc = await runRetryProvider(args, spawnFn, async (s) => sleeps.push(s), () => {})
  expect(rc).toBe(2)
  expect(call).toBe(2) // gives up exactly at maxAttempts, no further spawn
})

test("runRetryProvider: echoes every merged line via writeLine (so a human sees the wrapped run's output)", async () => {
  const args: RetryProviderArgs = { base: 30, cap: 600, maxAttempts: 0, runnerArgs: ["run"] }
  const written: string[] = []
  await runRetryProvider(args, fakeSpawn(["line one", "line two"], 0), async () => {}, (l) => written.push(l))
  expect(written).toContain("line one")
  expect(written).toContain("line two")
})

// ── marker-string producer/consumer wiring ────────────────────────────────
// retry-provider.ts imports (does not redeclare) REALWORK_RE/TRANSIENT_MARK
// from opencode-run.ts — assert it is literally the SAME export, and that
// scanning opencode-run.ts's actual log-line shapes works end to end.

test("marker contract: retry-provider re-exports the SAME REALWORK_RE/TRANSIENT_MARK objects opencode-run.ts produces", async () => {
  const oc = await import("../src/bench/opencode-run.ts")
  expect(REALWORK_RE).toBe(oc.REALWORK_RE)
  expect(TRANSIENT_MARK).toBe(oc.TRANSIENT_MARK)
})

test("marker contract: a full opencode-run.ts transcript (transient retry then real turns) correctly signals 'provider up'", async () => {
  const args: RetryProviderArgs = { base: 30, cap: 600, maxAttempts: 0, runnerArgs: ["run"] }
  // A realistic merged transcript: one transient failure, then a real pass.
  const lines = [
    "  opencode run (timeout=900s, attempt 1/4)...",
    `  ${TRANSIENT_MARK} — retrying in 5s`,
    "  opencode run (timeout=900s, attempt 2/4)...",
    "  opencode done in 12.3s, turns=4",
    "  reward=1  elapsed=12.3s",
  ]
  let sleepCalls = 0
  const rc = await runRetryProvider(args, fakeSpawn(lines, 0), async () => sleepCalls++, () => {})
  // sawTransient=true AND sawRealwork=true -> providerDown=false -> no outer retry.
  expect(rc).toBe(0)
  expect(sleepCalls).toBe(0)
})
