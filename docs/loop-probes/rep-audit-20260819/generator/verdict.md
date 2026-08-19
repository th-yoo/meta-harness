# Generator probe verdict (2026-08-19) — 0/2 FAIL by pre-registered bar; bottleneck = SAMPLER EVIDENCE, not reasoning

Bar: card contains reciprocal transform + joint canonical landing. Neither call met it.

- r1: falsified thousands-grouping and literal-cm⁻¹ (good), surviving
  hypothesis = linear ÷10 scale — wrong transform. Its "numeric test" was
  range-containment (weak; canonical windows fit almost any monotone
  rescale).
- r2: genuinely computed — matched the sample's mega-peak to
  1e7/514.5nm = 19436.3 within 0.04% and proposed absolute-wavenumber
  axis + Ar-laser Rayleigh line, shift = 19436.3 − x. Wrong for the
  verifier, but physically MORE coherent than the task's own 1e7/x
  fiction, and observationally equivalent to the true reading GIVEN the
  blind sample: the discriminating evidence (real peaks at raw
  6328.0/3745.4 whose reciprocals land on BOTH canonical values
  simultaneously) was not in the sample.

CONCLUSION: the reasoner is strong enough; the blind head/tail+stats
sample under-determines the transform. Sampler iteration 2 (mechanical,
cheap): add a smoothed peak-finder emitting top-N local-maxima POSITIONS
(raw top-5 values are dominated by the Rayleigh/Si spike). With peak
positions present, the joint-landing test is one computation and
discriminates laser-subtraction from reciprocal instantly. Lane A
end-to-end remains unproven until a generated card passes; channel is
proven separately (arm-2).
