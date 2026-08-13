# Review — a3-live-adapter (Plan B)

reviewed-range: afae9276dcbc6188d46b6fea480c5facb81ab5b3..2604da8852a0fbfdb2bf78fc66760996a56f1307
reviewer: fresh-context-code-reviewer-subagent (session-model final pass; per-task fresh sonnet reviewers)
fresh-context: true
verdict: approved
findings-count: 1

Seven-commit branch implementing spec §4 (live adapter) of
docs/superpowers/specs/2026-08-13-a3-rule-routing-design.md per the
FLAWLESS plan docs/superpowers/plans/2026-08-13-a3-live-adapter.md.
SDD: 5 tasks, fresh implementer + fresh reviewer per task, 1 in-task fix
round (calibration), 1 final-review fix wave (docs rescope). Ships:
producer `exportRuleChecks(repoRoot, storeRoot)` called at every
playbook-mutating store transition (activate all scopes, startTrial both
propose sites, resolveTrial confirm+revert reaffirm, gate-trial
keep/rollback/abandoned; deferred exempt; cmdRolesImport/bootstrapStore
exempt) writing `.km/rule-checks.json` (liveEligible-only, `rules: []`
when none) + F2 sync-exclusion lock; consumer shadow evaluator
cc-gate-plugin/src/rule-checks.ts (RULE_CHECKS_MAX 8, BUDGET_MS 5000,
runtime unsafeReason re-screen, fail-open, per-rejection skip with budget
untouched) spliced into the Stop path on `line` after all reassignments —
annotation only, SHADOW structurally guaranteed; SensorLine contract rev
(`ruleChecks?: RuleCheckOutcome[]`, type owned by types.ts per
GaugeSensorField precedent) with conformance extensions, driven
byte-identity + shadow-invariant pins, km-crank parity hard-fail on a
present-but-half-updated kkamak fixture (absent fixture still
advisory-skips), scan.ts mirror; plugin 0.4.4 → 0.4.5 same-window;
calibration coveredMechanismRev advanced over the telemetry-only T4 core
edit (TM1 precedent, 4th instance).

## Finding (Important, addressed in fix wave 2604da8)

1. Plan/spec premise "yoo-mac has no kkamak clone" is false —
   ~/z2/kkamak exists on this host with the 4-vector
   sensor-contract.ndjson fixture, so the new hard-fail would turn
   km-crank red on main immediately post-merge (worktree runs masked it:
   the worktree's extra path segment resolves ../../../kkamak to a
   nonexistent dir and advisory-skips). Addressed by rescoping the
   resume.md handoff to MERGE-WINDOW duties on yoo-mac: kkamak fixture
   gains the 5th vector + kkamak conformance extension in the same
   change window as the merge (ordering pinned: fixture must not land
   before the merge or main's 4-line compare goes red), suites verified
   from the main checkout. Scoped re-review: ADDRESSED, no breakage.

## Verification

Per-task suites green at every gate; final state opencode-plugin 1884
pass / 0 fail, cc-gate-plugin 1050 pass / 0 fail (incl. packaging parity
at 0.4.5), km-crank 400 pass / 0 fail (calibration 11/11 after rev
bump). Final reviewer independently re-derived every production
writeActive/activateCandidate/startTrial/resolveTrial/resolveGateTrial
call site (none unwired beyond the exempt set), traced the
producer→consumer contract end-to-end (paths, shapes, empty-vs-absent
round-trip), and re-verified F2 (no cmd text on lines, in sync FILES, or
in the scan.ts mirror) and the SHADOW splice order. Ledger deferred
minors all triaged stays-deferred (fail-open test coverage gap, unused
test helper, report count mislabels, passthrough lambda, MIN_N-drift
latent note). SDD ledger + per-task reports:
.superpowers/sdd/2026-08-13-a3-live-adapter/ (worktree-local, deleted
after merge; git history is the record).

## Merge-window duties (execute WITH the merge, not before)

Per the rescoped resume.md block: kkamak fixture 5th vector + kkamak
conformance extension; km-crank suite from the MAIN checkout; deploy
separately (bun install, km-refresh, grep-verify 0.4.5, boundary ts in
the adoption ledger).
