# Review artifact — fix-s4-denominator (S4 span-aware rates + erratum)

reviewed-range: 25497030ed1e60a6ab1b89dde6683bb5ec307a42..e25670f32ec2df0f5ba9c274d095b68069fc3d5a
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 1

Two-commit fix branch. Defect (found by the kkamak-repo session's
independent review of the merged loop-probes artifacts): S4 segments
divided line counts by the full 7-day window while the post-boundary
segment spans ~0.19 days — committed rate read 2.43/day vs real
~88/day, a spurious 25x "emission drop". Fix: per-segment clamped-span
denominator (spanDays field, rate = n/spanDays, null on zero span) in
scripts/p1-event-density.ts + 4 pinning test assertions + spec Erratum
(frozen snapshot untouched; corrected interpretation recorded — the real
S4 story is gated-Stop durationMs mean 108,733 -> 4,943 ms, ~22x faster
Stops across the two-tier boundary). Reviewer hand-traced the
null-as-open-ended bounds clamping both edge cases, independently
recomputed every erratum number from the frozen json (61.85 / 88.04 per
day; durationMs means exact), ran the CLI test file (10/10), confirmed
3-file scope. Single finding = a 0.1 rounding slip in erratum prose,
fixed in the trailing commit. E table unaffected (S4 excluded by design).
