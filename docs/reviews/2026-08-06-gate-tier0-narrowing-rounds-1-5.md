# Review record — gate tier-0 narrowing design + plan, rounds 1-5

reviewed-commit: a2661db
reviewer: fresh-context code-architect (opus), five independent rounds
fresh-context: true
verdict: changes-requested
findings-count: 79

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

## Round 4 — against revision 4 (4 Critical, 6 Important, 8 Minor)

- **D1 residue would have reinstated D1.** Task 6 Step 4 still said "add CLI
  cases for a `minimal/tasks/` change appending the desk test" — that rule IS
  D1, and no task in revision 4 created it. An implementer would have added it
  to make their own test pass, with no opencode `slowTestRe` gating it.
- **The suite-keyed pull-in return type was never specified**, though the
  disposition section of this record claimed it was folded. A flat union
  appends each suite's files to every other suite's argv; a non-matching
  `bun test` positional can exit non-zero, which `gate-check.ts:246-249` turns
  into a blocked Stop.
- **Nothing created the suite→package-dir map.** Revision 4 fixed the
  attribution sentence in the consumer task and never added the instruction
  to the producer task.
- **Task 6 Step 3's "open question" was a false dilemma.** Marking
  *degradation* (`scanFailed: true`) rather than *narrowing* makes absence of
  the flag mean "append normally", so the seam fixture is unaffected and
  `gate-check-cli.test.ts:260` stays green. The `doccheck` objection was
  fabricated — `doccheck` has no `slowTestRe`, hence no rules.
- **The governing rule is necessary, not sufficient.** Tier-1 rescue is
  spawn-conditional (`decide` returns `spawnBg: false` on a live fresh
  `"running"` marker), content-raced (`bgMain` runs against the live worktree
  and writes green for a pre-computed tree), and absent on a session-final
  Stop. D3 does lose one deferred detection.
- **D4 violates two policies written into the file it modifies**
  (`gate-check-core.ts:138-143` "do not re-anchor them to a directory";
  `:144-149` one-hop direct value imports, deeper chains "deliberately NOT
  chased … the bg debt gate is the stated safety net"). D4's chain is two
  hops and its rule must be directory-anchored on a file whose purpose is to
  be moved. Under the recorded policy D4 is the documented deferral, not a gap.

## Disposition in revision 5

- **D4 withdrawn.** Plan reduced to D2 + D3, five tasks.
- Governing rule restated as *admissible, necessary-not-sufficient*, with the
  three rescue-chain gaps and D3's accepted residual loss recorded.
- All D1 residue purged, including the `minimal/tasks/` CLI-test instruction.
- Task 1 now creates the map and pins `pullInsFor(suite, paths)`.
- Task 4 Step 3 resolved: mark degradation, not narrowing.
- Folded: port-then-remove for the wrapper tests, baselines as lower bounds,
  readdirSync 2→4 (not tripled), the second-package self-pull moved to Task 2,
  `Cmd.cwd` key-set mismatch, and the `scripts/`-path expected-effect gap
  (~0.7 s) with a segmentation instruction so a null there is legible.

## Round 5 — against revision 5 (2 Critical, 5 Important, 8 Minor)

- **D2 was never priced, and it is worth 0.02 s.** Four rounds argued its
  correctness; none costed it. For a `scripts/foo.ts` change: today's
  fallback 29.67 s → 15.07 s after **D3 alone** → 15.05 s after D3+D2. D2's
  entire effect is dropping the `gateplugin` row. For `scripts/gate-check.ts`
  it changes nothing, because D3's rules are guardless and `kmcrank` is
  already in `FALLBACK_SUITES`. Against that: a resolution-semantics change
  to `TIA_MAP`, two moved pins, a re-pinned invariant, and a deliberate
  coverage reduction. Withdrawn.
- **The `Cmd.cwd` agreement test was unimplementable and dangerous.**
  `scripts/gate-check.ts` exports nothing and calls `main()` at module scope,
  so importing it from a km-crank test re-enters the gate, spawns `bun test`
  in km-crank, recurses, and exits the outer suite via `process.exit(0)` — a
  green gate from a partially-run suite. Replaced by deriving `Cmd.cwd` from
  the map in the wiring task.
- **`scanFailed` must be per-`Cmd`, not per-`CommandTable`**: with two
  packages scanned, a km-crank readdir failure would otherwise suppress
  *ccgate's* append while its argv is a correctly-narrowed fast list — the
  exact hole amendment b exists to close. Must be set in the `catch`, never
  inferred from `all.length === 0`.
- **`slowPull` at `gate-check.ts:236` and the log at `:237` were unspecified**
  under suite-keyed pull-ins, and Task 5's acceptance depends on that log.
- **Task 4 edits the check gating the session doing the edit**, with no
  escape route stated (`scripts/km-panic.sh`).
- Step 2's "VERBATIM" seeding contradicted the per-rule guard step and would
  redden a test the Verification note then misdiagnoses; "per-rule guard
  honoured" was not testable in Task 1, inviting a placeholder rule in
  production code.
- **Confirmed against the code:** Task 1's "no existing assertion changes"
  claim genuinely holds — the outer guard and per-rule guards are
  input-equivalent, `continue` semantics survive, and the wrappers reproduce
  `:111-181` exactly.
- **Also surfaced: a live defect in deployed code.** On the degraded readdir
  path, ccgate's `["bun","test"]` plus the append becomes
  `bun test test/acp-daemon.test.ts` — the whole suite collapses to one file.
  Worth landing regardless of D3.

## Disposition in revision 6

- **D2 withdrawn**, Task 3 deleted, `TIA_MAP` untouched. Plan is four tasks
  and one decision (D3).
- `Cmd.cwd` agreement test replaced by derivation; `scanFailed` scoped to
  `Cmd` and set in the `catch`, with the never-serialized fact commented;
  `:236` deletion and the `:237` log format specified and pinned; panic-path
  note added; "verbatim" reworded to seed lists but require guards; per-rule
  test moved to Task 2; the expected-effect note marked unobservable until
  the wiring task; caching instruction dropped; citations fixed.
- D3's residual loss restated at full width (every fallback Stop, not only
  session-final).

## Status after five rounds

Round 5's own verdict: fix the task text in place — edits, not restructuring
— then **stop reviewing and execute**, because "the residual defect supply
after these is in the 'wrong line number in a citation' band" and a sixth
round will find citation offsets.

The arc: five decisions became one. D1, D2, D4 and D8 were each withdrawn for
a reason found in the code — coverage that tier 1 cannot provide, a price of
0.02 s, two in-code policies, and a multi-host gate wedge. D3 alone survived
every round on its merits, and it is the one with the measured 88 % share.

What remains true: revision 6 is itself unreviewed, and every prior fold
introduced something. The difference is that the remaining surface is one
decision and four tasks of task-text, and round 5 verified the one structural
claim that mattered (Task 1 preserves every existing assertion). Further
review rounds now cost more than they return.
