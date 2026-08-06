# Gate tier-0 narrowing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`.
**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.
**Reviews:** `docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-5.md`.

**Revision 6, execution-ready.** Five architect rounds withdrew four of the
five decisions this started with: D1 (narrow opencode), D4 (acp-index
coverage), D8 (opencode into tier 1), and — round 5, on price — D2 (map
`scripts/`, worth 0.02 s). **One decision remains: D3, narrow `kmcrank`.**
Round 5's verdict was to fix the task text in place and execute; a sixth
review round would find citation offsets.

The governing rule with its limits: narrowing a suite is *admissible* only if
that suite runs in `table.full` — necessary, **not sufficient**. Tier-1
rescue is spawn-conditional, content-raced, and absent on a session-final
Stop. D3 loses coverage in reachable scenarios (spec D1, "Necessary, not
sufficient"); accepted knowingly.

**Goal:** cut `kmcrank`-selected Stops from ≈15.8 s to ≈1.9 s, and the
dominant fallback path from ≈29.7 s to ≈15.1 s. Fix one live defect on the
way (Task 3 Step 3).

## Measured baseline (Pass B — JUnit, repo `487d104`, yoo-dev, n=1)

| suite | total | dominant file | share |
|---|---|---|---|
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |

`ccgate` (14.4 s, diffuse) and `opencode` are out of scope.

**Architecture:** no new mechanism. `ccgate` already pairs an exclusion regex
with an amendment-b pull-in; this generalises that to a per-suite table and
applies it once, to `kmcrank`.

## Global Constraints

- **`gate.json`'s `check` string and `table.full` MUST NOT change.** The
  `KKAMAK_DEV_CHECKS` drift guard (`trial-verdict.test.ts:199`) stays green
  untouched.
- **No task keys on `changed === undefined`** (the fallback path, spec §2.3).
- **`TIA_MAP` is not touched** (D2 withdrawn). If a task seems to need a
  selection-table change, it is mis-scoped.
- **Do not touch `opencode-plugin/`, and add no opencode rule.** A
  `minimal/tasks/` rule would reinstate D1.
- **Admissibility:** only narrow a suite that runs in `table.full`, and pull
  the excluded file back on changes to its inputs AND to itself. Not a proof
  of no-loss — see the rule's limits above.
- **MECHANISM_PATHS** (`calibration.ts:65-72`) never edited. (Retained from
  D1; nothing here references `minimal/`.)
- **Fail-safe direction.** Uncertain ⇒ run MORE.
- `bunx tsc --noEmit` clean and `bun test` green in `km-crank` and
  `cc-gate-plugin` at the end of EVERY task. Baselines are **lower bounds**,
  since tasks add tests: km-crank ≥ 327, cc-gate-plugin ≥ 1043. Nothing here
  touches `opencode-plugin`.
- **Fresh worktree? `bun install` per package first** — no root
  `package.json`. A depless worktree fails as "Unhandled error between
  tests", which reads like a code defect and is not one.
- Commit per task, conventional format, message explains why not what.

## Task 1 — generalise the machinery

**Files:** `km-crank/src/gate-check-core.ts`, `km-crank/test/gate-check-core.test.ts`

- [ ] **Step 1: create the suite→package-dir map**, exported from
  `gate-check-core.ts`. Entries: `ccgate` → `"cc-gate-plugin"`, `kmcrank` →
  `"km-crank"`. Task 3 imports it; **do not add a `Cmd.cwd` agreement test
  here.** `scripts/gate-check.ts` exports nothing and calls `main()` at
  module scope (`:256`), so importing it from a km-crank test re-enters the
  gate, `spawnSync`s `bun test` in km-crank, recurses, and exits the outer
  suite via `process.exit(0)` — a green gate from a partially-run suite.
  Drift is prevented instead in Task 3 Step 1, by deriving `Cmd.cwd` from
  this map.
- [ ] **Step 2: per-suite policy record** — suite id → optional `slowTestRe`
  plus pull-in rules, each rule carrying an optional path guard. Seed the
  `tests` lists from `gate-check-core.ts:150` **verbatim**, and give every
  ccgate rule the guard `^cc-gate-plugin/`. (Seeding the rules *literally*
  verbatim — i.e. guardless — reddens `gate-check-core.test.ts:152-158`,
  because `km-crank/src/acp-daemon.ts` would then pull
  `test/acp-daemon.test.ts`. That is a mis-execution of this step, not the
  "semantics changed" case the Verification note describes.)
- [ ] **Step 3: the pull-in function is SUITE-KEYED.** Signature
  `pullInsFor(suite: SuiteId, paths: string[]): string[]`, returning only
  that suite's own test paths — never a flat union. A flat union would append
  `test/gate-check-cli.test.ts` to the **ccgate** argv; `bun test` treats
  positionals as path filters, so a non-matching filter either wastes the run
  or exits non-zero, and `gate-check.ts:246-249` turns the latter into a
  blocked Stop. Pin the signature with a test.
- [ ] **Step 4: the package-prefix guard becomes PER-RULE.** Today
  `slowCcgateTestsForChangedPaths` early-continues on `!/^cc-gate-plugin\//`
  (`:172`). A per-*suite* guard would make Task 2's rules dead, since they
  map a `scripts/` path to a km-crank test. **Per-rule-ness is pinned in
  Task 2**, where the first guardless rule exists — do not add a placeholder
  rule here to make a Task 1 test possible.
- [ ] **Step 5: the self-pull becomes PER-SUITE**, keyed off Step 1's map,
  replacing the hardcoded `^cc-gate-plugin/((?:test|src)/.*\.test\.ts)$`
  (`:174`, pinned by `gate-check-core.test.ts:139-142`). **Keep the existing
  `slowTestRe` gate** (`:175`) so it fires only for narrowed suites.
- [ ] **Step 6:** tests — ccgate behaviour identical on the existing
  fixtures, and the suite-keyed return pinned. The second-package self-pull
  case belongs to Task 2.
- [ ] **Step 7:** green + commit.

**Verification:** no existing `gate-check-core.test.ts` assertion may need
editing in this task. If one does, either semantics changed or Step 2's guard
was omitted — check Step 2 first, then stop and report.

## Task 2 — D3: narrow `kmcrank`

- [ ] **Step 1:** `SLOW_KMCRANK_TEST_RE` matching `gate-check-cli.test.ts`
  (13.9 s of 15.8 s). Comment carries the measurement and the cause
  (end-to-end CLI drive with multi-second `until()` waits).
- [ ] **Step 2:** pull-in rules `^scripts/gate-check\.ts$` and
  `(^|/)gate-check-core\.ts$` → `["test/gate-check-cli.test.ts"]`, carrying
  **no package-prefix guard** — this is the first guardless rule, and it is
  why Task 1 Step 4 made the guard per-rule. Load-bearing: without them,
  edits to the gate itself lose their most direct coverage.
- [ ] **Step 3:** tests — the second-package self-pull (Task 1 Step 5) covers
  `km-crank/test/gate-check-cli.test.ts`; and **per-rule-ness**, deferred
  from Task 1: a `scripts/gate-check.ts` path yields the km-crank test while
  ccgate's guarded rules stay inert.
- [ ] **Step 4:** commit message notes these pull-ins fire only when
  `kmcrank` is selected — a pull-in does not select its own suite
  (`gate-check.ts:239-250` iterates `suites`). That holds because `kmcrank`
  is in `FALLBACK_SUITES`; with D2 withdrawn, nothing else provides it.
- [ ] **Step 5:** green + commit.

**Expected:** ≈15.8 s → ≈1.9 s on kmcrank-selected Stops — **observable only
after Task 3 rewires the argv.** Tasks 1-2 change pure logic; do not try to
measure the effect here, and do not pull Task 3 forward when you cannot.

## Task 3 — wire the command table

**Files:** `scripts/gate-check.ts`, `km-crank/test/gate-check-cli.test.ts`

**Before starting:** this task edits the script that `gate.json` runs on every
Stop, so any broken intermediate state blocks your own turns, and
`KKAMAK_GATE_FULL=1` does not route around it (same script, `:201`). Know the
disarm path — `scripts/km-panic.sh`, pinned by
`cc-gate-plugin/test/escape-hatch.test.ts:12-13` — before you begin.

- [ ] **Step 1:** generalise the fast-list computation (`:36-49`), which
  hardcodes package dir `"cc-gate-plugin"` and scan roots `["test","src"]`.
  **Import Task 1's map and derive `Cmd.cwd` from it** for the two suites it
  covers (`ccgate`, `kmcrank`), so the strings cannot drift — the other three
  `Cmd.cwd` entries stay literal. Re-verify the guard comment at `:32-35` for
  `km-crank`: confirmed at plan time it has no `.test.ts` outside `test/` and
  no nested `node_modules` under `src/`. (The added `readdirSync` pair is
  microseconds over 36 files — no caching, no measurement step.)
- [ ] **Step 2:** replace the hardcoded `s === "ccgate"` (`:242-244`) with
  per-suite pull-ins. **`slowPull` at `:236` is deleted** — it is computed
  once, flat, before the loop; the replacement is `pullInsFor(s, changed ?? [])`
  **inside** the loop. The log line at `:237` must then accumulate
  `suite:file` pairs across suites rather than printing one flat list; pin
  its format with a test, because Task 4's acceptance correlates against it.
- [ ] **Step 3: guard the degraded case — mark DEGRADATION, per-`Cmd`.**
  `:41-45` degrades to `all = []` on readdir failure, giving
  `argv = ["bun","test"]`; the append then turns the whole suite into a
  single file. **This is a live defect in deployed code today**, not one this
  plan introduces — it is worth landing on its own merits.
  - Put the flag on `Cmd` (`:28`): `scanFailed?: boolean`. **Not on
    `CommandTable`** — with two packages scanned, a km-crank readdir failure
    would otherwise suppress *ccgate's* append while ccgate's argv is a
    correctly-narrowed fast list, opening the exact hole amendment b closes.
  - Set it in the `catch` at `:41`, **never** inferred from
    `all.length === 0` — a package with genuinely zero test files produces
    the same empty list.
  - Mark **degradation, not narrowing**, so *absence* means "append
    normally": the seam fixture (`gate-check-cli.test.ts:47-51`) has no such
    field, `undefined` is falsy, the append still fires, and the assertion at
    `:260` stays green untouched. **Do not rewrite that fixture.**
  - Comment the load-bearing fact: `realCommands()`'s output is **never
    serialized** — `commands()` (`:61-65`) either `JSON.parse`s the seam file
    or builds fresh, and the only seam-JSON producer is `writeCommands` in
    `gate-check-cli.test.ts:34-55`. The flag is process-local by
    construction, which is what makes "absence means append" safe.
- [ ] **Step 4: test at the right level.** `KKAMAK_GATE_COMMANDS` returns the
  seam JSON verbatim and never calls `realCommands()`, so fast lists are
  **not** CLI-observable — unit-test them on Task 1's helpers. The pull-in
  *append* IS CLI-observable (it happens in `main()`), which is what
  `gate-check-cli.test.ts:250-261` exercises. Add a CLI case for a changed
  excluded test file appending itself.
- [ ] **Step 5: retire the ccgate-shaped exports — PORT, then remove.**
  `SLOW_CCGATE_TEST_RE` / `ccgateFastFiles` / `slowCcgateTestsForChangedPaths`
  were kept as wrappers so Tasks 1-2 would not churn. Their tests at
  `km-crank/test/gate-check-core.test.ts:111-181` include the exact-list
  assertions at `:112-123` and `:124-138` — the only committed proof of which
  slow test each source pulls, and `:124-138` specifically proves the
  post-promotion `src/acp/` layout still matches. **Port every assertion to
  the generalised function first, then remove the wrappers.**
- [ ] **Step 6:** note in a comment that the map now does double duty —
  suite→package-dir *and* "suites whose argv becomes an enumerated file
  list". A third entry added later for a self-pull would silently convert
  that suite's `["bun","test"]` into a file list.
- [ ] **Step 7:** green + commit.

## Task 4 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure with the **Pass B (JUnit) method only**. Read
  the live stream via `gateNdjsonPath()` (`scripts/p0-signal-variance.ts:83-87`,
  default at `:65`) — **home-anchored**; a bare relative
  `.km/gate-outcomes.ndjson` read from a worktree is a different, near-empty
  file (`scripts/b3-binarization-measure.ts:46-53` records this as "NEVER
  cwd-relative").
- [ ] **Step 2: segment by selection.** Correlate durations with the
  per-Stop suite log (`gate-check.ts:237`, format pinned in Task 3 Step 2).
  The recorded 23.8-25.4 s band matches no predicted selection and stays
  unattributed until correlated. Expect the gain on kmcrank-selected Stops
  (≈15.8 → ≈1.9 s) and on the fallback (≈29.7 → ≈15.1 s); expect **no** gain
  when `scripts/gate-check.ts` itself changed, since the pull-in restores the
  13.9 s file by design.
- [ ] **Step 3:** append an INSTRUMENT entry to
  `docs/2026-08-01-gauntlet-adoption-ledger.md` — what changed, before/after
  (same method), and the **boundary ts**, stating that gated-Stop
  `durationMs` must not pool across it. Append post-change numbers to spec §1
  as a new dated pass; never overwrite Pass A or Pass B.
- [ ] **Step 4:** green + commit.

**Verification:** never claim improvement from a single Stop. The tail is
governed by red-marker debt repayment (133-167 s), untouched here.

## Sequencing

Task 1 → Task 2 → Task 3 → Task 4, serially. Tasks 1-2 both touch
`gate-check-core.ts`.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact whose
`findings-count` is a **bare integer** — the 7b gate rejects the prose form.

## Non-goals

- **`TIA_MAP` / mapping `scripts/`** (D2, withdrawn round 5 — 0.02 s).
- **Narrowing `opencode`** (D1, round 3) — specifically no `minimal/tasks/`
  rule, which would reinstate it.
- **The `src/acp/index.ts` tier-0 gap** (D4, round 4) — the documented
  two-hop deferral.
- `ccgate`'s ≈14 s (diffuse); `table.full` / D8; sync debt repayment (D6);
  concurrency (D7).
