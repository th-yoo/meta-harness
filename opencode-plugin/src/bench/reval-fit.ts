/** D&C merge machinery — spec docs/superpowers/specs/2026-08-20-dnc-design.md §6.
 * SHIPS OFF: nothing in the run/audit path imports this module. Pure functions,
 * no I/O, no model calls. Reference probe: docs/loop-probes/dnc-merge-fit-20260820/. */

export const EPS = 1e-9

export interface AffineFit { a: number; b: number; rms: number }

/** Least-squares y = a + b*u. Constant-u input degrades to the mean (b=0). */
export function fitAffine(us: number[], cs: number[]): AffineFit {
  const n = us.length
  const mu = us.reduce((s, v) => s + v, 0) / n
  const mc = cs.reduce((s, v) => s + v, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (us[i]! - mu) ** 2
    sxy += (us[i]! - mu) * (cs[i]! - mc)
  }
  const b = sxx < EPS ? 0 : sxy / sxx
  const a = mc - b * mu
  let se = 0
  for (let i = 0; i < n; i++) se += (a + b * us[i]! - cs[i]!) ** 2
  return { a, b, rms: Math.sqrt(se / n) }
}

/** Spec D4: delta < |b| * min spacing / 2 — derived from the fit's own slope and
 * the detected anchor geometry; no external constant. */
export function deriveDelta(us: number[], b: number): number {
  if (us.length < 2) throw new RangeError("deriveDelta: need >= 2 anchors")
  const sorted = [...us].sort((x, y) => x - y)
  let minDu = Infinity
  for (let i = 1; i < sorted.length; i++) minDu = Math.min(minDu, sorted[i]! - sorted[i - 1]!)
  if (minDu < EPS) throw new RangeError("deriveDelta: coincident anchors")
  return (Math.abs(b) * minDu) / 2
}
