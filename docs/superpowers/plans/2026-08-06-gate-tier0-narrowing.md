# Gate tier-0 narrowing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`.
**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.
**Reviews:** `docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-4.md`
(round 4 appended there).

**Revision 5.** Four architect rounds. Round 1 killed D1's premise; round 2
killed the fix for it and killed D8; round 3 killed D1; **round 4 killed D4**
and showed the governing rule was overstated. **What remains is D2 and D3.**

The governing rule with its limits: narrowing a suite is *admissible* only if
that suite runs in `table.full` — necessary, **not sufficient**. Tier-1
rescue is spawn-conditional, content-raced, and absent on a session-final
Stop (spec D1, "Necessary, not sufficient"). D3 therefore loses one deferred
detection in a reachable scenario; accepted knowingly, not overlooked.

**Goal:** cut tier-0 blocking latency for `kmcrank`-selected Stops, and give
`scripts/` a correct TIA mapping instead of the fallback union.

## Measured baseline (Pass B — JUnit, repo `487d104`, yoo-dev, n=1)

| suite | total | dominant file | share |
|---|---|---|---|
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, … | diffuse |

`ccgate` is not narrowed here — diffuse, and already narrowed by the executed
2026-08-05 plan. `opencode` is out of scope (D1 withdrawn).

**Architecture:** no new mechanism. `ccgate` already pairs an exclusion regex
with an amendment-b pull-in; this generalises that to a per-suite table and
applies it once, to `kmcrank`.

## Global Constraints

- **`gate.json`'s `check` string and `table.full` MUST NOT change.** Editing
  either means the task is mis-scoped. The `KKAMAK_DEV_CHECKS` drift guard
  (`trial-verdict.test.ts:199`) stays green untouched.
- **No task keys on `changed === undefined`** (the fallback path, spec §2.3).
- **Admissibility:** only narrow a suite that runs in `table.full`, and pull
  the excluded file back on changes to its inputs AND to itself. Both halves
  required. This is not a proof of no-loss — see the rule's limits above.
- **MECHANISM_PATHS** (`calibration.ts:65-72`) never edited.
- **Do not touch `opencode-plugin/` or add any opencode rule.** D1 was
  withdrawn after three rounds; a `minimal/tasks/` rule would reinstate it.
- **Fail-safe direction.** Uncertain ⇒ run MORE.
- `bunx tsc --noEmit` clean and `bun test` green in `km-crank` and
  `cc-gate-plugin` at the end of EVERY task. Baselines are **lower bounds,
  not equalities** — most tasks add tests: km-crank ≥ 327, cc-gate-plugin
  ≥ 1043. No task here touches `opencode-plugin`; run it once at Task 5 if
  the host has `python3`, `tmux` and `rdflib`, and record "not run" otherwise
  rather than reporting a false green.
- **Fresh worktree? `bun install` per package first** — no root
  `package.json`. A depless worktree fails as "Unhandled error between
  tests", which reads like a code defect and is not one.
- Commit per task, conventional format, message explains why not what.

## Task 1 — generalise the machinery

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1: create the suite→package-dir map.** It does not exist today.
  Define it **here**, exported, so Task 4 imports it instead of making a
  second copy. Entries: `ccgate` → `"cc-gate-plugin"`, `kmcrank` →
  `"km-crank"`. A third copy of these strings already exists as `Cmd.cwd`
  (`gate-check.ts:49-53`), which has five keys including `doccheck: "."` — do
  **not** derive one from the other; add a test asserting that for every key
  present in both, the values agree, so a package rename fails loudly.
- [ ] **Step 2: per-suite policy record** — suite id → optional `slowTestRe`
  plus pull-in rules, each rule carrying an optional path guard. Seed with
  ccgate's existing regex (`:125-126`) and rules (`:150`) VERBATIM. Keep the
  current exported names as wrappers so nothing outside changes yet.
- [ ] **Step 3: the pull-in function is SUITE-KEYED.** Signature
  `pullInsFor(suite: SuiteId, paths: string[]): string[]`, returning only
  that suite's own test paths — never a flat union. A flat union would append
  `test/gate-check-cli.test.ts` to the **ccgate** argv and
  `test/acp-daemon.test.ts` to the **kmcrank** argv; `bun test` treats
  positionals as path filters, so a non-matching filter either wastes the run
  or exits non-zero, and `gate-check.ts:246-249` turns the latter into a
  blocked Stop. Pin the signature with a test.
- [ ] **Step 4: the package-prefix guard becomes PER-RULE.** Today
  `slowCcgateTestsForChangedPaths` early-continues on `!/^cc-gate-plugin\//`
  (`:172`), which is what makes `gate-check-core.test.ts:155` pass. A
  per-*suite* guard would make Task 2's rules dead, since they map a
  `scripts/` path to a km-crank test. ccgate's rules carry `^cc-gate-plugin/`
  and behave identically.
- [ ] **Step 5: the self-pull becomes PER-SUITE**, keyed off Step 1's map,
  replacing the hardcoded `^cc-gate-plugin/((?:test|src)/.*\.test\.ts)$`
  (`:174`, pinned by `gate-check-core.test.ts:139-142`). **Keep the existing
  `slowTestRe` gate** (`:175`) so it fires only for narrowed suites.
- [ ] **Step 6:** tests — ccgate behaviour identical on the existing
  fixtures; suite-keyed return pinned; per-rule guard honoured; map/`Cmd.cwd`
  agreement. **The second-package self-pull case belongs to Task 2**, where
  `SLOW_KMCRANK_TEST_RE` is introduced — do not add it here, and do not add
  the kmcrank regex early to make a Task 1 test possible.
- [ ] **Step 7:** green + commit.

**Verification:** no existing `gate-check-core.test.ts` assertion may need
editing in THIS task. If one does, semantics changed — stop and report.
(Task 3 legitimately changes two.)

## Task 2 — D3: narrow `kmcrank`

- [ ] **Step 1:** `SLOW_KMCRANK_TEST_RE` matching `gate-check-cli.test.ts`
  (13.9 s of 15.8 s). Comment carries the measurement and the cause
  (end-to-end CLI drive with multi-second `until()` waits).
- [ ] **Step 2:** pull-in rules `^scripts/gate-check\.ts$` and
  `(^|/)gate-check-core\.ts$` → `["test/gate-check-cli.test.ts"]`, carrying
  **no package-prefix guard** — mapping an out-of-package path to a km-crank
  test is why Task 1 Step 4 made the guard per-rule. Load-bearing: without
  them, edits to the gate itself lose their most direct coverage.
- [ ] **Step 3:** test that Task 1 Step 5's self-pull covers
  `km-crank/test/gate-check-cli.test.ts` — the second-package case deferred
  from Task 1.
- [ ] **Step 4:** commit message notes these pull-ins fire only when
  `kmcrank` is selected (a pull-in does not select its own suite;
  `gate-check.ts:239-250` iterates `suites`). **At this commit** that holds
  because `kmcrank` is in `FALLBACK_SUITES`; Task 3 later adds the
  `^scripts/` TIA entry. Do not write it as though Task 3 has landed.
- [ ] **Step 5:** green + commit.

**Expected:** kmcrank-selected Stops ≈15.8 s → ≈1.9 s; full ≈15.8 s when the
gate's own sources or that test file change.

## Task 3 — D2: map `scripts/`

- [ ] **Step 1: change `TIA_MAP`'s record type first.** Entries are
  `{ re; suite: SuiteId }` singular resolved by `.find` (`:98`, `:112`) —
  first match wins, so two entries sharing a regex silently yield one. Give
  the entry a suite **list**. Do not instead "collect all matches": that
  changes resolution semantics for every existing entry.
- [ ] **Step 2:** add `^scripts/` → **`kmcrank` AND `ccgate`**. Not kmcrank
  alone: `cc-gate-plugin/test/escape-hatch.test.ts:13` drives
  `scripts/km-panic.sh`; `test/fixture-ref.test.ts:187` and
  `test/corpus-store.test.ts:270` assert over `scripts/km-sensors-sync.sh`.
- [ ] **Step 3: record what the entry DROPS.** Today `scripts/` unions
  `FALLBACK_SUITES`, which includes `gateplugin`; after this it does not.
  Verified at plan time that `gate-plugin/` has zero references to
  `scripts/`, so the drop is defensible — but "Uncertain ⇒ run MORE" makes an
  unrecorded reduction unresolvable for a later reader. Put it in the comment.
- [ ] **Step 4: two pinned assertions change; one invariant must be
  re-pinned.** `gate-check-core.test.ts:97` and `:100` both move. `:99-101`
  is the only test of the conservative-union behaviour at
  `gate-check-core.ts:113-114`; after this task `scripts/x.ts` is no longer
  unknown, so **re-pin it with a path that is still unknown** (e.g. under
  `term-bench2/`). Say in the commit message why each pin moved.
- [ ] **Step 5:** green + commit.

## Task 4 — wire the command table

**Files:** `scripts/gate-check.ts`, `km-crank/test/gate-check-cli.test.ts`

- [ ] **Step 1:** generalise the fast-list computation (`:36-49`), which
  hardcodes package dir `"cc-gate-plugin"` and scan roots `["test","src"]`.
  **Import Task 1 Step 1's map**; do not define a second one. This adds one
  package, taking the recursive `readdirSync` from 2 calls to 4 — measure it;
  if not negligible, cache per tree hash. Re-verify the guard comment at
  `:32-35` for `km-crank`: confirmed at plan time that it has no `.test.ts`
  outside `test/` and no nested `node_modules` under `src/`.
- [ ] **Step 2:** replace the hardcoded `s === "ccgate"` (`:242-244`) with
  the general form: append **that suite's own** pull-ins (Task 1 Step 3).
- [ ] **Step 3: guard the degraded case — mark DEGRADATION, not narrowing.**
  `:41-45` degrades to `all = []` on readdir failure, giving
  `argv = ["bun","test"]` (whole suite, correctly fail-safe); appending a
  pull-in to that yields `bun test <one-file>`, running **only** that file.
  Set an explicit flag in `realCommands()` on the degraded path — e.g.
  `scanFailed: true` — and skip the append when it is set. **Mark degradation
  rather than narrowing**, so that *absence* of the flag means "append
  normally": the seam fixture (`gate-check-cli.test.ts:47-51`) has no such
  field, so `undefined` is falsy, the append still fires, and the existing
  assertion at `:260` stays green untouched. A flag meaning "narrowed" would
  invert that and redden the only end-to-end proof that pull-ins reach argv —
  **do not rewrite that fixture.**
- [ ] **Step 4: test at the right level.** `KKAMAK_GATE_COMMANDS` (`:61-65`)
  returns the seam JSON verbatim and never calls `realCommands()`, so fast
  lists are **not** CLI-observable — unit-test them on Task 1's helpers. The
  pull-in *append* IS CLI-observable (it happens in `main()`), which is what
  `gate-check-cli.test.ts:250-261` exercises. Add a CLI case for a changed
  excluded test file appending itself.
- [ ] **Step 5: retire the ccgate-shaped exports — PORT, then remove.**
  `SLOW_CCGATE_TEST_RE` / `ccgateFastFiles` / `slowCcgateTestsForChangedPaths`
  were kept as wrappers so earlier tasks would not churn. Their tests at
  `km-crank/test/gate-check-core.test.ts:111-181` include the exact-list
  assertions at `:112-123` and `:124-138` — the only committed proof of which
  slow test each source pulls, and `:124-138` specifically proves the
  post-promotion `src/acp/` layout still matches. **Port every assertion to
  the generalised function first, then remove the wrappers.**
- [ ] **Step 6:** green + commit.

## Task 5 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure with the **Pass B (JUnit) method only**. Read
  the live stream via `gateNdjsonPath()` / `MAIN_GATE_NDJSON_DEFAULT`
  (`scripts/p0-signal-variance.ts:83-87`) — **home-anchored**; a bare
  relative `.km/gate-outcomes.ndjson` read from a worktree is a different,
  near-empty file (`scripts/b3-binarization-measure.ts:46-53` records this as
  "NEVER cwd-relative").
- [ ] **Step 2: segment the acceptance data by selection.** Correlate
  durations with `gate-check.ts:237`'s per-Stop suite log. Two reasons: the
  recorded 23.8-25.4 s band matches no predicted selection and stays
  unattributed until correlated; and the path most exercised while executing
  this plan — editing `scripts/gate-check.ts` — goes from the 29.7 s fallback
  to `ccgate` 13.1 + `kmcrank` 1.9 + pull-in 13.9 + `doccheck` ≈ **28.9 s**, a
  ~0.7 s gain. Without segmentation, a null result there is
  indistinguishable from failure.
- [ ] **Step 3:** append an INSTRUMENT entry to
  `docs/2026-08-01-gauntlet-adoption-ledger.md` — what changed, before/after
  (same method), and the **boundary ts**, stating that gated-Stop
  `durationMs` must not pool across it. Append post-change numbers to spec §1
  as a new dated pass; never overwrite Pass A or Pass B.
- [ ] **Step 4:** green + commit.

**Verification:** never claim improvement from a single Stop. The tail is
governed by red-marker debt repayment (133-167 s), untouched here.

## Sequencing

Task 1 → Task 2 → Task 3 (2 and 3 are independent of each other but both
touch `gate-check-core.ts`; run serially) → Task 4 → Task 5.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact whose
`findings-count` is a **bare integer** — the 7b gate rejects the prose form.

## Non-goals

- **Narrowing `opencode`** (D1, withdrawn round 3) — specifically **no
  `minimal/tasks/` rule**, which would reinstate it.
- **The `src/acp/index.ts` tier-0 gap** (D4, withdrawn round 4) — the
  documented two-hop deferral; closing it needs amending two in-code policies.
- `ccgate`'s ≈14 s (diffuse; already narrowed by the executed plan).
- `table.full` / D8; synchronous debt repayment (D6); concurrency (D7).
