# Merge=fit design probe — verdict (2026-08-20, `yoo-dev`)

Scored against `pre-registration.md` (written first). Scorer: `probe.py`,
deterministic, zero model spend. Every registered expectation matched.

## Results

| case | plain residual gate | conditioning check | registered |
|---|---|---|---|
| T1 equal-spaced, ALL identities wrong (+1 shift) | **PASS, rms = 0** | REJECT (R=0) | ✅ both |
| T2 equal-spaced, honest | PASS (rms 0) | REJECT — fail-closed | ✅ both |
| T3 irregular, honest | PASS (rms 2e-14) | ACCEPT (R = 1.5e10) | ✅ both |
| T4 irregular, shifted | REJECT (rms 30.9 ≫ delta) | REJECT (R = 6.5e-16) | ✅ |
| T5 real fixture, geometry only | — | n=17 peaks; CV(Δu) 1.374 (u=x), 1.861 (u=1/x) → irregular | reported |

## Design decisions, resolved by measurement

**D1 — the constellation check is REQUIRED, not defence-in-depth.** The
global-identity-shift attack passes the plain over-determined gate with
ZERO residual on an equal-spaced constellation: the affine family absorbs a
consistent canonical shift entirely into the intercept. Redundancy alone
does not defeat it. T1 is the standing regression input for any merge
implementation.

**D2 — check + residuals are jointly sufficient on the tested matrix.** The
shift-degeneracy ratio (R ≤ 3 → reject; n < 3 → reject) kills T1, accepts
T3 with 10 orders of magnitude of margin, and T4 is caught twice
independently (residuals AND check). The fail-closed cost is real and
intended: T2 (honest, degenerate geometry) is refused — a degenerate
constellation is UNCHECKABLE, not wrong; no inject, never a pass.

**D3 — the real fixture is naturally conditioned; the attack is a transfer
risk, not a live one here.** 17 scale-persistent peaks (windows 5..101,
persistence ≥5 scales, no count prior), spacing strongly irregular in both
family variables. The detector found the known peak region (x≈6329) purely
mechanically — no line list, no expected count. n=17 ≥ 3: the queue-#3
sampler design (emit mechanical peaks, `input` must BE a peak) is feasible
as specified.

**D4 — delta is derivable with no external constant:**
`delta < |b| · min Δu / 2`, b from the merge fit itself; measured
min Δu = 106.0 (u=x) / 9.81e-7 (u=1/x) on the fixture. The bound uses only
detected geometry and the fitted slope.

## Corrections during run

One transport fix after T5 crashed: this fixture variant carries EU decimal
commas (`47183,554644`); parser given the same single-comma tolerance the
shipped `parseFirstColNum` has. Rubric untouched; T1–T4 ran before and after
identically.

## Consequences for the D&C spec

1. Merge = over-determined fit + REQUIRED constellation conditioning check
   (T1 as regression) + derived delta (D4 formula) + frozen family.
2. Fail-closed semantics documented: degenerate geometry → no card, never a
   pass (same posture as the revalidator's malformed-block rule).
3. Sampler (divide step) confirmed feasible on the real fixture at n=17
   with zero answer knowledge.
4. Sibling's prediction stands ready for post-redesign measurement: raman
   minimal-thrash count should drop once a correct answer can actually pass.

## Not measured

Noise robustness of the check's R threshold (synthetic cases are noiseless;
threshold 3 untested against noisy honest claims); >±1-index shifts;
families beyond affine-in-u; second fixture (the standing transfer test for
everything here).
