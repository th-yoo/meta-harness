# Review — judge-check-aware (a3 pipeline unblock)

reviewed-range: 981948472e52cc6d386239e360d9fce188b8c290..1df449f6fb2ec81b850d101764f3bfd3d4eade73
reviewer: fresh-context-general-purpose-subagent (sonnet, execution-probing; 2 rounds)
fresh-context: true
verdict: approved
findings-count: 3

Two-commit branch fixing the seam that made the a3 checked-rule pipeline
unwinnable: the review judge (minimal/review.ts) never saw that a
proposed bullet carried a screen-passed check, so rubric item 5
(mechanize_instead — "prose must never do a check's job") rejected every
mechanized proposal. Live-proven before the fix: 4 headless cranks; the
4th's proposer emitted a well-formed `check:{cmd,timeoutMs}` op
(transcript-verified, self-tested by the proposer) and still drew
mechanize_instead. Ships: `buildReviewPrompt`/`reviewBullet` gain
optional `checkCmd` (attached check shown to the judge EPHEMERALLY —
F2 governs persisted artifacts, not judge input; traced: prompt never
persists); `computeVerdict` gains `{carriesCheck}` suppression AND
`reviewBullet` sanitizes the judge's raw `mechanize_instead` fail at the
single JSON-ingestion point (so `reviewLoop`'s raw fast-abstain agrees —
round-1 F1); the revision seat is shown the attached check with a
stay-verified-or-abstain contract and the revised text is re-judged with
the check visible (round-1 F2); judge-rejected checked bullets ledger
with the F2-safe suffix `[check: attached (<tier>)]`, never the command;
proposer prompt hardened (check REQUIRED when mechanizable, check in the
ops JSON example, mechanize_instead-rejection re-propose guidance —
revisions 1+2, each live-crank-evaluated).

## Findings (round 1, all addressed in 1df449f)

1. Medium — reviewLoop's own raw `checks.mechanize_instead.pass===false`
   fast-abstain ignored carriesCheck, silently denying checked bullets
   their revision round. Fixed by ingestion-point sanitation;
   execution-probed (3 prompts fire: review, revise, re-review) + pinned.
2. Medium-high — a revised bullet could persist paired with the original
   check with the reviser blind to it. Fixed by the revision-prompt
   contract + re-judge-with-check; pinned. RESIDUAL ADVISORY (accepted):
   revised-prose/check coherence remains prompt-compliance-based — no
   rubric key can fail cmd-relevance; bounded by 1 revision round and
   the trial/ab/curation process backstops.
3. Low — no-checkCmd prompt was not byte-stable (one stray newline).
   Fixed; byte-diffed identical against main by the reviewer.

## Verification

Round-2 reviewer re-verified by direct execution: original F1 repro now
stages with all three prompts; sanitized checks object traced as
never-persisted; no-checkCmd prompt byte-diffed against main (identical);
isolated full suite 1995 pass / 1 skip / 0 fail (1996 tests, 124 files)
+ tsc clean, matching the coordinator's run. An intervening single-fail
was reproduced as concurrent-suite contention (two suites overlapping),
absent in isolation — suites-serial rule reaffirmed. 11 new tests in
opencode-plugin/test/review-gate-check-aware.test.ts pin suppression,
sanitation, revision contract, byte-stability, F2 suffix, and the
unchanged prose-only path.
