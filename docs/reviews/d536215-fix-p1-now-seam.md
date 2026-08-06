# Review artifact — fix-p1-now-seam (P1 test time-bomb defuse)

reviewed-range: e010c4478c71f0ae279119f9ce8a82fbecfe12f0..d53621582147a07114d31a899d24fb1354e8712f
reviewer: fresh-context-code-reviewer-subagent
fresh-context: true
verdict: approved
findings-count: 1

Two-commit branch: (d34bbd8) KKAMAK_PROBE_NOW_TS test seam in
scripts/p1-event-density.ts + frozen fixture clock in
km-crank/test/loop-probes-cli.test.ts; (d536215) review-nit fix (seam
added to the file's header env-override list).

Defect (found by the promote-acp session): 348cd5c's P1 test asserted
`post.spanDays < 1` against real Date.now() vs the fixed
S4_BOUNDARY=1785888548054 — expired 00:09Z 2026-08-06, failing main for
everyone; fixture segment membership also drifted daily.

Reviewer (fresh context, no shell — static verification, launching
agent ran the live commands): hand-verified all seam degenerate inputs
(absent/empty/NaN/negative/zero → Date.now() fallback, production
provably unchanged); recomputed the frozen geometry by hand (now =
boundary + 4h; splitAtBoundaries uses ts >= b so ties go POST; pre.n=5,
post.n=1, post.spanDays = 4/24 exactly, spans sum to exactly 7);
grepped km-crank/ for remaining wall-clock-vs-boundary dependencies —
none (sibling test file uses synthetic boundary 5; the S2-label test
uses wall-clock but asserts only branch/note fields, no window math);
judged generatedAtTs staying Date.now() correct (metadata, never
asserted). Single finding: header seam-list omission, fixed in the
trailing commit. Launching agent's live runs: file tests 10/10 pass,
tsc --noEmit clean.
