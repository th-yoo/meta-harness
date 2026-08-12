/**
 * ab-stats.ts — statistics for the Phase 1 A/B selection gate.
 *
 * Ported from term-bench2/ab_stats.py. Pure functions, no I/O, no
 * third-party deps. The inferential unit is the *run-pair*: arm A (active)
 * run i and arm B (candidate) run i of the same task, interleaved by
 * cmd_ab. McNemar's exact test on the discordant pairs is the cheap screen;
 * a bootstrap-over-tasks CI is the clustering-aware confirmatory statistic.
 *
 * Two deliberate behavioral deviations from the Python source (see the brief
 * for term-bench2/ab_stats.py for the full rationale):
 *  - mcnemarExactOneSided sums the binomial tail with BigInt. Python's
 *    `math.comb` is arbitrary precision and n (=b+c) can reach ~200 pairs,
 *    where C(200,100) ~= 9e58 overflows a JS double. BigInt keeps the tail
 *    sum and the 2**n denominator exact; only the final ratio is converted
 *    to a number, at 1e-18 relative precision.
 *  - bootstrapTaskCi ports the *algorithm* of Python's random.Random(seed),
 *    not its bit stream (which is irreproducible outside CPython). It
 *    vendors a seeded mulberry32 PRNG instead, so results are deterministic
 *    under a seed but numerically different from the Python run.
 */
import { pyFixed, pySigned, mulberry32 } from "./util.ts"

export { mulberry32 } from "./util.ts"

export interface PairStats {
  nTasks: number
  nPairs: number
  b: number // discordant run-pairs where candidate passed, active failed
  c: number // discordant run-pairs where active passed, candidate failed
  candPass: number // total candidate passes across all run-pairs
  actPass: number // total active passes
  delta: number // mean paired per-run delta (candidate - active), 0 when nPairs=0
  taskDeltas: Record<string, number> // task -> mean(candidate rewards) - mean(active rewards)
}

export interface DecisionConfig {
  alpha: number // held-in significance threshold
  nonregressMargin: number // tolerated held-out point drop
  hoGuardAlpha: number // held-out "significantly worse" guard
  // Phase 3 W1c (speed tiebreaker): opt-in, absent/undefined = off (the
  // pre-existing reward-only gate, byte-identical). When present, splits.ts's
  // abDecision may upgrade an `inconclusive` verdict to `accept` — see that
  // function's doc comment for the full structural-guard list (ho !== null,
  // held-in delta >= 0, !earlyStopped, plus these thresholds on
  // pairedSpeedStats(heldIn)).
  speedTiebreak?: SpeedTiebreakConfig
}

export interface SpeedTiebreakConfig {
  alpha: number // one-sided sign-test significance threshold on the speed pairs
  maxMedianRatio: number // medianRatio (candidate/active) must be <= this to count as "significantly faster"
  minBothPassPairs: number // pairedSpeedStats(heldIn).nPairs must be >= this
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  alpha: 0.05,
  nonregressMargin: 0.05,
  hoGuardAlpha: 0.05,
}

// Phase 3 W1c defaults — cmd-ab.ts wires this in when `--speed-tiebreak` is
// passed; DEFAULT_DECISION_CONFIG above deliberately omits speedTiebreak so
// every OTHER caller (existing tests, flag-off runs) stays byte-identical.
export const DEFAULT_SPEED_TIEBREAK_CONFIG: SpeedTiebreakConfig = {
  alpha: 0.05,
  maxMedianRatio: 0.8,
  minBothPassPairs: 8,
}

export type TaskResults = Record<
  string,
  {
    candidate?: number[]
    active?: number[]
    error?: string
    // W1a (time-to-resolve): per-run agent-phase elapsed seconds, index-
    // aligned with candidate/active. Optional — absent on pre-feature
    // entries, which simply drop out of pairedSpeedStats (see its doc
    // comment).
    candidateElapsed?: number[]
    activeElapsed?: number[]
  }
>

/**
 * Aggregate {task: {candidate:[rewards], active:[rewards], error?}} into
 * PairStats. Tasks with a truthy `error` (e.g. setup_failed) are excluded
 * from every count.
 */
export function pairedRunStats(taskResults: TaskResults): PairStats {
  let b = 0
  let c = 0
  let candPass = 0
  let actPass = 0
  let nPairs = 0
  let nTasks = 0
  const taskDeltas: Record<string, number> = {}

  for (const [task, tr] of Object.entries(taskResults)) {
    if (tr.error) continue
    const cand = tr.candidate ?? []
    const act = tr.active ?? []
    const m = Math.min(cand.length, act.length)
    if (m === 0) continue
    nTasks += 1
    let tc = 0
    let ta = 0
    for (let i = 0; i < m; i++) {
      const rc = cand[i]!
      const ra = act[i]!
      candPass += rc
      actPass += ra
      tc += rc
      ta += ra
      nPairs += 1
      if (rc === 1 && ra === 0) {
        b += 1
      } else if (rc === 0 && ra === 1) {
        c += 1
      }
    }
    taskDeltas[task] = (tc - ta) / m
  }

  const delta = nPairs ? (candPass - actPass) / nPairs : 0.0
  return { nTasks, nPairs, b, c, candPass, actPass, delta, taskDeltas }
}

/**
 * One-sided McNemar exact p-value for the hypothesis that the candidate is
 * better: P(X >= b) where X ~ Binomial(b+c, 0.5). Small p = candidate wins
 * the discordant pairs more than chance. Returns 1.0 when there are no
 * discordant pairs.
 *
 * Uses BigInt binomial coefficients + a BigInt 2**n denominator so n up to
 * ~200 (where C(200,100) ~= 9e58) doesn't overflow a JS double; only the
 * final ratio is converted to `number`.
 */
export function mcnemarExactOneSided(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1.0

  const bigN = BigInt(n)
  let tail = 0n
  for (let k = b; k <= n; k++) {
    tail += binomialCoefficient(bigN, BigInt(k))
  }
  const denom = 1n << bigN // 2**n

  return bigRatioToNumber(tail, denom)
}

/**
 * num/den as a `number`, for arbitrarily large BigInt num/den (num <= den).
 * A fixed decimal scale (e.g. `* 10n**18n`) underflows to exactly 0 once the
 * true ratio is smaller than the scale's resolution — which happens well
 * within the ~200-pair range this module needs (2**-200 ~= 6e-61). Instead,
 * left-shift by a fixed number of *bits* before the integer division: the
 * shifted quotient is bounded by 2**SHIFT regardless of how large num/den
 * are, so it always converts to a finite, precise `number`, and it stays
 * nonzero as long as the true ratio exceeds ~2**-SHIFT (with SHIFT=300,
 * i.e. ratios down to ~5e-91 — comfortably below anything reachable at
 * n<=200).
 */
function bigRatioToNumber(num: bigint, den: bigint): number {
  if (num === 0n) return 0
  const SHIFT = 300n
  const scaled = (num << SHIFT) / den
  return Number(scaled) / 2 ** Number(SHIFT)
}

function binomialCoefficient(n: bigint, k: bigint): bigint {
  if (k < 0n || k > n) return 0n
  const kk = k > n - k ? n - k : k
  let result = 1n
  for (let i = 0n; i < kk; i++) {
    result = (result * (n - i)) / (i + 1n)
  }
  return result
}

/**
 * Bootstrap CI on the mean per-task delta, resampling *tasks* with
 * replacement (respects within-task clustering). Returns the
 * (alpha/2, 1-alpha/2) percentiles — a (1-alpha) two-sided interval, e.g. a
 * 90% CI at alpha=0.10. Deterministic under `seed`.
 *
 * Ports the algorithm, not Python's `random.Random` bit stream (see file
 * header) — uses a vendored mulberry32 PRNG instead.
 */
export function bootstrapTaskCi(
  taskDeltas: Iterable<number>,
  nBoot = 10_000,
  alpha = 0.1,
  seed = 0,
): [number, number] {
  const deltas = Array.from(taskDeltas)
  if (deltas.length === 0) return [0.0, 0.0]

  const rand = mulberry32(seed)
  const randrange = (n: number) => Math.floor(rand() * n)

  const n = deltas.length
  const means: number[] = []
  for (let i = 0; i < nBoot; i++) {
    let s = 0.0
    for (let j = 0; j < n; j++) {
      s += deltas[randrange(n)]!
    }
    means.push(s / n)
  }
  means.sort((a, b) => a - b)

  const lo = means[Math.max(0, Math.floor((alpha / 2) * nBoot) - 1)]!
  const hi = means[Math.min(nBoot - 1, Math.floor((1 - alpha / 2) * nBoot))]!
  return [round4(lo), round4(hi)]
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

export interface SpeedStats {
  nPairs: number
  nTasks: number
  medianCandidate: number // median agent-phase elapsed seconds, candidate arm
  medianActive: number // median agent-phase elapsed seconds, active arm
  medianRatio: number // median over PER-PAIR candidate/active ratios; <1 = candidate faster
  fasterB: number // pairs where candidate's elapsed < active's (mirrors pairedRunStats' b)
  slowerC: number // pairs where active's elapsed < candidate's (mirrors pairedRunStats' c)
  signTestP: number // mcnemarExactOneSided(fasterB, slowerC) — one-sided exact sign test
}

/**
 * Paired time-to-resolve stats (report-only in this phase — a later phase
 * wires it as a decision tiebreaker). A run-pair counts iff BOTH candidate
 * and active rewards are exactly 1 at that index AND both elapsed values are
 * present and >0 — a fast failure is never a meaningful speed signal, so
 * fail times are never compared. Reuses mcnemarExactOneSided as an exact
 * one-sided sign test on which arm was faster, mirroring pairedRunStats' b/c
 * discordant-pair convention (fasterB/slowerC here, not win/loss counts).
 * medianRatio is the median over PER-PAIR candidate/active ratios — NOT the
 * ratio of the pooled medians, which weights arms independently and can
 * disagree with the paired construction (e.g. pairs 10/20 + 30/10: per-pair
 * median 1.75 vs 20/15 ≈ 1.33). Returns null when there are no qualifying
 * pairs.
 */
export function pairedSpeedStats(taskResults: TaskResults): SpeedStats | null {
  const candidates: number[] = []
  const actives: number[] = []
  const ratios: number[] = []
  let fasterB = 0
  let slowerC = 0
  let nTasks = 0

  for (const tr of Object.values(taskResults)) {
    if (tr.error) continue
    const cand = tr.candidate ?? []
    const act = tr.active ?? []
    const candElapsed = tr.candidateElapsed ?? []
    const actElapsed = tr.activeElapsed ?? []
    const m = Math.min(cand.length, act.length, candElapsed.length, actElapsed.length)
    let taskHasPair = false
    for (let i = 0; i < m; i++) {
      if (cand[i] !== 1 || act[i] !== 1) continue
      const ce = candElapsed[i]!
      const ae = actElapsed[i]!
      if (!(ce > 0) || !(ae > 0)) continue
      candidates.push(ce)
      actives.push(ae)
      ratios.push(ce / ae)
      taskHasPair = true
      if (ce < ae) fasterB += 1
      else if (ce > ae) slowerC += 1
    }
    if (taskHasPair) nTasks += 1
  }

  const nPairs = candidates.length
  if (nPairs === 0) return null

  const medianCandidate = median(candidates)
  const medianActive = median(actives)
  const medianRatio = median(ratios)
  const signTestP = mcnemarExactOneSided(fasterB, slowerC)

  return { nPairs, nTasks, medianCandidate, medianActive, medianRatio, fasterB, slowerC, signTestP }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * Early-KILL only (never early-accept, so no alpha inflation): stop once the
 * candidate is `netBehind` discordant pairs behind after `minTasks`
 * completed.
 */
export function futilityStop(
  b: number,
  c: number,
  tasksDone: number,
  minTasks = 12,
  netBehind = 3,
): boolean {
  return tasksDone >= minTasks && c - b >= netBehind
}

export interface Decision {
  decision: "accept" | "reject" | "inconclusive"
  reasons: string[]
}

/**
 * accept  iff  held-in wins significantly (delta>0, McNemar p<=alpha) AND a
 *              held-out split exists AND held-out shows no regression.
 * reject  if   active wins held-in significantly, or held-out regresses.
 * else    inconclusive (the common case at these sample sizes).
 */
export function decide(
  heldIn: PairStats,
  heldOut: PairStats | null,
  cfg: DecisionConfig,
): Decision {
  const reasons: string[] = []
  const pIn = mcnemarExactOneSided(heldIn.b, heldIn.c)
  const pInRev = mcnemarExactOneSided(heldIn.c, heldIn.b)
  reasons.push(
    `held-in: delta=${pySigned(heldIn.delta, 3)} p=${pyFixed(pIn, 3)} ` +
      `(b=${heldIn.b},c=${heldIn.c},n=${heldIn.nPairs})`,
  )

  if (heldIn.delta < 0 && pInRev <= cfg.alpha) {
    reasons.push("active significantly better on held-in")
    return { decision: "reject", reasons }
  }

  const winIn = heldIn.delta > 0 && pIn <= cfg.alpha

  if (heldOut === null) {
    reasons.push("no held-out split (legacy mode) — cannot accept")
    return { decision: "inconclusive", reasons }
  }

  const pHoRev = mcnemarExactOneSided(heldOut.c, heldOut.b)
  reasons.push(
    `held-out: delta=${pySigned(heldOut.delta, 3)} p_active=${pyFixed(pHoRev, 3)} ` +
      `(b=${heldOut.b},c=${heldOut.c},n=${heldOut.nPairs})`,
  )
  // Reject is permanent (feeds the do-not-re-derive ledger), so it demands
  // statistical support — a point estimate past the margin alone proved to
  // fire on pure noise (v18 crank: delta −0.10 at p_active=0.377, erased by
  // a single pair-flip of 20). The margin therefore only VETOES accept.
  const hoRegressSignificant = heldOut.delta < 0 && pHoRev <= cfg.hoGuardAlpha
  if (hoRegressSignificant) {
    reasons.push("held-out regression")
    return { decision: "reject", reasons }
  }

  const hoMarginVeto = heldOut.delta < -cfg.nonregressMargin
  if (hoMarginVeto) {
    reasons.push("held-out margin regression (not significant) — cannot accept")
    return { decision: "inconclusive", reasons }
  }

  if (winIn) {
    reasons.push("accept: held-in significant win, held-out non-regress")
    return { decision: "accept", reasons }
  }

  reasons.push("inconclusive: held-in win not significant")
  return { decision: "inconclusive", reasons }
}
