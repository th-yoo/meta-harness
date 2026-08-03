# Review artifact — cls-combine-hardgate (provisional hard-gate)

reviewed-range: 63bb15f4ec3b7da7e7f4266af8b85ea35559b998..06688fd917470d0ad8a017c4a834b4032b9c4cce
reviewer: fresh-context-reviewer-subagent
fresh-context: true
verdict: approved
findings-count: 1

Combine hard-gate (resume queue residual, registered-verdict path):
parseClsScoreCombineFile requires boolean `provisional` on the other-host
file (fail-closed — missing/non-boolean refuses); the combined verdict
carries its own `provisional = local || other-host || absent-registered-
arms` with a WARNING line naming the source(s); the combine is marked,
never refused (per-host warn-and-mark precedent). Decision math,
constants, and the 0.10 margin verified byte-untouched (spec-is-law).

Review verified: fail-closed parse both cases; all 3 provisional sources
converge on one boolean with no drifting second definition of arm
absence; WARNING only-when-provisional with accurate sources; emit-doc
writes the flag into the committed combined body (file-content asserted);
8 new tests RED-first-able against old code, no weakened existing
assertions. One finding (refusal message omitted the provisional cause)
fixed in-range. Reviewer executed 821 pass / 0 fail; driver re-verified
821 + tsc clean post-fix.
