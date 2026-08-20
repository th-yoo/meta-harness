# Addendum 02 verdict — noise robustness of the R check (2026-08-20)

Ran per `addendum-02-noise-pre.md` (registered before this run) against
`noise-sweep.ts`, which imports `conditioningCheck` and
`R_THRESHOLD_PLACEHOLDER` directly from the TS library
(`opencode-plugin/src/bench/reval-fit.ts`) — the library is the thing under
test, not the python probe. Deterministic seeded PRNG (xorshift128+, seeds
1..200), no `Date.now()`/`Math.random()`. Re-ran once to confirm bit-for-bit
reproducibility; identical output both runs.

## Runner output (verbatim)

```
sigma=0.1%: GAP(worst-case)=2.88e+3 threshold-3-SURVIVES honest-false-reject=0/200
sigma=0.5%: GAP(worst-case)=6.16e+1 threshold-3-FAILS honest-false-reject=0/200
sigma=1.0%: GAP(worst-case)=1.98e+1 threshold-3-FAILS honest-false-reject=1/200
sigma=2.0%: GAP(worst-case)=3.61e+0 threshold-3-FAILS honest-false-reject=52/200
sigma=5.0%: GAP(worst-case)=2.97e-1 threshold-3-FAILS honest-false-reject=174/200
```

## Per-sigma reading against the registered rule (GAP ≥ 100 → SURVIVES)

| sigma | GAP (worst-case) | reading |
|---|---|---|
| 0.1% | 2.88e+3 | SURVIVES |
| 0.5% | 6.16e+1 | FAILS (GAP < 100) |
| 1.0% | 1.98e+1 | FAILS (GAP < 100) |
| 2.0% | 3.61e+0 | FAILS (reported as operating boundary only — sigma > 1%, not grounds for tuning per the registered rule) |
| 5.0% | 2.97e-1 | FAILS (reported as operating boundary only — sigma > 1%, not grounds for tuning per the registered rule) |

## Consequence (§8.2, applied verbatim)

**GAP < 100 at a sigma at or below 1% (0.5% and 1.0% both fail) → the
derived-threshold branch of §8.2 is now the requirement.** The fixed
threshold `R_THRESHOLD_PLACEHOLDER = 3` does NOT survive the pre-registered
worst-case rule once additive noise on the canonical values reaches 0.5% of
the honest claim's span — an order of magnitude below the 1% boundary this
addendum was scoped to check up to. Per the pre-registration, sigmas above
1% (2% and 5%) are recorded only as the operating boundary, not as
additional grounds for the derived-threshold call, which is already
triggered by 0.5%/1.0%.

**This plan does NOT implement the derived threshold.** Per §8.2, a fixed
threshold is disallowed once GAP < 100 at ≤1% is observed; the replacement
must be derived from the fit's condition number under the delta bound
(`deriveDelta`, `opencode-plugin/src/bench/reval-fit.ts`), never a second
tuned constant chosen to make this sweep pass. That derivation is scoped to
the arming increment, not this task. `R_THRESHOLD_PLACEHOLDER` should gain a
code comment pointing here (this file) recording that the placeholder is
now known-insufficient at realistic noise levels and blocks arming until
the derived form lands — that edit is out of scope for this task (this task
touches only the three addendum-02 files) and is left for the increment
that implements the derived threshold.

## Honest false-reject cost (fail-closed cost under noise; no rule attached)

| sigma | honest-irregular false-reject rate |
|---|---|
| 0.1% | 0/200 |
| 0.5% | 0/200 |
| 1.0% | 1/200 |
| 2.0% | 52/200 |
| 5.0% | 174/200 |

Even where GAP nominally clears 100 (sigma=0.1%), the false-reject rate is
already 0/200 — clean. Cost rises sharply above 1%, consistent with GAP
collapsing toward and below 1 by sigma=5% (worst-case shifted R exceeds
worst-case honest R at that noise level).

## Bottom line

Threshold does NOT survive through the 1% boundary this addendum was
registered to test. §8.2's derived-threshold branch is now the requirement
for arming; this task records that consequence and stops — implementation
is deferred to the arming increment.
