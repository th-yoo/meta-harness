/**
 * trial-verdict.test.ts — §4.3 verdict engine (spec §2/§5/§6/§9; plan Task 6).
 *
 * Layout:
 *   1. exclusion matrix (§2) — each rule is a NAMED test
 *   2. decision truth table (§5) — table-driven over decideTrialVerdict
 *   3. end-to-end evaluateGateTrial — A/A machinery, calibration-stale
 *      refusal, exposure-density guard, futility projection, T_MAX
 *   4. runTrialScan — crank-facing wiring seam (enact-exactly-once,
 *      pending-enacts-nothing, non-winning-repo trial, two-repo fixture)
 */
import { test, expect, describe } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { unionRawLines } from "../src/sensor-union.ts"
import { parseSensorLines } from "../src/scan.ts"
import { parseExposureRows } from "../../opencode-plugin/src/trial-arm.ts"
import {
  evaluateGateTrial,
  decideTrialVerdict,
  runTrialScan,
  MIN_N,
  MIN_SESSIONS_PER_ARM,
  E_MIN,
  T_MAX_MS,
  DENSITY_DIVERGENCE_FACTOR,
  KKAMAK_DEV_CHECKS,
  type ArmReport,
  type TrialEvaluationInput,
  type TrialScanDeps,
} from "../src/trial-verdict.ts"
import type { GroupScore, SensorLineIn } from "../../cc-gate-plugin/src/score.ts"
import type { ExposureRow } from "../../opencode-plugin/src/trial-arm.ts"
import type { GateTrialVerdict, TrialState } from "../../opencode-plugin/src/harness-store.ts"

const DAY = 86_400_000
const T0 = Date.parse("2026-07-01T00:00:00.000Z")
const NOW = T0 + 10 * DAY
const TRIAL_ID = "v7-2026-07-01T00:00:00.000Z"

function mkTrial(o: Partial<TrialState> = {}): TrialState {
  return {
    trial: "v7",
    baseline: "v6",
    baselineSystem: "sys",
    baselineTools: "tools",
    startedAt: new Date(T0).toISOString(),
    minSessions: 5,
    rewardMode: "gate-outcomes",
    trialId: TRIAL_ID,
    ...o,
  }
}

function mkLine(sessionID: string, o: Partial<SensorLineIn> = {}): SensorLineIn {
  return {
    ts: T0 + DAY,
    sessionID,
    check: "cd real-repo && bun test",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 1000,
    host: "office",
    app: "claude-code",
    ...o,
  }
}

function mkRow(sessionID: string, arm: "baseline" | "trial", o: Partial<ExposureRow> = {}): ExposureRow {
  return { ts: T0, sessionID, trialId: TRIAL_ID, layer: "project-global", arm, forced: false, ...o }
}

function evaluate(
  lines: SensorLineIn[],
  rows: ExposureRow[],
  o: Partial<TrialEvaluationInput> = {},
) {
  return evaluateGateTrial({
    trial: mkTrial(),
    sensorLines: lines,
    exposureRows: rows,
    now: NOW,
    calibration: null,
    calibrationIsStale: false,
    ...o,
  })
}

/** Identical stream on both arms, meeting ALL §5 floors: per arm 25 sessions,
 * one line each — 15 clean, 5 catch, 3 exhausted, 2 interrupted. gateCycles
 * 23 ≥ MIN_N, sessions-with-gate-cycle 23 ≥ 5, pooled block-class
 * (5+3+2)×2 = 20 ≥ E_MIN. */
function aaStream(): { lines: SensorLineIn[]; rows: ExposureRow[] } {
  const lines: SensorLineIn[] = []
  const rows: ExposureRow[] = []
  for (const arm of ["baseline", "trial"] as const) {
    for (let i = 1; i <= 25; i++) {
      const sid = `${arm}-s${i}`
      rows.push(mkRow(sid, arm))
      let o: Partial<SensorLineIn>
      if (i <= 15) o = { rounds: ["accepted"] }
      else if (i <= 20) o = { rounds: ["verify-failed", "accepted"] }
      else if (i <= 23) o = { gateExhausted: true, accepted: false, rounds: ["verify-failed", "verify-failed"] }
      else o = { interrupted: true, accepted: false, rounds: ["verify-failed"] }
      lines.push(mkLine(sid, o))
    }
  }
  return { lines, rows }
}

// ── 1. §2 exclusion matrix — each rule is a NAMED test ─────────────────────

describe("§2 exclusions", () => {
  test("no-exposure-row: a sensor line with no matching exposure row is excluded from everything", () => {
    const r = evaluate([mkLine("orphan")], [])
    expect(r.perArm.baseline.cycleCount).toBe(0)
    expect(r.perArm.trial.cycleCount).toBe(0)
    expect(r.perArm.baseline.sessionCount).toBe(0)
    expect(r.perArm.trial.sessionCount).toBe(0)
  })

  test("forced-row: an exposure row with forced:true excludes the whole session (never compared)", () => {
    const r = evaluate([mkLine("s1")], [mkRow("s1", "trial", { forced: true })])
    expect(r.perArm.trial.cycleCount).toBe(0)
    expect(r.perArm.trial.sessionCount).toBe(0) // excluded from density too, not just metrics
  })

  test("gauge-only: excluded from metrics, COUNTED for the exposure-density guard", () => {
    const r = evaluate(
      [mkLine("s1"), mkLine("s1", { rounds: [], accepted: false })],
      [mkRow("s1", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(1) // gauge-only line NOT a metric cycle
    expect(r.perArm.trial.score.gateCycles).toBe(1)
    expect(r.exposureGuard.densityTrial).toBe(2) // ...but it IS density: 2 lines / 1 session
  })

  test("skipped-stop (Task 1, fix-them-serialized-teacup plan): excluded from metrics AND from the exposure-density guard (own rationale, unlike gauge-only)", () => {
    const r = evaluate(
      [mkLine("s1"), mkLine("s1", { rounds: [], accepted: false, skippedStop: true })],
      [mkRow("s1", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(1) // skipped-stop line NOT a metric cycle
    expect(r.perArm.trial.score.gateCycles).toBe(1)
    // Unlike gauge-only, the skipped-stop line does NOT inflate density:
    // still 1 line / 1 session, not 2 lines / 1 session.
    expect(r.exposureGuard.densityTrial).toBe(1)
  })

  test("skipped-stop: repeated queued-prompt lines in one session do not inflate density at all (the false-void risk this exclusion prevents)", () => {
    const r = evaluate(
      [
        mkLine("s1"),
        mkLine("s1", { rounds: [], accepted: false, skippedStop: true }),
        mkLine("s1", { rounds: [], accepted: false, skippedStop: true }),
        mkLine("s1", { rounds: [], accepted: false, skippedStop: true }),
      ],
      [mkRow("s1", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(1)
    expect(r.exposureGuard.densityTrial).toBe(1)
  })

  test("prompt-check (Phase 3 Task 4, 5th pre-data amendment): excluded from metrics AND from the exposure-density guard, mirroring rule 7's skipped-stop shape", () => {
    const r = evaluate(
      [mkLine("s1"), mkLine("s1", { rounds: [], accepted: false, promptCheck: true })],
      [mkRow("s1", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(1) // prompt-check line NOT a metric cycle
    expect(r.perArm.trial.score.gateCycles).toBe(1)
    // Unlike gauge-only, the prompt-check line does NOT inflate density:
    // still 1 line / 1 session, not 2 lines / 1 session.
    expect(r.exposureGuard.densityTrial).toBe(1)
  })

  test("kkamak-dev: this repo's own check group is excluded from every metric (current check)", () => {
    const r = evaluate(
      [mkLine("s1", { check: KKAMAK_DEV_CHECKS[KKAMAK_DEV_CHECKS.length - 1] }), mkLine("s2")],
      [mkRow("s1", "trial"), mkRow("s2", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(1)
    expect(r.perArm.trial.sessionCount).toBe(1)
  })

  test("kkamak-dev: HISTORICAL check strings stay excluded too — append-only set, not swap-in-place (regression for the fix-wave finding: 55/209 lines on the 2-stage/3-stage strings must not leak into a future trial window)", () => {
    const r = evaluate(
      [mkLine("s1", { check: KKAMAK_DEV_CHECKS[0] }), mkLine("s2", { check: KKAMAK_DEV_CHECKS[1] })],
      [mkRow("s1", "trial"), mkRow("s2", "trial")],
    )
    expect(r.perArm.trial.cycleCount).toBe(0)
    expect(r.perArm.trial.sessionCount).toBe(0)
  })

  test("kkamak-dev: KKAMAK_DEV_CHECKS is append-only — the CURRENT gate.json check is the LAST entry, and every check string this repo's gate has ever run stays present (single-source drift guard; a removed entry fails this test)", () => {
    const gate = JSON.parse(fs.readFileSync(new URL("../../gate.json", import.meta.url), "utf-8")) as {
      check: string
    }
    expect(KKAMAK_DEV_CHECKS[KKAMAK_DEV_CHECKS.length - 1]).toBe(gate.check)

    // Historical entries this repo's gate has run, reconstructed from the
    // live stream at fix-wave time (`jq -r '.check' .km/gate-outcomes.ndjson
    // | sort -u`). Append-only: this list only ever grows.
    const HISTORICAL_CHECKS = [
      "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test",
      "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test",
    ]
    for (const h of HISTORICAL_CHECKS) {
      expect(KKAMAK_DEV_CHECKS).toContain(h)
    }
  })

  test("time-bound: lines with ts outside [startedAt, now] are excluded", () => {
    const r = evaluate(
      [
        mkLine("s1", { ts: T0 - 1 }), // before trial start
        mkLine("s1", { ts: NOW + 1 }), // after now
        mkLine("s1", { ts: T0 + DAY }), // inside the window
      ],
      [mkRow("s1", "baseline")],
    )
    expect(r.perArm.baseline.cycleCount).toBe(1)
  })

  test("different-trialId enrollment: the session is VOID for this trial (§2 boundary class) — metrics AND density", () => {
    const r = evaluate([mkLine("s1")], [mkRow("s1", "trial", { trialId: "earlier-trial" })])
    expect(r.perArm.trial.cycleCount).toBe(0)
    expect(r.perArm.trial.sessionCount).toBe(0)
    expect(r.exposureGuard.densityTrial).toBe(0)
  })

  test("arm attribution comes from the exposure record, never recomputed from a hash", () => {
    // A row that says "baseline" IS baseline, whatever the salt would say.
    const r = evaluate([mkLine("s1")], [mkRow("s1", "baseline")])
    expect(r.perArm.baseline.cycleCount).toBe(1)
    expect(r.perArm.trial.cycleCount).toBe(0)
  })

  test("no-trialId: a gate-outcomes TrialState without trialId falls back to trial.trial (unified with engine.ts's enrollment fallback, engine.ts:379) — rows written under that fallback still join", () => {
    const r = evaluate(
      [mkLine("s1")],
      [mkRow("s1", "trial", { trialId: "v7" })], // exposure enrolled while trial.trialId was absent — engine.ts's fallback used trial.trial ("v7")
      { trial: mkTrial({ trialId: undefined }) },
    )
    expect(r.perArm.trial.cycleCount).toBe(1)
  })
})

// ── 2. §5 decision truth table — table-driven ──────────────────────────────

function mkScore(o: Partial<GroupScore> = {}): GroupScore {
  return {
    check: "(pooled)",
    host: "(pooled)",
    counts: { clean: 15, catch: 5, exhausted: 3, interrupted: 2, gaugeOnly: 0, skippedStop: 0, promptCheck: 0 },
    gateCycles: 23,
    underpowered: false,
    mCatch: 0.3,
    mExhaust: 0.1,
    mInterrupt: 0.1,
    mTaxMedianMs: 1000,
    mRounds: [2, 2],
    ...o,
  }
}

function mkArm(o: {
  gateCycles?: number
  swgc?: number
  mCatch?: number | null
  mExhaust?: number | null
  mInterrupt?: number | null
} = {}): ArmReport {
  return {
    cycleCount: 25,
    sessionCount: 25,
    sessionsWithGateCycle: o.swgc ?? 23,
    score: mkScore({
      gateCycles: o.gateCycles ?? 23,
      mCatch: o.mCatch !== undefined ? o.mCatch : 0.3,
      mExhaust: o.mExhaust !== undefined ? o.mExhaust : 0.1,
      mInterrupt: o.mInterrupt !== undefined ? o.mInterrupt : 0.1,
    }),
  }
}

interface TruthRow {
  name: string
  baseline?: ArmReport
  trial?: ArmReport
  pooledBlockEvents?: number
  elapsedMs?: number
  expect: "keep" | "rollback" | "pending" | "deferred"
  reasonContains?: string
}

// Baseline reference: mExhaust 0.1, mInterrupt 0.1, mCatch 0.3.
const TRUTH_TABLE: TruthRow[] = [
  // — the 3-clause rule (KEEP iff mExhaust(T)≤B AND mInterrupt(T)≤B AND mCatch(T)≥B) —
  { name: "all three tie → KEEP (ties are keeps: 'not measurably worse')", trial: mkArm(), expect: "keep" },
  { name: "all three strictly better → KEEP", trial: mkArm({ mExhaust: 0.05, mInterrupt: 0.05, mCatch: 0.4 }), expect: "keep" },
  { name: "mExhaust worsens alone → ROLLBACK", trial: mkArm({ mExhaust: 0.2 }), expect: "rollback", reasonContains: "mExhaust" },
  { name: "mInterrupt worsens alone → ROLLBACK", trial: mkArm({ mInterrupt: 0.2 }), expect: "rollback", reasonContains: "mInterrupt" },
  { name: "mCatch guard falls alone → ROLLBACK", trial: mkArm({ mCatch: 0.2 }), expect: "rollback", reasonContains: "mCatch" },
  { name: "mExhaust better but mCatch falls → ROLLBACK (guard is hard)", trial: mkArm({ mExhaust: 0.05, mCatch: 0.2 }), expect: "rollback" },
  { name: "mCatch rises but mInterrupt worsens → ROLLBACK", trial: mkArm({ mCatch: 0.4, mInterrupt: 0.2 }), expect: "rollback" },
  { name: "both primaries better but guard falls → ROLLBACK", trial: mkArm({ mExhaust: 0.05, mInterrupt: 0.05, mCatch: 0.2 }), expect: "rollback" },
  { name: "everything worsens → ROLLBACK", trial: mkArm({ mExhaust: 0.2, mInterrupt: 0.2, mCatch: 0.2 }), expect: "rollback" },
  // — floors (each floor breached independently → pending) —
  { name: "baseline gateCycles below MIN_N → pending", baseline: mkArm({ gateCycles: MIN_N - 1 }), expect: "pending" },
  { name: "trial gateCycles below MIN_N → pending", trial: mkArm({ gateCycles: MIN_N - 1 }), expect: "pending" },
  { name: "baseline sessions-with-gate-cycle below 5 → pending", baseline: mkArm({ swgc: MIN_SESSIONS_PER_ARM - 1 }), expect: "pending" },
  { name: "trial sessions-with-gate-cycle below 5 → pending", trial: mkArm({ swgc: MIN_SESSIONS_PER_ARM - 1 }), expect: "pending" },
  { name: "pooled block-class events below E_MIN → pending", pooledBlockEvents: E_MIN - 1, expect: "pending" },
  { name: "floors exactly AT thresholds → decided (keep on tie), not pending", baseline: mkArm({ gateCycles: MIN_N, swgc: MIN_SESSIONS_PER_ARM }), trial: mkArm({ gateCycles: MIN_N, swgc: MIN_SESSIONS_PER_ARM }), pooledBlockEvents: E_MIN, expect: "keep" },
  // — T_MAX —
  { name: "floors unmet at T_MAX → ROLLBACK insufficient-events", trial: mkArm({ gateCycles: 3 }), elapsedMs: T_MAX_MS, expect: "rollback", reasonContains: "insufficient-events" },
  { name: "floors unmet past T_MAX → ROLLBACK insufficient-events", pooledBlockEvents: 0, elapsedMs: T_MAX_MS + DAY, expect: "rollback", reasonContains: "insufficient-events" },
  { name: "floors MET past T_MAX → decided normally, not insufficient-events", elapsedMs: T_MAX_MS + DAY, expect: "keep" },
  // — null metrics (floors met) → DEFERRED, never coerced to 0 —
  { name: "baseline mCatch null with floors met → DEFERRED", baseline: mkArm({ mCatch: null }), expect: "deferred", reasonContains: "null-metric" },
  { name: "trial mExhaust null with floors met → DEFERRED", trial: mkArm({ mExhaust: null }), expect: "deferred", reasonContains: "null-metric" },
  { name: "trial mInterrupt null with floors met → DEFERRED", trial: mkArm({ mInterrupt: null }), expect: "deferred", reasonContains: "null-metric" },
]

describe("§5 decision truth table", () => {
  for (const row of TRUTH_TABLE) {
    test(row.name, () => {
      const v = decideTrialVerdict({
        baseline: row.baseline ?? mkArm(),
        trial: row.trial ?? mkArm(),
        pooledBlockEvents: row.pooledBlockEvents ?? 20,
        elapsedMs: row.elapsedMs ?? 10 * DAY,
      })
      expect(v.verdict).toBe(row.expect)
      if (row.reasonContains && "reason" in v) expect(v.reason).toContain(row.reasonContains)
    })
  }

  test("null metric is NEVER coerced to 0 — a null-mCatch baseline does not hand the trial arm a win", () => {
    // If null were coerced to 0, mCatch(T)=0.3 ≥ 0 would pass the guard and
    // the verdict would be KEEP. It must be DEFERRED instead.
    const v = decideTrialVerdict({
      baseline: mkArm({ mCatch: null }),
      trial: mkArm({ mCatch: 0.3 }),
      pooledBlockEvents: 20,
      elapsedMs: 10 * DAY,
    })
    expect(v.verdict).toBe("deferred")
  })
})

// ── 3. end-to-end evaluateGateTrial ────────────────────────────────────────

describe("A/A machinery (§9 design falsification)", () => {
  test("synthetic identical-arm stream meeting all floors → KEEP by tie (equality on all three clauses)", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows)
    expect(r.verdict.verdict).toBe("keep")
    // equality, not merely ≤/≥ passing:
    expect(r.perArm.trial.score.mExhaust).toBe(r.perArm.baseline.score.mExhaust)
    expect(r.perArm.trial.score.mInterrupt).toBe(r.perArm.baseline.score.mInterrupt)
    expect(r.perArm.trial.score.mCatch).toBe(r.perArm.baseline.score.mCatch)
  })

  test("A/A floors are actually met (the test is not vacuous)", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows)
    expect(r.perArm.baseline.score.gateCycles).toBeGreaterThanOrEqual(MIN_N)
    expect(r.perArm.trial.score.gateCycles).toBeGreaterThanOrEqual(MIN_N)
    expect(r.perArm.baseline.sessionsWithGateCycle).toBeGreaterThanOrEqual(MIN_SESSIONS_PER_ARM)
    expect(r.perArm.trial.sessionsWithGateCycle).toBeGreaterThanOrEqual(MIN_SESSIONS_PER_ARM)
  })
})

describe("end-to-end verdicts", () => {
  test("trial arm measurably worse (extra exhausted cycles) → ROLLBACK with three-clause reason", () => {
    const { lines, rows } = aaStream()
    for (const i of [26, 27]) {
      const sid = `trial-s${i}`
      rows.push(mkRow(sid, "trial"))
      lines.push(mkLine(sid, { gateExhausted: true, accepted: false, rounds: ["verify-failed", "verify-failed"] }))
    }
    const r = evaluate(lines, rows)
    expect(r.verdict.verdict).toBe("rollback")
    if (r.verdict.verdict === "rollback") expect(r.verdict.reason).toContain("three-clause-rule")
  })

  test("per-arm N_eff triplet is reported (cycleCount / sessionCount / sessionsWithGateCycle)", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows)
    expect(r.perArm.baseline.cycleCount).toBe(25)
    expect(r.perArm.baseline.sessionCount).toBe(25)
    expect(r.perArm.baseline.sessionsWithGateCycle).toBe(23) // interrupted-only sessions don't count here
  })

  test("reinjectBalance reports the v0/v1 split per arm (§3 balance check)", () => {
    const lines = [
      mkLine("b1", { reinject: "v0" }),
      mkLine("b2", { reinject: "v0" }),
      mkLine("b3", { reinject: "v1" }),
      mkLine("t1", { reinject: "v1" }),
      mkLine("t2"), // no reinject arm recorded — belongs to neither
    ]
    const rows = [
      mkRow("b1", "baseline"), mkRow("b2", "baseline"), mkRow("b3", "baseline"),
      mkRow("t1", "trial"), mkRow("t2", "trial"),
    ]
    const r = evaluate(lines, rows)
    expect(r.reinjectBalance.baseline).toEqual({ v0: 2, v1: 1 })
    expect(r.reinjectBalance.trial).toEqual({ v0: 0, v1: 1 })
  })
})

describe("calibration-stale refusal (spec §4 rule 1)", () => {
  test("stale calibration refuses the verdict as pending 'calibration-stale' even when floors are met and a KEEP is on the table", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows, { calibrationIsStale: true })
    expect(r.verdict.verdict).toBe("pending")
    if (r.verdict.verdict === "pending") expect(r.verdict.projection).toContain("calibration-stale")
  })

  test("stale refusal comes BEFORE floor evaluation — an empty stream still reads calibration-stale, not futility", () => {
    const r = evaluate([], [], { calibrationIsStale: true })
    expect(r.verdict.verdict).toBe("pending")
    if (r.verdict.verdict === "pending") {
      expect(r.verdict.projection).toContain("calibration-stale")
      expect(r.verdict.projection).not.toContain("floors unmet")
    }
  })

  test("stale + elapsed just under T_MAX → pending refusal (existing behavior preserved)", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows, {
      calibrationIsStale: true,
      now: T0 + T_MAX_MS - 1,
    })
    expect(r.verdict.verdict).toBe("pending")
    if (r.verdict.verdict === "pending") expect(r.verdict.projection).toContain("calibration-stale")
  })

  test("stale + elapsed EXACTLY AT T_MAX → abandoned 'calibration-stale' (boundary: ≥ fires abandon)", () => {
    const { lines, rows } = aaStream()
    const r = evaluate(lines, rows, {
      calibrationIsStale: true,
      now: T0 + T_MAX_MS,
    })
    expect(r.verdict.verdict).toBe("abandoned")
    if (r.verdict.verdict === "abandoned") expect(r.verdict.reason).toBe("calibration-stale")
  })

  test("stale + elapsed past T_MAX → abandoned 'calibration-stale'", () => {
    const r = evaluate([], [], {
      calibrationIsStale: true,
      now: T0 + T_MAX_MS + DAY,
    })
    expect(r.verdict.verdict).toBe("abandoned")
    if (r.verdict.verdict === "abandoned") expect(r.verdict.reason).toBe("calibration-stale")
  })
})

describe("exposure-density guard (§9)", () => {
  /** baseline: 5 sessions × 1 line; trial: 5 sessions × `perSession` lines. */
  function densityFixture(perSession: number): { lines: SensorLineIn[]; rows: ExposureRow[] } {
    const lines: SensorLineIn[] = []
    const rows: ExposureRow[] = []
    for (let i = 1; i <= 5; i++) {
      rows.push(mkRow(`b${i}`, "baseline"))
      lines.push(mkLine(`b${i}`))
      rows.push(mkRow(`t${i}`, "trial"))
      for (let k = 0; k < perSession; k++) lines.push(mkLine(`t${i}`))
    }
    return { lines, rows }
  }

  test("gross divergence (>3x, both arms ≥5 sessions) → abandoned 'exposure-divergence' (VOID, not silently pooled)", () => {
    const { lines, rows } = densityFixture(4) // trial density 4 vs baseline 1 → >3x
    const r = evaluate(lines, rows)
    expect(r.exposureGuard.voided).toBe(true)
    expect(r.verdict.verdict).toBe("abandoned")
    if (r.verdict.verdict === "abandoned") expect(r.verdict.reason).toBe("exposure-divergence")
  })

  test("divergence in the OTHER direction (baseline denser) also voids", () => {
    const lines: SensorLineIn[] = []
    const rows: ExposureRow[] = []
    for (let i = 1; i <= 5; i++) {
      rows.push(mkRow(`b${i}`, "baseline"))
      for (let k = 0; k < 4; k++) lines.push(mkLine(`b${i}`))
      rows.push(mkRow(`t${i}`, "trial"))
      lines.push(mkLine(`t${i}`))
    }
    const r = evaluate(lines, rows)
    expect(r.verdict.verdict).toBe("abandoned")
  })

  test(`exactly ${DENSITY_DIVERGENCE_FACTOR}x is NOT gross — the v0 pin is STRICTLY greater than`, () => {
    const { lines, rows } = densityFixture(3) // exactly 3x
    const r = evaluate(lines, rows)
    expect(r.exposureGuard.voided).toBe(false)
    expect(r.verdict.verdict).not.toBe("abandoned")
  })

  test("divergence with an arm under 5 sessions does NOT void (too thin to call gross)", () => {
    const lines: SensorLineIn[] = []
    const rows: ExposureRow[] = []
    for (let i = 1; i <= 4; i++) { // only 4 trial sessions
      rows.push(mkRow(`t${i}`, "trial"))
      for (let k = 0; k < 10; k++) lines.push(mkLine(`t${i}`))
    }
    for (let i = 1; i <= 5; i++) {
      rows.push(mkRow(`b${i}`, "baseline"))
      lines.push(mkLine(`b${i}`))
    }
    const r = evaluate(lines, rows)
    expect(r.exposureGuard.voided).toBe(false)
  })

  test("densities are lines-per-session per arm", () => {
    const { lines, rows } = densityFixture(2)
    const r = evaluate(lines, rows)
    expect(r.exposureGuard.densityBaseline).toBe(1)
    expect(r.exposureGuard.densityTrial).toBe(2)
  })
})

describe("futility projection + T_MAX (§5/§6)", () => {
  /** 2 sessions per arm, one clean + one catch each → every floor unmet but
   * every floor's event rate is nonzero. */
  function thinStream(): { lines: SensorLineIn[]; rows: ExposureRow[] } {
    const lines: SensorLineIn[] = []
    const rows: ExposureRow[] = []
    for (const arm of ["baseline", "trial"] as const) {
      for (let i = 1; i <= 2; i++) {
        const sid = `${arm}-s${i}`
        rows.push(mkRow(sid, arm))
        lines.push(mkLine(sid, i === 1 ? {} : { rounds: ["verify-failed", "accepted"] }))
      }
    }
    return { lines, rows }
  }

  test("floors unmet + under 28d → pending with a days-to-floors projection at the current rate", () => {
    const { lines, rows } = thinStream()
    const r = evaluate(lines, rows)
    expect(r.verdict.verdict).toBe("pending")
    if (r.verdict.verdict === "pending") {
      // worst floor: gateCycles 2/20 over 10d → rate 0.2/d → 18 more → 90d
      expect(r.verdict.projection).toMatch(/~90\.0d/)
      expect(r.verdict.projection).toContain("floors unmet")
    }
  })

  test("zero event rate → projection is ∞", () => {
    const r = evaluate([], [])
    expect(r.verdict.verdict).toBe("pending")
    if (r.verdict.verdict === "pending") expect(r.verdict.projection).toContain("∞")
  })

  test("floors unmet at ≥28d → ROLLBACK 'insufficient-events'", () => {
    const { lines, rows } = thinStream()
    const r = evaluate(lines, rows, { now: T0 + 29 * DAY })
    expect(r.verdict.verdict).toBe("rollback")
    if (r.verdict.verdict === "rollback") expect(r.verdict.reason).toBe("insufficient-events")
  })
})

// ── 4. runTrialScan — the crank-facing seam ────────────────────────────────

interface FakeWorld {
  trials: Record<string, TrialState> // keyed by store root
  linesByRepo?: Record<string, SensorLineIn[]>
  rowsByRepo?: Record<string, ExposureRow[]>
  agesByRepo?: Record<string, { host: string; ageDays: number }[]>
  stale?: boolean
  resolveResult?: "kept" | "rolled-back" | "deferred" | "abandoned" | "none"
}

function fakeDeps(w: FakeWorld): TrialScanDeps & { resolveCalls: Array<{ root: string; v: GateTrialVerdict }> } {
  const resolveCalls: Array<{ root: string; v: GateTrialVerdict }> = []
  return {
    resolveCalls,
    now: NOW,
    readTrial: (root) => w.trials[root] ?? null,
    projectGlobalRootFor: (repo) => `${repo}/store`,
    readFullSensorLines: (repo) => w.linesByRepo?.[repo] ?? [],
    readExposureRows: (repo) => w.rowsByRepo?.[repo] ?? [],
    readSnapshotAges: (repo) => w.agesByRepo?.[repo] ?? [],
    readCalibration: () => null,
    calibrationStale: () => w.stale ?? false,
    resolveGateTrial: (root, v) => {
      resolveCalls.push({ root, v })
      const auto: Record<string, "kept" | "rolled-back" | "deferred" | "abandoned"> = {
        keep: "kept", rollback: "rolled-back", deferred: "deferred", abandoned: "abandoned",
      }
      return { action: w.resolveResult ?? auto[v.verdict]! }
    },
  }
}

describe("runTrialScan (crank wiring seam)", () => {
  const REPOS = ["/repoA", "/repoB"]

  test("no live trial anywhere → null (round proceeds untouched)", () => {
    const deps = fakeDeps({ trials: {} })
    expect(runTrialScan(REPOS, deps)).toBeNull()
    expect(deps.resolveCalls.length).toBe(0)
  })

  test("detail.snapshotAges is populated from deps.readSnapshotAges(repo) (§7, deferred from TM6)", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
      agesByRepo: { "/repoA": [{ host: "office", ageDays: 3.5 }] },
    })
    const r = runTrialScan(REPOS, deps)
    if (r!.action.kind === "trial-keep") {
      expect(r!.action.detail?.snapshotAges).toEqual([{ host: "office", ageDays: 3.5 }])
    } else {
      throw new Error(`expected trial-keep, got ${r!.action.kind}`)
    }
  })

  test("non-winning-repo trial still evaluated (two-repo fixture: trial lives in the SECOND repo)", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoB/store": mkTrial() },
      linesByRepo: { "/repoB": lines },
      rowsByRepo: { "/repoB": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(r).not.toBeNull()
    expect(r!.repo).toBe("/repoB")
    expect(r!.action.kind).toBe("trial-keep")
  })

  test("KEEP verdict → resolveGateTrial enacted EXACTLY once, with the keep verdict, on the trial's own layer root", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(1)
    expect(deps.resolveCalls[0]!.root).toBe("/repoA/store")
    expect(deps.resolveCalls[0]!.v.verdict).toBe("keep")
    expect(r!.action.kind).toBe("trial-keep")
  })

  test("pending verdict enacts NOTHING — resolveGateTrial is never called", () => {
    const deps = fakeDeps({ trials: { "/repoA/store": mkTrial() } }) // empty stream → floors unmet → pending
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(0)
    expect(r!.action.kind).toBe("trial-pending")
    if (r!.action.kind === "trial-pending") expect(r!.action.projection).toContain("∞")
  })

  test("calibration stale → trial-pending 'calibration-stale', no enactment", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
      stale: true,
    })
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(0)
    expect(r!.action.kind).toBe("trial-pending")
    if (r!.action.kind === "trial-pending") expect(r!.action.projection).toContain("calibration-stale")
  })

  test("calibration stale PAST T_MAX → resolveGateTrial enacted EXACTLY ONCE with abandoned 'calibration-stale', emitting trial-abandoned", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
      stale: true,
    })
    deps.now = T0 + T_MAX_MS + DAY
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(1)
    expect(deps.resolveCalls[0]!.v).toEqual({ verdict: "abandoned", reason: "calibration-stale" })
    expect(r!.action.kind).toBe("trial-abandoned")
    if (r!.action.kind === "trial-abandoned") expect(r!.action.reason).toBe("calibration-stale")
  })

  test("rollback verdict → trial-rollback action carrying the reason", () => {
    const { lines, rows } = aaStream()
    for (const i of [26, 27]) {
      rows.push(mkRow(`trial-s${i}`, "trial"))
      lines.push(mkLine(`trial-s${i}`, { gateExhausted: true, accepted: false, rounds: ["verify-failed", "verify-failed"] }))
    }
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(r!.action.kind).toBe("trial-rollback")
    if (r!.action.kind === "trial-rollback") {
      expect(r!.action.trial).toBe("v7")
      expect(r!.action.reason).toContain("three-clause-rule")
    }
  })

  test("abandoned verdict (exposure divergence) → trial-abandoned action", () => {
    const lines: SensorLineIn[] = []
    const rows: ExposureRow[] = []
    for (let i = 1; i <= 5; i++) {
      rows.push(mkRow(`b${i}`, "baseline"))
      lines.push(mkLine(`b${i}`))
      rows.push(mkRow(`t${i}`, "trial"))
      for (let k = 0; k < 5; k++) lines.push(mkLine(`t${i}`))
    }
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(1)
    expect(r!.action.kind).toBe("trial-abandoned")
    if (r!.action.kind === "trial-abandoned") expect(r!.action.reason).toBe("exposure-divergence")
  })

  test("enactment says abandoned for a KEEP verdict (active changed underneath) → trial-abandoned with the active-changed reason", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
      resolveResult: "abandoned",
    })
    const r = runTrialScan(REPOS, deps)
    expect(r!.action.kind).toBe("trial-abandoned")
    if (r!.action.kind === "trial-abandoned") expect(r!.action.reason).toContain("active version changed")
  })

  test("awaitingGo (queued) trial is inert — ignored by the scan", () => {
    const deps = fakeDeps({ trials: { "/repoA/store": mkTrial({ awaitingGo: true }) } })
    expect(runTrialScan(REPOS, deps)).toBeNull()
  })

  test("golden window: refused with a registered-deferral pending action — no evaluation, no enactment (golden machinery unbuilt)", () => {
    const { lines, rows } = aaStream() // a stream that WOULD otherwise decide (keep) — proves refusal, not floors
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial({ golden: true }) },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(deps.resolveCalls.length).toBe(0)
    expect(r).not.toBeNull()
    expect(r!.repo).toBe("/repoA")
    expect(r!.action.kind).toBe("trial-pending")
    if (r!.action.kind === "trial-pending") {
      expect(r!.action.projection).toBe(
        "golden-window machinery unbuilt — registered deferral (explicitly-not-now §7.8); no verdict will be read until it lands",
      )
    }
  })

  test("golden window: false/absent golden is unaffected — normal evaluation still runs", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial({ golden: false }) },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(r!.action.kind).toBe("trial-keep")
    expect(deps.resolveCalls.length).toBe(1)
  })

  test("legacy trial (no rewardMode) is ignored — owned by the old resolveTrial, not this engine", () => {
    const legacy = mkTrial()
    delete legacy.rewardMode
    const deps = fakeDeps({ trials: { "/repoA/store": legacy } })
    expect(runTrialScan(REPOS, deps)).toBeNull()
  })

  test("enact result 'none' (trial raced away between read and resolve) → null, nothing posted", () => {
    const { lines, rows } = aaStream()
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
      resolveResult: "none",
    })
    expect(runTrialScan(REPOS, deps)).toBeNull()
  })

  test("action detail carries the per-arm N_eff triplet and the per-host coverage note", () => {
    const { lines, rows } = aaStream()
    lines.push(mkLine("unjoined-line", { host: "macbook" })) // host coverage spans the full stream read
    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": lines },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(REPOS, deps)
    expect(r!.action.kind).toBe("trial-keep")
    if (r!.action.kind === "trial-keep") {
      const d = r!.action.detail!
      expect(d.perArm.baseline).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
      expect(d.perArm.trial).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
      expect(d.hosts).toContain("office")
      expect(d.hosts).toContain("macbook")
    }
  })
})

// ── 5. Cross-host union verdict input (§7, final review item 3) ───────────
// Wires runTrialScan's readFullSensorLines/readExposureRows exactly the way
// crank.ts wires them (unionRawLines + parseSensorLines/parseExposureRows on
// the unioned raw text) so these tests exercise the real union path the
// verdict input goes through, not just the sensor-union.ts primitive
// (covered directly in sensor-union.test.ts).

function tmpEvidenceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-trial-verdict-union-"))
}

function writeSnapshotFile(evidenceRoot: string, host: string, base: string, kind: string, lines: string[]): void {
  const dir = path.join(evidenceRoot, host)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${base}.${kind}.ndjson`), lines.join("\n") + (lines.length ? "\n" : ""), "utf-8")
}

/** Deps wired through the real union path (mirrors crank.ts's
 * readUnionSensorLines/readUnionExposureRows), reading `liveLines`/`liveRows`
 * as this repo's "local" data and unioning against whatever is committed
 * under `evidenceRoot` for the repo's basename. */
function unionWiredDeps(
  world: { trials: Record<string, TrialState>; agesByRepo?: Record<string, { host: string; ageDays: number }[]> },
  evidenceRoot: string,
  liveLines: SensorLineIn[],
  liveRows: ExposureRow[],
): TrialScanDeps & { resolveCalls: Array<{ root: string; v: GateTrialVerdict }> } {
  const resolveCalls: Array<{ root: string; v: GateTrialVerdict }> = []
  return {
    resolveCalls,
    now: NOW,
    readTrial: (root) => world.trials[root] ?? null,
    projectGlobalRootFor: (repo) => `${repo}/store`,
    readFullSensorLines: (repo) => {
      const liveText = liveLines.map((l) => JSON.stringify(l)).join("\n")
      const unioned = unionRawLines(evidenceRoot, repo, "gate-outcomes", liveText).join("\n")
      return unioned ? (unioned.split("\n").map((l) => JSON.parse(l)) as SensorLineIn[]) : []
    },
    readExposureRows: (repo) => {
      const liveText = liveRows.map((r) => JSON.stringify(r)).join("\n")
      const unioned = unionRawLines(evidenceRoot, repo, "trial-arms", liveText).join("\n")
      return parseExposureRows(unioned)
    },
    readSnapshotAges: (repo) => world.agesByRepo?.[repo] ?? [],
    readCalibration: () => null,
    calibrationStale: () => false,
    resolveGateTrial: (root, v) => {
      resolveCalls.push({ root, v })
      const auto: Record<string, "kept" | "rolled-back" | "deferred" | "abandoned"> = {
        keep: "kept", rollback: "rolled-back", deferred: "deferred", abandoned: "abandoned",
      }
      return { action: auto[v.verdict]! }
    },
  }
}

/** trial-sN's numeric suffix, or null if `sid` isn't a trial-arm aaStream id. */
function trialNum(sid: string): number | null {
  const m = /^trial-s(\d+)$/.exec(sid)
  return m ? Number(m[1]) : null
}

describe("cross-host union verdict input (§7, final review item 3)", () => {
  test("(a) other-host snapshot-only sessions reach the verdict input — can push an arm's session/gateCycle counts over the §5 floors", () => {
    const { lines, rows } = aaStream()
    // Keep the baseline arm entirely local. Split the TRIAL arm: sessions
    // trial-s1..trial-s4 stay "live"; trial-s5..trial-s25 exist ONLY in
    // another host's committed snapshot. Live-only, the trial arm has just 4
    // sessions/cycles — under both MIN_SESSIONS_PER_ARM (5) and MIN_N (20).
    const liveLines = lines.filter((l) => trialNum(l.sessionID) === null || trialNum(l.sessionID)! <= 4)
    const snapshotOnlyLines = lines.filter((l) => trialNum(l.sessionID) !== null && trialNum(l.sessionID)! > 4)
    const liveRows = rows.filter((r) => trialNum(r.sessionID) === null || trialNum(r.sessionID)! <= 4)
    const snapshotOnlyRows = rows.filter((r) => trialNum(r.sessionID) !== null && trialNum(r.sessionID)! > 4)

    // Sanity: proves the split actually starves the trial arm without union.
    const liveOnly = evaluateGateTrial({
      trial: mkTrial(), sensorLines: liveLines, exposureRows: liveRows,
      now: NOW, calibration: null, calibrationIsStale: false,
    })
    expect(liveOnly.verdict.verdict).toBe("pending")
    expect(liveOnly.perArm.trial.sessionsWithGateCycle).toBeLessThan(MIN_SESSIONS_PER_ARM)

    const evidenceRoot = tmpEvidenceRoot()
    writeSnapshotFile(evidenceRoot, "other-host", "myrepo", "gate-outcomes", snapshotOnlyLines.map((l) => JSON.stringify(l)))
    writeSnapshotFile(evidenceRoot, "other-host", "myrepo", "trial-arms", snapshotOnlyRows.map((r) => JSON.stringify(r)))

    const deps = unionWiredDeps({ trials: { "/repos/myrepo/store": mkTrial() } }, evidenceRoot, liveLines, liveRows)
    const r = runTrialScan(["/repos/myrepo"], deps)
    // Union restores the full aaStream (both arms 25 sessions, all floors
    // met) → decided normally instead of stuck pending.
    expect(r!.action.kind).toBe("trial-keep")
  })

  test("(b) a raw line present in BOTH the live data and the snapshot counts once (no double-counted sessions in the verdict input)", () => {
    const { lines, rows } = aaStream()
    const evidenceRoot = tmpEvidenceRoot()
    // The ENTIRE live stream is also committed to the snapshot verbatim —
    // full overlap, not just one session.
    writeSnapshotFile(evidenceRoot, "other-host", "myrepo", "gate-outcomes", lines.map((l) => JSON.stringify(l)))
    writeSnapshotFile(evidenceRoot, "other-host", "myrepo", "trial-arms", rows.map((r) => JSON.stringify(r)))

    const deps = unionWiredDeps({ trials: { "/repos/myrepo/store": mkTrial() } }, evidenceRoot, lines, rows)
    const r = runTrialScan(["/repos/myrepo"], deps)
    expect(r!.action.kind).toBe("trial-keep")
    if (r!.action.kind === "trial-keep") {
      // Exactly aaStream's own per-arm counts (25/25/23) — not doubled by
      // the full-overlap snapshot.
      expect(r!.action.detail?.perArm.baseline).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
      expect(r!.action.detail?.perArm.trial).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
    }
  })

  test("(c) no snapshot dir for this repo at all → identical to the pre-union, live-only read", () => {
    const { lines, rows } = aaStream()
    const evidenceRoot = path.join(os.tmpdir(), "km-trial-verdict-union-absent-" + Date.now())
    const deps = unionWiredDeps({ trials: { "/repos/myrepo/store": mkTrial() } }, evidenceRoot, lines, rows)
    const r = runTrialScan(["/repos/myrepo"], deps)
    expect(r!.action.kind).toBe("trial-keep")
    if (r!.action.kind === "trial-keep") {
      expect(r!.action.detail?.perArm.baseline).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
      expect(r!.action.detail?.perArm.trial).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
    }
  })
})

// ── 6. Composition: disk -> scan.ts's REAL parseSensorLines -> runTrialScan
// (round-2 review finding). Everywhere else in this file feeds
// evaluateGateTrial/runTrialScan hand-built SensorLineIn fixtures — this is
// the one test that goes through the actual production parser reading an
// actual file off disk, proving (a) skipped-stop lines are NOT dropped by
// the parser (so trial-verdict.ts's rule-7 exclusion is reachable at all in
// production, not just exercised by unit fixtures), (b) rule 7 still
// excludes them from BOTH metrics and density once they reach
// evaluateGateTrial, and (c) a host whose ONLY trial-window activity is a
// skipped-stop line still appears in runTrialScan's SITREP host coverage.

describe("composition: disk -> parseSensorLines -> runTrialScan (round-2 review, real production path)", () => {
  test("a skipped-stop line read off disk via the real parser is excluded from metrics AND density, but its host still appears in SITREP coverage", () => {
    const { lines, rows } = aaStream() // meets all §5 floors on its own
    const QUEUED_HOST = "queued-host"
    const queuedSession = "baseline-queued-only"
    // A session whose ONLY sensor line is a skipped-stop marker (the shape
    // prompt.ts actually emits: rounds:[], accepted:true, gateExhausted:
    // false, interrupted:false, durationMs:0), on a host that appears
    // NOWHERE else in the stream.
    rows.push(mkRow(queuedSession, "baseline"))
    lines.push(
      mkLine(queuedSession, {
        host: QUEUED_HOST,
        rounds: [],
        accepted: true,
        gateExhausted: false,
        interrupted: false,
        durationMs: 0,
        skippedStop: true,
      }),
    )

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-trial-verdict-disk-"))
    const sensorPath = path.join(dir, "gate-outcomes.ndjson")
    fs.writeFileSync(sensorPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8")

    // The REAL parser, reading the REAL file off disk (mirrors
    // readUnionSensorLines's own parseSensorLines(unioned) call in crank.ts,
    // minus the union step itself — already covered by section 5 above).
    const diskText = fs.readFileSync(sensorPath, "utf-8")
    const parsed = parseSensorLines(diskText) as unknown as SensorLineIn[]

    // Sanity: the parser must NOT have dropped the skipped-stop line —
    // this is what makes the rest of this test meaningful.
    expect(parsed.length).toBe(lines.length)
    expect(parsed.some((l) => l.sessionID === queuedSession && l.skippedStop === true)).toBe(true)

    const deps = fakeDeps({
      trials: { "/repoA/store": mkTrial() },
      linesByRepo: { "/repoA": parsed },
      rowsByRepo: { "/repoA": rows },
    })
    const r = runTrialScan(["/repoA"], deps)
    expect(r!.action.kind).toBe("trial-keep")
    if (r!.action.kind === "trial-keep") {
      // (c) host coverage: the queued-only host is visible in the SITREP
      // even though it contributed zero cycles to any arm.
      expect(r!.action.detail?.hosts).toContain(QUEUED_HOST)
      // (b) metrics + density exclusion: baseline's numbers are UNCHANGED
      // from plain aaStream (25/25/23) — the extra skipped-stop-only
      // session moved neither cycleCount nor sessionCount nor
      // sessionsWithGateCycle.
      expect(r!.action.detail?.perArm.baseline).toEqual({ cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 })
    }
  })
})
