# Review artifact — acp-budget-floor-guard

reviewed-range: ccb2cbb03f4711609504ccb6265583fe8bddf0dc..a499848
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One test-only commit (+33, single file) pinning a numeric invariant that lives entirely
inside a dependency.

**The invariant.** `@th-yoo/cc-api-daemon`'s client refuses to send and resolves
`{kind:"no-call"}` when the daemon's advertised `daemonWorstCaseMs >= budgetMs`
(`acp-client.ts:248`), and `budgetMs` defaults to `ACP_BUDGET.clientBudgetMs`
(`acp-client.ts:133`). Today that passes only because 36 000 > 32 000. Both meta-harness
consumers now on the package take that default and pass no explicit `budgetMs` —
`review-sensor/runner.ts:221` and `p2/a4-review.ts:208`. If a future package version
narrowed that margin, EVERY turn from both would degrade to `no-call`: `daemonCall`
documents that it NEVER throws, so there is no exception, no rejection, no non-zero exit
— just a permanent silent stream of skips. `tsc` cannot see runtime constant values, and
neither consumer's own tests assert on the margin between two constants defined inside
the dependency. This test is the only place it is checked.

**Scope correction worth recording.** The plan's B4 called for a floor guard on callers
passing an explicit `budgetMs`. That was checked before dispatch and found PREMATURE for
the second time in this plan: the only caller that passes `budgetMs` is
`gauge/providers/anthropic-cli-warm.ts:62` (from `sendOpts.timeoutMs`), and that file is
still deliberately on the OLD in-repo client, which has no `daemonWorstCaseMs` check at
all. So the planned guard would have pinned a cliff no consumer can currently reach. The
reachable invariant is the DEFAULT margin, which is what this commit pins.

**Verified by the reviewer against source, not taken on faith:** the assertion reads both
values live off the package export with no hardcoded 36000/32000 (the numbers appear only
in the explanatory comment); `toBeGreaterThan` is the correct strict `>` because the
client refuses on `>=`, making equality already a failure; both cited consumers confirmed
to omit `budgetMs`; the never-throws claim confirmed against `daemonCall`'s own contract.

**Minor, recorded not fixed:** if this margin ever flipped, `runner.ts` would emit skip
lines tagged `"warm-lane-busy"` — a misleading label for this particular cause, since
every non-`ok` outcome collapses into that one reason (`runner.ts:223-226`). Diagnosis
would start in the wrong place. The collapse itself is pre-existing and already recorded
in `docs/reviews/4f113c7-review-sensor-swap.md`.

Verified: `bunx tsc --noEmit` clean; `bun test` 1133 pass / 0 fail (baseline 1132, +1 is
this test); `git diff cc-gate-plugin/src/acp/` EMPTY; diff is test-only, no clamp or
production change.
