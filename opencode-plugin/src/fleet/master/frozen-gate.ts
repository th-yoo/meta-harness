/**
 * frozen-gate.ts — the out-of-process quality gate + gaming monitor (R3).
 *
 * The master runs the deterministic gate (`bun test` + smoke — the
 * self-hosting N5b gate CONTENT) from `gateRoot`, a location the fleet's
 * worktrees cannot write to. This module does not rebuild the gate content;
 * it owns *where/how* the gate runs (out-of-process isolation, via the
 * injected `GateExec` seam) and a *gaming monitor* on top of successive
 * results.
 *
 * GAMING IS MONITORED, NOT AUTO-RESOLVED: `detectGaming` flags the DGM
 * node-114 signature — a run that flips FAIL→PASS while the test count it
 * ran DROPS (the check surface was shrunk/deleted, not fixed), or a PASS
 * whose testsRun falls below a baseline floor. A suspicious signal is
 * surfaced to the human via the relay (`master/relay.ts`'s gate/escalation
 * path) — it is NEVER a silent auto-accept. `detectGaming` is a pure,
 * deterministic heuristic: no LLM, no network, no randomness.
 *
 * `GateExec` is injected so this module is hermetically testable (tests
 * script stdout/rc directly, no real `bun test` process spawn). A real
 * default wraps `bench/exec.ts`'s `runHost`; that wiring belongs to the
 * caller (master/master.ts, Task 8) — never exercised in this module's
 * tests.
 */

/** Injected process-exec seam. A real impl wraps `bench/exec.ts`'s `runHost`. */
export type GateExec = (argv: string[], opts: { cwd: string }) => Promise<{ rc: number; stdout: string }>

export interface FrozenGateResult {
  pass: boolean
  testsRun: number
  raw: string
}

export interface GamingSignal {
  suspicious: boolean
  reason?: string
}

const TEST_COUNT_RE = /(\d+)\s+(?:pass|tests)/i

/**
 * Run the frozen gate in `gateRoot` (an out-of-repo checkout of `ref` the
 * fleet cannot write to). Parses pass/fail from the exec's return code and a
 * test-count from stdout (the `bun test` summary line: `N pass` / `Ran N
 * tests`).
 */
export async function runFrozenGate(deps: {
  gateRoot: string
  ref: string
  exec: GateExec
}): Promise<FrozenGateResult> {
  const { gateRoot, exec } = deps
  const { rc, stdout } = await exec(["bun", "test"], { cwd: gateRoot })
  const match = stdout.match(TEST_COUNT_RE)
  const testsRun = match ? Number(match[1]) : 0
  return { pass: rc === 0, testsRun, raw: stdout }
}

/**
 * Pure heuristic: flag the DGM-114 signature (FAIL→PASS while testsRun
 * DROPS — the gate was gamed by shrinking the check surface, not fixed), or
 * a PASS whose testsRun sits below a baseline floor (`opts.minTests`,
 * default 1 — a "pass" that ran (almost) nothing is itself suspicious).
 * Deterministic; no LLM.
 */
export function detectGaming(
  prev: { pass: boolean; testsRun: number },
  next: { pass: boolean; testsRun: number },
  opts?: { minTests?: number },
): GamingSignal {
  const minTests = opts?.minTests ?? 1

  if (!prev.pass && next.pass && next.testsRun < prev.testsRun) {
    return {
      suspicious: true,
      reason: `FAIL→PASS while testsRun dropped ${prev.testsRun}→${next.testsRun} (DGM-114 signature: gate surface shrunk, not fixed)`,
    }
  }

  if (next.pass && next.testsRun < minTests) {
    return {
      suspicious: true,
      reason: `PASS with testsRun=${next.testsRun} below floor minTests=${minTests}`,
    }
  }

  return { suspicious: false }
}
