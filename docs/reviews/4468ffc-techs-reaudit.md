# Review artifact — techs-reaudit (docs/techs.md 2026-08-06 re-audit + effectiveness ranking)

reviewed-range: 12ef3adc0560eac9b7dd670c2522c654be6c080c..4468ffcd3e46aff72c421f6054d34fa74fbfd660
reviewer: fresh-context-fable-code-reviewer
fresh-context: true
verdict: approved
findings-count: 2

Five docs-only commits, one file (`docs/techs.md`): Part 1 §L (GA-era
instrument/transport/seat/process-gate inventory), Part 2 third re-audit
delta (2026-08-06, PROVEN/DISPROVEN/UNPROVEN for the GA6–GA14 +
loop-fix-probes arc), Part 3 effectiveness ranking with per-row evidence
pointers, a proven-ineffective table, and the fix round.

Review was a FACT-CHECK, not style: the reviewer traced every
quantitative claim to its cited primary source (HISTORY rows SG/A1/R10/
A2/G1/C2/R1–R8/FA1/GA12/GA13, adoption-ledger boundary sections and both
Gauntlet loop rows, `docs/reviews/e25670f-fix-s4-denominator.md`,
`docs/gauge-pv/*.json`, `docs/loop-probes/*.json`,
`docs/reviews/b6d858f-b3-binarization-ruling.md`,
`docs/reviews/81fe22c-fix-darwin-sock-len.md`, the extractor
pre-registration OUTCOME blocks). Every number matched exactly: A1
6/20→17/20 p=0.00106; R10/A2 3/10→10/10 p=0.0031; G1 0/5 vs 7/9; C2
4/12 vs 7/10 p=0.198; two-tier 108,733→4,943 ms (the erratum-corrected
22x); §6c SPLIT 0.625/missed-C 6>2 and §6d edge-pass 0.800/missed-C 1=1;
§6c token cut with both boundary ts values; probe program sd/mean 1.41,
S1 62.57, S3 1.43, 245-day vs 6–7-day crossings; B3 18.26/day.
All cited file paths verified present. No technique listed both PROVEN
and UNPROVEN; warm-lane/agent-sdk dormancy descriptions consistent
across all three parts and against the preserved 07-23/07-27 sections.

Findings (both Important-class citation/scope errors, both FIXED in the
range's final commit `4468ffc`): (1) the `/clear` third-result-frame
discovery was cited to the GA13 row, which does not contain it — it is
the GA14-era T4·1a probe; re-cited at both sites. (2) the
proven-ineffective table folded R1 into "the post-A1 residual, 8
straight" — R1 ran on the BARE base pre-A1; the row is rescoped (post-A1
streak proper = R2–R8, matching the 07-27 section's own framing). The
fix commit implements exactly and only the reviewer's two findings; no
scoped re-review was run (controller-applied, mechanical re-citation —
recorded here rather than silently).

Merge-base note: branch forked from the 87d4937-era tip; main has since
advanced (office 08-06-late arc). The range contains no code and only
this one file, which the office arc did not touch — no semantic overlap.
