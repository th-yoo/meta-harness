/**
 * trial-verdict.ts — the §4.3 gate-outcomes trial VERDICT ENGINE (spec §6;
 * docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md;
 * plan Task 6, §11 items 4 and 10).
 *
 * Authority split (spec §6): this module COMPUTES — the `(sessionID, trialId)`
 * join, the §2 exclusion rules, the §5 three-floor fixed-N decision rule, the
 * futility projection, the §9 exposure-density guard, and the §4-rule-1
 * calibration-staleness refusal. It never touches the store: enactment is
 * `resolveGateTrial` (opencode-plugin/src/harness-store.ts), called from the
 * crank wiring (`runTrialScan` below hands the verdict over exactly once;
 * a `pending` verdict enacts nothing at all).
 *
 * Per-arm scoring reuses the scorecard's exported `scoreLines`
 * (cc-gate-plugin/src/score.ts) once per arm-filtered subset with
 * `pool: true`, so each arm collapses to one bucket; `scoreGroup` stays
 * unexported — the join and arm filtering live entirely here, upstream of
 * `scoreLines` (spec §6, verbatim). km-crank already imports cross-package
 * with relative paths (crank.ts → opencode-plugin/harness-store.ts); this
 * module mirrors that style. All cross-package imports here are TYPE-ONLY,
 * so nothing from those packages executes at km-crank runtime.
 */
import { classifyCycle, scoreLines, type GroupScore, type SensorLineIn } from "../../cc-gate-plugin/src/score.ts"
import type { ExposureRow, TrialArm } from "../../opencode-plugin/src/trial-arm.ts"
import type { GateTrialVerdict, TrialState } from "../../opencode-plugin/src/harness-store.ts"
import type { Calibration } from "./calibration.ts"
import type { SitrepAction, TrialSitrepDetail } from "./sitrep.ts"

// ── Registered constants (spec §5/§9 — byte-faithful, do not tune) ─────────

/** §5 floor 1: per-arm minimum gateCycles (clean + catch + exhausted). */
export const MIN_N = 20
/** §5 floor 2: per-arm minimum sessions-with-≥1-completion-gate-cycle. */
export const MIN_SESSIONS_PER_ARM = 5
/** §5 floor 3: pooled block-class events (catch + exhausted + interrupted,
 * summed across BOTH arms). Prose is not adopted on zero events. */
export const E_MIN = 5
/** §5: a trial may occupy the single live slot for at most 28 days. */
export const T_MAX_MS = 28 * 24 * 60 * 60 * 1000
/**
 * §9 exposure guard: the spec registers "a GROSS density divergence between
 * arms is VOID for that trial" without pinning a number; the build plan pins
 * the v0 constant at STRICTLY GREATER THAN 3x in either direction (plan
 * Task 6, "pick and COMMENT the threshold"). Exactly 3x is not gross.
 */
export const DENSITY_DIVERGENCE_FACTOR = 3
/** The divergence call needs both arms ≥5 sessions to be meaningful — a
 * 1-session arm's density is noise, not a tripwire (same 5-session shape as
 * the §5 session floor). */
export const DENSITY_GUARD_MIN_SESSIONS = 5

/**
 * §2: the kkamak-dev check group — this repo's own completion-gate check
 * (gate.json at the meta-harness repo root). The scorecard identifies the
 * group purely by check-string grouping (scorecard pre-reg §3: "the
 * meta-harness/kkamak repo's own check is a distinct value"), so the same
 * convention is encoded here as a constant. SINGLE-SOURCED by test:
 * trial-verdict.test.ts's drift guard asserts this equals the live
 * gate.json's `check` — if the repo's check string ever changes, that test
 * fails and this constant (and the historical-exclusion question it raises)
 * must be revisited deliberately, never silently.
 */
export const KKAMAK_DEV_CHECK =
  "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts"

const DAY_MS = 24 * 60 * 60 * 1000

// ── Interfaces (plan Task 6 — binding) ─────────────────────────────────────

export interface TrialEvaluationInput {
  /** rewardMode "gate-outcomes", not awaitingGo — the caller filters. */
  trial: TrialState
  /** Full stream(s), union of repos/hosts — the WHOLE trial window, never an
   * offset tail. */
  sensorLines: SensorLineIn[]
  exposureRows: ExposureRow[]
  now: number
  calibration: Calibration | null
  calibrationIsStale: boolean
}

/** §3 N_eff: three different denominators, printed separately so a thin arm
 * cannot hide behind a healthier-looking one.
 * - cycleCount: metric-eligible cycles (post-§2-exclusions, gauge-only out;
 *   includes interrupted — the M-interrupt denominator's extra class).
 * - sessionCount: distinct sessions with ≥1 included line (gauge-only IN —
 *   any sensor evidence the enrolled session actually ran).
 * - sessionsWithGateCycle: distinct sessions with ≥1 clean/catch/exhausted
 *   cycle — the quantity the §5 session floor checks. */
export interface ArmReport {
  cycleCount: number
  sessionCount: number
  sessionsWithGateCycle: number
  /** Pooled scorecard bucket for this arm (`scoreLines` with pool:true). */
  score: GroupScore
}

export type TrialVerdictOutcome = GateTrialVerdict | { verdict: "pending"; projection: string }

export interface TrialEvaluation {
  verdict: TrialVerdictOutcome
  perArm: { baseline: ArmReport; trial: ArmReport }
  /** §9 exposure guard. `voided` reports whether the guard TRIPPED (both
   * arms ≥ DENSITY_GUARD_MIN_SESSIONS and > FACTOR× divergence) — it is a
   * report field, computed regardless of which verdict branch fired. */
  exposureGuard: { densityBaseline: number; densityTrial: number; voided: boolean }
  /** §3 balance check: reinject-arm composition of each trial arm, over the
   * metric-included lines. A skewed split is a warning sign, never a void. */
  reinjectBalance: { baseline: { v0: number; v1: number }; trial: { v0: number; v1: number } }
}

// ── §2 join + exclusions ───────────────────────────────────────────────────

interface JoinedStream {
  /** Metric-eligible lines per arm (gauge-only excluded). */
  metrics: Record<TrialArm, SensorLineIn[]>
  /** Density-guard lines per arm (gauge-only INCLUDED — §9: gauge-only lines
   * witness a Stop the gate never armed for; tripwire, never a metric). */
  density: Record<TrialArm, SensorLineIn[]>
}

/**
 * The §2 inner join of the cycle stream on (sessionID, trialId) against the
 * exposure log, with every registered exclusion applied in order:
 *   1. no exposure row at all → excluded;
 *   2. row enrolled under a DIFFERENT trialId → session VOID for this trial
 *      (§2 boundary class — excluded from metrics AND density: its injected
 *      text may not match its recorded arm, so counting it anywhere would be
 *      silently wrong, not just noisy);
 *   3. forced row (KKAMAK_TRIAL_ARM override) → excluded — forced arms are
 *      never compared, enforced from the exposure record itself;
 *   4. ts outside [startedAt, now] → excluded (time-bounded join);
 *   5. kkamak-dev check group → excluded (workload = editing the gate
 *      itself, the exact confound this design exists to avoid);
 *   6. gauge-only (`rounds: []`, non-interrupted) → excluded from metrics,
 *      COUNTED for the density guard.
 *   7. skipped-stop (Task 1, fix-them-serialized-teacup plan) → excluded
 *      from BOTH metrics AND the density guard — a pure diagnostic class,
 *      unlike gauge-only. §9's gauge-only density-inclusion rationale
 *      ("witness a Stop the gate never armed for") does NOT apply here — a
 *      skipped-stop line means the gate WAS armed. Density inclusion would
 *      also let a prompt-queuing habit difference inflate density
 *      arbitrarily (repeated queued prompts emit one line each) and falsely
 *      trip `DENSITY_DIVERGENCE_FACTOR` (§9, below). See the pre-data spec
 *      amendment, docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md.
 *   8. prompt-check (Phase 3 Task 4, 5th pre-data amendment) → excluded from
 *      BOTH metrics AND the density guard, the same double exclusion as rule
 *      7 — three registered rationales, distinct from skipped-stop's single
 *      one: (a) wrong quantity — the detached check runs mid-turn against
 *      whatever half-finished state the agent left at the boundary, not the
 *      agent's own Stop-boundary claim of done, so scoring it would mix two
 *      different measurands under one `accepted` label; (b) false-void
 *      density risk — line count scales with per-session prompting habit
 *      exactly as skipped-stop's does, so density inclusion re-opens the
 *      exact §9 noise-void rule 7 closed; (c) no actuator exposure — the
 *      line is fabricated by a detached spawn, so the completion gate never
 *      delivered evidence to the agent at that boundary, meaning the line
 *      says nothing about either arm's candidate text in action. See the
 *      2026-07-31 amendment in the same pre-data spec.
 * Arm attribution comes from the exposure ROW (the record of what was
 * actually injected), never recomputed from the salt.
 */
function joinAndExclude(
  trial: TrialState,
  sensorLines: SensorLineIn[],
  exposureRows: ExposureRow[],
  now: number,
): JoinedStream {
  const rowBySession = new Map<string, ExposureRow>()
  for (const r of exposureRows) if (!rowBySession.has(r.sessionID)) rowBySession.set(r.sessionID, r)

  // trialId fallback unified with engine.ts's enrollment fallback
  // (engine.ts:379, `trial.trialId ?? trial.trial`) — a gate-outcomes trial
  // predating trialId's introduction, or any other absence, must join under
  // the same fallback the exposure rows were actually written under.
  // Defensive: a malformed startedAt degrades to an EMPTY window (nothing
  // joins → floors unmet → inert pending), never a bogus since-epoch window.
  const trialId = trial.trialId ?? trial.trial
  const parsedStart = Date.parse(trial.startedAt)
  const startMs = Number.isFinite(parsedStart) ? parsedStart : now

  const out: JoinedStream = {
    metrics: { baseline: [], trial: [] },
    density: { baseline: [], trial: [] },
  }
  for (const l of sensorLines) {
    const row = rowBySession.get(l.sessionID)
    if (!row) continue // §2: no matching exposure record at all
    if (row.trialId !== trialId) continue // §2: boundary class — session VOID
    if (row.forced) continue // §2: forced arms are never compared
    if (l.ts < startMs || l.ts > now) continue // §2: time-bounded join
    if (l.check === KKAMAK_DEV_CHECK) continue // §2: kkamak-dev group
    // Task 1 (fix-them-serialized-teacup plan): "skipped-stop" is excluded
    // from BOTH density and metrics — see the join-rule comment above
    // (rule 7). Gauge-only stays density-included per §9.
    // Phase 3 Task 4 (5th pre-data amendment): "prompt-check" gets the SAME
    // double exclusion — see rule 8 above (wrong quantity / density
    // false-void / no actuator exposure).
    const cls = classifyCycle(l)
    if (cls === "skipped-stop") continue
    if (cls === "prompt-check") continue
    out.density[row.arm].push(l)
    if (cls !== "gauge-only") out.metrics[row.arm].push(l)
  }
  return out
}

/** What scoreLines' unexported scoreGroup returns for zero lines — pool:true
 * with an empty subset yields no bucket at all, so the empty arm is
 * synthesized here (all-zero counts, every rate null/suppressed). */
function emptyGroupScore(): GroupScore {
  return {
    check: "(pooled)",
    host: "(pooled)",
    counts: { clean: 0, catch: 0, exhausted: 0, interrupted: 0, gaugeOnly: 0, skippedStop: 0, promptCheck: 0 },
    gateCycles: 0,
    underpowered: true,
    mCatch: null,
    mExhaust: null,
    mInterrupt: null,
    mTaxMedianMs: null,
    mRounds: [],
  }
}

function buildArmReport(metrics: SensorLineIn[], density: SensorLineIn[]): ArmReport {
  const score = metrics.length
    ? scoreLines(metrics, { pool: true, minN: MIN_N }).groups[0]!
    : emptyGroupScore()
  const gateSessionIds = new Set<string>()
  for (const l of metrics) {
    const c = classifyCycle(l)
    if (c === "clean" || c === "catch" || c === "exhausted") gateSessionIds.add(l.sessionID)
  }
  return {
    cycleCount: metrics.length,
    sessionCount: new Set(density.map((l) => l.sessionID)).size,
    sessionsWithGateCycle: gateSessionIds.size,
    score,
  }
}

// ── §5 decision rule (fixed-N, counts-only) ────────────────────────────────

export interface DecideInput {
  baseline: ArmReport
  trial: ArmReport
  /** catch + exhausted + interrupted, summed across BOTH arms (§5 floor 3). */
  pooledBlockEvents: number
  /** now − trial.startedAt. */
  elapsedMs: number
}

/** Days-to-floors at the current per-floor event rate; any unmet floor with
 * a zero rate projects "∞" (§6: futility projection, for the SITREP). */
function futilityProjection(i: DecideInput): string {
  const elapsedDays = i.elapsedMs / DAY_MS
  const deficits = [
    { have: i.baseline.score.gateCycles, need: MIN_N },
    { have: i.trial.score.gateCycles, need: MIN_N },
    { have: i.baseline.sessionsWithGateCycle, need: MIN_SESSIONS_PER_ARM },
    { have: i.trial.sessionsWithGateCycle, need: MIN_SESSIONS_PER_ARM },
    { have: i.pooledBlockEvents, need: E_MIN },
  ].filter((d) => d.have < d.need)
  let worstDays = 0
  for (const d of deficits) {
    const perDay = elapsedDays > 0 ? d.have / elapsedDays : 0
    if (perDay === 0) return "floors unmet — ∞ (zero event rate toward an unmet floor)"
    worstDays = Math.max(worstDays, (d.need - d.have) / perDay)
  }
  return `floors unmet — ~${worstDays.toFixed(1)}d to floors at current rate`
}

/**
 * The §5 registered decision rule, in order:
 *   1. floors — both arms gateCycles ≥ MIN_N, both arms
 *      sessions-with-gate-cycle ≥ 5, pooled block-class ≥ E_MIN;
 *      unmet + elapsed ≥ T_MAX → ROLLBACK "insufficient-events";
 *      unmet + under T_MAX → pending with the futility projection;
 *   2. floors met + any needed metric null → DEFERRED, NEVER coerced to 0.
 *      (With minN = MIN_N and floor 1 holding, scoreLines can't actually
 *      suppress these — the branch is a registered invariant kept as a hard
 *      guard against any future minN/floor drift, and is exercised directly
 *      by the truth-table tests.)
 *   3. KEEP iff mExhaust(T) ≤ mExhaust(B) AND mInterrupt(T) ≤ mInterrupt(B)
 *      AND mCatch(T) ≥ mCatch(B); otherwise ROLLBACK. Ties KEEP — KEEP means
 *      "not measurably worse", never "better" (§5 adoption semantics).
 */
export function decideTrialVerdict(i: DecideInput): TrialVerdictOutcome {
  const floorsMet =
    i.baseline.score.gateCycles >= MIN_N &&
    i.trial.score.gateCycles >= MIN_N &&
    i.baseline.sessionsWithGateCycle >= MIN_SESSIONS_PER_ARM &&
    i.trial.sessionsWithGateCycle >= MIN_SESSIONS_PER_ARM &&
    i.pooledBlockEvents >= E_MIN

  if (!floorsMet) {
    if (i.elapsedMs >= T_MAX_MS) return { verdict: "rollback", reason: "insufficient-events" }
    return { verdict: "pending", projection: futilityProjection(i) }
  }

  const b = i.baseline.score
  const t = i.trial.score
  const nulls: string[] = []
  for (const [name, v] of [
    ["mExhaust(B)", b.mExhaust],
    ["mExhaust(T)", t.mExhaust],
    ["mInterrupt(B)", b.mInterrupt],
    ["mInterrupt(T)", t.mInterrupt],
    ["mCatch(B)", b.mCatch],
    ["mCatch(T)", t.mCatch],
  ] as const) {
    if (v === null) nulls.push(name)
  }
  if (nulls.length > 0) return { verdict: "deferred", reason: `null-metric: ${nulls.join(", ")}` }

  const fails: string[] = []
  if (!(t.mExhaust! <= b.mExhaust!)) fails.push(`mExhaust(T)=${t.mExhaust!.toFixed(3)} > mExhaust(B)=${b.mExhaust!.toFixed(3)}`)
  if (!(t.mInterrupt! <= b.mInterrupt!)) fails.push(`mInterrupt(T)=${t.mInterrupt!.toFixed(3)} > mInterrupt(B)=${b.mInterrupt!.toFixed(3)}`)
  if (!(t.mCatch! >= b.mCatch!)) fails.push(`mCatch(T)=${t.mCatch!.toFixed(3)} < mCatch(B)=${b.mCatch!.toFixed(3)}`)
  if (fails.length === 0) return { verdict: "keep" }
  return { verdict: "rollback", reason: `three-clause-rule: ${fails.join("; ")}` }
}

// ── evaluateGateTrial — the full engine ────────────────────────────────────

function reinjectSplit(lines: SensorLineIn[]): { v0: number; v1: number } {
  let v0 = 0
  let v1 = 0
  for (const l of lines) {
    if (l.reinject === "v0") v0++
    else if (l.reinject === "v1") v1++
    // no reinject field → predates the experiment, belongs to neither arm
  }
  return { v0, v1 }
}

function densityOf(lines: SensorLineIn[]): { density: number; sessions: number } {
  const sessions = new Set(lines.map((l) => l.sessionID)).size
  return { density: sessions > 0 ? lines.length / sessions : 0, sessions }
}

function densityDiverged(a: number, b: number): boolean {
  if (a === 0 && b === 0) return false
  if (a === 0 || b === 0) return true // one arm produced NO cycles at all — infinitely divergent
  return Math.max(a, b) / Math.min(a, b) > DENSITY_DIVERGENCE_FACTOR
}

/**
 * Verdict branch ORDER (each earlier branch masks the later ones):
 *   1. calibration stale → pending "calibration-stale" (§4 rule 1: verdicts
 *      are refused while stale — checked BEFORE floors, enacts NOTHING),
 *      UNLESS the trial has already occupied the single live slot for
 *      ≥ T_MAX_MS, in which case the refusal is bounded by the same §5
 *      T_MAX backstop the floors branch uses: abandoned "calibration-stale"
 *      (pre-data spec amendment, 54238eb, TM6 review). Refusal alone is
 *      conservative (the trial stays live, the SITREP shows the refusal,
 *      recalibration un-blocks the next crank round) — but unbounded, a
 *      permanently-stale registry would occupy that slot forever, which
 *      T_MAX exists to prevent everywhere else in this engine.
 *   2. exposure-density gross divergence → abandoned "exposure-divergence"
 *      (§9: VOID for that trial, not silently pooled through).
 *   3. the §5 floors/T_MAX/null-metric/three-clause rule.
 */
export function evaluateGateTrial(i: TrialEvaluationInput): TrialEvaluation {
  const joined = joinAndExclude(i.trial, i.sensorLines, i.exposureRows, i.now)
  const baseline = buildArmReport(joined.metrics.baseline, joined.density.baseline)
  const trialArm = buildArmReport(joined.metrics.trial, joined.density.trial)

  const dB = densityOf(joined.density.baseline)
  const dT = densityOf(joined.density.trial)
  const voided =
    dB.sessions >= DENSITY_GUARD_MIN_SESSIONS &&
    dT.sessions >= DENSITY_GUARD_MIN_SESSIONS &&
    densityDiverged(dB.density, dT.density)

  const pooledBlockEvents =
    baseline.score.counts.catch + baseline.score.counts.exhausted + baseline.score.counts.interrupted +
    trialArm.score.counts.catch + trialArm.score.counts.exhausted + trialArm.score.counts.interrupted

  const parsedStart = Date.parse(i.trial.startedAt)
  const elapsedMs = i.now - (Number.isFinite(parsedStart) ? parsedStart : i.now)

  let verdict: TrialVerdictOutcome
  if (i.calibrationIsStale) {
    if (elapsedMs >= T_MAX_MS) {
      // §5 T_MAX backstop bounds the stale refusal too — see the branch-
      // order comment above evaluateGateTrial (pre-data amendment 54238eb).
      verdict = { verdict: "abandoned", reason: "calibration-stale" }
    } else {
      verdict = {
        verdict: "pending",
        projection:
          "calibration-stale — verdict refused (spec §4 rule 1): refresh the calibration registry before any verdict can be read",
      }
    }
  } else if (voided) {
    verdict = { verdict: "abandoned", reason: "exposure-divergence" }
  } else {
    verdict = decideTrialVerdict({ baseline, trial: trialArm, pooledBlockEvents, elapsedMs })
  }

  return {
    verdict,
    perArm: { baseline, trial: trialArm },
    exposureGuard: { densityBaseline: dB.density, densityTrial: dT.density, voided },
    reinjectBalance: {
      baseline: reinjectSplit(joined.metrics.baseline),
      trial: reinjectSplit(joined.metrics.trial),
    },
  }
}

// ── runTrialScan — the crank-facing seam ───────────────────────────────────

/** Injected IO so the wiring is unit-testable without a real store, git, or
 * sensor files. crank.ts supplies the real implementations. */
export interface TrialScanDeps {
  readTrial(storeRoot: string): TrialState | null
  /** The repo's project-global layer root (v0 scope, spec §1). */
  projectGlobalRootFor(repo: string): string
  /** FULL sensor stream for the repo — the whole file, never the crank's
   * positions-offset tail: the verdict wants the entire trial window. */
  readFullSensorLines(repo: string): SensorLineIn[]
  readExposureRows(repo: string): ExposureRow[]
  /** §7 (deferred from TM6, built alongside scripts/km-sensors-sync.sh):
   * per-host age of the COMMITTED sensor snapshot for `repo`
   * (evidence/kkamak-sensors/<host>/), distinct from the live `.km/` stream
   * `readFullSensorLines` reads. crank.ts wires this to
   * snapshot-age.ts's readSnapshotAges. */
  readSnapshotAges(repo: string): { host: string; ageDays: number }[]
  readCalibration(): Calibration | null
  calibrationStale(cal: Calibration | null): boolean
  resolveGateTrial(
    storeRoot: string,
    v: GateTrialVerdict,
  ): { action: "kept" | "rolled-back" | "deferred" | "abandoned" | "none" }
  now: number
}

export interface TrialScanResult {
  repo: string
  scope: string
  action: SitrepAction
  /** Absent only for the golden-window refusal branch below — that branch
   * never runs evaluateGateTrial at all. */
  evaluation?: TrialEvaluation
}

/**
 * §5 acceptance criterion: the trial scan is independent of propose-target
 * selection — every repo's project-global layer is checked for a live
 * gate-outcomes trial, REGARDLESS of which repo wins the round's
 * new-line-volume contest. At most one trial is live anywhere (declared
 * convention, spec §1), so the scan handles the FIRST one found and stops;
 * a convention-breaching second trial simply waits for the next round.
 *
 * Enactment discipline (behavior contracts): `resolveGateTrial` is called
 * EXACTLY ONCE per non-pending verdict; a `pending` verdict enacts nothing
 * (no store touch at all). Calibration is only read/staleness-checked once a
 * live trial is actually found — no git shell-out on trial-less rounds.
 */
export function runTrialScan(repos: string[], deps: TrialScanDeps): TrialScanResult | null {
  for (const repo of repos) {
    const root = deps.projectGlobalRootFor(repo)
    const trial = deps.readTrial(root)
    // Legacy trials (no rewardMode) belong to the old resolveTrial; queued
    // awaitingGo trials are inert everywhere until human-go (plan Global
    // Constraints).
    if (!trial || trial.rewardMode !== "gate-outcomes" || trial.awaitingGo) continue

    // Golden-window refusal guard: the golden machinery (every-3rd-KEEP
    // queueing, golden human-go, golden T_MAX keep-incumbent rules) is
    // unbuilt, and nothing can start a golden trial today — ruling: refuse,
    // don't build (found at the §4.3 build's final whole-branch review;
    // registered deferral, docs/explicitly-not-now.md §7.8). Without this
    // guard the generic T_MAX/three-clause path below would enact the
    // §5-forbidden rollback-vs-incumbent decision on a golden window. Checked
    // BEFORE evaluateGateTrial runs at all — enacts NOTHING, no store touch.
    if (trial.golden) {
      const scope = `project-global @ ${repo}`
      return {
        repo,
        scope,
        action: {
          kind: "trial-pending",
          scope,
          projection:
            "golden-window machinery unbuilt — registered deferral (explicitly-not-now §7.8); no verdict will be read until it lands",
        },
      }
    }

    const sensorLines = deps.readFullSensorLines(repo)
    const cal = deps.readCalibration()
    const evaluation = evaluateGateTrial({
      trial,
      sensorLines,
      exposureRows: deps.readExposureRows(repo),
      now: deps.now,
      calibration: cal,
      calibrationIsStale: deps.calibrationStale(cal),
    })

    const scope = `project-global @ ${repo}`
    const triplet = (a: ArmReport) => ({
      cycleCount: a.cycleCount,
      sessionCount: a.sessionCount,
      sessionsWithGateCycle: a.sessionsWithGateCycle,
    })
    const detail: TrialSitrepDetail = {
      perArm: { baseline: triplet(evaluation.perArm.baseline), trial: triplet(evaluation.perArm.trial) },
      // §7: per-host coverage over the full stream READ (joined or not) — a
      // one-host-only read is visible in the SITREP, never silently complete.
      hosts: [...new Set(sensorLines.map((l) => l.host))],
      // §7 (deferred from TM6): age of each host's COMMITTED snapshot, so a
      // stale cross-host read is visible too, not just a missing-host read.
      snapshotAges: deps.readSnapshotAges(repo),
    }

    const v = evaluation.verdict
    if (v.verdict === "pending") {
      // Pending enacts NOTHING — the trial stays live; decideGate's existing
      // trialInProgress check keeps the layer un-proposed-on.
      return { repo, scope, evaluation, action: { kind: "trial-pending", scope, projection: v.projection, detail } }
    }

    const enacted = deps.resolveGateTrial(root, v)
    switch (enacted.action) {
      case "kept":
        return { repo, scope, evaluation, action: { kind: "trial-keep", scope, trial: trial.trial, detail } }
      case "rolled-back":
        return {
          repo, scope, evaluation,
          action: {
            kind: "trial-rollback", scope, trial: trial.trial,
            reason: v.verdict === "rollback" ? v.reason : "(rollback enacted)",
            detail,
          },
        }
      case "deferred":
        return {
          repo, scope, evaluation,
          action: {
            kind: "trial-deferred", scope,
            reason: v.verdict === "deferred" ? v.reason : "(deferred)",
            detail,
          },
        }
      case "abandoned":
        return {
          repo, scope, evaluation,
          action: {
            kind: "trial-abandoned", scope,
            // resolveGateTrial abandons on its own when active changed under
            // the trial, whatever verdict it was handed — surface that reason.
            reason: v.verdict === "abandoned" ? v.reason : "active version changed under trial",
            detail,
          },
        }
      case "none":
        // The trial raced away (cleared/changed) between readTrial and
        // enactment — nothing was enacted, nothing to report this round.
        return null
    }
  }
  return null
}
