# Review artifact — gate tier-0 narrowing (D3: narrow the kmcrank blocking suite)

reviewed-range: fcebdb3..4fbca97
reviewer: fresh-context-opus-branch-reviewer
fresh-context: true
verdict: approved
findings-count: 7

Breakdown: 0 Critical, 1 Important (Task 3, fixed), 6 Minor — 4 from the
whole-branch pass (2 fixed pre-merge, 2 recorded), 2 from Task 3's review
(both fixed). Design-phase findings are counted separately in
`docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-5.md` (79 across five
architect rounds) and are not included here.

**What ships.** One decision, D3: `km-crank/test/gate-check-cli.test.ts`
(13.9 s of km-crank's 15.8 s — an end-to-end CLI drive with multi-second
`until()` waits) leaves the blocking tier, and is pulled back whenever
`scripts/gate-check.ts` changes, `gate-check-core.ts` changes
(basename-anchored), or the file itself changes. Measured result: km-crank
tier-0 **15.8 s → 1.20 s**; derived fallback selection ≈29.7 s → ≈14.4 s.
Instrument boundary ts **1785990600996** stamped in
`docs/2026-08-01-gauntlet-adoption-ledger.md`.

Four sibling decisions were withdrawn during design, each for a reason found
in the code, and are recorded as non-goals so they are not re-proposed: D1
(narrow `opencode` — `table.full` does not run it, so exclusion deletes
coverage rather than deferring it, and the green marker advances via tiers
that never ran it), D2 (map `scripts/` in `TIA_MAP` — priced at 0.02 s), D4
(close the `src/acp/index.ts` gap — violates the basename-anchoring and
one-hop policies stated at `gate-check-core.ts:138-149`), D8 (`opencode` into
`table.full` — puts a module-scope `python3` + `tmux` + `rdflib` dependency on
the synchronous debt-repayment path, an unclearable wedge on any host lacking
them).

**Verified by execution, not inspection.** The whole-branch reviewer
reconstructed the pre-branch `slowCcgateTestsForChangedPaths` /
`ccgateFastFiles` from `main` and differentially tested them against the new
`pullInsFor("ccgate", …)` / `fastFiles("ccgate", …)` across all 1390
git-tracked paths, 10 adversarial synthetics, 5000 random multi-path subsets,
and the real cc-gate-plugin test list: **zero mismatches**, ccgate's fast list
still exactly 53 of 59 files. It then ran the real gate end-to-end
(`KKAMAK_GATE_NO_BG=1`, exit 0), measuring km-crank tier-0 at **1.29 s** and
the production argv with the pull-in appended at **19.17 s** — both
corroborating the ledger's 1.20 s / 18.82 s within run-to-run spread. Added
scan cost for the second package: **0.29 ms**. All three coverage pull-back
triggers were exercised and fire. Cross-suite leakage is structurally
impossible: `pullInsFor` returns `[]` for any suite absent from
`SUITE_POLICY`, and only the two suites with enumerated argv have policies.

**One live defect fixed on the way.** The degraded-readdir path previously
produced a bare `["bun","test"]` argv and then appended a pull-in to it,
collapsing a whole suite to a single file. Task 3's review found a sharper
variant — a *partial* scan failure (one of `test/`/`src/` throwing) left a
NARROWED argv plus `scanFailed: true`, suppressing the append and leaving a
changed slow source covered by neither. Fixed by discarding partial scans, so
any scan anomaly degrades to "run everything for that package".

**Accepted coverage loss, recorded rather than discovered later.** On the
fallback path pull-ins do not fire (the deliberate ruling at
`docs/superpowers/plans/2026-08-05-two-tier-gate-check.md:919`), so the
excluded file does not run in the blocking tier there; rescue is the
background tier-1 run, which is spawn-conditional, content-raced, and absent
on a session-final Stop. This is the same trade already shipped for `ccgate`
on 2026-08-05, where the six excluded files are ~98 s of a 111.6 s suite —
D3 applies it to one 13.9 s file.

**Constraints held:** `gate.json`'s `check` string unchanged (still the last
`KKAMAK_DEV_CHECKS` entry, so no append and the drift guard at
`trial-verdict.test.ts:199` stays green untouched); `table.full` byte-unchanged;
`TIA_MAP` untouched; MECHANISM_PATHS untouched; no test imports
`scripts/gate-check.ts`.

Suite at the reviewed tip: 3197 pass / 12 skip / 0 fail repo-wide before the
fix wave; km-crank 343 and cc-gate-plugin 1115 after it. `tsc --noEmit` clean
in both packages; doc-check 0 violations.

RECORDED, not fixed (2 Minor, neither blocking):

1. The scan matches `.test.ts` only, while tier 1's bare `bun test` also
   discovers `*.spec.ts`, `*_test.ts`, `*.test.tsx/js`. A future
   `km-crank/test/foo.spec.ts` would run in tier 1 only. Pre-existing for
   ccgate since 2026-08-05; this branch extends the same gap to km-crank.
   None exist today.
2. Deleting or renaming an excluded test file makes the self-pull append a
   now-nonexistent filter, which `bun test` exits non-zero on, blocking Stops
   until a green marker advances. Escapes exist (`KKAMAK_GATE_FULL=1`,
   `scripts/km-panic.sh`). Identical hazard already shipped for ccgate's six
   slow files — a second instance, not a new class.

CROSS-SESSION NOTE: this host carries a **second** instrument boundary today —
the review-sensor arming at ts **1785988568548**, 34 minutes earlier, from a
concurrent session. The two are independent (theirs changes what a Stop does,
in the main checkout only; this changes what a Stop runs, wherever the script
executes), but main-checkout `durationMs` after merge carries both, so a
before/after attributed to either alone is a confound. Both ledger entries now
cross-reference each other.
