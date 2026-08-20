# Pre-registration — merge=fit design probe (2026-08-20)

## Purpose

Design-decision probe for the D&C spec (user go 2026-08-20). The spec's
merge step for globally-coupled tasks is an over-determined fit (harness
fits ONE frozen family over n≥3 mechanical anchors; data contradicts a false
claim via residuals). Sibling lane identified an unbuilt attack and a
candidate defence. This probe builds the breaking input BEFORE the spec
fixes the design. Zero model spend; deterministic; stdlib only.

## Design decisions under probe

- **D1 (necessity):** does the *global identity shift* attack — every anchor
  misassigned by one index — PASS a plain over-determined fit when anchor
  positions are equally spaced? If yes, a residual check alone is
  insufficient and the constellation check is REQUIRED in the spec.
- **D2 (sufficiency):** does the proposed conditioning check — the
  shift-degeneracy ratio — reject the attack while accepting an honest claim
  on an irregular constellation, with residuals alone rejecting a shifted
  claim on an irregular constellation?
- **D3 (real-fixture geometry):** does mechanical scale-persistent peak
  detection on the real fixture (`graphene.dat`, the 4-way-identical probe
  copy, md5 23a31815…) yield n≥3 anchors, and is their spacing near-regular
  (attack live on the real task) or irregular (naturally conditioned)?
- **D4 (delta derivation):** state delta as a formula derivable from the fit
  and the detected anchor spacing (no constants from outside the artifact):
  `delta < |b| * min Δu / 2` for fitted slope b; report min Δu per family
  member.

## Frozen family (fixed a priori, never grown)

`y = a + b·u`, `u ∈ {x, 1/x}`. Two fitted parameters. General measurement
algebra (linear readout of a possibly reciprocal axis), not a trap response.

## The conditioning check (pre-registered form)

For a claimed assignment of canonical values `c_i` to anchors `u_i` (n ≥ 3):
fit the family; RMS_claimed. Refit under index-shifted assignments (±1
shift, anchors re-paired to neighbours' canonicals, ends dropped, requiring
n−1 ≥ 3). `R = min(RMS_shifted) / max(RMS_claimed, ε)`.

- **REJECT (ill-conditioned)** if `R ≤ 3` — a shifted (wrong-identity)
  assignment fits within 3× of the claimed one, so the constellation cannot
  distinguish identity; geometry refuses to certify. Applies to HONEST
  claims on degenerate constellations too — intended, fail-closed.
- n < 3 → REJECT (zero redundancy).
- ε = 1e-9 (guards exact-fit division).

## Test matrix and expected outcomes (registered before running)

| case | constellation | claim | plain residual gate | conditioning check |
|---|---|---|---|---|
| T1 | equal-spaced (synthetic, n=5) | shifted (all wrong) | expect PASS (the attack) | expect REJECT |
| T2 | equal-spaced (synthetic, n=5) | honest | expect PASS | expect REJECT (fail-closed) |
| T3 | irregular (synthetic, n=5) | honest | expect PASS | expect ACCEPT |
| T4 | irregular (synthetic, n=5) | shifted | expect REJECT (residuals) | (moot; reported) |
| T5 | real fixture detected peaks | no claim — geometry only | — | report n, Δu, CV, R-geometry |

Synthetic canonical values are self-defined by construction (no answer key:
the synthetic spectrum's "truth" is whatever we generated).

## Decision mapping (registered)

- T1 attack passes plain gate → constellation check goes into the spec as a
  REQUIRED merge condition (with T1 as its regression input).
- T1 attack also rejected by plain gate → check demoted to
  defence-in-depth; spec says so.
- T2 rejected by check → spec documents the fail-closed cost: degenerate
  constellations are UNCHECKABLE, not wrong — no inject, never a pass.
- T3 accepted AND T4 rejected → check + residuals jointly sufficient on
  irregular constellations; spec adopts the pair.
- D3 near-regular (CV < 0.15 in the relevant u) → the attack is LIVE on the
  real fixture class; check priority = blocking. Irregular → still required
  (transfer), priority = normal.
- Peak detection yielding n < 3 persistent peaks → queue-#3 sampler design
  needs rework before the merge design can stand; spec must say so.

## Peak detection (D3, mechanical, no answer knowledge)

Moving-average smoothing, window w swept over odd values 5..101; local
maxima above the 90th percentile of the smoothed series; peaks persisting
across ≥5 consecutive scales (position tolerance ±3 samples) survive.
Parameters are stated a priori and NOT tuned against any expected peak
count or identity (survivor set never trimmed by expected count).

## Disclosure

Seen before registration: file format (tab-sep, plain decimals, 1500 rows,
x range 5800–7100 from head/tail — the standard sample view), md5s. NOT
seen: any peak position, any spacing, any fit.
