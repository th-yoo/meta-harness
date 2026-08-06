# Gate tier-0 narrowing — design (2026-08-06)

**Status:** design, unexecuted. No code changed. Decisions D1-D5 below are the
user's; this file records the measurement and the options, not the ruling.

**Problem statement:** the two-tier gate is deployed and working as designed,
but its blocking tier is not seconds-scale for any change that touches code.
Doc-only Stops are sub-second; code Stops cost 13-30s, and the most common
non-package path costs ~30s.

## 1. What was measured

Host `yoo-dev`, 2026-08-06, single samples each, repo at `6417b7a`. Timed by
running each tier-0 suite exactly as `scripts/gate-check.ts`'s command table
invokes it.

| tier-0 suite | wall time | narrowed? |
|---|---|---|
| `doccheck` | 0.05 s | n/a — always runs |
| `gateplugin` | 0.02 s | n/a — trivially small |
| `ccgate` (fast list) | **13.1 s** | yes — 50 of 56 files |
| `kmcrank` | **16.5 s** | **no — whole suite** |
| `opencode` | **30.0 s** | **no — whole suite** |
| `FALLBACK_SUITES` union | **≈ 29.7 s** | ccgate+gateplugin+kmcrank+doccheck |

Live evidence from `.km/gate-outcomes.ndjson` (this repo, `pluginVersion`
0.3.0 regime, 2026-08-05 22:15 → 2026-08-06 10:11):

- fast Stops: 212, 226, 270, 331 ms
- slow Stops: 23800, 24027, 24185, 24482, 25357, **37430** ms
- **debt-repayment Stops: 133452, 160319, 166587 ms**

Three populations, not two. The third is the one a user actually feels, and
§2.1 explains how a Stop enters it.

## 2. Root cause

`TIA_MAP` (`km-crank/src/gate-check-core.ts:98-104`) maps **directory →
suite**, not file → tests:

```
^cc-gate-plugin/  -> ccgate      ^opencode-plugin/ -> opencode
^minimal/         -> opencode    ^gate-plugin/     -> gateplugin
^km-crank/        -> kmcrank
```

Only `ccgate` is then narrowed to a file list (`ccgateFastFiles` +
`SLOW_CCGATE_TEST_RE`). Every other suite runs in full. So a one-line change
under `opencode-plugin/` runs all 1688 opencode tests.

Anything matching no entry unions `FALLBACK_SUITES`. Verified selections:

```
docs/resume.md            -> doccheck                                   (0.05 s)
cc-gate-plugin/src/…      -> ccgate, doccheck                           (13.1 s)
km-crank/src/…            -> kmcrank, doccheck                          (16.5 s)
opencode-plugin/…         -> opencode, doccheck                         (30.0 s)
minimal/run.ts            -> opencode, doccheck                         (30.0 s)
scripts/gate-check.ts     -> ccgate, gateplugin, kmcrank, doccheck      (29.7 s)
term-bench2/runner.ts     -> ccgate, gateplugin, kmcrank, doccheck      (29.7 s)
package.json              -> ccgate, gateplugin, kmcrank, doccheck      (29.7 s)
```

The fallback surface is large and everyday: `scripts/`, `term-bench2/`,
`evidence/`, `resource-profiles/`, root files. Editing the gate's own script
costs ~30 s per Stop.

### 2.1 TIA only applies when a GREEN marker exists — and the sync-full tier

The path-based narrowing above is **conditional**, which the cost table alone
hides (`scripts/gate-check.ts:233-235`):

```js
const base = marker?.status === "green" ? marker.tree : undefined
const changed = base ? changedPathsSince(base, tree) : undefined
const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
```

With no green marker to diff against there are no changed paths, so TIA is
skipped entirely and `d.suites` — `FALLBACK_SUITES`, ≈29.7 s — runs. That is
the state on a first Stop in a fresh worktree, after any red, and after any
tree change with no completed background run. **The ~30 s fallback is
therefore the default, not the exception**, and the per-path table in §2 is
the best case rather than the typical one.

Above that sits a third tier. `decide()`
(`km-crank/src/gate-check-core.ts:69-71`) returns `full-sync` in exactly two
cases: `forceFull`, and **`marker.status === "red"` — debt repayment**. A
full-sync Stop runs the whole tier-1 chain in the foreground: measured
133-167 s.

Normal full runs are NOT synchronous. `spawnBg` detaches them
(`scripts/gate-check.ts:154-161`) and they write the marker themselves —
`green` on exit 0, `red` otherwise (`:143-145`). So the only way to a ~160 s
Stop is a background full run that went red, after which **every** subsequent
Stop pays synchronously until a full run goes green again.

Observed live on 2026-08-06: a worktree created without `bun install` made
`cc-gate-plugin`'s imports fail, the background full run went red, and the
next two Stops cost 160 s and 167 s each. The failure was environmental, not
a code defect — but the tail cost is identical either way.

**This matters for D1-D3.** Narrowing tier 0 lowers the common case; it does
nothing for the tail, which is governed by how often tier 0 or the background
run goes red and how much repayment costs. A narrower tier 0 that goes red
more often can be worse overall.

**Why the earlier ~5 s figure did not generalize.** The two-tier deploy
measured `durationMs` 108733 → 4943 and reported ≈22× faster Stops. That is
accurate for the window it measured, which was doc-heavy. The mechanism
works; the claim simply was not a statement about code Stops, and nothing in
tier 0 was ever going to make a 13 s suite seconds-scale.

## 3. Decisions

**D1 — narrow `opencode`.** Largest single tier-0 cost (30 s) with no
exclusion list. Options: (a) mirror the `ccgateFastFiles` +
`SLOW_OPENCODE_TEST_RE` pattern, excluding the spawn-heavy files, kept in
tier 1; (b) leave it and accept 30 s for `opencode-plugin/` and `minimal/`
edits. Recommendation: (a) — the pattern already exists and generalizes
directly; the measurement work is identifying which opencode files dominate.

**D2 — shrink the fallback.** Currently any unmapped path unions three
suites. Options: (a) add explicit `TIA_MAP` entries for the known unmapped
directories (`^scripts/` → `kmcrank`, `^term-bench2/` → its own or none);
(b) reduce `FALLBACK_SUITES` itself; (c) leave conservative. Recommendation:
(a) — it is additive, leaves the conservative default intact for genuinely
unknown paths, and takes the commonest slow case from ~30 s to ~16.5 s.
**(b) is the risky one:** the fallback exists so an unrecognised path cannot
silently skip coverage. Narrowing the default rather than mapping known
paths trades that safety for latency.

**D3 — narrow `kmcrank`** (16.5 s) with the same pattern as D1. Lower payoff
than D1; do it in the same pass or not at all, since it is the same code.

**D4 — `src/acp/index.ts` tier-0 coverage.** Deferred minor from the
promote-acp review (`docs/reviews/4fc2cf1-promote-acp.md`). TIA maps it to
`ccgate`, whose fast list excludes the ACP tests, so a rename in that seam
file has zero blocking coverage. A directory-qualified `SLOW_SOURCE_TO_TESTS`
rule fixes it. Include here because it is the same file and the same pass.

**D6 — should debt repayment stay synchronous?** New, raised by §2.1's
measurement. Today a red marker makes the next Stop pay 133-167 s in the
foreground. The argument for keeping it: a red full run means something is
genuinely broken, and continuing to let turns through on a stale green is the
failure mode the gate exists to prevent. The argument against: the repayment
is indiscriminate — an environmental failure (missing `node_modules`, a flaky
spawn test, a wedged daemon) costs three minutes per Stop until something
goes green, and the person paying usually cannot tell why. Options:
(a) keep sync — correctness first, status quo; (b) repay in the background
while tier 0 still blocks on its own result, so a red marker degrades
throughput rather than stopping it; (c) keep sync but only for a red whose
`outputTail` indicates a real test failure, treating load/spawn errors as
retry-worthy. Recommendation: **(a) for now** — (b) reopens exactly the
stale-green hole the two-tier design closed, and (c) needs a classifier
nobody has specified. Revisit only with measured red-cause data: how many
reds are environmental versus real. That data does not exist yet, and the
first step is recording `outputTail` causes rather than guessing.

**D7 — run tier-0 suites concurrently?** DEFERRED until D1-D4 is deployed and
measured. Today they are serial: `scripts/gate-check.ts:239-250` is a
`for (const s of suites)` loop over `runSyncCaptured`, which is `spawnSync`
(`:131-138`). Nothing in tier 0 is async; the only backgrounded thing in the
whole design is the detached tier-1 child (`spawn` + `detached` + `unref`).
So a multi-suite selection costs the SUM of its suites, not the max.

The lever is real but is largely consumed by D1-D3:

| fallback selection | cost |
|---|---|
| today, serial | 13.1 + 0.02 + 16.5 + 0.05 = **29.7 s** |
| serial, after D3 narrows kmcrank | 13.1 + 0.02 + 1.9 + 0.05 = **15.1 s** |
| concurrent, after D1-D4 | max(13.1, 1.9, …) = **13.1 s** |

≈14.6 s of value today, ≈2 s after the narrowing lands — because `ccgate`
then dominates and it is the diffuse suite this plan does not narrow. And
concurrency buys **nothing** for single-suite selections, which is what every
successful TIA narrowing produces. Sequencing therefore matters: doing D7
first would bank most of the win and make D1-D3 look marginal, while doing it
after makes D7 look marginal. The narrowing is the more durable fix — it
removes work rather than overlapping it — so it goes first.

**Blocking prerequisite if D7 is ever taken up:** `runSyncCaptured` writes
each suite's combined output to `process.stdout` (`:136`), and the check
runner captures that stream as the block reason handed back to the agent.
Concurrent suites would interleave those writes and make a failure message
unreadable. Per-suite output buffering must land BEFORE any parallelism, not
alongside it.

**D5 — measurement boundary.** Any of D1-D4 changes what `durationMs` means.
A boundary ts must be stamped in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at deploy, and gated-Stop
durations must never pool across it — same rule as every prior instrument
change. This is not optional and is not a decision, only a reminder.

## 4. Constraints

- **`gate.json`'s `check` string does not change.** It is already
  `bun scripts/gate-check.ts`, which is the last entry of
  `KKAMAK_DEV_CHECKS` (`km-crank/src/trial-verdict.ts:77-82`). All work here
  is internal to `gate-check-core.ts` / `gate-check.ts`, so **no
  `KKAMAK_DEV_CHECKS` append is required** and the append-only drift guard in
  `trial-verdict.test.ts:199` stays green untouched. (An earlier session note
  claimed this change carried a drift-guard obligation — it does not.)
- `cc-gate-plugin/src/core/` and `cc-gate-plugin/vendor/` are
  MECHANISM_PATHS. `km-crank/src/` is not among them, so editing
  `gate-check-core.ts` triggers no calibration staleness.
- **One policy site.** `SLOW_CCGATE_TEST_RE`'s comment states the rule: one
  regex, one policy site. Any new exclusion follows the same shape rather
  than scattering per-suite conditionals through `gate-check.ts`.
- **Tier 1 remains the net.** Narrowing tier 0 trades blocking coverage for
  latency; the background full run and the pre-merge sanity chain are what
  make that safe. No change here may weaken either.
- **Fail-safe direction.** When selection is uncertain, run more, not less.
  A narrowing bug that skips a suite is silent; one that runs an extra suite
  is merely slow.

## 5. Verification

- `km-crank/test/gate-check-core.test.ts` already unit-tests suite selection
  and slow-source pull-in over explicit path fixtures; every D1-D4 rule gets
  a case there, asserting over **current** paths.
- Re-measure each tier-0 suite after the change, same method as §1, and
  record the new table in the adoption-ledger entry alongside the boundary ts.
- The honest acceptance test is the live stream: after deploy, the slow
  population in `.km/gate-outcomes.ndjson` should separate into a new,
  lower band. Do not claim an improvement from a single Stop.

## 6. Out of scope

- Anything that changes what tier 1 runs.
- Parallelising suites within tier 0 — now tracked as **D7**, deferred with
  the arithmetic showing why it goes after the narrowing rather than instead
  of it.
- The stale comment at `cc-gate-plugin/src/acp/acp-paths.ts:2-4` (claims
  `hook-cli.ts` imports `acp-client.ts`; it does not). Unrelated, noted so it
  is not folded in opportunistically.
