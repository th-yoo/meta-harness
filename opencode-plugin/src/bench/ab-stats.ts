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
import { pyFixed, pySigned } from "./util.ts"

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
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  alpha: 0.05,
  nonregressMargin: 0.05,
  hoGuardAlpha: 0.05,
}

export type TaskResults = Record<
  string,
  { candidate?: number[]; active?: number[]; error?: string }
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

/** Vendored seeded PRNG (mulberry32) — deterministic, no third-party deps. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
  const hoRegress =
    heldOut.delta < -cfg.nonregressMargin ||
    (heldOut.delta < 0 && pHoRev <= cfg.hoGuardAlpha)
  if (hoRegress) {
    reasons.push("held-out regression")
    return { decision: "reject", reasons }
  }

  if (winIn) {
    reasons.push("accept: held-in significant win, held-out non-regress")
    return { decision: "accept", reasons }
  }

  reasons.push("inconclusive: held-in win not significant")
  return { decision: "inconclusive", reasons }
}
