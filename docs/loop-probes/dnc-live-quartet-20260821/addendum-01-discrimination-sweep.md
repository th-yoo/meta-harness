# Addendum 01 — what the gate actually rejects (2026-08-21)

Answering "so it works fine?" with a sweep instead of caveats. Zero model spend:
the quartet fixture regenerated under 3 noise levels x 4 seeds, four claim types
graded by the real `mergeCheck` at every point.

## Result — uniform across all 12 variants

| claim | verdict |
|---|---|
| honest (`1e7/x`) | **ACCEPT** 12/12 |
| shifted pairing | reject(residual) 12/12 |
| raw-x as the answer | reject(residual) 12/12 |
| **T6-class fabrication** (`137.0 + 9.4e6·u` — invented laser offset) | **ACCEPT 12/12** |

## What the fabrication would have reported

| band | true | fabricated | error | task verifier (+-5) |
|---|---|---|---|---|
| 2D | 2670.17 | 2646.96 | 23.21 | **FAIL** |
| D' | 1619.46 | 1659.29 | 39.83 | **FAIL** |
| G | 1580.39 | 1622.57 | 42.18 | **FAIL** |
| D | 1349.25 | 1405.30 | 56.04 | **FAIL** |

**A claim that fails the task on every single band, by up to 11x its own
tolerance, passes the merge gate cleanly and repeatably.**

This is not a defect — §6's threat split says exactly this ("rejects ERROR,
never DECEPTION"). But there is a large difference between a documented scope
limitation and a measured one with task-relevant magnitudes attached, and the
fabrication used here is not an artificial adversary: `a + b/lambda` with an
invented laser constant is precisely the F4 failure class, where models
fabricated a 532 nm laser-offset story and back-solved to it.

## Two corrections to earlier claims of mine

1. **"Zero margin at n=4" was wrong, in direction.** Noise ADDS anchors
   (4 -> 10 as sigma goes 15 -> 60), never removes them. The n>=4 floor is not
   fragile against noise, only against genuinely feature-poor spectra.
2. **The honest-claim ACCEPT is near-vacuous.** `shift = 1e7/x` is exactly affine
   in `u = 1/x` BY IDENTITY, not by physics. For any anchor set — real bands or
   noise bumps — residuals are zero. 12/12 honest accepts measures arithmetic,
   not discrimination. The same effect explains rung 2's 17 anchors of which only
   2 are Raman bands: the gate verifies the TRANSFORM, never the PEAKS, and has
   no opinion about whether an anchor is a band or a bump.

## So: does it work?

It works exactly as specified. The specification does not include catching a
wrong answer.

What it demonstrably catches: a misassigned pairing, and a wrong family member.
What it demonstrably does not catch: any consistently-applied invented constant —
i.e. the failure mode this task class actually exhibits, and the one that
motivated building the gate in the first place.

Value truth needs §8.8's outside prior. On this fixture that route is closed:
single artifact -> structurally NO-SOURCE -> criteria-class only, no numeric
authority, forever.
