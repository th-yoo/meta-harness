# Gate tier-0 narrowing — implementation plan (D1-D4 approved 2026-08-06)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`
(exists, holds the design spec).

**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.
D1-D4 approved; D5 (boundary ts) is a requirement, not a choice; D6 (sync
debt repayment) is explicitly OUT of scope — repayment stays synchronous.

**Goal:** cut tier-0 blocking latency for `opencode` and `kmcrank`
selections, shrink the fallback surface, and close the `src/acp/index.ts`
coverage gap — without weakening tier 1 or the pre-merge chain.

## Measured baseline (yoo-dev, 2026-08-06, JUnit reporter, repo at `487d104`)

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | **36.0 s** / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | **15.8 s** / 65 suites | `test/gate-check-cli.test.ts` (“gate-check CLI”) **13.9 s** | **88 %** |
| `ccgate` (fast list) | **14.4 s** / 50 files | `test/cli.test.ts` 5.2 s, `init-cli` 2.6 s, `sensor-contract` 1.5 s | diffuse — top 3 = 65 % |

Excluding one file takes `opencode` to ≈2.2 s (top-2 excluded) and `kmcrank`
to ≈1.9 s. **`ccgate` has no single dominator** — it is a long tail of
CLI-spawn tests, so D1/D3's technique does not help it. That is stated as a
limit, not solved here (§ Non-goals).

`minimal-relations-desk.test.ts` spawns **real python3** against
`minimal/tasks` — the same spawn-heavy class `SLOW_CCGATE_TEST_RE` already
excludes. `gate-check-cli.test.ts` drives the gate CLI end to end, including
15 s `until()` waits: **the gate's own CLI test is 88 % of the gate's own
km-crank tier-0 cost.**

**Architecture:** no new mechanism. `ccgate` already has the pattern —
one exclusion regex plus an amendment-b pull-in that re-adds the excluded
file when its covered source changes. This plan *generalises that pattern to
any suite* and applies it twice. Excluded files still run in tier 1 (the
background full check) and in the pre-merge sanity chain; nothing leaves
coverage, it only stops blocking.

**Tech Stack:** Bun + TypeScript. Pure logic in `km-crank/src/gate-check-core.ts`,
wiring in `scripts/gate-check.ts`, unit tests in `km-crank/test/gate-check-core.test.ts`.

## Global Constraints

- **`gate.json`'s `check` string MUST NOT change.** It is already
  `bun scripts/gate-check.ts`, the last entry of `KKAMAK_DEV_CHECKS`
  (`km-crank/src/trial-verdict.ts:77-82`). **No `KKAMAK_DEV_CHECKS` append is
  required or permitted** — the append-only drift guard at
  `km-crank/test/trial-verdict.test.ts:199` must stay green untouched. If you
  find yourself editing `gate.json` or that array, stop: the task is
  mis-scoped.
- **Tier 1 is untouched.** `table.full` keeps running the entire chain. Every
  file excluded from a tier-0 fast list must still be reachable there — assert
  it, do not assume it.
- **Fail-safe direction.** When selection is uncertain, run MORE. A narrowing
  bug that skips a suite is silent; one that runs an extra suite is merely
  slow. Never narrow `FALLBACK_SUITES` itself (spec D2 rejects that option).
- **One policy site.** Follow `SLOW_CCGATE_TEST_RE`'s stated rule: one regex,
  one place. No per-suite conditionals scattered through `gate-check.ts`.
- `cc-gate-plugin/src/core/` and `cc-gate-plugin/vendor/` are MECHANISM_PATHS
  — never edited. `km-crank/src/` is not among them; this work triggers no
  calibration staleness.
- `bun test` green in `km-crank`, `cc-gate-plugin`, `opencode-plugin` and
  `bunx tsc --noEmit` clean at the end of EVERY task, before its commit.
  Baseline at branch head: km-crank 327, cc-gate-plugin 1043,
  opencode-plugin 1694 (12 skip).
- **Fresh worktree? Run `bun install` in each package first** (`cc-gate-plugin`,
  `km-crank`, `opencode-plugin`; there is no root `package.json`). A worktree
  without deps fails as "Unhandled error between tests", which reads like a
  code defect and is not one. This cost a blocked turn on 2026-08-06.
- Commit per task, conventional format, message explains why not what.

## Task 1 — generalise the fast-list + pull-in machinery (pure logic)

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

Today the mechanism is ccgate-shaped: `SLOW_CCGATE_TEST_RE` (`:125-126`),
`ccgateFastFiles` (`:128`), `SLOW_SOURCE_TO_TESTS` (`:146`) and
`slowCcgateTestsForChangedPaths`. Generalise to a per-suite table without
changing ccgate's current behaviour.

- [ ] **Step 1:** introduce a per-suite policy record — for each suite id, an
  optional `slowTestRe` and an optional list of `{ re, tests }` pull-in rules.
  Seed it with ccgate's existing regex and rules VERBATIM. Keep the existing
  exported names as thin wrappers so nothing outside has to change yet.
- [ ] **Step 2:** generalise `slowCcgateTestsForChangedPaths` to
  `slowTestsForChangedPaths(suite, paths)`. Keep the old export delegating to
  it with `"ccgate"`, so `scripts/gate-check.ts` keeps compiling untouched
  this task.
- [ ] **Step 3:** tests. Assert ccgate's behaviour is IDENTICAL before/after
  (same inputs → same outputs, using the existing fixture cases), and that an
  unknown suite id yields an empty exclusion and no pull-ins.
- [ ] **Step 4:** `bun test` + `tsc` green in km-crank; commit.

**Verification:** the diff must not change any observable ccgate behaviour.
If any existing gate-check-core test needed editing to pass, that is a signal
you changed semantics — stop and report.

## Task 2 — D1: narrow `opencode`

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1:** add `SLOW_OPENCODE_TEST_RE` matching
  `minimal-relations-desk.test.ts` and `bench-cmd-ab.test.ts`, with a comment
  carrying the measurement (31.5 s and 2.25 s of a 36.0 s suite, JUnit
  reporter, 2026-08-06) and the reason (real python3 subprocess spawns).
- [ ] **Step 2:** add the pull-in rule so coverage is not lost:
  `^minimal/tasks/` → `["test/minimal-relations-desk.test.ts"]`. That test
  validates the relation artifacts under `minimal/tasks` (its own header says
  so), so a change there must pull it back into tier 0.
- [ ] **Step 3:** tests — a `minimal/tasks/...` path pulls the desk test in; an
  unrelated `opencode-plugin/...` path does not; the fast list excludes both
  slow files and retains everything else.
- [ ] **Step 4:** green + commit.

**Expected effect:** `opencode`-selected Stops ≈36 s → **≈2.2 s**.

## Task 3 — D3: narrow `kmcrank`

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1:** add `SLOW_KMCRANK_TEST_RE` matching
  `gate-check-cli.test.ts` (13.9 s of 15.8 s), comment carrying the
  measurement and the cause (end-to-end CLI drive with multi-second `until()`
  waits).
- [ ] **Step 2:** pull-in rules — `^scripts/gate-check\.ts$` AND
  `(^|/)gate-check-core\.ts$` → `["test/gate-check-cli.test.ts"]`. **This one
  is load-bearing:** without it, edits to the gate itself lose their most
  direct blocking coverage, which is precisely the change most able to break
  the gate. Basename-anchor the core rule, matching the existing convention
  that survived the ACP directory move.
- [ ] **Step 3:** tests for both pull-in paths and for the exclusion.
- [ ] **Step 4:** green + commit.

**Expected effect:** `kmcrank`-selected Stops ≈15.8 s → **≈1.9 s**, except
when the gate's own sources change, which correctly costs the full ≈15.8 s.

## Task 4 — D2: map the unmapped directories

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

`TIA_MAP` (`:98-104`) has five entries; everything else unions
`FALLBACK_SUITES` (≈29.7 s): `scripts/`, `term-bench2/`, `evidence/`,
`resource-profiles/`, root files.

- [ ] **Step 1:** add entries for directories whose blast radius is known.
  At minimum `^scripts/` → `kmcrank` (the gate's own tests live there;
  Task 3's pull-in then adds the CLI test when `gate-check.ts` changes).
  For each additional entry, justify it in a comment from what actually
  imports that directory — do not guess. If a directory's blast radius is
  genuinely unknown, LEAVE IT on the fallback: that is the fail-safe default
  and the spec forbids narrowing `FALLBACK_SUITES` itself.
- [ ] **Step 2:** tests naming each newly-mapped directory and asserting an
  unmapped path still unions the fallback.
- [ ] **Step 3:** green + commit.

## Task 5 — D4: close the `src/acp/index.ts` coverage gap

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

Deferred minor from `docs/reviews/4fc2cf1-promote-acp.md`: `index.ts` maps to
`ccgate`, whose fast list excludes every ACP test, so renaming an export in
the seam file has ZERO blocking coverage.

- [ ] **Step 1:** add a **directory-qualified** pull-in rule —
  `^cc-gate-plugin/src/acp/index\.ts$` → the ACP tests that import the
  symbols it re-exports (`test/acp-client.test.ts` at minimum). Directory-
  qualified, not basename-anchored: `index.ts` is a generic basename and a
  bare rule would match unrelated files.
- [ ] **Step 2:** test asserting the rule fires for that exact path and does
  NOT fire for other `index.ts` files in the repo.
- [ ] **Step 3:** green + commit.

## Task 6 — wire the command table

**Files:** `scripts/gate-check.ts`

Today the fast list is computed for ccgate only (`:36-49`) and the pull-in is
applied with a hardcoded `s === "ccgate"` (`:242-244`).

- [ ] **Step 1:** compute the fast file list per suite from Task 1's table,
  for `opencode` and `kmcrank` as well as `ccgate`. Suites with no exclusion
  regex keep their current whole-suite argv.
- [ ] **Step 2:** replace the `s === "ccgate"` special case with the general
  form: for each selected suite, append that suite's pull-ins to its argv.
  No dupes — the fast list never contains an excluded file.
- [ ] **Step 3:** exercise the seams rather than the network: `KKAMAK_GATE_COMMANDS`
  already injects a command table, and `km-crank/test/gate-check-cli.test.ts`
  uses it. Add CLI-level cases proving an `opencode` selection runs a narrowed
  argv, and that a `minimal/tasks/` change puts the desk test back on it.
- [ ] **Step 4:** green + commit.

## Task 7 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure all three suites with the same JUnit method as
  the baseline table above. Record the new numbers.
- [ ] **Step 2:** append an INSTRUMENT entry to
  `docs/2026-08-01-gauntlet-adoption-ledger.md`: what changed, the
  before/after table, and the **boundary ts**. State explicitly that
  gated-Stop `durationMs` MUST NOT pool across it — the same rule every prior
  instrument change carries.
- [ ] **Step 3:** update the spec's §1 table with the post-change numbers and
  mark D1-D4 as implemented.
- [ ] **Step 4:** green + commit.

**Verification:** the honest acceptance test is the live stream. After
deploy, the slow population in `.km/gate-outcomes.ndjson` should separate into
a new lower band. **Do not claim an improvement from a single Stop** — and
remember the tail is governed by red-marker debt repayment (133-167 s), which
this plan does not touch.

## Sequencing

Task 1 first (everything else builds on the generalised table). Tasks 2-5 are
independent of each other and each ends green and committed. Task 6 requires
1-5. Task 7 requires 6.

All of Tasks 1-5 touch `km-crank/src/gate-check-core.ts` and its test file —
running them in parallel worktrees would conflict. Run them serially.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact, and
note the artifact's `findings-count` must be a **bare integer** — the 7b gate
rejects the prose form (observed 2026-08-06).

## Non-goals

- **`ccgate` stays ≈14 s.** It has no dominant file; its cost is a long tail
  of CLI-spawn tests (`cli.test.ts` 5.2 s, `init-cli.test.ts` 2.6 s, …).
  Narrowing it needs its own analysis and probably its own technique. After
  this plan, ≈14 s is the tier-0 floor for `cc-gate-plugin` changes.
- Debt repayment stays synchronous (spec D6).
- Parallelising suites within tier 0.
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment (claims
  `hook-cli.ts` imports `acp-client.ts`; it does not). Unrelated.
