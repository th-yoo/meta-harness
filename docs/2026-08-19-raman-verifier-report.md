# raman-fitting verifier: offset/gamma bars grade an unstated procedure, not accuracy

**Status: DOCUMENTED, NOT FILED upstream (user ruling 2026-08-19).** If filed
later: repo `harbor-framework/terminal-bench-2`, task `raman-fitting`
(author Jan-Lucas Uslu <uslu@stanford.edu>; imported by Mike Merrill,
commit 73fc228). All measurements reproducible from
`docs/loop-probes/rep-audit-20260819/` (meta-harness).

## Claim

`tests/test_outputs.py`'s 2D gamma (±1) and offset (±10%) bars cannot be
satisfied by measurement accuracy: the expected values are the output of
`solution/solve.sh`'s specific procedure (Lorentz + constant on hard-coded
crop windows, 2D: 2500–2900 cm⁻¹) applied to data on which the barred
quantities have **no procedure-independent value**. The instruction
discloses neither window, model, nor units. x0 and amplitude bars are
sound (data-determined).

## Evidence (all measured on the shipped graphene.dat, converted 1e7/x)

1. **No plateau.** Offset vs fit half-window (Lorentz+const, center 2670):
   hw 50→126, 75→755, 100→991, 150→1253, 200→1387, 250→1473, 300→1503,
   400→1536, 500→1578. Still drifting at hw 500. Gamma anti-correlated
   (20.5→16.3). Lorentz+**linear** background, center freed: 752→1614 —
   no plateau under a better model either.
2. **The ±10% band (1115–1363) maps to hw ≈ 130–190 only.** Narrow
   windows fail low; wide windows — classical best practice for baseline
   identification — fail HIGH (+21…27%).
3. **The expected value is not the local truth.** Model-free side-band
   interpolation puts the background at 2670 at ≈1360–1700 raw
   (≈1360 after tail subtraction) — above the expected 1239. The
   background is strongly curved across the spectrum (band medians
   7225→4157→2913→815→388); "constant offset" has no referent.
4. **Degeneracy inside any narrow window.** A Lorentzian retains 5.2% of
   its amplitude 75 cm⁻¹ from center (γ≈17.5): peak tail ≈ flat floor.
   Fixing offset at 767 vs the expected 1239 in the ±75 window changes
   RMS residual 290 vs 363 — the "wrong" value fits better.
5. **Field signature.** TB2 leaderboard (10-agent snapshot): 7/10 stacks
   at 0, survivors at 0.2/0.4/0.8, none at 1.0 — the zeros-and-fractions
   shape of a trap-plus-lottery task, not a skill task.
6. **Controlled demonstration.** With the representation trap removed by
   convention-card injection (6/6 trials converted, x0 within 0.05
   cm⁻¹/0.05%), pass rate is 3/6; every failure is the offset/gamma pair
   (one degree of freedom), incl. a trial passing 7/8 bars and missing
   2D offset alone by design-of-window.

## Suggested upstream fix (any one suffices)

- State the fit procedure in the instruction (model + crop windows), or
- Drop/loosen the 2D gamma/offset bars to the parameter's legitimate
  procedure-sensitivity (offset spans ~470 across defensible windows), or
- Re-derive expected values from the data-generation parameters if any
  exist, with tolerances derived from window-sensitivity.

## Local consequence (meta-harness bench policy)

See `docs/loop-probes/rep-audit-20260819/verdict.md` round-8 block:
raman-fitting reclassified — retained for board/leaderboard comparability
and as a representation-probe instrument; excluded as a binary
loop-signal task.
