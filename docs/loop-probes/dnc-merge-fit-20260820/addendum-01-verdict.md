# Addendum 01 verdict — architect-review attacks (2026-08-20)

Scored against `addendum-01-pre.md` (registered first). Runner:
`probe.py addendum()`. Every registered prediction confirmed, including the
prediction that the v1 check itself fails a case.

## Results

| case | plain gate | check v1 (±1) | check v2 (+reversal) | registered |
|---|---|---|---|---|
| T6 value-fab (invented a=7, b=3, irregular) | **PASS** (rms 4e-15) | **ACCEPT** (R=1.09e9) | **ACCEPT** | ✅ attack succeeds |
| T7a reversal, equal-spaced | PASS | REJECT (R=0) | REJECT | ✅ |
| T7b reversal, irregular-asym | REJECT (rms 43.3) | REJECT (R=0.41) | REJECT (R=5e-16) | ✅ |
| T8 +2-shift, equal-spaced | PASS | REJECT (R=0) | REJECT | ✅ magnitude-blind |
| T9 two-element swap, irregular | REJECT (rms 65.8) | REJECT (R=0.90) | REJECT | ✅ |
| **T10 reversal, SYMMETRIC irregular** | **PASS (rms=0)** | **ACCEPT (R=5.9e10) — wrong claim accepted** | **REJECT (R=0)** | ✅ v1 gap + v2 fix |

v2 regression over T1–T4: verdicts identical to v1 (REJECT, REJECT,
ACCEPT, REJECT). Registered adoption rule satisfied → **check v2 adopted**:
alternate set = {+1 shift, −1 shift, full reversal}.

## Consequences

1. **F13 → closed with a real find.** The ±1-shift alternate set was
   incomplete: a symmetric constellation makes REVERSAL affine with negated
   slope — plain gate rms = 0, v1 blind at ten orders of magnitude. The
   attack class is "any wrong pairing that composes with a symmetry of the
   constellation"; the defence is to put that symmetry's image into the
   alternate set. v2's reversal alternate closes the mirror symmetry; the
   spec's check definition is now v2 with T10 as the second standing
   regression input (alongside T1).
2. **F1 → boundary confirmed and scoped.** T6: an invented (a,b) applied to
   the harness's own anchors passes everything, at every check version, by
   construction. No geometry check can catch it — the claim is genuinely
   affine, just untrue. The spec's §6 guarantee is hereby SCOPED to
   *pairing integrity over honestly-derived values plus geometric
   non-degeneracy*; value-truth requires a mechanism outside the
   constellation (open design item — candidate: sibling's
   `source_crosscheck` class, or loop-level outcome evidence), and the spec
   must say so rather than claim "the merge is the check" unqualified.
3. **F2's fit-side mechanism** is T6's cherry-picking twin: freedom to
   choose WHICH anchors are graded is freedom to construct T6 on a subset.
   Spec fix: the merge consumes the FULL harness survivor set;
   the claimant never selects the graded subset; inability to identify the
   full set → fail-closed, no card.
4. Degeneracy rejection is attack-magnitude-blind (T8): the check rejects
   the GEOMETRY, so untested shift magnitudes are covered on degenerate
   constellations; on non-degenerate ones, residuals carry (T7b, T9).

## Not measured

Noise (unchanged, §8.2's pre-committed rule stands); symmetries beyond
mirror (e.g. partial/periodic symmetries — same defence shape: add the
symmetry image to the alternate set when the constellation exhibits it;
flagged for the implementation spec); the value-truth mechanism (open by
design, per consequence 2).
