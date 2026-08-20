# Derived-thresholds verdict (2026-08-21, `yoo-dev`)

Scored against `pre-registration.md` (derivation + full validation matrix +
expectations registered before the reference implementation existed).
Runner: `derive.py`, deterministic, stdlib only, zero model spend.

**Headline: ALL ELEVEN validation cases held on the first run, with no
tuning. The consolidation hypothesis is CONFIRMED — one noise-floor
predicate replaces the R ratio, its placeholder threshold, AND delta_fit.
Arming blockers (i) and (ii) discharge into a single derivation. The only
remaining arming blocker is §8.8 value-truth.**

## The derivation, as validated

- Noise floor from the ARTIFACT, never the claim: `sigma_y` via
  MAD×1.4826 on smoothing residuals; per-anchor `sigma_u` from the peak's
  position spread across its persistent detection scales; `sigma_c =
  |b|·sigma_u`.
- ONE predicate: normalized residual chi-square `X² = Σ(r_i/sigma_c_i)²`
  against `chi2(LEVEL, n−2)`. Accept iff the CLAIM passes AND EVERY
  alternate pairing (derived automorphisms + ±1 shifts) FAILS. Degeneracy,
  residual acceptance, and conditioning are one mechanism at one scale.
- Convention constants only: 1.4826, chi-square quantiles, LEVEL=0.999.

## Results

| case | expected | got |
|---|---|---|
| V1 eq+shift | reject-degenerate | ✅ |
| V2 eq honest | reject-degenerate (fail-closed) | ✅ |
| V3 irregular honest | accept | ✅ |
| V4 irregular shifted | reject-residual | ✅ |
| V5 value-fab | accept (documented T6 boundary, by design) | ✅ |
| V6 symmetric reversal | reject-degenerate | ✅ |
| V8 fixture-2 oracle (real series-side sigma) | accept | ✅ |
| V9 **fixture-2 b3 quadratic** | reject-residual | ✅ **F1 CLOSED** |
| V10 fixture-2 b1/b2 | reject | ✅ / ✅ |
| V11 graphene, 17 anchors, real sigma tracking | accept | ✅ |

**V7 noise sweep** (same rig/seeds/sigmas/trials as the run that killed
R=3):

| sigma | honest false-reject | shifted false-accept | placeholder (for reference) |
|---|---|---|---|
| 0.1% | 0/200 | 0/200 | FR 0/200 |
| 0.5% | 0/200 | 0/200 | (GAP rule FAILED here) |
| 1.0% | **0/200** | **0/200** | FR 1/200, GAP FAILED |
| 2.0% | 10/200 | 0/200 | FR 52/200 |
| 5.0% | 182/200 | 0/200 | FR 174/200 |

Through the registered ≤1% domain the predicate is EXACT — zero errors of
either kind, strictly better than the placeholder it replaces. 2%/5% =
operating boundary (honest rejects rise, fail-closed; false-accepts stay
zero everywhere).

**LEVEL sensitivity:** V1–V6 verdicts identical at 0.99 / 0.999 / 0.9999 —
the level is NOT load-bearing (the extent-tolerance bar the pre-reg set
for itself).

**Independent instrument check (unregistered, reported):** the series-side
derivation recovered fixture-2's generative noise nearly exactly —
measured `sigma_y = 25.2` against the generator's injected sigma 25 — with
no access to the generator.

## Consequences

1. **Registered decision rule fires: derivation VALIDATED, consolidation
   CONFIRMED.** The arming spec adopts: delta_pair (spacing, pairing
   sanity) + the single chi-square-vs-noise predicate (residual acceptance
   AND conditioning). `R_THRESHOLD_PLACEHOLDER` and the GAP rule retire at
   arming time.
2. **Final-review F1 is closed by measurement** (V9): the noise-scaled
   bound is geometry-independent; the wide-span hole is gone.
3. **Arming blockers: 3 → 1.** Only §8.8 value-truth remains (V5's intact
   boundary is the reminder of why).
4. Library implementation belongs to the arming increment; this reference
   implementation + matrix is its spec and regression set.

## Not measured

Value truth (out of scope by design); anchor-position sigma under
correlated noise; families beyond affine-in-u; third fixture.
