/**
 * master-frozen-gate.test.ts — Task 4 (T4): master/frozen-gate.ts, the
 * out-of-process gate + gaming monitor (R3). Injected `GateExec` returning
 * scripted stdout — NO real `bun test` is spawned, no real process, no LLM.
 */
import { describe, expect, test } from "bun:test"
import type { GateExec } from "../src/fleet/master/frozen-gate.ts"
import { detectGaming, runFrozenGate } from "../src/fleet/master/frozen-gate.ts"

const PASSING_STDOUT = `bun test v1.1.0

gate.test.ts:
✓ some test [1.00ms]
✓ another test [1.00ms]

 5 pass
 0 fail
 5 expect() calls
Ran 5 tests across 1 files. [12.00ms]
`

const FAILING_STDOUT = `bun test v1.1.0

gate.test.ts:
✗ some test [1.00ms]

 2 pass
 1 fail
 3 expect() calls
Ran 3 tests across 1 files. [12.00ms]
`

describe("runFrozenGate (R3 out-of-process isolation)", () => {
  test("runs the injected exec with cwd:gateRoot — proves out-of-repo isolation", async () => {
    let sawCwd: string | undefined
    const exec: GateExec = async (_argv, opts) => {
      sawCwd = opts.cwd
      return { rc: 0, stdout: PASSING_STDOUT }
    }
    await runFrozenGate({ gateRoot: "/frozen/gate/checkout", ref: "abc123", exec })
    expect(sawCwd).toBe("/frozen/gate/checkout")
  })

  test("passing stdout → { pass:true, testsRun:N }", async () => {
    const exec: GateExec = async () => ({ rc: 0, stdout: PASSING_STDOUT })
    const result = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "abc123", exec })
    expect(result.pass).toBe(true)
    expect(result.testsRun).toBe(5)
  })

  test("failing stdout → { pass:false }", async () => {
    const exec: GateExec = async () => ({ rc: 1, stdout: FAILING_STDOUT })
    const result = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "abc123", exec })
    expect(result.pass).toBe(false)
  })

  test("raw stdout is preserved on the result", async () => {
    const exec: GateExec = async () => ({ rc: 0, stdout: PASSING_STDOUT })
    const result = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "abc123", exec })
    expect(result.raw).toBe(PASSING_STDOUT)
  })

  test("realistic FAILING multi-line stdout → testsRun is the TOTAL (Ran N tests), not the pass count", async () => {
    const stdout = " 2 pass\n 118 fail\n 120 expect() calls\nRan 120 tests across 1 file. [1.00ms]"
    const exec: GateExec = async () => ({ rc: 1, stdout })
    const result = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "abc123", exec })
    expect(result.pass).toBe(false)
    expect(result.testsRun).toBe(120)
  })
})

describe("detectGaming (DGM-114 signature, pure heuristic — no LLM)", () => {
  test("gaming detected: FAIL→PASS while testsRun DROPS", () => {
    const result = detectGaming({ pass: false, testsRun: 120 }, { pass: true, testsRun: 3 })
    expect(result.suspicious).toBe(true)
    expect(result.reason).toMatch(/test.*count|dropped|drop/i)
  })

  test("not gaming: FAIL→PASS with testsRun holding steady or growing (real fix)", () => {
    const result = detectGaming({ pass: false, testsRun: 120 }, { pass: true, testsRun: 121 })
    expect(result.suspicious).toBe(false)
  })

  test("floor: a PASS with testsRun below minTests is suspicious even without a drop", () => {
    const result = detectGaming({ pass: true, testsRun: 40 }, { pass: true, testsRun: 40 }, { minTests: 50 })
    expect(result.suspicious).toBe(true)
  })

  test("no floor violation when testsRun meets minTests and no drop occurred", () => {
    const result = detectGaming({ pass: true, testsRun: 50 }, { pass: true, testsRun: 55 }, { minTests: 50 })
    expect(result.suspicious).toBe(false)
  })

  test("a FAIL→FAIL transition is never suspicious regardless of testsRun delta", () => {
    const result = detectGaming({ pass: false, testsRun: 120 }, { pass: false, testsRun: 3 })
    expect(result.suspicious).toBe(false)
  })

  test("end-to-end: detector is NOT blinded on a failing baseline (DGM-114 scenario the totals-parse bug defeated)", async () => {
    // Realistic failing baseline: bun test puts " N pass" BEFORE "Ran N tests" —
    // a first-match-wins parser would wrongly capture the pass count (2), not
    // the total (120), which hides the gaming signal below.
    const baselineStdout = " 2 pass\n 118 fail\n 120 expect() calls\nRan 120 tests across 1 file. [1.00ms]"
    const baselineExec: GateExec = async () => ({ rc: 1, stdout: baselineStdout })
    const prev = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "baseline", exec: baselineExec })

    // Gamed run: passes, but the check surface was shrunk to far fewer tests.
    const gamedStdout = " 3 pass\n 0 fail\n 3 expect() calls\nRan 3 tests across 1 file. [1.00ms]"
    const gamedExec: GateExec = async () => ({ rc: 0, stdout: gamedStdout })
    const next = await runFrozenGate({ gateRoot: "/frozen/gate", ref: "gamed", exec: gamedExec })

    expect(prev.testsRun).toBe(120)
    expect(next.testsRun).toBe(3)

    const result = detectGaming({ pass: prev.pass, testsRun: prev.testsRun }, { pass: next.pass, testsRun: next.testsRun })
    expect(result.suspicious).toBe(true)
  })
})
