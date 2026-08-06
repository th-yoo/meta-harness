# Gate tier-0 narrowing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `~/z2/meta-harness`. **Branch:** `worktree-gate-tier0-narrowing`.
**Spec:** `docs/superpowers/specs/2026-08-06-gate-tier0-narrowing-design.md`.
**Reviews:** `docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-3.md`.

**Revision 4.** Round 1 killed D1's original safety argument; round 2 killed
revision 2's fix for it and killed D8; **round 3 killed D1 itself**. Task 5
is deleted and `opencode` is out of scope. What remains is D2, D3, D4. Net
effect on this plan:

- **`opencode` cannot be narrowed by this mechanism.** The pull-in is
  edge-triggered on the diff since the green marker, and the green marker is
  written by `runFullSync`/`bgMain` running `table.full`, which excludes
  opencode. So a `minimal/tasks/` edit can be baked behind the baseline
  without opencode ever running, after which the pull-in never fires. The
  governing rule: **narrowing a suite is safe iff that suite runs in
  `table.full`.** `ccgate` and `kmcrank` do; `opencode` does not.

- **No task keys on `changed === undefined`.** Revision 2's "un-narrow on the
  fallback" rule is withdrawn: `FALLBACK_SUITES` is the same four commands
  `table.full` chains, so un-narrowing it *is* the incumbent full check in the
  blocking tier — 29.7 s → 133-167 s on the majority of code Stops, to buy at
  most one Stop of deferral that the already-running bg run covers. The prior
  executed plan had ruled this deliberate
  (`2026-08-05-two-tier-gate-check.md:919`).
- **D8 is withdrawn**, so `table.full` is untouched.

**Goal:** cut tier-0 blocking latency on the TIA-active path for `kmcrank`,
shrink the fallback's *selection* surface, and close the `src/acp/index.ts`
gap — without narrowing any suite that `table.full` does not run.

## Measured baseline (Pass B — JUnit, repo `487d104`, yoo-dev, n=1)

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | 36.0 s / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, … | diffuse |

**Architecture:** no new mechanism. `ccgate` already pairs an exclusion regex
with an amendment-b pull-in; this generalises that to a per-suite table.
Coverage on the TIA-active path is preserved by input-scoped pull-ins plus
self-pulls; **on the fallback path it is preserved by tier 1**, which is
legitimate here because every suite this plan narrows (`ccgate`, `kmcrank`)
runs in `table.full`. That rescue is exactly what `opencode` lacks, which is
why D1 is withdrawn.

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
- **Coverage constraint, precisely:** a narrowed suite must pull the excluded
  file back on changes to its inputs AND on changes to the file itself, and
  the suite **must run in `table.full`** so the fallback path — where pull-ins
  do not fire (spec §2.3) — still reaches it. Both halves are required; the
  second is what D1 could not satisfy. Do not read this as "runs in at least
  as many situations", which no narrowing can satisfy.
- **MECHANISM_PATHS** (`km-crank/src/calibration.ts:65-72`) —
  `minimal/{complete-gate,mutate,spec-probe,session2}.ts`,
  `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor` — never edited.
- **Fail-safe direction.** Uncertain ⇒ run MORE.
- `bun test` green in `km-crank`, `cc-gate-plugin`, `opencode-plugin` and
  `bunx tsc --noEmit` clean at the end of EVERY task. Baselines: km-crank
  **327**, cc-gate-plugin **1043**, opencode-plugin **1694** (12 skip).
  **Host caveat:** the opencode suite needs `python3`, `tmux` and host
  `rdflib` (`minimal-relations-desk.test.ts:17,57,72,103`) — the same
  fragility that killed D8. On a host lacking them, record that this suite
  could not be run rather than reporting a false green; no task in this plan
  touches `opencode-plugin`, so its result is informational here.
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
  Without this, editing `gate-check-cli.test.ts` selects `kmcrank` and skips
  the file you just edited — verbatim the failure `gate-check-core.ts:132-137`
  exists to prevent. **Keep the existing gate on `slowTestRe`** (`:175`): the
  self-pull must fire only for suites that are actually narrowed, or every
  changed `.test.ts` in every mapped package starts appending single-file
  filters to un-narrowed argvs.
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
  (`gate-check.ts:239-250` iterates `suites`). At the time THIS task commits,
  that holds because `kmcrank` is in `FALLBACK_SUITES`; Task 3 later adds the
  `^scripts/` TIA entry. Do not write the commit message as though Task 3 has
  already landed.
- [ ] **Step 5:** green + commit.

**Expected:** kmcrank-selected Stops ≈15.8 s → ≈1.9 s; full when the gate's
own sources or that test file change.

## Task 3 — D2: map the unmapped directories

- [ ] **Step 1: change `TIA_MAP`'s record type first.** Entries are
  `{ re; suite: SuiteId }` singular resolved by `.find` (`:98`, `:112`) —
  first match wins. Two entries sharing a regex would silently yield only one.
  **Prefer a suite list per entry over "collect all matches"**: the latter
  repeals the documented "first match wins, one suite per path" property
  (`gate-check-core.ts:88-97`, restated in spec §2), which other rules rely
  on. If you take it anyway, update that module comment in the same commit.
- [ ] **Step 2:** add `^scripts/` → **`kmcrank` AND `ccgate`**. Not kmcrank
  alone: `cc-gate-plugin/test/escape-hatch.test.ts:13` drives
  `scripts/km-panic.sh`; `test/fixture-ref.test.ts:187` and
  `test/corpus-store.test.ts:270` assert over `scripts/km-sensors-sync.sh`.
- [ ] **Step 3:** record what the entry **drops**, not only what it adds.
  Today `scripts/` unions `FALLBACK_SUITES`, which includes `gateplugin`;
  after this entry it does not. Verified at plan time that `gate-plugin/` has
  zero references to `scripts/`, so the drop is defensible — but "Uncertain ⇒
  run MORE" makes an unrecorded reduction unresolvable for the implementer.
  Any further entry must be justified in a comment from what actually imports
  that directory. Unknown blast radius **stays on the fallback**; never narrow
  `FALLBACK_SUITES`.
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

## Task 6 — wire the command table

**Files:** `scripts/gate-check.ts`, `km-crank/test/gate-check-cli.test.ts`

- [ ] **Step 1:** generalise the fast-list computation (`:36-49`), which
  hardcodes package dir `"cc-gate-plugin"` and scan roots `["test","src"]`.
  The suite→package-dir map is **defined in `gate-check-core.ts` by Task 1**
  and imported here — not introduced in this task, and not a second copy.
  A third copy of the same strings already exists as `Cmd.cwd` (`:49-53`);
  derive from the map or assert they agree, so a package rename cannot
  desynchronise them silently. Only `ccgate` and `kmcrank` need entries;
  `opencode` is out of scope, and `gateplugin`/`doccheck` are not narrowed. Re-verify the guard comment at `:32-35` per package: confirmed at plan
  time that neither package has `.test.ts` outside `test/`, nor nested
  `node_modules` under `src/`. This triples the recursive `readdirSync` on
  every Stop — measure it; if not negligible, cache per tree hash.
- [ ] **Step 2:** replace the hardcoded `s === "ccgate"` (`:242-244`) with
  the general form: append each selected suite's pull-ins to its argv.
- [ ] **Step 3: guard the degraded case — OPEN IMPLEMENTATION QUESTION,
  decide deliberately and record the choice.** `:41-45` degrades to
  `all = []` on readdir failure, giving `argv = ["bun","test"]` — correctly
  fail-safe. Appending a pull-in to that yields `bun test <one-file>`, running
  **only** that file. The obvious guard ("append only when the fast list is
  non-empty") is **not expressible for a seam table**: `commands()`
  (`:61-65`) returns the seam JSON verbatim and never calls `realCommands()`,
  so under every CLI test there is no fast list at all. Two implementations
  diverge and both look like compliance:
  (a) an explicit flag set in `realCommands()` — the seam fixture
  (`gate-check-cli.test.ts:47-51`) lacks it, so the append stops firing and
  the existing amendment-b assertion at `:260` goes red;
  (b) a heuristic on argv shape — passes `:250-261` only by accident and
  means the wrong thing for `doccheck`'s two-element argv.
  **Do not silently rewrite the fixture to make (a) pass** — that would delete
  the only end-to-end proof that pull-ins reach argv. Pick one, state why in
  the commit message, and if the fixture must change, change it as a declared
  decision with the assertion preserved.
- [ ] **Step 4: test at the right level.** `KKAMAK_GATE_COMMANDS`
  (`:61-65`) returns the seam JSON verbatim and never calls `realCommands()`,
  so a fast list is **not** observable at CLI level — the argv under test is
  the fixture's own. Unit-test fast lists on Task 1's helpers. What IS
  CLI-observable is the pull-in *append*, which happens in `main()` outside
  `commands()` — the mechanism `gate-check-cli.test.ts:250-261` already
  exercises. Add CLI cases for a `minimal/tasks/` change appending the desk
  test, and for a changed excluded test file appending itself.
- [ ] **Step 5: retire the ccgate-shaped exports.** Task 1 kept
  `SLOW_CCGATE_TEST_RE` / `ccgateFastFiles` / `slowCcgateTestsForChangedPaths`
  as wrappers so earlier tasks would not churn. Now that every caller is on
  the generalised form, remove them and their tests, or ccgate's policy is
  expressed twice — violating the one-policy-site rule this plan inherits.
- [ ] **Step 6:** green + commit.

## Task 7 — measure, stamp the boundary, deploy

- [ ] **Step 1:** re-measure with the **Pass B (JUnit) method only** — never
  mixing bases. Read the live stream via `gateNdjsonPath()` /
  `MAIN_GATE_NDJSON_DEFAULT` (`scripts/p0-signal-variance.ts:83-87`), which is
  **home-anchored**: a bare relative `.km/gate-outcomes.ndjson` read from a
  worktree is a different, near-empty file
  (`scripts/b3-binarization-measure.ts:46-53` records this as "NEVER
  cwd-relative"). Also correlate durations with `gate-check.ts:237`'s
  per-Stop suite log — the recorded 23.8-25.4 s band matches no predicted
  selection, and until it is attributed no post-change shift can be assigned
  to D3. Record as a **new dated pass appended** to spec §1; do not
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

Task 1 first. Tasks 2-4 are independent of each other but all touch
`gate-check-core.ts` and its test file — **run them serially**, not in
parallel worktrees. Task 6 needs 1-4; Task 7 needs 6.

Merge via `scripts/merge-with-gate.sh` with a committed review artifact whose
`findings-count` is a **bare integer** — the 7b gate rejects the prose form.

## Non-goals

- `ccgate` stays ≈14 s — diffuse cost; the tier-0 floor for `cc-gate-plugin`
  changes on the TIA-active path.
- The fallback path (spec §2.3 ruling).
- `table.full` / D8; debt repayment stays synchronous (D6).
- Concurrency (D7).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment. Unrelated.
