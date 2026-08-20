# Addendum 01 pre-registration — architect-review attack extension (2026-08-20)

Triggered by the D&C spec architect review (`docs/reviews/
2026-08-20-dnc-spec-architect-review.md`): F1 (value fabrication), F2
(anchor cherry-picking, probed here as its fit-side mechanism), F13
(permutation space beyond ±1 shift). Registered before running. Same frozen
family, same check, plus a candidate check-v2 whose alternate set adds
REVERSAL (registered response to the predicted T10 gap).

## New cases and registered expectations

| case | constellation | claim | plain gate | check v1 (±1 shift) | prediction |
|---|---|---|---|---|---|
| T6 value-fab | irregular | invented (a,b): c = 7 + 3·u | PASS (rms≈0 by construction) | ACCEPT (pairing is genuinely affine; shifts fit badly) | **attack SUCCEEDS — F1 boundary is REAL; geometry checks pairing, not truth** |
| T7a reversal | equal-spaced | honest values, order reversed | PASS (affine, negated slope) | REJECT (degenerate geometry) | check catches via degeneracy |
| T7b reversal | irregular asymmetric | honest values, order reversed | REJECT (non-affine) | (report) | residuals catch |
| T8 ±2 shift | equal-spaced | honest values shifted 2 | PASS (absorbed in intercept) | REJECT (±1 refit also perfect → R≈1) | degeneracy rejection is shift-magnitude-blind |
| T9 swap | irregular | two canonicals swapped | REJECT (2 outliers vs 2-param fit) | (report) | residuals catch |
| **T10 symmetric-reversal** | irregular but SYMMETRIC spacing (e.g. u = [1, 2, 6, 10, 11]) | honest values, order reversed | **PASS predicted** (symmetry makes reversal affine with negated slope) | **ACCEPT predicted — a WRONG claim the v1 check MISSES** | if confirmed: v1's alternate set is incomplete; adopt v2 |
| T10-v2 | same | same | — | check v2 (±1 shifts + reversal alternate) | REJECT predicted |

## Check v2 (registered)

Same R ratio, alternate set extended: {+1 shift, −1 shift, full reversal}.
R = min(RMS over alternates) / max(RMS_claimed, ε); R ≤ 3 or n < 3 → reject.
Registered decision rule: adopt v2 in the spec iff T10 confirms the v1 gap
AND v2 changes no verdict on T1–T9 (regression: all prior expectations must
hold under v2).

## What T6 decides (registered)

T6 is not fixable by any geometry check — an invented affine claim is
geometrically indistinguishable from a true one. Registered consequence:
spec §6's guarantee is SCOPED to "defeats misassignment among
honestly-derived values"; value-truth requires a mechanism OUTSIDE the
constellation (F1 fix option b), named in the spec as an open design item —
not silently absorbed.
