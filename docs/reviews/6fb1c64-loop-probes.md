# Review artifact — loop-probes (P0/P1/E probe program execution)

reviewed-range: 22513967b9f19cc942d6b8893ad48ecbbce1dc7f..6fb1c64e82d911954952d6328c7655b22bfb9cb7
reviewer: fresh-context-fable-code-reviewer
fresh-context: true
verdict: approved
findings-count: 10

Five-commit branch executing the loop-fix probe program
(docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md,
itself reviewed-to-SOUND over 3 architect rounds) via SDD: Task 1 pure
module (4a69769, km-crank/src/loop-probes.ts — parsing, boundary splits,
per-family viability floors, power formulas; binomial spot value
hand-derivation independently recomputed by its reviewer), Task 2 P0+P1
CLIs + real office outputs (bb56775 + fix f025c7c — task review caught
B3 reading the WRONG repository (worktree cwd) with no disclosure;
repointed at the main checkout via home-anchored constant, real counts
live 107 / corpus 407 independently reproduced), Task 3 E table
(690706f — reviewer recomputed every load-bearing number exactly), final
fix wave e6cc05e (spec §3 results-append; scoped re-review verified every
appended number against the committed jsons), controller cause-mapping
record 6fb1c64 (documentation-only table over the already-verified
numbers: per-cause effective options + fixed/reframed/open register).

Final whole-branch review (fresh fable reviewer): 0 Critical, 1 Important
(the §3 append — fixed), 6 minors (all defer-ruled in the SDD ledger:
worktree-absolute source paths, latest-segment n labeling, B4
trial-vs-task pooling taxonomy, e-table trusting recorded viability,
buildB4 crash path on malformed json, b1Foreign excluded-list absence).
End-to-end result-integrity chain verified by independent recomputation:
raw streams → P0 stats/viability → E rows → verdict.

RESULT (committed docs/loop-probes/yoo-dev-*.json + spec Results
section): P0 viable signals = b2 review findings (n=10, mean 4.2,
sd 5.92) and b4 TB2 trials (22/34); all four B1 gate-outcomes signals
UNKNOWN (latest regime n=5 — the 0.3.0-stamp boundary 1785899174570 was
derived from data as designed); B3 categorical, binarization undeclared.
P1: s1 62.57 gate lines/day, s2 55.43 (this repo) / 10.57 (kkamak)
commits/day, s3 1.43 review-adds/day. E verdict: meaningfulCrosses 1,
passing 0 — **NO-CONFIG-PASSES**: the only pairing where a viable signal
actually rides a real source today (b2×s3) needs 245 days at effect
0.30 vs the 14-day bar. Capacity-only crosses would pass but nothing
emits those signals at those cadences today. Spec §5 applies: the loop is
unaffordable on current evidence channels; the architecture decision goes
to the user with these numbers.

Pre-merge sanity chain green on the reviewed tip: cc-gate 1043,
gate-plugin 26, km-crank 327, doc-check 0 violations, opencode 1688
(12 skip), 3m45s. Zero model calls in all probes and tests; F2 clean;
MECHANISM_PATH untouched.
