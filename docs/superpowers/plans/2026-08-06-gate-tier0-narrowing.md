# Gate tier-0 narrowing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`.
**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.

**Revision 2** — architect review round 1 found 4 Critical and 8 Important
defects in revision 1. The two that reshaped this plan:

- **Tier 1 does not run `opencode`** (`gate-check.ts:56-57`), and neither
  does `FALLBACK_SUITES` (`gate-check-core.ts:22`, deliberately). Revision 1
  claimed "excluded files still run in tier 1 … nothing leaves coverage".
  That is true for ccgate and kmcrank and **false for opencode**, where tier 0
  is the only automated path. D1 therefore deletes coverage rather than
  deferring it, and is now **blocked on D8**.
- **Exclusions apply unconditionally; pull-ins only fire with a green
  marker** (`gate-check.ts:233-236`). Narrowing a suite therefore makes the
  *fallback* — the "when uncertain, run more" path — run strictly less.
  Fixed by the binding rule in Task 1 Step 3.

**BLOCKING DECISION — D8, must be ruled before Task 5.** Does `opencode-plugin`
join `table.full` (tier 1)? Spec §2.2/D8 recommends yes. Tasks 1-4, 6 and 7
do not depend on it. **Task 5 (D1) must not start until D8 is ruled**, and if
D8 is declined, Task 5 is withdrawn — not silently taken anyway.

**Goal:** cut tier-0 blocking latency for `kmcrank` and (conditionally)
`opencode`, shrink the fallback surface, close the `src/acp/index.ts`
coverage gap, without any suite ending up with less coverage than today.

## Measured baseline (Pass B — JUnit reporter, repo `487d104`, yoo-dev)

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | 36.0 s / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, … | diffuse |

`ccgate` has no dominator — this plan does not narrow it (§ Non-goals).

**Architecture:** no new mechanism. `ccgate` already pairs an exclusion regex
with an amendment-b pull-in. This plan generalises that to a per-suite table
and applies it. Excluded ccgate/kmcrank files still run in tier 1; excluded
opencode files run in tier 1 **only if D8 lands first**.

**Tech Stack:** Bun + TypeScript. Pure logic in
`km-crank/src/gate-check-core.ts`, wiring in `scripts/gate-check.ts`, unit
tests in `km-crank/test/gate-check-core.test.ts`, CLI tests in
`km-crank/test/gate-check-cli.test.ts`.

## Global Constraints

- **`gate.json`'s `check` string MUST NOT change** — already
  `bun scripts/gate-check.ts`, the last `KKAMAK_DEV_CHECKS` entry
  (`km-crank/src/trial-verdict.ts:77-82`). **No append is required or
  permitted**; the drift guard at `trial-verdict.test.ts:199` stays green
  untouched. Editing `gate.json` or that array means the task is mis-scoped.
- **MECHANISM_PATHS** (`km-crank/src/calibration.ts:65-72`):
  `minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`,
  `minimal/session2.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`.
  Never edited. Note the four `minimal/` entries — this plan writes *policy
  about* `minimal/` paths but touches none of those files.
- **No suite may end up with less coverage than today**, on any path
  (TIA-active, fallback, or full-sync). This is the constraint revision 1
  violated three ways.
- **Fail-safe direction.** When selection is uncertain, run MORE.
- **One policy site** — follow `SLOW_CCGATE_TEST_RE`'s stated rule.
- `bun test` green in `km-crank`, `cc-gate-plugin`, `opencode-plugin` and
  `bunx tsc --noEmit` clean at the end of EVERY task before its commit.
  Baselines: km-crank **327**, cc-gate-plugin **1043**, opencode-plugin
  **1694** (12 skip).
- **Fresh worktree? `bun install` in each package first** (`cc-gate-plugin`,
  `km-crank`, `opencode-plugin`; there is no root `package.json`). A worktree
  without deps fails as "Unhandled error between tests", which reads like a
  code defect and is not one. Cost a blocked turn on 2026-08-06.
- Commit per task, conventional format, message explains why not what.

## Task 1 — generalise the machinery, and make exclusion conditional

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1: per-suite policy record.** Introduce a table keyed by suite
  id holding an optional `slowTestRe` and a list of pull-in rules. Seed with
  ccgate's existing regex (`:125-126`) and rules (`:150`) VERBATIM. Keep the
  existing exported names as wrappers so nothing outside changes this task.
- [ ] **Step 2: the prefix guard is PER-RULE, not per-suite.**
  `slowCcgateTestsForChangedPaths` currently early-continues on
  `!/^cc-gate-plugin\//.test(p)` (`:172`), which is what makes the existing
  assertion at `gate-check-core.test.ts:155` pass (`km-crank/src/acp-daemon.ts`
  pulls nothing). A per-*suite* prefix would make Task 2's rule impossible,
  because `^scripts/gate-check\.ts$` maps to a **km-crank** test from a path
  outside `km-crank/`. Give each rule its own optional path guard; ccgate's
  rules carry `^cc-gate-plugin/` and behave identically.
- [ ] **Step 3: preserve the self-pull rule.** `:174-175` handles a changed
  slow *test* file pulling itself in, pinned by `gate-check-core.test.ts:139-142`.
  The generalised table must keep it, or editing an excluded test file selects
  the suite without running the file you just edited.
- [ ] **Step 4: the binding un-narrowing rule.** Add a pure helper that,
  given a suite and whether TIA was active, returns either the fast list or
  **the un-narrowed (empty) file list**. Exclusion must be conditional on the
  same signal the pull-in is — see spec §2.3. Task 6 wires it; this task
  defines and tests it.
- [ ] **Step 5:** tests — ccgate behaviour byte-identical on the existing
  fixture cases; per-rule guard honoured; self-pull preserved; un-narrowing
  helper returns the full list when TIA is inactive.
- [ ] **Step 6:** `bun test` + `tsc` green in km-crank; commit.

**Verification:** no existing `gate-check-core.test.ts` assertion may need
editing in THIS task. If one does, semantics changed — stop and report.
(Task 3 does legitimately change two assertions; that is that task's business.)

## Task 2 — D3: narrow `kmcrank`

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1:** `SLOW_KMCRANK_TEST_RE` matching `gate-check-cli.test.ts`
  (13.9 s of 15.8 s). Comment carries the measurement and the cause
  (end-to-end CLI drive with multi-second `until()` waits).
- [ ] **Step 2:** pull-in rules, each with its own path guard per Task 1
  Step 2: `^scripts/gate-check\.ts$` and `(^|/)gate-check-core\.ts$` →
  `["test/gate-check-cli.test.ts"]`. **Load-bearing:** without these, edits to
  the gate itself lose their most direct blocking coverage — the change most
  able to break the gate. Basename-anchor the core rule, matching the
  convention that survived the ACP directory move.
- [ ] **Step 3:** tests for both pull-in paths, the exclusion, and — per
  Task 1 Step 4 — that a TIA-inactive selection runs kmcrank **un-narrowed**.
- [ ] **Step 4:** green + commit.

**Expected:** kmcrank-selected Stops ≈15.8 s → ≈1.9 s; full ≈15.8 s when the
gate's own sources change, or when TIA is inactive.

## Task 3 — D2: map the unmapped directories

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1:** add `^scripts/` → **`kmcrank` AND `ccgate`**. Not kmcrank
  alone: three ccgate tests drive files under `scripts/` —
  `cc-gate-plugin/test/escape-hatch.test.ts:13` (`km-panic.sh`),
  `test/fixture-ref.test.ts:187` and `test/corpus-store.test.ts:270`
  (`km-sensors-sync.sh`). Mapping to kmcrank alone would delete that coverage.
- [ ] **Step 2:** any further entry must be justified in a comment from what
  actually imports that directory. If a directory's blast radius is unknown,
  **leave it on the fallback** — that is the fail-safe default, and narrowing
  `FALLBACK_SUITES` itself is forbidden.
- [ ] **Step 3:** **two existing assertions change here and that is
  expected** — `gate-check-core.test.ts:97` (`["scripts/gate-check.ts"]` ==
  `FALLBACK_SUITES`) and `:100` (`["scripts/x.ts","opencode-plugin/src/y.ts"]`
  == `ALL_SUITES`). Update both, and say in the commit message why the pin
  moved. Do not edit them silently.
- [ ] **Step 4:** green + commit.

## Task 4 — D4: close the `src/acp/index.ts` gap

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1:** rule `^cc-gate-plugin/src/acp/index\.ts$` →
  **`["test/anthropic-cli-warm.test.ts"]`**. Directory-qualified, not
  basename-anchored — `index.ts` is generic and a bare rule would match
  unrelated files. **The target is not `acp-client.test.ts`:** that file
  imports `src/acp/acp-client.ts` and `acp-wire.ts` directly (which
  `src/acp/index.ts:11-13` explicitly permits for tests), so it stays green
  when a barrel export is renamed and would close nothing. The only runtime
  consumer of the barrel is
  `cc-gate-plugin/src/gauge/providers/anthropic-cli-warm.ts:10`;
  `send-prompt.ts:29` is `import type` and cannot break at runtime.
- [ ] **Step 2:** test asserting the rule fires for that exact path and not
  for other `index.ts` files.
- [ ] **Step 3:** green + commit.

## Task 5 — D1: narrow `opencode` — BLOCKED ON D8

**Do not start until D8 is ruled.** If D8 is declined, delete this task and
record the withdrawal; do not implement it with a weaker justification.

**Files:** `scripts/gate-check.ts` (D8 part), `km-crank/src/gate-check-core.ts`,
plus both test files.

- [ ] **Step 1 (D8, only if approved):** add `opencode-plugin` to
  `table.full` (`gate-check.ts:56-57`). This ends `table.full`'s "incumbent
  check VERBATIM" property — state that in the commit message; it is a change
  to what tier 1 means. Verify the bg run still completes and writes green.
- [ ] **Step 2:** `SLOW_OPENCODE_TEST_RE` matching
  `minimal-relations-desk.test.ts` only. Comment carries the measurement
  (31.5 s of 36.0 s) and the cause (spawns real `python3` against
  `minimal/tasks`).
- [ ] **Step 3:** pull-in `^minimal/tasks/` →
  `["test/minimal-relations-desk.test.ts"]`. Verified adequate: that file
  reads only from `minimal/tasks` (`TASKS` at `:10`; every fixture, oracle and
  relation path under it) and imports no `opencode-plugin/src` module.
- [ ] **Step 4:** **do NOT exclude `bench-cmd-ab.test.ts`** (2.25 s) unless
  you first derive its pull-in from its actual imports — it pulls nine
  `src/bench/*` modules (`paths`, `cmd-ab`, `cmd-run`, `report-loop`, `util`,
  `resource-profile`, `scheduler`, `host-pressure`, `ab-stats`). 2.25 s does
  not justify that rule surface; revision 1 excluded it with no pull-in at
  all, which is the defect this step exists to prevent.
- [ ] **Step 5:** tests, including the TIA-inactive un-narrowed case.
- [ ] **Step 6:** green + commit.

**Expected:** opencode-selected Stops ≈36 s → ≈4.5 s (31.5 s removed, 2.25 s
retained).

## Task 6 — wire the command table

**Files:** `scripts/gate-check.ts`, `km-crank/test/gate-check-cli.test.ts`

- [ ] **Step 1:** generalise the fast-list computation (`:36-49`), which
  today hardcodes package dir `"cc-gate-plugin"` and scan roots
  `["test","src"]`. Needs an explicit suite→package-dir map (`opencode` →
  `opencode-plugin`, `kmcrank` → `km-crank`). Re-verify the guard comment at
  `:32-35` per package: confirmed at plan time that neither package has
  `.test.ts` outside `test/`, nor nested `node_modules` under `src/`. Note
  this triples the recursive `readdirSync` on every Stop — measure it; if it
  is not negligible, cache per tree hash.
- [ ] **Step 2:** replace the hardcoded `s === "ccgate"` (`:242-244`) with the
  general form: append each selected suite's pull-ins to its argv.
- [ ] **Step 3: guard the degraded case.** `:41-45` degrades to `all = []` on
  readdir failure, giving `argv = ["bun","test"]` — a whole-suite run, which
  is correctly fail-safe. But appending pull-ins to that produces
  `bun test <one-file>`, which runs **only** that file. This inversion exists
  for ccgate today; do not replicate it. Append pull-ins **only** when the
  fast list is non-empty.
- [ ] **Step 4: apply Task 1 Step 4's un-narrowing.** When
  `changed === undefined`, every suite uses its un-narrowed argv.
- [ ] **Step 5: test at the right level.** `KKAMAK_GATE_COMMANDS`
  (`gate-check.ts:61-65`) returns the seam JSON verbatim and **never calls
  `realCommands()`**, so the fast list cannot be observed through it — the
  argv under test is the fixture's own. Fast-list computation is unit-tested
  on the Task 1 helpers. What IS observable at CLI level is the *append*
  (it happens in `main()`, outside `commands()`), which is why the existing
  amendment-b test at `gate-check-cli.test.ts:250-261` works. Add CLI cases
  for: a `minimal/tasks/` change appending the desk test; a TIA-inactive Stop
  using un-narrowed argv.
- [ ] **Step 6:** green + commit.

## Task 7 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure all suites with the **Pass B (JUnit) method
  only** — never mixing bases. Record as a **new dated pass appended** to
  spec §1. Do not overwrite Pass A or Pass B: they are dated measurement
  records, and rewriting them destroys the pre-change baseline.
- [ ] **Step 2:** append an INSTRUMENT entry to
  `docs/2026-08-01-gauntlet-adoption-ledger.md` — what changed, before/after
  (same method), and the **boundary ts**, stating that gated-Stop
  `durationMs` must not pool across it.
- [ ] **Step 3:** mark the implemented decisions in the spec.
- [ ] **Step 4:** green + commit.

**Verification:** the acceptance test is the live stream — the slow
population should separate into a new lower band. **Do not claim improvement
from a single Stop.** The tail is governed by red-marker debt repayment
(133-167 s), which this plan does not touch.

## Sequencing

Task 1 first. Tasks 2-4 are independent of each other. Task 5 needs D8 ruled.
Task 6 needs 1-5 (or 1-4 if D1 is withdrawn). Task 7 needs 6.

Tasks 1-5 all touch `km-crank/src/gate-check-core.ts` and its test file —
**run them serially**, not in parallel worktrees.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact whose
`findings-count` is a **bare integer** — the 7b gate rejects the prose form
(observed 2026-08-06).

## Non-goals

- **`ccgate` stays ≈14 s** — diffuse cost, no dominant file. After this plan
  that is the tier-0 floor for `cc-gate-plugin` changes.
- Debt repayment stays synchronous (spec D6).
- Concurrency (spec D7, deferred with arithmetic).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment. Unrelated.
