# Review: 2026-08-20-dnc-merge-library.md (plan) — iteration 1

Reviewer: code-architect subagent (fresh context), dispatched under a ralph
review loop at plan commit 96485da. Saved verbatim by the controller. Verdict:
NEEDS-FIXES (3 Critical, 2 Important, 4 Minor, 3 Observations). All fixes
applied in the commit that carries this file; iteration 2 re-review follows.

## Findings (headlines — full reasoning was returned inline and is reflected
in the fixes; the hand-computed numbers are recorded here)

1. [CRITICAL, Task 3/4] mergeCheck ran conditioningCheck BEFORE the residual
   loop; since R's denominator is the claimed fit's own rms, any badly-fitting
   claim collapses R and steals the reason: T4 shifted-irregular (claimed rms
   ≈30.9, slice-alternate rms ≈0 → R≈0), quadratic (claimed ≈23.2, alternate
   ≈12.6), log (claimed ≈105.9, alternate ≈68.3) would all report
   "degenerate-constellation", failing the plan's own `expect(reason:
   "residual")` in three tests. FIX APPLIED: residuals first, conditioning
   second (matches the probe's independent side-by-side signals).
2. [CRITICAL, Task 2 / spec §6.4] enumerateAutomorphisms returns [] on every
   asymmetric constellation (including the real fixture), so the "derived"
   mechanism did zero work on the primary use case and the fixed ±1-shift arm
   was the actual implementation — contradicting the spec's "the floor is
   never the implementation". FIX APPLIED: two-component semantics made
   explicit in plan and spec — derived automorphisms = symmetry defence
   (empty ⇔ no symmetric attack surface); fixed ±1 shifts = minimal-
   misassignment distinguishability reference, fixed before any attack and
   never grown; reversal comes only from the derived component.
3. [CRITICAL, Task 9] score-o4.py scored PARSE RATE, but the registered O4
   metric is CONSTANT-CONSISTENCY (strict token-in-derivation, baseline O3
   2/4); the two metrics measurably diverge (out-O4-r1: strictBlock=malformed
   yet CONSTANT 18797.0 appears in both derivation rows). FIX APPLIED:
   scorer rewritten to the registered metric with parse rate reported-not-
   scored; three-branch rule (4/4 adopt, ≤2/4 confirms, 3/4 INDETERMINATE)
   applied by the scorer; no expected outcome pre-written.
4. [IMPORTANT, DAG] T8 imports FIT_FAMILY (T7) but the DAG listed T8 as
   "after T3+T5+T6" — a future parallel dispatcher would race it. FIX
   APPLIED: G5 = after T3+T5+T6+T7; Consumes line corrected.
5. [IMPORTANT, Task 11] the no-tuning rule was prose-only. FIX APPLIED:
   registration committed BEFORE the run (REG_SHA), verdict must embed
   `git diff --stat REG_SHA..HEAD -- opencode-plugin/src/bench/` with
   required-empty output; a non-empty diff voids the transfer claim.
6. [MINOR, Task 2] test name claimed translation automorphisms exist on
   finite equal-spaced input; only the mirror survives boundaries. FIX
   APPLIED: renamed + exact assertion `toEqual([[4,3,2,1,0]])`.
7. [MINOR, Task 7] inv-x regression attack was byte-identical to x's,
   never exercising the member's transform. FIX APPLIED: attack constructed
   in x-space through `m.u`.
8. [MINOR, Task 3] duplicated sort logic. FIX APPLIED: mergeCheck reuses
   `sortedWith`.
9. [MINOR, Tasks 2/3/4/7] "extend the existing import line" prose did not
   match the shown new-import-statement code. FIX APPLIED: prose corrected.
10. [OBSERVATION] n<3 checked in both mergeCheck and conditioningCheck —
    intentional (conditioningCheck is a public API); no change.
11. [OBSERVATION] T5 synthetic detector tests are new constructions,
    unexecuted at plan time; plan's no-tuning discipline is the right guard.
    No change.
12. [OBSERVATION] T8's exact counts (3565 rows, 17 peaks) assume Python/Bun
    arithmetic parity; plan already flags the percentile-index parity. No
    change.

## Iteration 2 (scoped re-review)

Findings 1-4, 6-9: ADDRESSED (hand-verified, incl. re-walk of all five
mergeCheck cases under the reorder and float-walk of the inv-x attack).
Finding 5: NOT ADDRESSED as scoped — freeze guard covered only
opencode-plugin/src/bench/, leaving fixture/truth/runner/pre-registration
tunable post-run with an empty-diff alibi. NEW IMPORTANT: the finding-1
reorder made deriveDelta reachable with coincident anchors → uncaught
RangeError escaping "fail-closed" mergeCheck.

Fixes applied for iteration 3: freeze guard path extended to the probe dir
(verdict.md not yet existing at guard time); mergeCheck gains a
"coincident-anchors" typed reject with spacing pre-check + test; Task 9
addendum must state the fail-closed no-table rationale in one sentence.
