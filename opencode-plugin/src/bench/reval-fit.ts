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

/** Placeholder pending the §8.2 pre-registered noise rule — NOT a validated
 * constant. In the noiseless probe the separation was total (R = 0 vs 1.5e10),
 * so this value is not load-bearing; the noise sweep decides whether it
 * survives or the check moves to a derived threshold. */
export const R_THRESHOLD_PLACEHOLDER = 3

function sortedWith<T>(us: number[], cs: T[]): { su: number[]; sc: T[] } {
  const idx = us.map((_, i) => i).sort((i, j) => us[i]! - us[j]!)
  return { su: idx.map((i) => us[i]!), sc: idx.map((i) => cs[i]!) }
}

/** Spec §6.4 derived form: enumerate the constellation's approximate
 * automorphisms — mirror and translations — as index permutations over the
 * SORTED anchor order. A candidate mapping is an automorphism only when every
 * mapped value pairs to a distinct anchor within tol (default minΔu/4). The
 * fixed set {±1 shift, reversal} is the regression FLOOR the derived form must
 * cover (equal-spaced: translations + mirror; symmetric: mirror) — see the
 * floor tests; the floor is never the implementation. */
export function enumerateAutomorphisms(us: number[], tol?: number): number[][] {
  const su = [...us].sort((x, y) => x - y)
  const n = su.length
  if (n < 3) return []
  let minDu = Infinity
  for (let i = 1; i < n; i++) minDu = Math.min(minDu, su[i]! - su[i - 1]!)
  const t = tol ?? minDu / 4
  const candidates: number[][] = []
  const images: ((u: number) => number)[] = [(u) => su[0]! + su[n - 1]! - u]
  for (let k = 1; k < n; k++) {
    const d = su[k]! - su[0]!
    images.push((u) => u + d, (u) => u - d)
  }
  for (const img of images) {
    const used = new Set<number>()
    const perm: number[] = []
    let valid = true
    for (let i = 0; i < n && valid; i++) {
      const target = img(su[i]!)
      let hit = -1
      for (let j = 0; j < n; j++) {
        if (!used.has(j) && Math.abs(su[j]! - target) <= t) { hit = j; break }
      }
      if (hit < 0) valid = false
      else { used.add(hit); perm.push(hit) }
    }
    if (valid && perm.some((p, i) => p !== i)) candidates.push(perm)
  }
  // dedupe identical permutations from different generators
  const seen = new Set<string>()
  return candidates.filter((p) => { const k = p.join(","); if (seen.has(k)) return false; seen.add(k); return true })
}

export interface ConditioningResult { ok: boolean; R: number; alternates: number }

/** Spec §6.4 (as amended): R = min(RMS over alternates) / max(RMS claimed, EPS);
 * reject when R <= threshold or n < 3. TWO alternate components with distinct
 * jobs: (1) the constellation's DERIVED automorphism pairings — the symmetry
 * defence; an empty set on asymmetric geometry is CORRECT, not a gap, because
 * a wrong pairing can only fit well by composing with a symmetry of the
 * constellation, so no symmetry = no attack surface in that class; (2) the
 * FIXED ±1-index-shift pair — the minimal-misassignment distinguishability
 * reference, fixed before any attack existed and never grown in response to
 * one (reversal is NOT fixed here: it arrives via (1) when the geometry has
 * mirror symmetry). Growth-by-incident applies to neither component. */
export function conditioningCheck(us: number[], cs: number[], tol?: number): ConditioningResult {
  const n = us.length
  if (n < 3 || cs.length !== n) return { ok: false, R: NaN, alternates: 0 }
  const { su, sc } = sortedWith(us, cs)
  const claimed = fitAffine(su, sc).rms
  const altRms: number[] = []
  for (const perm of enumerateAutomorphisms(su, tol)) {
    altRms.push(fitAffine(su, perm.map((p) => sc[p]!)).rms)
  }
  if (n - 1 >= 3) {
    altRms.push(fitAffine(su.slice(0, -1), sc.slice(1)).rms)
    altRms.push(fitAffine(su.slice(1), sc.slice(0, -1)).rms)
  }
  if (altRms.length === 0) return { ok: false, R: NaN, alternates: 0 }
  const R = Math.min(...altRms) / Math.max(claimed, EPS)
  return { ok: R > R_THRESHOLD_PLACEHOLDER, R, alternates: altRms.length }
}
