/**
 * self-score-correlate.ts — the best-of-k Phase 0 GATE computation.
 *
 * Reads a `--self-check` run's results (tasks[t].selfScores parallel to
 * tasks[t].rewards) and answers the load-bearing question: does the agent's own
 * self-verification predict the hidden TB2 grader? If it doesn't, best-of-k
 * selects noise → do NOT build the k-loop (plan Phase 0 gate).
 *
 * Reports three views, all over attempts with a non-null selfScore:
 *  - self-PASS lift: reward rate among self-PASS attempts minus the base rate.
 *  - best-of-k selection lift: per task, the reward of the ARGMAX-selfScore
 *    attempt (what best-of-k would actually keep), averaged, minus base — the
 *    most direct proxy for the feature's payoff.
 *  - point-biserial r: continuous selfScore vs binary reward.
 * The self-score is a self-report (see self-score.ts) — this measures whether
 * that self-report is trustworthy enough to select on.
 */

export interface ResultsLike {
  tasks: Record<string, { rewards: number[]; selfScores?: (number | null)[] }>
}

export interface CorrelationReport {
  nPairs: number
  nTasks: number
  minTasks: number
  baseRewardRate: number
  selfPassThreshold: number
  rewardRateGivenSelfPass: number
  liftSelfPass: number
  bestOfKSelectionRate: number
  bestOfKLift: number
  pointBiserial: number
  predictive: boolean
}

export interface CorrelateOpts {
  /** selfScore ≥ this counts as "self-PASS" (default 1.0 = agent claims all its
   * own checks passed). */
  selfPassThreshold?: number
  /** gate: predictive iff self-PASS lift ≥ this (default 0.20 = +20pp). */
  liftGate?: number
  /** gate: minimum self-check tasks (N) before a verdict is trustworthy
   * (default 30, per plan Phase 0). Below this, `predictive` is forced false —
   * a lucky handful of self-PASS runs must NOT greenlight the whole feature
   * (review R4#1). Tests override to exercise the lift axis on small fixtures. */
  minTasks?: number
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  // No variance in one axis → correlation is undefined; report 0 as "not
  // measurable" (review R4#3). Common when every attempt self-reports 1.0
  // (self-check optimism): a printed pointBiserial=0 then means "insufficient
  // variance to measure", NOT "measured zero correlation". It's a reported
  // diagnostic only — `predictive` gates on liftSelfPass, never on this.
  if (sxx === 0 || syy === 0) return 0
  return sxy / Math.sqrt(sxx * syy)
}

/** Compute the Phase 0 gate report from a `--self-check` results object. */
export function correlateSelfScores(results: ResultsLike, opts: CorrelateOpts = {}): CorrelationReport {
  const selfPassThreshold = opts.selfPassThreshold ?? 1.0
  const liftGate = opts.liftGate ?? 0.20
  const minTasks = opts.minTasks ?? 30

  const selfScores: number[] = []
  const rewards: number[] = []
  let bestOfKHits = 0
  let bestOfKTasks = 0

  for (const agg of Object.values(results.tasks)) {
    const ss = agg.selfScores
    if (!ss) continue
    let bestIdx = -1
    let bestScore = -Infinity
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i]
      const r = agg.rewards[i]
      if (s === null || s === undefined || r === undefined) continue
      selfScores.push(s)
      rewards.push(r)
      // argmax tie-break = FIRST attempt at the max score (strict `>`). At the
      // default threshold 1.0 many attempts self-report exactly 1.0, so ties
      // are common and this degenerates to "attempt 0" — a deliberate, honest
      // choice: with no discriminating self-score there's nothing to pick on
      // (review R4#4). bestOfKSelectionRate is reported, not gated, so this only
      // affects a diagnostic number.
      if (s > bestScore) { bestScore = s; bestIdx = i }
    }
    if (bestIdx >= 0) {
      bestOfKTasks++
      if (agg.rewards[bestIdx] === 1) bestOfKHits++
    }
  }

  const nPairs = rewards.length
  const baseRewardRate = nPairs ? rewards.reduce((a, b) => a + b, 0) / nPairs : 0
  const passIdx = selfScores.map((s, i) => (s >= selfPassThreshold ? i : -1)).filter((i) => i >= 0)
  const rewardRateGivenSelfPass = passIdx.length
    ? passIdx.reduce((a, i) => a + rewards[i]!, 0) / passIdx.length
    : 0
  const liftSelfPass = passIdx.length ? rewardRateGivenSelfPass - baseRewardRate : 0
  const bestOfKSelectionRate = bestOfKTasks ? bestOfKHits / bestOfKTasks : 0
  const bestOfKLift = bestOfKTasks ? bestOfKSelectionRate - baseRewardRate : 0
  const pointBiserial = pearson(selfScores, rewards)

  return {
    nPairs,
    nTasks: bestOfKTasks,
    minTasks,
    baseRewardRate,
    selfPassThreshold,
    rewardRateGivenSelfPass,
    liftSelfPass,
    bestOfKSelectionRate,
    bestOfKLift,
    pointBiserial,
    // Gate: ENOUGH DATA (N ≥ minTasks, the plan's mandatory ≥30-band-task
    // floor — review R4#1) + at least one self-PASS observation + self-PASS
    // lift clears the bar (the plan's ≥+20pp). Without the N floor the gate
    // fires PREDICTIVE on a single lucky self-PASS run.
    predictive: bestOfKTasks >= minTasks && passIdx.length >= 1 && liftSelfPass >= liftGate,
  }
}
