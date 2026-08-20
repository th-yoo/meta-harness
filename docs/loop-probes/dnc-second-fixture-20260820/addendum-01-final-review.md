# Addendum 01 — final-review cross-task finding (2026-08-20)

Source: the plan's final whole-branch review (series ddf9907..10ea752).
Recorded here because the finding lives at the seam BETWEEN two probes and
neither one's verdict could see it. No verdict file is edited.

## F1 — derived delta is geometry-dependent, and the b3 arm exposes it

On fixture 2's wide-span constellation, the out-of-family quadratic arm (b3)
PASSED the residual gate: recomputed delta = 487.5 (|b|·minΔu/2 grows with
anchor spacing) against max residual 436.8. It was rejected ONLY by the
conditioning check, at R = 1.49 — under the R = 3 placeholder that the noise
sweep (addendum-02, dnc-merge-fit-20260820) simultaneously measured as
FAILING its pre-registered acceptance rule.

Consequences:
1. "Residuals reject a wrong family" (spec §8.3) is GEOMETRY-DEPENDENT —
   true on the compact synthetic constellation, false on fixture 2's span.
2. The arming increment's derived threshold (§8.2 branch) must be validated
   against OUT-OF-FAMILY arms, not only identity-shift arms — otherwise
   b3-class claims pass every gate on wide-span geometry.
3. Arming now has three recorded blockers: the §8.2 derived threshold, its
   out-of-family validation (this finding), and the §8.8 value-truth
   mechanism.

Also noted (minor, code-level): the conditioning check's effective minimum
usable n is 4, not 3 — n = 3 constellations are always fail-closed rejected
(asymmetric → zero alternates; symmetric-3 → degenerate). Fail-closed, known
in the execution ledger, flagged for the arming spec.
