/**
 * leaderboard.ts — PURE curation math for the Terminal-Bench-2 leaderboard
 * sweep (Phase 4 / W2a). No I/O here — reading matrix.json, tiers.json,
 * splits.json/results (via splits.ts's taskPassRates), and localTasks
 * (readdir of the TB2 checkout) all live in the driver,
 * term-bench2/leaderboard/curate-band.ts.
 *
 * `matrix.json` (built by term-bench2/leaderboard/pull-leaderboard.ts, one
 * committed file per repo) has the shape `Matrix` below: task -> submission
 * -> pass rate in [0,1] (mean of that submission's k trials' 0/1 reward for
 * that task). Coverage is sparse BY DESIGN — some submissions report fewer
 * than the full 89-task suite, or a different k — so a (task, sub) pair
 * simply absent from the matrix means "that submission never reported that
 * task", not "reward 0". All the functions below compute over ONLY the subs
 * present for a given task; they never impute a missing pair.
 */

export type Matrix = Record<string, Record<string, number>>

/** sub (submission id, e.g. "NexAU-AHE__gpt-5.5") -> hand-assigned capability
 * tier. See term-bench2/leaderboard/tiers.json for the maintained map. */
export type TiersMap = Record<string, string>

export interface TaskStats {
  /** Mean pass rate across every submission that reported this task.
   * null only when coverage is 0 (task not present in the matrix at all). */
  mean: number | null
  /** Population variance across the same submissions. null below the
   * `minSubs` coverage floor — untrusted, too few data points to mean
   * anything (a submission or two of noise can swing it wildly). */
  variance: number | null
  /** Number of submissions that reported this task. */
  coverage: number
}

export interface TierTaskStats extends TaskStats {
  /** Per-tier mean pass rate, tiers with zero reporting subs omitted. */
  tierMeans: Record<string, number>
  /** Number of distinct tiers with at least one reporting sub. */
  tiersCovered: number
}

/**
 * Per-task mean/variance of pass rate across whichever submissions reported
 * that task, gated by a minimum-coverage floor: below `minSubs` reporting
 * submissions, `variance` is null ("untrusted") even though `mean` is still
 * reported (a mean of 1 data point is still a mean, just not a variance).
 * Default minSubs=4 per the W2a spec.
 */
export function harnessVariance(matrix: Matrix, minSubs = 4): Record<string, TaskStats> {
  const out: Record<string, TaskStats> = {}
  for (const task of Object.keys(matrix)) {
    const rates = Object.values(matrix[task] ?? {})
    const coverage = rates.length
    if (coverage === 0) {
      out[task] = { mean: null, variance: null, coverage: 0 }
      continue
    }
    const mean = rates.reduce((a, b) => a + b, 0) / coverage
    const variance = coverage < minSubs ? null : rates.reduce((a, r) => a + (r - mean) ** 2, 0) / coverage
    out[task] = { mean, variance, coverage }
  }
  return out
}

/**
 * Per-task variance of pass rate BETWEEN capability tiers (tierMeans), as
 * opposed to `harnessVariance`'s variance across raw per-submission values.
 * This filters out within-tier harness noise: a task where two harnesses on
 * the SAME model tier disagree wildly (raw variance high) but every tier's
 * mean lands in the same place (tier variance ~0) is not actually
 * discriminating by capability — it's noisy, not informative. Conversely a
 * task where all frontier subs pass and all mid subs fail is exactly the
 * kind of task band curation wants (tier variance high).
 *
 * Trust gating: variance is null unless coverage >= minSubs (same floor as
 * harnessVariance) AND at least 2 distinct tiers reported the task — a
 * single tier's variance is trivially 0 and would look (falsely) like "no
 * discrimination" rather than "not enough tiers to tell".
 * Submissions absent from `tiers` (unmapped) still count toward `coverage`
 * but are excluded from tier grouping.
 */
export function tierVariance(matrix: Matrix, tiers: TiersMap, minSubs = 4): Record<string, TierTaskStats> {
  const out: Record<string, TierTaskStats> = {}
  for (const task of Object.keys(matrix)) {
    const cells = matrix[task] ?? {}
    const subs = Object.keys(cells)
    const coverage = subs.length
    if (coverage === 0) {
      out[task] = { mean: null, variance: null, coverage: 0, tierMeans: {}, tiersCovered: 0 }
      continue
    }
    const byTier: Record<string, number[]> = {}
    for (const sub of subs) {
      const tier = tiers[sub]
      if (tier === undefined) continue
      ;(byTier[tier] ??= []).push(cells[sub]!)
    }
    const tierMeans: Record<string, number> = {}
    for (const [tier, rs] of Object.entries(byTier)) {
      tierMeans[tier] = rs.reduce((a, b) => a + b, 0) / rs.length
    }
    const tiersCovered = Object.keys(tierMeans).length

    const allRates = Object.values(cells)
    const mean = allRates.reduce((a, b) => a + b, 0) / allRates.length

    let variance: number | null = null
    if (coverage >= minSubs && tiersCovered >= 2) {
      const tierVals = Object.values(tierMeans)
      const tMean = tierVals.reduce((a, b) => a + b, 0) / tierVals.length
      variance = tierVals.reduce((a, v) => a + (v - tMean) ** 2, 0) / tierVals.length
    }
    out[task] = { mean, variance, coverage, tierMeans, tiersCovered }
  }
  return out
}

export interface CurateOptions {
  /** [lo, hi] band on the cross-harness MEAN pass rate — same "sweet spot,
   * not too easy / not too hard" semantics as splits.ts's bandPartition,
   * applied here to leaderboard-wide difficulty rather than our own rate. */
  band: [number, number]
  /** Task names present in the local TB2 checkout (has a task.toml) — the
   * driver derives this via readdir, never hardcoded (see curate-band.ts). */
  localTasks: string[]
  /** Cap on the size of the returned `band` list (highest-variance kept). */
  max: number
  /** Minimum-coverage floor forwarded to (and re-checked against) `stats`;
   * default 4, matching harnessVariance/tierVariance's own default. */
  minSubs?: number
}

export interface CurateResult {
  /** Final curated task list: in the difficulty band, variance-trusted,
   * present locally, AND we already have our own pass rate for it. Sorted
   * deterministically — variance descending, ties broken alphabetically —
   * and capped at `max`. */
  band: string[]
  /** Same qualification as `band` but we have no local ourRates entry yet —
   * needs a bench run before it can be trusted enough to promote. Same sort,
   * uncapped. */
  shortlist: string[]
  /** Qualifies on variance/band criteria but isn't in the local TB2
   * checkout at all — needs `bench task-load` to fetch it first. Sorted
   * alphabetically (no variance-ranking stake in exclusion order). */
  excludedNonLocal: string[]
}

/**
 * Select the candidate task band: filter `stats` to tasks whose mean falls
 * in `opts.band` AND whose variance is trusted (coverage >= minSubs — stats
 * already nulls untrusted variance, but the coverage check is re-applied
 * here defensively so a caller-constructed `stats` with a non-null variance
 * under a stricter minSubs than it was computed with still gets excluded).
 * Qualifying tasks are then partitioned by local-availability and
 * our-rate-availability into `band` / `shortlist` / `excludedNonLocal`.
 */
export function curateBand(
  stats: Record<string, TaskStats>,
  ourRates: Record<string, number>,
  opts: CurateOptions,
): CurateResult {
  const [lo, hi] = opts.band
  const minSubs = opts.minSubs ?? 4
  const localSet = new Set(opts.localTasks)

  const qualifying = Object.keys(stats)
    .filter((t) => {
      const s = stats[t]!
      if (s.variance === null || s.mean === null) return false
      if (s.coverage < minSubs) return false
      return s.mean >= lo && s.mean <= hi
    })
    .sort((a, b) => a.localeCompare(b))

  const excludedNonLocal: string[] = []
  const localQualifying: string[] = []
  for (const t of qualifying) {
    if (localSet.has(t)) localQualifying.push(t)
    else excludedNonLocal.push(t)
  }

  const band: string[] = []
  const shortlist: string[] = []
  for (const t of localQualifying) {
    if (ourRates[t] === undefined) shortlist.push(t)
    else band.push(t)
  }

  const byVarianceDesc = (a: string, b: string): number => {
    const va = stats[a]!.variance ?? 0
    const vb = stats[b]!.variance ?? 0
    if (vb !== va) return vb - va
    return a.localeCompare(b)
  }
  band.sort(byVarianceDesc)
  shortlist.sort(byVarianceDesc)
  excludedNonLocal.sort((a, b) => a.localeCompare(b))

  return {
    band: band.slice(0, opts.max),
    shortlist,
    excludedNonLocal,
  }
}
