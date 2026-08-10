#!/usr/bin/env bun
/**
 * P2 tally — verdict table + b2 shadow read (docs/superpowers/plans/
 * 2026-08-06-p2-actuator-binding.md §Task 5). Zero model calls, F2-clean:
 * reads the three arm results files (a1/a3/a4) p2-run wrote under
 * docs/loop-probes/p2/ plus a PASSIVE read of the review-sensor ndjson
 * stream, and emits ONE committed verdict json — counts/stats/task-ids
 * only, never transcript or finding text.
 *
 * Per-attempt annotation format CONSUMED here (frozen by cmd-p2.ts, Task
 * 4 — this module does not compute compliance, only reads the recorded
 * bit): each task's `errors[i]` is a JSON string
 * `{arm, ruleSha, compliant, reprompted, reviewFailed, error}`,
 * index-aligned 1:1 with that task's `rewards[i]`/`turns[i]`/`elapsed[i]`
 * (cmd-p2.ts's own header comment: "errors.length === rewards.length
 * strictly, so Task 5's tally can zip the two arrays 1:1"). This file
 * only reads `compliant`/`reprompted`/`reviewFailed`/`error` — `arm`/
 * `ruleSha` are per-run provenance, cross-checked instead via each
 * results file's own top-level `harness.ruleSha` (see main() below).
 *
 * Pure core (bars math, per-attempt zip, b2 window math) lives directly
 * in this file and is unit-tested by direct import from
 * km-crank/test/p2-tally.test.ts, mirroring scripts/p0-signal-variance
 * .ts's precedent (that file's own pure helpers are tested the same way
 * from km-crank/test/loop-probes-cli.test.ts — the closest existing
 * analog: a scripts/*.ts probe with committed JSON output, home-anchored
 * env-seam paths, pure functions defined directly in the script rather
 * than extracted to km-crank/src). Formulas are NOT reimplemented from
 * results.ts's `aggTotals` — that lives in opencode-plugin/src, a
 * different package scripts/ does not otherwise import from, so
 * `computeArmStats` below reimplements the identical any-of-k pass@k
 * definition locally (task-5-report.md records this as a recorded
 * choice, not a silent duplication).
 *
 * scripts/*.ts files exercised from km-crank/test/ must also be added to
 * km-crank/tsconfig.json's `include` array (mirrors that file's existing
 * p0/p1/e-table/gate-check entries) so `cd km-crank && bunx tsc --noEmit`
 * actually type-checks this file — done for this file (task-5-report.md).
 *
 * Env overrides (test seam ONLY — production omits all of these):
 *   KKAMAK_P2_A1_RESULTS, KKAMAK_P2_A3_RESULTS, KKAMAK_P2_A4_RESULTS,
 *   KKAMAK_P2_REVIEW_FINDINGS_NDJSON, KKAMAK_P2_VERDICT_OUT.
 *
 * Results-file naming convention (not pinned anywhere else in the plan —
 * DECISION recorded in task-5-report.md): Task 6's real `p2-run
 * --results-file` invocations should write to
 * `docs/loop-probes/p2/<hostname>-p2-<arm>-results.json`, mirroring
 * p0/p1's `${hostname()}-p0-...json` host-scoped convention — these are
 * this script's PRODUCTION DEFAULTS below (overridable per-arm via env
 * for anyone who names their results files differently).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------
// pure core — no I/O
// ---------------------------------------------------------------------

export type P2Arm = "a1" | "a3" | "a4"

/** The fields this module actually consumes from cmd-p2.ts's per-attempt
 * `errors[i]` JSON annotation (that object also carries `arm`/`ruleSha`,
 * unused here — see file header). */
export interface AttemptAnnotation {
  compliant: boolean
  reprompted: boolean
  reviewFailed: boolean
  error: string
  /** ff8dbb8/083aa07 instrumentation-failure flags. OPTIONAL in the parse
   * (absent on annotations written by older encoders — treated as false,
   * never as a parse failure) so a mixed-era results file still tallies. */
  reviewTruncated: boolean
  rePassHardFail: boolean
}

/** Tolerant parse of one cmd-p2.ts `errors[]` entry — malformed/non-JSON
 * or wrong-shape entries parse to undefined so one bad line degrades a
 * single attempt (treated as non-compliant/non-reprompted) rather than
 * crashing the whole tally. This module CONSUMES the recorded bit; it
 * never recomputes compliance. */
export function parseAttemptAnnotation(raw: string | undefined): AttemptAnnotation | undefined {
  if (typeof raw !== "string") return undefined
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (v === null || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (
    typeof o.compliant === "boolean" &&
    typeof o.reprompted === "boolean" &&
    typeof o.reviewFailed === "boolean" &&
    typeof o.error === "string"
  ) {
    return {
      compliant: o.compliant,
      reprompted: o.reprompted,
      reviewFailed: o.reviewFailed,
      error: o.error,
      reviewTruncated: o.reviewTruncated === true,
      rePassHardFail: o.rePassHardFail === true,
    }
  }
  return undefined
}

export interface P2TaskAgg {
  rewards?: number[]
  elapsed?: number[]
  turns?: number[]
  errors?: string[]
}

export interface P2ResultsDoc {
  tasks?: Record<string, P2TaskAgg>
  k?: number
  model?: string
  timestamp?: string
  harness?: { ruleSha?: string }
}

export interface ArmStatsCore {
  n: number
  compliance: number
  passAtK: number
  meanTurns: number
  meanElapsedSec: number
}

/** Per-attempt zip (index-aligned across rewards/turns/elapsed/errors,
 * per cmd-p2.ts's contract) + per-task pass@k (any reward===1 in that
 * task's k repeats — the same any-of-k definition results.ts's
 * `aggTotals` uses, reimplemented here rather than imported — see file
 * header). */
export function computeArmStats(doc: P2ResultsDoc): ArmStatsCore {
  let n = 0
  let compliantCount = 0
  let turnsSum = 0
  let elapsedSum = 0
  let nPass = 0
  let nTotal = 0
  for (const agg of Object.values(doc.tasks ?? {})) {
    const rewards = agg.rewards ?? []
    const turns = agg.turns ?? []
    const elapsed = agg.elapsed ?? []
    const errors = agg.errors ?? []
    if (rewards.length > 0) {
      nTotal += 1
      if (Math.max(...rewards) === 1) nPass += 1
    }
    for (let i = 0; i < rewards.length; i++) {
      n += 1
      turnsSum += turns[i] ?? 0
      elapsedSum += elapsed[i] ?? 0
      const parsed = parseAttemptAnnotation(errors[i])
      if (parsed?.compliant) compliantCount += 1
    }
  }
  return {
    n,
    compliance: n > 0 ? compliantCount / n : 0,
    passAtK: nTotal > 0 ? nPass / nTotal : 0,
    meanTurns: n > 0 ? turnsSum / n : 0,
    meanElapsedSec: n > 0 ? elapsedSum / n : 0,
  }
}

/** A3's own `compliance` stat (from computeArmStats) is expected to sit
 * at ~1.0 "by construction" (design spec §4 — the Stop-gate mechanically
 * blocks completion until the compliance predicate holds). cmd-p2.ts's
 * per-attempt annotation carries no direct in-container block-EVENT
 * counter — only compliant/reprompted/reviewFailed/error, and
 * reprompted/reviewFailed are always false for a3 (P2AttemptResult's own
 * doc comment in cmd-p2.ts) — so the only observable proxy for "the
 * gate's binding still fell short on this attempt" is the count of
 * non-compliant a3 attempts. DEVIATION from a literal per-block-event
 * count, recorded in task-5-report.md. */
export function computeA3StopBlocks(doc: P2ResultsDoc): number {
  let stopBlocks = 0
  for (const agg of Object.values(doc.tasks ?? {})) {
    const rewards = agg.rewards ?? []
    const errors = agg.errors ?? []
    for (let i = 0; i < rewards.length; i++) {
      const parsed = parseAttemptAnnotation(errors[i])
      if (parsed && !parsed.compliant) stopBlocks += 1
    }
  }
  return stopBlocks
}

export interface A4Extra {
  rePassRate: number
  reviewFailedCount: number
  /** Attempts whose review reply was cut off by the api lane's maxTokens
   * cap (`reviewTruncated` — always implies `reviewFailed`): an
   * instrumentation failure, not a model verdict. Surfaced in the verdict
   * so A4's compliance/reviewFailed numbers are never read without knowing
   * how many of them are the lane's fault (closes the recorded
   * "manual grep after the run" gap). */
  reviewTruncatedCount: number
  /** Attempts whose fired re-pass exec itself died (`rePassHardFail`,
   * ff8dbb8): compliance degraded to the pass-1 verdict — same
   * instrumentation-failure family, same reason to surface. */
  rePassHardFailCount: number
}

/** rePassRate = fraction of a4 attempts whose one bounded re-pass
 * actually fired (`reprompted`); reviewFailedCount = count of attempts
 * whose host-side review call itself failed (`reviewFailed`, no re-pass
 * fires in that case — cmd-p2.ts). */
export function computeA4Extra(doc: P2ResultsDoc): A4Extra {
  let n = 0
  let reprompted = 0
  let reviewFailed = 0
  let reviewTruncated = 0
  let rePassHardFail = 0
  for (const agg of Object.values(doc.tasks ?? {})) {
    const rewards = agg.rewards ?? []
    const errors = agg.errors ?? []
    for (let i = 0; i < rewards.length; i++) {
      n += 1
      const parsed = parseAttemptAnnotation(errors[i])
      if (parsed?.reprompted) reprompted += 1
      if (parsed?.reviewFailed) reviewFailed += 1
      if (parsed?.reviewTruncated) reviewTruncated += 1
      if (parsed?.rePassHardFail) rePassHardFail += 1
    }
  }
  return {
    rePassRate: n > 0 ? reprompted / n : 0,
    reviewFailedCount: reviewFailed,
    reviewTruncatedCount: reviewTruncated,
    rePassHardFailCount: rePassHardFail,
  }
}

/** Pre-registered decision rule (plan §Global Constraints / spec §5):
 * a mechanism earns routing iff compliance >= complianceBar AND pass@k
 * does not drop more than passDropBar absolute vs A1. a1PassAtK -
 * armPassAtK negative (the arm beats A1) still passes trivially. */
export const COMPLIANCE_BAR = 0.75
export const PASS_DROP_BAR = 0.15

/** FLOAT_EPS absorbs float-representation drift at the exact boundary
 * (e.g. 0.5 + 0.15 - 0.5 === 0.15000000000000002 in IEEE754) — real
 * inputs are themselves fractions of small integers (n/28-scale), so a
 * 1e-9 tolerance can never flip a genuine >0.15 drop into a pass. */
const FLOAT_EPS = 1e-9

export function earnsRouting(armCompliance: number, armPassAtK: number, a1PassAtK: number): boolean {
  return armCompliance >= COMPLIANCE_BAR - FLOAT_EPS && a1PassAtK - armPassAtK <= PASS_DROP_BAR + FLOAT_EPS
}

/** Frozen caveat text (design spec §4 / plan §Global Constraints), always
 * reported alongside a4's numbers — never conditional on rePassRate,
 * since the reader must judge attribution themselves. */
export const COMPUTE_BONUS_CAVEAT =
  "a4 pass@k gains with high rePassRate are not attributable to binding vs +10 turns"

/** Band identifier (plan §Global Constraints: "the 14 tasks of
 * term-bench2/splits/loop1-band.txt") — a fixed label, not derived from
 * any results file field. */
export const BAND = "loop1-band"
export const SPEC_PATH = "docs/superpowers/specs/2026-08-05-p2-actuator-binding-design.md"

// ---------------------------------------------------------------------
// b2 shadow — passive read of .km/review-findings.ndjson
// ---------------------------------------------------------------------

export interface ReviewFindingsLine {
  ts?: number
  skipped?: boolean
  host?: string
}

/** design spec §4: "a near-empty stream ... is reported as 'shadow n too
 * small, not evidential', never as signal" — the bar Step 1's test
 * description pins at realizedN >= 10. */
export const SHADOW_EVIDENTIAL_MIN_N = 10

export interface B2ShadowCore {
  realizedN: number
  eventsPerDay: number
  evidential: boolean
}

/** realized n = non-skipped lines with ts in [windowStart, windowEnd];
 * events/day = realizedN / windowSpanDays (0 when the window has zero
 * span — never divides by zero). evidential = realizedN >=
 * SHADOW_EVIDENTIAL_MIN_N; main() prints the verbatim "shadow n too
 * small, not evidential" status line when false. */
export function computeB2Shadow(lines: ReviewFindingsLine[], windowStart: number, windowEnd: number): B2ShadowCore {
  const inWindow = lines.filter(
    (l) => typeof l.ts === "number" && l.ts >= windowStart && l.ts <= windowEnd && l.skipped !== true,
  )
  const realizedN = inWindow.length
  const spanDays = Math.max(windowEnd - windowStart, 0) / 86_400_000
  const eventsPerDay = spanDays > 0 ? realizedN / spanDays : 0
  return { realizedN, eventsPerDay, evidential: realizedN >= SHADOW_EVIDENTIAL_MIN_N }
}

// ---------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------

const P2_DIR_DEFAULT = path.join(process.cwd(), "docs", "loop-probes", "p2")

const ARM_RESULTS_ENV: Record<P2Arm, string> = {
  a1: "KKAMAK_P2_A1_RESULTS",
  a3: "KKAMAK_P2_A3_RESULTS",
  a4: "KKAMAK_P2_A4_RESULTS",
}

export function armResultsPath(arm: P2Arm): string {
  return process.env[ARM_RESULTS_ENV[arm]] ?? path.join(P2_DIR_DEFAULT, `${os.hostname()}-p2-${arm}-results.json`)
}

export function reviewFindingsNdjsonPath(): string {
  return (
    process.env.KKAMAK_P2_REVIEW_FINDINGS_NDJSON ??
    path.join(os.homedir(), "z2", "meta-harness", ".km", "review-findings.ndjson")
  )
}

export function verdictOutPath(): string {
  return process.env.KKAMAK_P2_VERDICT_OUT ?? path.join(P2_DIR_DEFAULT, `${os.hostname()}-p2-verdict.json`)
}

/** Tolerant results-file read: missing/malformed -> {} (n=0 stats
 * downstream), never throws — mirrors p0-signal-variance.ts's
 * readGateLines missing-file->[] contract, so the tally can run safely
 * before all three arms have completed. */
function readResultsDoc(file: string): P2ResultsDoc {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as P2ResultsDoc
  } catch {
    return {}
  }
}

/** Tolerant ndjson read: missing file -> [] (mirrors
 * p0-signal-variance.ts's readGateLines). Malformed lines silently
 * dropped. */
function readReviewFindingsLines(file: string): ReviewFindingsLine[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: ReviewFindingsLine[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as ReviewFindingsLine)
    } catch {
      /* drop malformed line */
    }
  }
  return out
}

function isNumber(v: unknown): v is number {
  return typeof v === "number"
}
function isString(v: unknown): v is string {
  return typeof v === "string"
}

function main(): void {
  // Silent-done hardening (launch-0 rule, minimal/HISTORY.md 2026-08-09/10):
  // tally ONLY when all three arm results files exist. An rc=0 sized-go that
  // wrote no results files is a no-op, not a fast win — and the previous
  // tolerant read laundered exactly that into a structurally-valid all-zero
  // verdict once already. The per-file reads below stay tolerant of
  // MALFORMED content; existence is the hard bar.
  const missing = (["a1", "a3", "a4"] as P2Arm[]).map((a) => armResultsPath(a)).filter((p) => !fs.existsSync(p))
  if (missing.length > 0) {
    console.error(`p2-tally: refusing — missing arm results file(s):\n  ${missing.join("\n  ")}`)
    process.exit(1)
  }

  const docs: Record<P2Arm, P2ResultsDoc> = {
    a1: readResultsDoc(armResultsPath("a1")),
    a3: readResultsDoc(armResultsPath("a3")),
    a4: readResultsDoc(armResultsPath("a4")),
  }

  const stats: Record<P2Arm, ArmStatsCore> = {
    a1: computeArmStats(docs.a1),
    a3: computeArmStats(docs.a3),
    a4: computeArmStats(docs.a4),
  }

  // Provenance cross-check: k/model/ruleSha must agree across every arm
  // that actually has attempts (n > 0) — disagreement means the arms
  // weren't run against the same frozen configuration, a correctness bug
  // worth a hard die (mirrors results.ts's resumeCarryForward
  // driver-mismatch guard), never a silently-wrong verdict.
  const present = (["a1", "a3", "a4"] as P2Arm[]).filter((a) => stats[a].n > 0)
  const ks = new Set(present.map((a) => docs[a].k).filter(isNumber))
  const models = new Set(present.map((a) => docs[a].model).filter(isString))
  const ruleShas = new Set(present.map((a) => docs[a].harness?.ruleSha).filter(isString))
  if (ks.size > 1) {
    console.error(`p2-tally: k disagrees across arms: ${[...ks].join(", ")}`)
    process.exit(1)
  }
  if (models.size > 1) {
    console.error(`p2-tally: model disagrees across arms: ${[...models].join(", ")}`)
    process.exit(1)
  }
  if (ruleShas.size > 1) {
    console.error(`p2-tally: ruleSha disagrees across arms: ${[...ruleShas].join(", ")}`)
    process.exit(1)
  }

  const a3earnsRouting = earnsRouting(stats.a3.compliance, stats.a3.passAtK, stats.a1.passAtK)
  const a4earnsRouting = earnsRouting(stats.a4.compliance, stats.a4.passAtK, stats.a1.passAtK)

  const windowStart = present.reduce((min, a) => {
    const ts = docs[a].timestamp
    const parsed = ts ? Date.parse(ts) : Infinity
    return Math.min(min, parsed)
  }, Infinity)
  const windowEnd = Date.now()
  const b2Lines = readReviewFindingsLines(reviewFindingsNdjsonPath())
  const b2 = computeB2Shadow(b2Lines, Number.isFinite(windowStart) ? windowStart : 0, windowEnd)
  if (!b2.evidential) {
    console.log("shadow n too small, not evidential")
  }

  const output = {
    spec: SPEC_PATH,
    ruleSha: [...ruleShas][0] ?? "",
    band: BAND,
    k: [...ks][0] ?? 0,
    model: [...models][0] ?? "",
    arms: {
      a1: stats.a1,
      a3: { ...stats.a3, stopBlocks: computeA3StopBlocks(docs.a3) },
      a4: { ...stats.a4, ...computeA4Extra(docs.a4) },
    },
    bars: { a3earnsRouting, a4earnsRouting, complianceBar: COMPLIANCE_BAR, passDropBar: PASS_DROP_BAR },
    computeBonusCaveat: COMPUTE_BONUS_CAVEAT,
    b2Shadow: {
      host: os.hostname(),
      realizedN: b2.realizedN,
      eventsPerDay: b2.eventsPerDay,
      evidential: b2.evidential,
      windowStart: Number.isFinite(windowStart) ? windowStart : 0,
      windowEnd,
    },
  }

  const outFile = verdictOutPath()
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n")
  console.log(`p2-tally: wrote ${outFile}`)
}

if (import.meta.main) main()
