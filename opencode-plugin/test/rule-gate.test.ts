/**
 * rule-gate.test.ts — TDD for src/bench/rule-gate.ts (a3-rule-routing-tb2
 * plan, Task 6). Written FIRST, failing (src/bench/rule-gate.ts did not
 * exist yet).
 *
 * Step 1's pin (task-6-brief.md) is the acceptance truth for the
 * round-cap contract: run1 -> exit 2 rounds=1, run2 -> exit 2 rounds=2,
 * run3 -> exit 0 exhausted rounds=3. `buildRuleGateScript`'s output is
 * REAL bash, spawned locally via `Bun.spawnSync(["bash", scriptPath])`
 * against a temp `RULE_GATE_DIR` — no fakes, no mocked exec.
 */
import { test, expect } from "bun:test"
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRuleGateScript,
  buildRuleGateSettings,
  readRuleGateStateArgs,
  RULE_GATE_DIR,
  RULE_GATE_ROUNDS_CAP,
  type RuleGateCheck,
} from "../src/bench/rule-gate.ts"

function writeScript(checks: RuleGateCheck[]): { scriptPath: string; rgDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rule-gate-test-"))
  const scriptPath = join(dir, "check.sh")
  writeFileSync(scriptPath, buildRuleGateScript(checks))
  return { scriptPath, rgDir: join(dir, "rg") }
}

function run(scriptPath: string, rgDir: string): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bash", scriptPath], {
    env: { ...process.env, RULE_GATE_DIR: rgDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function readState(rgDir: string): { rounds: number; exhausted: boolean; perRule: Record<string, { blocked: number; lastFail: string }> } {
  return JSON.parse(readFileSync(join(rgDir, "state.json"), "utf-8"))
}

// ── constants ────────────────────────────────────────────────────────────

test("RULE_GATE_DIR / RULE_GATE_ROUNDS_CAP are the pinned values", () => {
  expect(RULE_GATE_DIR).toBe("/app/.rule-gate")
  expect(RULE_GATE_ROUNDS_CAP).toBe(2)
})

// ── round-cap contract: THE pinned Step-1 sequence ──────────────────────

test("round cap: run1/run2 block, run3 exhausts — compare-THEN-increment", () => {
  // One failing + one passing check (brief's Step-1 fixture). The failing
  // check's cmd deliberately contains a single quote — the embedding must
  // survive it (implementer's choice: sh-single-quote escaping vs a JSON
  // sidecar; this is the edge case that would break a naive approach).
  const { scriptPath, rgDir } = writeScript([
    { bulletId: "b1", cmd: `echo "it's broken" 1>&2; exit 1`, timeoutMs: 5000 },
    { bulletId: "b2", cmd: "true", timeoutMs: 5000 },
  ])

  const run1 = run(scriptPath, rgDir)
  expect(run1.exitCode).toBe(2)
  expect(run1.stderr).toContain("it's broken")
  let state = readState(rgDir)
  expect(state.rounds).toBe(1)
  expect(state.exhausted).toBe(false)

  const run2 = run(scriptPath, rgDir)
  expect(run2.exitCode).toBe(2)
  expect(run2.stderr).toContain("it's broken")
  state = readState(rgDir)
  expect(state.rounds).toBe(2)
  expect(state.exhausted).toBe(false)

  const run3 = run(scriptPath, rgDir)
  expect(run3.exitCode).toBe(0)
  expect(run3.stderr).toContain("rule-gate: exhausted after 2 blocks")
  state = readState(rgDir)
  expect(state.rounds).toBe(3)
  expect(state.exhausted).toBe(true)
})

test("round cap: state.json perRule tracks bulletId + counts only (F2), never cmd text", () => {
  const { scriptPath, rgDir } = writeScript([{ bulletId: "no-eval", cmd: "exit 1", timeoutMs: 5000 }])
  run(scriptPath, rgDir)
  const state = readState(rgDir)
  expect(state.perRule["no-eval"]?.blocked).toBe(1)
  expect(typeof state.perRule["no-eval"]?.lastFail).toBe("string")
  const raw = readFileSync(join(rgDir, "state.json"), "utf-8")
  expect(raw).not.toContain("exit 1")
})

// ── all-pass ─────────────────────────────────────────────────────────────

test("all checks pass: exit 0, no state.json written at all", () => {
  const { scriptPath, rgDir } = writeScript([
    { bulletId: "b1", cmd: "true", timeoutMs: 5000 },
    { bulletId: "b2", cmd: "exit 0", timeoutMs: 5000 },
  ])
  const result = run(scriptPath, rgDir)
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(rgDir, "state.json"))).toBe(false)
  // RULE_GATE_DIR itself IS created (mkdir -p) — that's the "file creation"
  // the brief allows; state.json content is what must stay untouched.
  expect(existsSync(rgDir)).toBe(true)
})

test("no checks at all: exit 0, no state mutation", () => {
  const { scriptPath, rgDir } = writeScript([])
  const result = run(scriptPath, rgDir)
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(rgDir, "state.json"))).toBe(false)
})

// ── short-circuit: only the FIRST failing check is evaluated ────────────

test("first failure short-circuits — a later check never runs", () => {
  const { scriptPath, rgDir } = writeScript([
    { bulletId: "first", cmd: "exit 1", timeoutMs: 5000 },
    { bulletId: "never", cmd: "touch /this/should/not/matter; exit 1", timeoutMs: 5000 },
  ])
  const result = run(scriptPath, rgDir)
  expect(result.exitCode).toBe(2)
  const state = readState(rgDir)
  expect(Object.keys(state.perRule)).toEqual(["first"])
})

// ── per-check timeout (self-contained watchdog, no coreutils `timeout`) ──

test("a check exceeding its timeoutMs is killed and counted as a failure", () => {
  const { scriptPath, rgDir } = writeScript([{ bulletId: "slow", cmd: "sleep 5; echo should-not-appear", timeoutMs: 300 }])
  const started = Date.now()
  const result = run(scriptPath, rgDir)
  const elapsed = Date.now() - started
  expect(result.exitCode).toBe(2)
  expect(elapsed).toBeLessThan(4000) // killed well before the 5s sleep would finish
  expect(result.stdout).not.toContain("should-not-appear")
})

// ── process-group kill on timeout (fix round 1 — review finding) ────────
//
// GNU coreutils `timeout` puts its child in a fresh process group and
// signals the WHOLE GROUP by default; a naive `kill <pid>` (no leading
// `-`) only ever hits the direct child and orphans anything it
// backgrounded. Repro: the check backgrounds a grandchild
// (sleep-then-write-marker) with a timeoutMs shorter than the grandchild's
// own sleep, then the check itself blocks on a long sleep so the watchdog
// is guaranteed to be what ends it. If only the direct pid was killed, the
// orphaned grandchild survives check.sh's own exit and writes the marker
// on its own schedule; a correct process-GROUP kill takes the grandchild
// down too, so the marker must never appear.
test("timeout kills the check's whole process group — a backgrounded grandchild does not survive", () => {
  // Not writeScript(): the marker path needs the real rgDir baked into the
  // check's cmd text, so dir/rgDir must be computed BEFORE buildRuleGateScript
  // is called (rgDir isn't created on disk yet — the script's own `mkdir -p`
  // does that — but the path string is known and stable).
  const dir = mkdtempSync(join(tmpdir(), "rule-gate-test-"))
  const scriptPath = join(dir, "check.sh")
  const rgDir = join(dir, "rg")
  const markerPath = join(rgDir, "leak-marker")
  writeFileSync(
    scriptPath,
    buildRuleGateScript([
      { bulletId: "leaky", cmd: `(sleep 0.5; echo leaked > '${markerPath}') & sleep 10`, timeoutMs: 150 },
    ]),
  )

  const started = Date.now()
  const result = run(scriptPath, rgDir)
  const elapsed = Date.now() - started
  // Existing pin: a timed-out check still registers as a block/failure.
  expect(result.exitCode).toBe(2)
  expect(elapsed).toBeLessThan(2000) // watchdog fired at ~150ms, not the 10s sleep

  // Give the orphaned grandchild (if the group wasn't actually killed) time
  // past its own 0.5s sleep to write the marker, THEN check for it.
  Bun.spawnSync(["sleep", "0.9"])
  expect(existsSync(markerPath)).toBe(false)
})

// ── evidence tail-cap ──────────────────────────────────────────────────

test("failing check's evidence on stderr is tail-capped to 2048 bytes", () => {
  // 3000 'x' characters via a shell builtin (printf with a repeat count is
  // not POSIX-portable, so build the string in JS and pass it as a single
  // quoted literal — also exercises shQuote on a long string).
  const big = "x".repeat(3000)
  const { scriptPath, rgDir } = writeScript([{ bulletId: "big", cmd: `printf '%s' '${big}' 1>&2; exit 1`, timeoutMs: 5000 }])
  const result = run(scriptPath, rgDir)
  expect(result.exitCode).toBe(2)
  expect(result.stderr.length).toBeLessThanOrEqual(2049) // cap + trailing newline
  expect(result.stderr.length).toBeGreaterThan(2000)
})

// ── buildRuleGateSettings ────────────────────────────────────────────────

test("buildRuleGateSettings: single Stop hook runs bash /app/.rule-gate/check.sh", () => {
  const parsed = JSON.parse(buildRuleGateSettings())
  expect(parsed.hooks.Stop).toHaveLength(1)
  expect(parsed.hooks.Stop[0].hooks).toHaveLength(1)
  expect(parsed.hooks.Stop[0].hooks[0].type).toBe("command")
  expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`bash ${RULE_GATE_DIR}/check.sh`)
})

// ── readRuleGateStateArgs ────────────────────────────────────────────────

test("readRuleGateStateArgs: cat argv for the state file", () => {
  expect(readRuleGateStateArgs()).toEqual(["cat", `${RULE_GATE_DIR}/state.json`])
})
