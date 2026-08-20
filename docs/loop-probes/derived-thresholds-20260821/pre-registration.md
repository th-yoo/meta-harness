# Pre-registration — derived thresholds: one derivation for delta_fit AND the conditioning bound (2026-08-21)

## Question

Arming blockers (i) and (ii): the R=3 placeholder failed its noise rule,
and the spacing-derived delta let an out-of-family claim through on
wide-span geometry (final-review F1: a pairing bound doing a noise bound's
job). Sibling's consolidation hypothesis: the derived R threshold and
`delta_fit` are siblings — ONE noise-floor derivation may discharge both.
This probe designs and validates that derivation. Zero model spend.

## The derivation (registered before any validation runs)

**Noise floor, from the artifact, outside any claim** (the
chi-squared-misuse constraint — never from claim residuals):

1. `sigma_y` = robust y-noise of the raw series: `MAD(y − smooth(y)) ×
   1.4826` at the detection smoothing scale (1.4826 = normal-consistency
   convention constant, not a tunable).
2. `sigma_u_i` = per-anchor POSITION uncertainty, mechanical: the spread
   (std) of anchor i's matched peak positions across its persistent
   detection scales (the persistence tracker already computes these
   matches; the probe re-derives them). In u-units via the family map.
3. `sigma_c_i = |b| · sigma_u_i` = per-anchor canonical-space uncertainty
   under the fitted slope, floored at EPS for noiseless synthetics.

**ONE acceptance predicate replaces both thresholds:**

- **delta_fit (residual acceptance):** the claim passes iff its normalized
  residual chi-square `X² = Σ (r_i / sigma_c_i)²` ≤ `chi2.ppf(LEVEL, n−2)`.
  LEVEL is a CONVENTION constant, registered here as 0.999, with a
  MANDATORY sensitivity report across {0.99, 0.999, 0.9999}: if any
  validation verdict flips across that range, the level is load-bearing
  and the derivation FAILS its own bar (the extent-tolerance test).
- **conditioning (replaces R and its threshold):** the SAME predicate
  applied to every alternate pairing (derived automorphisms + fixed ±1
  shifts): the claim is accepted iff the claim PASSES the predicate AND
  EVERY alternate FAILS it. Degenerate geometry = some alternate also
  passes = reject (fail-closed, unchanged semantics). No ratio, no R, no
  GAP rule — the noise floor is the single scale.
- `delta_pair` (spacing bound) is retained UNCHANGED for its own job:
  pairing disambiguation (`|b|·minΔu/2` remains an upper bound sanity
  check that sigma_c must not exceed — if `z·sigma_c > delta_pair` the
  constellation cannot be read at this noise and the merge refuses).

## Validation matrix (all pre-existing registered cases; expectations fixed now)

| case | source | expected under the new predicate |
|---|---|---|
| V1 T1 equal+shifted | merge-fit probe | reject (alternate passes → degenerate) |
| V2 T2 equal honest | merge-fit probe | reject (degenerate, fail-closed) |
| V3 T3 irregular honest | merge-fit probe | ACCEPT |
| V4 T4 irregular shifted | merge-fit probe | reject (claim fails predicate) |
| V5 T6 value-fab | merge-fit probe | ACCEPT (documented deception boundary — unchanged by design) |
| V6 T10 symmetric reversal | addendum-01 | reject (mirror alternate passes) |
| V7 noise sweep re-run | addendum-02 rig, same seeds/sigmas/trials | honest-irregular FALSE-REJECT ≤ the placeholder's (0/200,0/200,1/200 at ≤1%) AND shifted FALSE-ACCEPT = 0/200 at ≤1%; report 2%,5% as operating boundary |
| V8 fixture-2 oracle | second-fixture probe | ACCEPT |
| V9 fixture-2 b3 quadratic | second-fixture probe | **reject at the RESIDUAL predicate** (this is F1's closure: noise-scaled bound, geometry-independent) |
| V10 fixture-2 b1/b2 | second-fixture probe | reject |
| V11 graphene 17-anchor geometry, honest synthetic affine claim | real fixture | ACCEPT (with measured sigma_u from real scale-tracking) |

Decision rule: ALL of V1–V11 as expected AND the LEVEL sensitivity stable →
derivation VALIDATED; consolidation hypothesis CONFIRMED (blockers i+ii
discharge into one mechanism; arming spec adopts it). Any V-case deviating
→ report which, no tuning — a failed expectation is the verdict.

## Scope

Reference implementation in this probe dir (reads the fixtures; re-derives
scale-tracking positions; does NOT modify the shipped library — the arming
increment owns library changes). Convention constants only (1.4826, chi2
quantiles, the registered LEVEL); anything else numeric must be derived
from artifact or fit.

## Disclosure

All fixtures and prior verdicts known (committed). Expectations above
written before the reference implementation existed or any V-case ran.
