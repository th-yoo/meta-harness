# Review artifact — b3-binarization-ruling (B3 ruling: D vs rest + measurement script)

reviewed-range: 40319d5c3f05c59da7916014c6dac7802ca64810..b6d858feb89762194b47208f405fc7145bff2f0e
reviewer: fresh-context-code-reviewer-subagent
fresh-context: true
verdict: approved
findings-count: 1

Two-commit branch: (5d494e7) B3 binarization ruling section appended to
the loop-fix probe-program spec (open-register item 2 closed, D vs rest)
+ `scripts/b3-binarization-measure.ts`, the zero-model-call measurement
the ruling rests on; (b6d858f) the review fix.

Reviewer (fresh context, no Bash — verified by hand-recomputation, which
caught what execution from the right cwd would have masked):
independently recomputed EVERY claimed number from the raw
`.km/gate-outcomes.ndjson` and the committed P0/P1 jsons — 119
gauge.present lines / 6.516d = 18.26/day out of 438 in-window Stops;
D-vs-rest minorities 27/107 = 25.2% live, 174/407 = 42.8% corpus; floor
failures C-vs-not-C (0.9%/5.2%) and B+C (6.5%/9.3%); hand-evaluated
nPerArmBinomial(0.2523, 0.30) = 41, (0.4275, 0.30) = 42,
daysToVerdict(41, 18.26) = 5 ≤ 14 bar; d=0.20 → 89/97 per arm → 10-11
days. ALL MATCHED the spec section. Also verified: formulas imported
from km-crank/src/loop-probes.ts (never reimplemented), MIN_N=20 floor
applied caller-side matching e-table.ts precedent, P0/P1 env-override
seam identical to e-table.ts, F2 (counts only, no prompt/note text),
ruling prose adopts no config and declares the workload-confound
limitation.

Single finding (Important, confidence 85): the script read
`.km/gate-outcomes.ndjson` cwd-relative with no fallback — crashes
ENOENT from worktrees whose `.km/` is absent, the exact trap
`p0-signal-variance.ts` documents and home-anchors around (and P0/P1
were in fact run from a worktree). Fixed in the trailing commit
b6d858f: imports `gateNdjsonPath()` + tolerant `readGateLines()` from
p0-signal-variance.ts, explicit exit 1 on zero lines; re-verified from
repo root and a foreign cwd (identical output — cadence had live-drifted
18.26 → 18.36/day as one new gauge line landed; conclusions unchanged,
spec snapshot left at ruling-time values).
