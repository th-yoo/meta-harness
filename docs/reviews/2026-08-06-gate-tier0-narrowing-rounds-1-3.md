# Review record — gate tier-0 narrowing design + plan, rounds 1-3

reviewed-commit: 66f6e9b
reviewer: fresh-context code-architect (opus), three independent rounds
fresh-context: true
verdict: changes-requested
findings-count: 43

Not a merge artifact — the branch carries no code. This exists because both
documents cite "review round 1/2" corrections, and those citations are
unauditable on another host unless the findings are committed (repo rule:
shareable artifacts live under git). Rounds ran against
`worktree-gate-tier0-narrowing`; no Bash in either reviewer thread, so every
finding was derived by reading the cited files.

## Round 1 — against revision 1 (4 Critical, 8 Important, 6 Minor)

The two that reshaped the design:

- **Tier 1 does not run `opencode`.** `table.full` (`scripts/gate-check.ts:56-57`)
  chains cc-gate-plugin, gate-plugin, km-crank, doc-check.
  `FALLBACK_SUITES` (`km-crank/src/gate-check-core.ts:22`) is the same four,
  deliberately (`:17-21`). `merge-with-gate.sh:16` runs no tests. So tier 0 is
  the ONLY automated path for opencode tests, and revision 1's claim that
  "excluded files still run in tier 1 — nothing leaves coverage" was false for
  the suite it mattered most for.
- **Exclusions are unconditional; pull-ins are green-marker-gated**
  (`gate-check.ts:233-236`), so narrowing a suite makes the fallback run
  strictly less than before.

Also: D4's pull-in target closed nothing (`acp-client.test.ts` imports
`src/acp/` internals directly, which `index.ts:11-13` permits for tests — the
barrel's only runtime consumer is `anthropic-cli-warm.ts:10`);
`bench-cmd-ab.test.ts` was excluded with no pull-in; the package-prefix guard
at `:172` must be per-rule or a `scripts/`→km-crank rule is dead; the
`KKAMAK_GATE_COMMANDS` seam returns its table verbatim and never calls
`realCommands()`, so fast lists are not CLI-observable; `^scripts/`→kmcrank
alone would delete ccgate coverage of `km-panic.sh` and `km-sensors-sync.sh`;
an empty fast list plus a pull-in inverts a whole-suite run into a
single-file run; the self-pull rule was dropped in the generalisation.

## Round 2 — against revision 2 (5 Critical, 9 Important, 9 Minor)

Round 2 rejected revision 2's central fix. The decisive findings:

- **`FALLBACK_SUITES` is the same four commands `table.full` chains.** So
  "un-narrow when `changed === undefined`" IS the incumbent full check run
  serially in the blocking tier: 29.7 s → **133-167 s** on the majority of
  code Stops, after which the Stop still spawns a bg run of the same suites.
- **The gap it closed was already ruled deliberate.**
  `docs/superpowers/plans/2026-08-05-two-tier-gate-check.md:919` states the
  fallback's empty pull-in is intentional because "the bg full run covers the
  slow files". Revision 2 declared it Critical without citing or rebutting
  that ruling.
- **It could not reach the one real gap.** `changed === undefined` ⇒
  `suites = FALLBACK_SUITES`, which contains no `opencode` — so the opencode
  un-narrowed argv is dead code.
- **It falsified D7's arithmetic and §6's floor inside the same document.**
- **D8 is unacceptable.** `table.full` is also the SYNCHRONOUS debt-repayment
  command (`gate-check.ts:141-147`, invoked `:205-211`), so adding opencode
  moves the red-marker Stop from 133-167 s to ~170-205 s. Worse,
  `minimal-relations-desk.test.ts` spawns `python3` at module scope (`:17`,
  no skip guard), spawns `tmux` (`:57`, `:72`) and requires host `rdflib`
  (`:103`). On a host lacking any of them the bg run goes red and can never go
  green — and D6 keeps repayment synchronous, so every Stop thereafter pays
  ~200 s with no exit. The repo is explicitly multi-host.
- **Neither narrowed suite got a self-pull:** `:172`/`:174` hardcode
  `^cc-gate-plugin/`, so "keep it" is insufficient; it must become per-suite.

Plus: `TIA_MAP` is `{ re; suite }` singular resolved by `.find`, so D2's
two-suite mapping needs a record-type change or it silently yields one suite;
Task 3's edit would delete the only test of "fallback never DROPS a TIA pick"
without re-pinning it; a pull-in does not select its own suite; `import type`
imports do not count under the amendment-b policy, so `bench-cmd-ab` has
seven value imports, not nine.

## Disposition in revision 3

- §2.3's binding rule **withdrawn**; the fallback path is out of scope, with
  the prior ruling cited.
- **D8 withdrawn**, with the wedge argument recorded so it is not
  re-proposed. `table.full` unchanged, so the executed two-tier plan's
  "byte-identical string" constraint still holds.
- **D1 re-justified on input-scoping** rather than tier 1: the desk test
  reads only `minimal/tasks`, so a pull-in on that path plus a self-pull
  preserves every situation in which it could newly fail. No regression on the
  TIA-inactive path, where opencode is not selected today.
- Per-rule guard, per-suite self-pull, `TIA_MAP` record-type change,
  re-pinned unknown-path invariant, degraded-case guard, corrected D4 target,
  `bench-cmd-ab` not excluded, and the seam's test-level limitation all folded
  into the plan's steps.
- D7's arithmetic and §6's floor restored, valid again once un-narrowing is
  withdrawn.

Round 2's own summary of the most load-bearing correction — decide whether
the fallback's exclusion is a defect at all, and price it — is what revision 3
acts on: it is not a defect, and the documents say so with the citation.

## Round 3 — against revision 3 (2 Critical, 6 Important, 8 Minor)

Round 3 killed D1, which revisions 1-3 had each tried to save with a different
argument.

- **The pull-in is edge-triggered on the diff since the green marker, and the
  green marker is advanced by tiers that never run opencode.**
  `changed = changedPathsSince(marker.tree, tree)` (`gate-check.ts:233-234`);
  the marker is written by `runFullSync` (`:143-145`) and `bgMain`
  (`:186-188`), both running `table.full`, which excludes opencode. Three
  documented routes bake a `minimal/tasks/` edit behind the baseline without
  opencode running: debt repayment, `KKAMAK_GATE_FULL=1`, and the pruned-tree
  fallback whose bg run writes green for the new tree. After any of them the
  pull-in never fires again and the desk test never runs — where today that
  Stop runs the whole suite. The self-pull leg dies the same way. Coverage
  lost permanently, not deferred.
- **Task 6's degraded-case guard is unsatisfiable as written**: the predicate
  "fast list is non-empty" does not exist for a seam table, because
  `commands()` returns the seam JSON verbatim and never calls
  `realCommands()`. Both natural implementations either break the only CLI
  test of the pull-in mechanism or mean the wrong thing for `doccheck`.

Also: the absolute coverage constraint was violated by the plan's own D3/D4,
which rely on tier-1 rescue while the architecture line claimed rescue is
"never by appeal to tier 1"; Task 1's self-pull depended on a map Task 6
introduced two tasks later, conflating a scan root with a path prefix and
duplicating `Cmd.cwd`; the generalised pull-in's return type was never
specified as suite-keyed, so a flat union would append each suite's files to
every other suite's argv; D7's "≈14.6 s" was D3's serial value, not
concurrency's (13.2 s today), and its table pooled Pass A and Pass B against
§1's own prohibition; the acceptance instrument was cited as a cwd-relative
path when the stream is home-anchored, and the observed 23.8-25.4 s band
matches no predicted selection, so acceptance was unfalsifiable.

## Disposition in revision 4

- **D1 withdrawn.** Task 5 deleted; `opencode` out of scope.
- **The durable rule extracted:** narrowing a suite is safe **iff that suite
  runs in `table.full`**. `ccgate` and `kmcrank` do; `opencode` does not.
  Making opencode narrowable needs marker provenance or D8, neither designed.
- Coverage constraint restated as two required halves (input+self pull-in,
  AND the suite runs in `table.full`), replacing the absolute form no
  narrowing could satisfy.
- Task 6 Step 3 converted into a declared open implementation question with
  both options and an explicit prohibition on silently rewriting the fixture.
- Folded: map ownership and the `Cmd.cwd` third copy, self-pull gated on
  `slowTestRe`, suite-keyed pull-in signature, D7 arithmetic corrected with a
  "today, concurrent" row and its pass-pooling flagged, home-anchored stream
  path, acceptance correlation against `gate-check.ts:237`, `^scripts/`
  dropping `gateplugin` recorded, `TIA_MAP` list-vs-collect-all ruling, the
  opencode host caveat, Task 2's commit-message ordering, and retirement of
  the ccgate-shaped exports in Task 6.

## Status after three rounds

**Not flawless.** Rounds 2 and 3 each found defects introduced by the
previous round's fold, and revision 4 has not been reviewed. The trend is
favourable — round 1 invalidated a decision's premise, round 2 invalidated
the fix, round 3 invalidated the decision itself, and revision 4 removes it
rather than defending it a fourth time — but a fourth round should be assumed
to find fold-induced defects, most likely around Task 1's generalisation and
Task 6's open question.
