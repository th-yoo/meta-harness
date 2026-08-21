# Live D&C run on raman-quartet-report — PRE-REGISTRATION (2026-08-21)

Registered before any model call. Small probe, own spend, user go given
("run it with the D&C").

## What is being run, and what is NOT

The merge gate is **not wired into the run path** — only the old `revalidate()`
card path is, and that is the bypassed revalidator. Arming the gate is the
unimplemented arming increment. So this probe exercises the **real pipeline
end-to-end without touching shipped code**:

1. harness reads `raman-quartet-report`'s series and detects anchors (real
   `detectPeaks`),
2. a real model is asked, in one call, for the family and a canonical value for
   EVERY detected anchor (the §6.5 full-coverage contract),
3. the claim is graded by the real `mergeCheck`.

No shipped file is modified. Nothing is armed. `conventionAudit` stays false.

## The question

**Does the merge gate correctly grade a REAL model's claim on the minimal
runnable fixture?** Every prior statement about this gate rests on synthetic
claims I constructed. This is the first time a model, not the author, supplies
the numbers.

## Pre-registered outcomes — all four are results

- **A: model claims correctly, gate ACCEPTS.** The gate works end-to-end on a
  real claim. Weakest-but-positive: it shows the gate does not reject truth.
- **B: model claims correctly, gate REJECTS.** A false-reject on a true claim —
  the most serious possible finding, and it would mean the n>=4 floor is not the
  only over-strict condition.
- **C: model claims incorrectly, gate REJECTS.** The gate catches a real error.
  This is the ERROR-class rejection §6 was designed for, and the strongest
  positive available.
- **D: model claims incorrectly, gate ACCEPTS.** A false-accept. Expected only
  for the consistent-fabrication class (§6 scope: rejects ERROR, never
  DECEPTION); any other route to D is a defect.

## Registered predictions

- The model will most likely produce the raw wavelength-nm values or a partial
  answer rather than the converted shifts — that is the representation trap this
  ladder exists to measure, and rung 0 scored 0/5 on a strictly easier version.
- **If the model echoes raw x values, the gate should ACCEPT them** — `x` is a
  frozen family member and `canonical = x` is affine with `a=0, b=1`. That is
  NOT a gate defect; it is the measured §6 scope boundary (pairing integrity,
  not value truth) showing up on a real claim for the first time. Registering it
  now so it cannot later be reported as a surprise.

## Cost

One model call per arm, `anthropic/claude-sonnet-5` via the opencode judge
transport (the authenticated provider; `DEFAULT_JUDGE_MODEL`'s openrouter route
is dead on this host). No SUT container run, no ab.
