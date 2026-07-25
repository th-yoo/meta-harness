/**
 * minimal/futility.ts — deterministic curtailment: stop an arm the moment
 * remaining trials CANNOT change its verdict.
 *
 * Theory: nonstochastic (curtailed) sampling — Alling 1963. The stop fires
 * only when the verdict is already decided under the BEST possible remaining
 * outcome, so the false-stop probability is exactly zero and no pre-registered
 * boundaries exist to tune. Deliberately NOT built here: stochastic
 * curtailment (Lan–Simon–Halperin 1982) and Wald's SPRT (1947) — both trade
 * error probability for earlier stops; docs/explicitly-not-now.md §7.5 defers
 * that whole family. This module is its smallest honest subset.
 *
 * Motivating incidents:
 *   - R7: the arm ran to 8/10 against baseline 6/10 at k=10 — mathematically
 *     dead from attempt 0 (even 10/10 gives Fisher p=0.087 > 0.05); a human
 *     killed it by hand at 8. designCheck() catches this BEFORE any spend.
 *   - v9 guard arm: ran 3 trials when trial 1's valid fail had already
 *     decided REGRESSED (gate.ts rule 3: every valid trial must pass).
 *
 * Pure logic only — callers (run.ts) own the trial accounting and the stop.
 */
import { fisherTwoSided } from "./gate.ts"

export interface FutilityState {
  /** valid passes so far */
  pass: number
  /** valid fails so far */
  fail: number
  /** total trials the arm will run */
  k: number
}

export interface FutilityVerdict {
  futile: boolean
  /** Fisher p of the best-case final table (all remaining trials pass). */
  bestCaseP: number
  /** human sentence naming the numbers when futile; null otherwise. */
  reason: string | null
}

/** Lift-arm curtailment: futile iff even the best case (all remaining trials
 * pass) cannot certify against the baseline — either its Fisher p stays above
 * alpha, or its pass RATE cannot even exceed the baseline's. */
export function liftFutility(
  s: FutilityState,
  basePass: number,
  baseN: number,
  alpha = 0.05,
): FutilityVerdict {
  const remaining = s.k - s.pass - s.fail
  const bestPass = s.pass + remaining
  const bestCaseP = fisherTwoSided(bestPass, s.fail, basePass, baseN - basePass)
  if (bestPass / s.k <= basePass / baseN)
    return {
      futile: true,
      bestCaseP,
      reason: `best case ${bestPass}/${s.k} cannot exceed baseline rate ${basePass}/${baseN} — no lift possible, remaining ${remaining} trial(s) are dead spend`,
    }
  if (bestCaseP > alpha)
    return {
      futile: true,
      bestCaseP,
      reason: `even ${bestPass}/${s.k} vs baseline ${basePass}/${baseN} gives Fisher p=${bestCaseP.toFixed(4)} > alpha=${alpha} — remaining ${remaining} trial(s) cannot certify a lift`,
    }
  return { futile: false, bestCaseP, reason: null }
}

/** Guard-arm curtailment: the guard verdict (gate.ts rule 3) is REGRESSED at
 * the first valid fail — every later trial is dead spend. bestCaseP is
 * nominal (1 = decided against, 0 = still open); guards have no p. */
export function guardFutility(validFails: number): FutilityVerdict {
  if (validFails >= 1)
    return {
      futile: true,
      bestCaseP: 1,
      reason: `${validFails} valid fail(s) — guard verdict is already REGRESSED (every valid trial must pass); remaining trials cannot change it`,
    }
  return { futile: false, bestCaseP: 0, reason: null }
}

/** Design viability at zero attempts: liftFutility with pass=0, fail=0.
 * Catches under-powered designs BEFORE any spend (the R7 case: k=10 vs
 * baseline 6/10 is futile at launch — best case p=0.087). */
export function designCheck(
  k: number,
  basePass: number,
  baseN: number,
  alpha = 0.05,
): FutilityVerdict {
  return liftFutility({ pass: 0, fail: 0, k }, basePass, baseN, alpha)
}
