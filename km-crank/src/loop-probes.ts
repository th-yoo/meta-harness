/**
 * Loop-probes — pure logic (no I/O, no process, no imports).
 *
 * Design (docs/superpowers/plans/2026-08-05-loop-probes.md, spec
 * docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md):
 * ndjson gate-outcomes line parsing, boundary-split (regime segmentation),
 * per-family descriptive stats + viability floors, and the E (effect-size)
 * sample-size / days-to-verdict formulas. Everything here is a pure
 * function over plain data — the thin CLIs in scripts/ bind real files,
 * this module never touches disk, network, or the clock, mirroring
 * km-crank/src/gate-check-core.ts's style.
 */

/** One parsed gate-outcomes ndjson line. Every field beyond `ts` is
 * optional: different check kinds / plugin versions emit different
 * shapes, and a probe must degrade gracefully rather than reject. */
export interface GateLine {
  ts: number
  accepted?: boolean
  gateExhausted?: boolean
  rounds?: unknown[]
  durationMs?: number
  pluginVersion?: string
  check?: string
  host?: string
}

/** Tolerant JSON parse of a gate-outcomes line. Missing/malformed/not an
 * object/non-numeric `ts` -> undefined: a broken line must degrade to
 * "skip it", never crash a probe run over a big ndjson file. */
export function parseGateLine(raw: string): GateLine | undefined {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return undefined }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.ts !== "number") return undefined
  return o as unknown as GateLine
}

/** Ordered segments split at `boundaries` (sorted + deduped internally).
 * A line with ts === boundary belongs to the POST segment (i.e. segment
 * i covers ts in [boundaries[i-1], boundaries[i]) with boundaries[-1] =
 * -Infinity and boundaries[boundaries.length] = +Infinity). Empty
 * segments are preserved: segments.length === boundaries.length + 1. */
export function splitAtBoundaries<T extends { ts: number }>(lines: T[], boundaries: number[]): T[][] {
  const bs = [...new Set(boundaries)].sort((a, b) => a - b)
  const segments: T[][] = Array.from({ length: bs.length + 1 }, () => [])
  for (const line of lines) {
    // segment index = count of boundaries <= line.ts (ts === boundary -> POST)
    let idx = 0
    for (const b of bs) if (line.ts >= b) idx++
    segments[idx]!.push(line)
  }
  return segments
}

/** Stable regime label for grouping: "<pluginVersion|unknown>@<segment index>". */
export function regimeKey(line: GateLine, boundaries: number[]): string {
  const bs = [...new Set(boundaries)].sort((a, b) => a - b)
  let idx = 0
  for (const b of bs) if (line.ts >= b) idx++
  const version = line.pluginVersion ?? "unknown"
  return `${version}@${idx}`
}

export interface BoolStats { n: number; trueCount: number; falseCount: number }
export function boolStats(xs: boolean[]): BoolStats {
  let trueCount = 0
  for (const x of xs) if (x) trueCount++
  return { n: xs.length, trueCount, falseCount: xs.length - trueCount }
}

export interface CountStats { n: number; mean: number; sd: number }
/** Sample sd (n-1 denominator); sd = 0 when n < 2 (no spread definable). */
export function countStats(xs: number[]): CountStats {
  const n = xs.length
  if (n === 0) return { n: 0, mean: 0, sd: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { n, mean, sd: 0 }
  const sumSq = xs.reduce((a, x) => a + (x - mean) ** 2, 0)
  const sd = Math.sqrt(sumSq / (n - 1))
  return { n, mean, sd }
}

export interface CatStats { n: number; classes: Record<string, number> }
export function catStats(xs: string[]): CatStats {
  const classes: Record<string, number> = {}
  for (const x of xs) classes[x] = (classes[x] ?? 0) + 1
  return { n: xs.length, classes }
}

export type Family = "boolean" | "categorical" | "count" | "rate"
export type ViabilityVerdict = "VIABLE" | "NON-VIABLE" | "UNKNOWN"

export interface RateStats { successes: number; failures: number }

/** Viability floors (spec §1, verbatim). Order matters: n-check first
 * (UNKNOWN below n=10), then the family-specific floor (VIABLE /
 * NON-VIABLE) on the remainder.
 *   - boolean:     minority count >= 3
 *   - categorical: second-most-frequent class count >= 3
 *   - count:       sd/mean >= 0.1, with mean === 0 => NON-VIABLE
 *   - rate:        >= 3 successes AND >= 3 failures
 */
export function viability(
  family: Family,
  stats: BoolStats | CatStats | CountStats | RateStats,
): ViabilityVerdict {
  switch (family) {
    case "boolean": {
      const s = stats as BoolStats
      if (s.n < 10) return "UNKNOWN"
      const minority = Math.min(s.trueCount, s.falseCount)
      return minority >= 3 ? "VIABLE" : "NON-VIABLE"
    }
    case "categorical": {
      const s = stats as CatStats
      if (s.n < 10) return "UNKNOWN"
      const counts = Object.values(s.classes).sort((a, b) => b - a)
      const second = counts[1] ?? 0
      return second >= 3 ? "VIABLE" : "NON-VIABLE"
    }
    case "count": {
      const s = stats as CountStats
      if (s.n < 10) return "UNKNOWN"
      if (s.mean === 0) return "NON-VIABLE"
      return s.sd / s.mean >= 0.1 ? "VIABLE" : "NON-VIABLE"
    }
    case "rate": {
      const s = stats as RateStats
      const n = s.successes + s.failures
      if (n < 10) return "UNKNOWN"
      return s.successes >= 3 && s.failures >= 3 ? "VIABLE" : "NON-VIABLE"
    }
  }
}

const Z_ALPHA = 1.96 // two-sided, alpha=0.05
const Z_POWER = 0.84 // power=0.80

/** Per-arm sample size for a two-proportion comparison (boolean/rate
 * families), alpha=0.05 two-sided (z=1.96), power=0.80 (z=0.84).
 * p1 = base rate, e = absolute effect (p2 = min(p1+e, 0.99)),
 * pbar = (p1+p2)/2. Formula verbatim from Global Constraints:
 *   N = ceil(((1.96*sqrt(2*pbar*(1-pbar)) + 0.84*sqrt(p1*(1-p1)+p2*(1-p2)))^2) / e^2)
 */
export function nPerArmBinomial(p1: number, e: number): number {
  const p2 = Math.min(p1 + e, 0.99)
  const pbar = (p1 + p2) / 2
  const term1 = Z_ALPHA * Math.sqrt(2 * pbar * (1 - pbar))
  const term2 = Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
  const sum = term1 + term2
  return Math.ceil((sum * sum) / (e * e))
}

/** Per-arm sample size for a count/mean comparison (standardized effect
 * d). Formula verbatim: N = ceil(2*(1.96+0.84)^2 / d^2) = ceil(15.68/d^2). */
export function nPerArmCount(d: number): number {
  return Math.ceil((2 * (Z_ALPHA + Z_POWER) ** 2) / (d * d))
}

/** Calendar days to accumulate 2*nPerArm paired events at eventsPerDay.
 * eventsPerDay === 0 -> null (would be Infinity; no verdict is ever
 * reachable at zero event rate).
 *
 * NOTE: this does NOT apply the MIN_N=20 floor to nPerArm — flooring is
 * the CALLER's responsibility (lives in the e-table CLI, Task 3), so this
 * function stays a pure, un-opinionated days-per-N converter reusable
 * both pre- and post-floor. */
export function daysToVerdict(nPerArm: number, eventsPerDay: number): number | null {
  if (eventsPerDay === 0) return null
  return Math.ceil((2 * nPerArm) / eventsPerDay)
}

/** UTC YYYY-MM-DD bucket for a numeric epoch-ms timestamp or ISO string. */
export function dayBucket(isoOrTs: string | number): string {
  const d = new Date(isoOrTs)
  return d.toISOString().slice(0, 10)
}
