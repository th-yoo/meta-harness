# Addendum 02 pre-registration — noise robustness of the R check (2026-08-20)

Implements spec §8.6 with the §8.2 acceptance rule. Registered before the
sweep runs. Runner: `noise-sweep.ts` against the TS library
(`opencode-plugin/src/bench/reval-fit.ts` conditioningCheck).

## Parameters (registered)

- Noise: additive gaussian on the CANONICAL values, sigma ∈ {0.1%, 0.5%, 1%,
  2%, 5%} of the canonical span (max−min of the honest claim).
- Trials: 200 per sigma per case, seeded xorshift128+ PRNG, seeds 1..200
  (deterministic — wall-clock and Math.random are banned).
- Cases: honest-irregular (probe T3 geometry, us=[1.0,2.3,2.9,5.1,7.8]) and
  shifted-irregular (probe T4 geometry, same us).
- GAP (registered definition, worst-case): min(R over all honest trials at a
  sigma) / max(R over all shifted trials at that sigma).

## Acceptance rule (from spec §8.2, applied verbatim)

The fixed threshold R=3 SURVIVES at a sigma iff GAP ≥ 100 (two orders of
magnitude, worst case). Report per-sigma. If GAP < 100 at any sigma at or
below 1%, the check moves to a DERIVED threshold (from the fit's condition
number under the delta bound) — never a tuned constant. Sigmas above 1% are
reported as the operating boundary, not grounds for tuning.

## Also reported (no rule attached)

False-reject rate of honest-irregular at R=3 per sigma (the fail-closed cost
under noise).
