# Gate tier-0 narrowing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`.
**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.
**Reviews:** `docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-2.md`.

**Revision 3.** Round 1 killed D1's original safety argument; round 2 killed
revision 2's fix for it, and killed D8. Net effect on this plan:

- **No task keys on `changed === undefined`.** Revision 2's "un-narrow on the
  fallback" rule is withdrawn: `FALLBACK_SUITES` is the same four commands
  `table.full` chains, so un-narrowing it *is* the incumbent full check in the
  blocking tier — 29.7 s → 133-167 s on the majority of code Stops, to buy at
  most one Stop of deferral that the already-running bg run covers. The prior
  executed plan had ruled this deliberate
  (`2026-08-05-two-tier-gate-check.md:919`).
- **D8 is withdrawn**, so `table.full` is untouched and Task 5 is unblocked
  on a different argument (input-scoping, spec D1).

**Goal:** cut tier-0 blocking latency on the TIA-active path for `kmcrank`
and `opencode`, shrink the fallback's *selection* surface, and close the
`src/acp/index.ts` gap — with no test file running in fewer situations where
it could newly fail.

## Measured baseline (Pass B — JUnit, repo `487d104`, yoo-dev, n=1)

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | 36.0 s / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, … | diffuse |

**Architecture:** no new mechanism. `ccgate` already pairs an exclusion regex
with an amendment-b pull-in; this generalises that to a per-suite table.
Coverage is preserved by **input-scoped pull-ins plus self-pulls**, never by
appeal to tier 1 — tier 1 does not run opencode at all (spec §2.2).

**Tech Stack:** Bun + TypeScript. Logic in `km-crank/src/gate-check-core.ts`,
wiring in `scripts/gate-check.ts`, tests in
`km-crank/test/gate-check-{core,cli}.test.ts`.

## Global Constraints

- **`gate.json`'s `check` string MUST NOT change**, and **`table.full` MUST
  NOT change** (D8 withdrawn). Editing either means the task is mis-scoped.
  The `KKAMAK_DEV_CHECKS` drift guard (`trial-verdict.test.ts:199`) stays
  green untouched, and the executed two-tier plan's "byte-identical string"
  constraint still holds.
- **No task may key on `changed === undefined`** (the fallback path). Spec
  §2.3.
- **Coverage constraint, precisely:** no test file may end up running in
  *fewer situations where it could newly fail* than today. A narrowed suite
  must pull the file back on changes to its inputs AND on changes to the file
  itself. Blanket exclusion fails this.
- **MECHANISM_PATHS** (`km-crank/src/calibration.ts:65-72`) —
  `minimal/{complete-gate,mutate,spec-probe,session2}.ts`,
  `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor` — never edited.
- **Fail-safe direction.** Uncertain ⇒ run MORE.
- `bun test` green in `km-crank`, `cc-gate-plugin`, `opencode-plugin` and
  `bunx tsc --noEmit` clean at the end of EVERY task. Baselines: km-crank
  **327**, cc-gate-plugin **1043**, opencode-plugin **1694** (12 skip).
- **Fresh worktree? `bun install` in each package first** — there is no root
  `package.json`. A depless worktree fails as "Unhandled error between
  tests", which reads like a code defect and is not one.
- Commit per task, conventional format, message explains why not what.

## Task 1 — generalise the machinery

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1: per-suite policy record** — suite id → optional `slowTestRe`
  plus a list of pull-in rules. Seed with ccgate's existing regex
  (`:125-126`) and rules (`:150`) VERBATIM; keep current exported names as
  wrappers so nothing outside changes this task.
- [ ] **Step 2: the package-prefix guard becomes PER-RULE.** Today
  `slowCcgateTestsForChangedPaths` early-continues on `!/^cc-gate-plugin\//`
  (`:172`), which is what makes `gate-check-core.test.ts:155` pass. A
  per-*suite* guard would make Task 2's rules dead, since they map a
  `scripts/` path to a km-crank test. Give each rule an optional guard;
  ccgate's rules carry `^cc-gate-plugin/` and behave identically.
- [ ] **Step 3: the self-pull becomes PER-SUITE.** `:172`/`:174` hardcode
  `^cc-gate-plugin/((?:test|src)/.*\.test\.ts)$`, pinned by
  `gate-check-core.test.ts:139-142`. Key it off the suite→package-dir map so
  a changed excluded test file pulls itself in for *every* narrowed suite.
  Without this, editing `gate-check-cli.test.ts` or
  `minimal-relations-desk.test.ts` selects the suite and skips the file you
  just edited — verbatim the failure `gate-check-core.ts:132-137` exists to
  prevent.
- [ ] **Step 4:** tests — ccgate behaviour identical on existing fixtures;
  per-rule guard honoured; self-pull works for a second package.
- [ ] **Step 5:** green + commit.

**Verification:** no existing `gate-check-core.test.ts` assertion may need
editing in THIS task. If one does, semantics changed — stop and report.
(Task 3 legitimately changes two; that is that task's business.)

## Task 2 — D3: narrow `kmcrank`

- [ ] **Step 1:** `SLOW_KMCRANK_TEST_RE` matching `gate-check-cli.test.ts`
  (13.9 s of 15.8 s). Comment carries the measurement and the cause
  (end-to-end CLI drive with multi-second `until()` waits).
- [ ] **Step 2:** pull-in rules `^scripts/gate-check\.ts$` and
  `(^|/)gate-check-core\.ts$` → `["test/gate-check-cli.test.ts"]`. **These
  carry NO package-prefix guard** — mapping an out-of-package path to a
  km-crank test is exactly why Task 1 Step 2 made the guard per-rule.
  Load-bearing: without them, edits to the gate itself lose their most direct
  coverage.
- [ ] **Step 3:** confirm Task 1 Step 3's self-pull covers
  `km-crank/test/gate-check-cli.test.ts`, with a test.
- [ ] **Step 4:** note in the commit message that these pull-ins only fire
  when `kmcrank` is selected — a pull-in does not select its own suite
  (`gate-check.ts:239-250` iterates `suites`). That holds here because
  `kmcrank` is in `FALLBACK_SUITES` and, after Task 3, in `TIA_MAP` for
  `^scripts/`.
- [ ] **Step 5:** green + commit.

**Expected:** kmcrank-selected Stops ≈15.8 s → ≈1.9 s; full when the gate's
own sources or that test file change.

## Task 3 — D2: map the unmapped directories

- [ ] **Step 1: change `TIA_MAP`'s record type first.** Entries are
  `{ re; suite: SuiteId }` singular resolved by `.find` (`:98`, `:112`) —
  first match wins. Two entries sharing a regex would silently yield only
  one. Make the entry carry a suite **list** (or make selection collect all
  matches) before adding anything.
- [ ] **Step 2:** add `^scripts/` → **`kmcrank` AND `ccgate`**. Not kmcrank
  alone: `cc-gate-plugin/test/escape-hatch.test.ts:13` drives
  `scripts/km-panic.sh`; `test/fixture-ref.test.ts:187` and
  `test/corpus-store.test.ts:270` assert over `scripts/km-sensors-sync.sh`.
- [ ] **Step 3:** any further entry must be justified in a comment from what
  actually imports that directory. Unknown blast radius **stays on the
  fallback**; never narrow `FALLBACK_SUITES`.
- [ ] **Step 4: two pinned assertions change, and one invariant must be
  re-pinned.** `gate-check-core.test.ts:97` (`["scripts/gate-check.ts"]` ==
  `FALLBACK_SUITES`) and `:100` both move. `:99-101` is named "fallback never
  DROPS a TIA pick" and is the only test of the union at
  `gate-check-core.ts:113-114`; after this task `scripts/x.ts` is no longer
  unknown, so **re-pin that invariant with a path that is still unknown**
  (e.g. under `term-bench2/`). Say in the commit message why each pin moved.
- [ ] **Step 5:** green + commit.

## Task 4 — D4: close the `src/acp/index.ts` gap

- [ ] **Step 1:** rule `^cc-gate-plugin/src/acp/index\.ts$` →
  **`["test/anthropic-cli-warm.test.ts"]`**, directory-qualified (a bare
  `index.ts` basename would match unrelated files). **Not
  `acp-client.test.ts`:** it imports `src/acp/acp-client.ts` and
  `acp-wire.ts` directly — which `src/acp/index.ts:11-13` permits for tests —
  so it stays green when a barrel export is renamed. The barrel's only
  runtime consumer is `src/gauge/providers/anthropic-cli-warm.ts:10`;
  `send-prompt.ts:29` is `import type` and cannot break at runtime.
- [ ] **Step 2:** test that it fires for that exact path and not for other
  `index.ts` files.
- [ ] **Step 3:** green + commit.

## Task 5 — D1: narrow `opencode`

Unblocked: D8 is withdrawn and this no longer relies on tier 1.

- [ ] **Step 1:** `SLOW_OPENCODE_TEST_RE` matching
  `minimal-relations-desk.test.ts` **only**. The comment must carry the
  measurement (31.5 s of 36.0 s) and the *full* cause: spawns `python3` at
  module scope (`:17`), spawns `tmux` (`:57`, `:72`), requires host `rdflib`
  (`:103`).
- [ ] **Step 2:** pull-in `^minimal/tasks/` →
  `["test/minimal-relations-desk.test.ts"]`. **This is the whole safety
  argument** — tier 1 does not run opencode (spec §2.2), so nothing catches
  this file later. Verified adequate in review round 1: the test reads only
  from `minimal/tasks` (`TASKS` at `:10`; every fixture, oracle and relation
  path under it) and imports no `opencode-plugin/src` module.
- [ ] **Step 3:** confirm Task 1 Step 3's self-pull covers
  `opencode-plugin/test/minimal-relations-desk.test.ts`, with a test.
- [ ] **Step 4: do NOT exclude `bench-cmd-ab.test.ts`** (2.25 s). It
  value-imports seven `src/bench/*` modules (two more are `import type`,
  which the amendment-b policy at `gate-check-core.ts:144-146` does not
  count). 2.25 s does not justify that rule surface; revision 1 excluded it
  with no pull-in at all, which is the defect this step prevents.
- [ ] **Step 5:** green + commit.

**Expected:** opencode-selected Stops ≈36 s → ≈4.5 s.

## Task 6 — wire the command table

**Files:** `scripts/gate-check.ts`, `km-crank/test/gate-check-cli.test.ts`

- [ ] **Step 1:** generalise the fast-list computation (`:36-49`), which
  hardcodes package dir `"cc-gate-plugin"` and scan roots `["test","src"]`.
  Add an explicit suite→package-dir map (`opencode` → `opencode-plugin`,
  `kmcrank` → `km-crank`) — the same map Task 1 Step 3 keys the self-pull
  off. Re-verify the guard comment at `:32-35` per package: confirmed at plan
  time that neither package has `.test.ts` outside `test/`, nor nested
  `node_modules` under `src/`. This triples the recursive `readdirSync` on
  every Stop — measure it; if not negligible, cache per tree hash.
- [ ] **Step 2:** replace the hardcoded `s === "ccgate"` (`:242-244`) with
  the general form: append each selected suite's pull-ins to its argv.
- [ ] **Step 3: guard the degraded case.** `:41-45` degrades to `all = []` on
  readdir failure, giving `argv = ["bun","test"]` — correctly fail-safe. But
  appending a pull-in to that yields `bun test <one-file>`, running **only**
  that file. This inversion exists for ccgate today; do not replicate it.
  Append pull-ins only when the fast list is non-empty.
- [ ] **Step 4: test at the right level.** `KKAMAK_GATE_COMMANDS`
  (`:61-65`) returns the seam JSON verbatim and never calls `realCommands()`,
  so a fast list is **not** observable at CLI level — the argv under test is
  the fixture's own. Unit-test fast lists on Task 1's helpers. What IS
  CLI-observable is the pull-in *append*, which happens in `main()` outside
  `commands()` — the mechanism `gate-check-cli.test.ts:250-261` already
  exercises. Add CLI cases for a `minimal/tasks/` change appending the desk
  test, and for a changed excluded test file appending itself.
- [ ] **Step 5:** green + commit.

## Task 7 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure with the **Pass B (JUnit) method only** — never
  mixing bases. Record as a **new dated pass appended** to spec §1; do not
  overwrite Pass A or Pass B, which are dated records of the pre-change state.
- [ ] **Step 2:** append an INSTRUMENT entry to
  `docs/2026-08-01-gauntlet-adoption-ledger.md` — what changed, before/after
  (same method), and the **boundary ts**, stating that gated-Stop
  `durationMs` must not pool across it.
- [ ] **Step 3:** mark implemented decisions in the spec.
- [ ] **Step 4:** green + commit.

**Verification:** acceptance is the live stream — the slow population should
separate into a lower band. **Never claim improvement from a single Stop.**
The tail is governed by red-marker debt repayment (133-167 s), untouched here.

## Sequencing

Task 1 first. Tasks 2-5 are independent of each other but all touch
`gate-check-core.ts` and its test file — **run them serially**, not in
parallel worktrees. Task 6 needs 1-5; Task 7 needs 6.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact whose
`findings-count` is a **bare integer** — the 7b gate rejects the prose form.

## Non-goals

- `ccgate` stays ≈14 s — diffuse cost; the tier-0 floor for `cc-gate-plugin`
  changes on the TIA-active path.
- The fallback path (spec §2.3 ruling).
- `table.full` / D8; debt repayment stays synchronous (D6).
- Concurrency (D7).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment. Unrelated.
