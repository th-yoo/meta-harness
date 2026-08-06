# Gate tier-0 narrowing — design (2026-08-06)

**Status:** design, unexecuted. **Revision 5**, after four architect rounds.
Round 1 invalidated D1's original safety argument; round 2 invalidated
revision 2's fix for it and killed D8; round 3 killed D1 itself; round 4
killed D4 and showed the governing rule was overstated. **What survives is
D2 and D3.** Reviews:
`docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-4.md`.

**Decision index:** **D1 opencode narrowing — WITHDRAWN (round 3)** ·
D2 fallback mapping · D3 kmcrank narrowing · **D4 `index.ts` coverage — WITHDRAWN (round 4)** ·
D5 boundary ts (requirement) · D6 sync debt repayment (keep) · D7 concurrent
suites (deferred) · **D8 opencode in tier 1 — WITHDRAWN**.

**Problem:** the gate's blocking tier is not seconds-scale for code changes.
Doc-only Stops are sub-second; code Stops cost 13-30 s.

## 1. What was measured

Two passes exist. **Not interchangeable; never pooled.** Pass B is the basis
for all per-file claims and for any before/after comparison.

**Pass A — whole-suite wall clock**, `yoo-dev`, repo `6417b7a`, n=1 each,
invoked as the command table invokes them:

| tier-0 suite | wall time |
|---|---|
| `doccheck` | 0.05 s |
| `gateplugin` | 0.02 s |
| `ccgate` (fast list) | 13.1 s |
| `kmcrank` | 16.5 s |
| `opencode` | 30.0 s |

`FALLBACK_SUITES` union ≈ **29.7 s** — the arithmetic sum of the ccgate,
gateplugin, kmcrank and doccheck rows, not a separate measurement.

**Pass B — per-file, JUnit reporter**, repo `487d104`, n=1 each. Totals run
10-20 % above Pass A (reporter overhead, load); that spread is itself a
reason not to claim small deltas from n=1.

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | 36.0 s / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, … | diffuse, top 3 = 65 % |

Live stream, `.km/gate-outcomes.ndjson`, 0.3.0 regime, 2026-08-05 22:15 →
2026-08-06 10:11: fast Stops 212/226/270/331 ms; slow Stops
23800/24027/24185/24482/25357/37430 ms; debt-repayment Stops
133452/160319/166587 ms.

## 2. Root cause

`TIA_MAP` (`km-crank/src/gate-check-core.ts:98-104`) maps **directory →
suite**, not file → tests, and its entries are `{ re; suite }` singular,
resolved by `.find` (`:112`) — **first match wins, one suite per path**.
Only `ccgate` is then narrowed to a file list (`:125-128`). Others run whole.

Unmatched paths union `FALLBACK_SUITES` (`:22`) — `ccgate`, `gateplugin`,
`kmcrank`, `doccheck`. Verified selections:

```
docs/resume.md            -> doccheck                                   (0.05 s)
cc-gate-plugin/src/…      -> ccgate, doccheck                           (13.1 s)
km-crank/src/…            -> kmcrank, doccheck                          (16.5 s)
opencode-plugin/…         -> opencode, doccheck                         (30.0 s)
minimal/run.ts            -> opencode, doccheck                         (30.0 s)
scripts/gate-check.ts     -> ccgate, gateplugin, kmcrank, doccheck      (29.7 s)
package.json              -> ccgate, gateplugin, kmcrank, doccheck      (29.7 s)
```

### 2.1 TIA is green-marker-conditional; the sync-full tier

`scripts/gate-check.ts:233-236`:

```js
const base = marker?.status === "green" ? marker.tree : undefined
const changed = base ? changedPathsSince(base, tree) : undefined
const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
const slowPull = changed !== undefined ? slowCcgateTestsForChangedPaths(changed) : []
```

`base` is set on **any** green marker, regardless of tree (`:233`). Three
things produce `changed === undefined`, i.e. the fallback:

1. a `"running"` marker — any Stop landing inside the ~3 min window while the
   previous Stop's detached tier-1 child is still going. **The dominant
   trigger.**
2. a `"red"` marker → not fallback but `full-sync` (below).
3. an unresolvable tree in `changedPathsSince` (`:94-101`) — `git write-tree`
   objects are unreferenced and gc-prunable, so a green marker older than a
   gc silently falls back *with a green marker present*.

`decide()` (`gate-check-core.ts:69-71`) returns `full-sync` on `forceFull` or
a **red** marker — the whole tier-1 chain in the foreground, measured
133-167 s. Normal full runs are detached (`gate-check.ts:154-161`) and write
their own marker: `green` on exit 0, `red` otherwise (`:186-188`; `:143-145`
is the separate synchronous path).

### 2.2 `opencode` runs in exactly one place

- Tier 1 does not run it: `table.full` (`gate-check.ts:56-57`) chains
  `cc-gate-plugin`, `gate-plugin`, `km-crank`, `doc-check`.
- The fallback does not run it: `FALLBACK_SUITES` (`gate-check-core.ts:22`)
  is the same four, deliberately (`:17-21`).
- `merge-with-gate.sh` runs no tests, only `check-review-artifact.ts` (`:16`).

So opencode tests run automatically **only** on a TIA-active Stop whose
changed paths matched `^opencode-plugin/` or `^minimal/`. Note the stale
figure in that comment — it estimates opencode at "~47s"; measured 30.0/36.0 s.

**Consequence:** an excluded opencode test is not caught later by any other
tier, and — round 3 — cannot be rescued by a pull-in either, because the green
baseline the pull-in diffs against is advanced by tiers that never ran
opencode. See D1 (withdrawn).

### 2.3 The fallback's empty pull-in is a RECORDED DECISION, not a defect

When `changed === undefined`, suites run their narrowed argv with an empty
pull-in list. Revision 2 of this spec called that Critical and proposed
un-narrowing on that path. **Round 2 refuted it and it is withdrawn.**

The prior, executed design already ruled this
(`docs/superpowers/plans/2026-08-05-two-tier-gate-check.md:919`): *"On tier0
with NO green baseline, `changed` is `undefined` → suites = `FALLBACK_SUITES`
… and the slow pull-in list is empty (nothing to diff against — **the bg full
run covers the slow files**)."*

Why revision 2's fix was worse than the problem:

- `FALLBACK_SUITES` is the same four commands `table.full` chains. Un-narrowing
  the fallback **is** the incumbent full check, run serially in the blocking
  tier: 29.7 s → **133-167 s**, on the majority of code Stops, after which the
  Stop still spawns a bg run of the same suites.
- It buys at most one Stop of deferral, because the bg run whose existence
  makes the marker `"running"` is already executing those files.
- It cannot reach the one suite with a genuine gap: `changed === undefined`
  ⇒ `suites = FALLBACK_SUITES`, which contains no `opencode`.
- It would falsify D7's arithmetic and §6's floor inside this document.

**Ruling: the fallback path is out of scope.** No change keys on
`changed === undefined`.

## 3. Decisions

**D8 — put `opencode` in tier 1? WITHDRAWN.** Round 2's objection is
decisive and is recorded so it is not re-proposed:

- `table.full` is not only the background command. It is also the
  **synchronous** debt-repayment command (`gate-check.ts:141-147`, invoked
  `:205-211`) and the `KKAMAK_GATE_FULL` command. Adding opencode moves the
  red-marker Stop cost from 133-167 s to ~170-205 s.
- `minimal-relations-desk.test.ts` spawns `python3` **at module scope**
  (`:17`, no skip guard), spawns `tmux` (`:57`, `:72`), and requires host
  `rdflib` (`:103`). On any host lacking them the background run goes red and
  **can never go green** — and D6 keeps repayment synchronous, so every Stop
  thereafter pays ~200 s with no exit. This repo is explicitly multi-host.
  Today that fragility is confined to Stops touching `opencode-plugin/` or
  `minimal/`; D8 would promote it to a permanent global gate wedge.
- It also lengthens the `"running"` window, increasing fallback frequency.

**D1 — narrow `opencode`. WITHDRAWN (round 3).** The withdrawal reason is
structural and worth keeping, because it yields the rule that governs D2-D4.

The pull-in is **edge-triggered on the diff since the green marker**:
`changed = changedPathsSince(marker.tree, tree)` (`gate-check.ts:233-234`).
The green marker is written by `runFullSync` (`:143-145`) and `bgMain`
(`:186-188`) — both of which run `table.full`, which **contains no
opencode**. So the baseline advances past `minimal/tasks/` edits that opencode
never saw. Three documented routes do exactly that: debt repayment (D6),
`KKAMAK_GATE_FULL=1`, and the pruned-tree fallback of §2.1 item 3 (whose bg
run writes green for the new tree). After any of them the change is *behind*
the baseline, the pull-in never fires again, and the desk test never runs —
where today that Stop runs the whole opencode suite. The same argument kills
the self-pull leg. Coverage is lost permanently, not deferred.

Revision 3 justified D1 on input-scoping precisely to avoid appealing to tier
1; round 3 showed that is what breaks it, because the *baseline* depends on
tier 1 even when the coverage does not.

**The resulting rule, the durable finding of this arc:** narrowing a suite
is *admissible* only if that suite runs in `table.full`. `ccgate` and
`kmcrank` do; `opencode` does not, so it cannot be narrowed by this mechanism
at all. Making it narrowable needs per-suite "last ran against tree X"
provenance on the marker, or opencode in whatever tier writes green (D8,
refused above as a gate wedge). Neither is designed.

**Necessary, not sufficient — round 4.** Do not read "runs in `table.full`"
as "a regression will be caught and surfaced". Traced against the code, the
rescue chain is bg-run-red → marker red → *the next* gated Stop pays
`full-sync` (133-167 s). Three gaps in that chain, none of which this design
closes:

1. **Spawn-conditional.** `decide` returns `spawnBg: false` on a live, fresh
   `"running"` marker (`gate-check-core.ts:79`) — the very state §2.1 names
   the dominant fallback trigger. On that Stop the excluded file is skipped
   *and* no tier-1 run is keyed to that tree.
2. **Content-raced.** `bgMain` runs `table.full` against the live worktree
   (`gate-check.ts:176-178`) and writes green for the `tree` computed before
   the spawn. "Green for tree T" does not mean the excluded file passed *at*
   T. It fails safe (bg content ⊇ T), but it is not the guarantee the phrase
   suggests.
3. **No terminal rescue.** If the last Stop of a session lands in the
   `"running"` window, no later Stop repays the debt, and
   `merge-with-gate.sh` runs no tests. Today that Stop runs `kmcrank` whole.

So D3 does lose coverage in a reachable scenario. It is accepted knowingly:
the loss is one deferred detection on a session-final Stop, against ~14 s on
every kmcrank Stop. Recorded here so it is not later discovered as a
surprise.

**Superseded text (kept only to show what was withdrawn):**
Exclude `minimal-relations-desk.test.ts` (31.5 s of 36.0 s) with a pull-in on
`^minimal/tasks/` plus a self-pull on the test file itself. The safety
argument is **input-scoping, not tier 1**: round 1 verified that this test
reads only from `minimal/tasks` (`TASKS` at `:10`; every fixture, oracle and
relation path under it) and imports no `opencode-plugin/src` module. So it
runs exactly when its inputs or its own source change, which is the only time
it can newly fail. On the TIA-inactive path there is no regression either,
because opencode is not selected there today (§2.2).

Residual, stated honestly: a *non-hermetic* failure — host `python3`,
`rdflib` or `tmux` drifting — would now surface only when `minimal/tasks` or
the test file changes, rather than on every opencode-selected Stop. Given the
same drift currently produces a red-marker wedge only on those Stops, this
narrows an existing fragility rather than widening it.

Moot under the withdrawal, retained as a warning if opencode narrowing is
ever revisited: **do NOT exclude `bench-cmd-ab.test.ts`** (2.25 s). It value-imports
seven `src/bench/*` modules (two further imports are `import type`, which the
amendment-b policy at `gate-check-core.ts:144-146` explicitly does not
count). 2.25 s does not justify that rule surface.

**D2 — map the unmapped directories.** `^scripts/` must map to `kmcrank`
**and** `ccgate` — three ccgate tests drive files under `scripts/`
(`escape-hatch.test.ts:13` → `km-panic.sh`; `fixture-ref.test.ts:187` and
`corpus-store.test.ts:270` → `km-sensors-sync.sh`). **This requires changing
`TIA_MAP`'s record type**: entries are `{ re; suite }` singular resolved by
`.find` (§2), so two entries sharing a regex would silently yield only the
first. Unknown blast radius stays on the fallback; `FALLBACK_SUITES` is never
narrowed.

**D3 — narrow `kmcrank`.** Exclude `gate-check-cli.test.ts` (13.9 s of
15.8 s) with pull-ins on `^scripts/gate-check\.ts$` and
`(^|/)gate-check-core\.ts$`, plus a self-pull. Load-bearing: without them,
edits to the gate itself lose their most direct coverage. **These rules must
carry no package-prefix guard** — that is the point of making the guard
per-rule (§4).

**D4 — close the `src/acp/index.ts` gap. WITHDRAWN (round 4).** The rule
would violate two policies written into the very file it modifies:

- `gate-check-core.ts:138-143`: the pull-in patterns are basename-anchored
  *"precisely so a directory move cannot silently stop them matching — **do
  not re-anchor them to a directory**."* D4 needs
  `^cc-gate-plugin/src/acp/index\.ts$` because `index.ts` is a generic
  basename — directory-anchored, on a file whose stated purpose
  (`src/acp/index.ts:8-9`) is to make a later extraction "a directory move
  plus a package.json". The rule would silently stop matching at exactly the
  moment it was written for.
- `gate-check-core.ts:144-149`: *"DIRECT value imports only (one hop) …
  Deeper transitive chains are deliberately NOT chased … the bg debt gate is
  the stated safety net for that depth."* D4's chain is `index.ts` →
  `anthropic-cli-warm.ts` → `anthropic-cli-warm.test.ts` — two hops. Under
  the recorded policy this is **not a gap; it is the documented deferral.**

The `index.ts` seam genuinely has no tier-0 blocking coverage, and that
remains true and recorded. Closing it needs a deliberate amendment to both
policies, which is a larger design change than the gap justifies — the bg
debt gate is the stated net, as for every other two-hop chain.

**D5 — measurement boundary.** Not a decision. A boundary ts goes in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at deploy; gated-Stop
`durationMs` never pools across it. §1's tables are dated records —
post-change numbers are **appended as a new pass**, never overwritten.

**D6 — keep debt repayment synchronous.** A red full run means something is
broken, and letting turns through on a stale green is the failure the design
exists to prevent. Cost: repayment is indiscriminate — an environmental
failure costs ~160 s per Stop until something goes green. This is also the
mechanism that makes D8 unacceptable. Revisit only with measured red-cause
data, which does not exist.

**D7 — concurrent tier-0 suites. Deferred.** Tier 0 is serial:
`gate-check.ts:239-250` loops `runSyncCaptured` = `spawnSync` (`:132-139`).
Only the tier-1 child is detached. A multi-suite selection costs the SUM.

All rows below are Pass A except the post-D3 kmcrank figure, which is
Pass-B-derived (15.8 − 13.9 = 1.9). **That mixing is a known defect of this
table** — §1 forbids pooling the passes, and a real D7 decision must re-derive
every row on one basis first.

| fallback selection | cost |
|---|---|
| today, serial | 13.1 + 0.02 + 16.5 + 0.05 = **29.7 s** |
| today, concurrent | max(13.1, 0.02, 16.5, 0.05) = **16.5 s** |
| serial, after D3 | 13.1 + 0.02 + 1.9 + 0.05 = **15.1 s** |
| concurrent, after D3 | max(13.1, 0.02, 1.9, 0.05) = **13.1 s** |

Concurrency is worth **13.2 s today** (29.7 → 16.5) and **≈2 s after D3**
(15.1 → 13.1). The rows are "after D3", not "after D1-D4": D1 is withdrawn,
`FALLBACK_SUITES` contains no opencode, D2 changes selection frequency rather
than this selection's cost, and D4 only fires when ccgate is already
selected. Concurrency buys nothing for single-suite selections. **Prerequisite if taken up:**
`runSyncCaptured` writes each suite's output to `process.stdout` (`:137`),
which the check runner captures as the block reason; concurrent suites
interleave it into an unreadable message. Per-suite buffering lands first.

## 4. Constraints

- **`gate.json`'s `check` string MUST NOT change** — already
  `bun scripts/gate-check.ts`, the last `KKAMAK_DEV_CHECKS` entry
  (`km-crank/src/trial-verdict.ts:77-82`). No append required or permitted;
  the drift guard at `trial-verdict.test.ts:199` stays green untouched.
- **`table.full` is unchanged** (D8 withdrawn), so the executed two-tier
  plan's "byte-identical string" constraint
  (`2026-08-05-two-tier-gate-check.md:15`) still holds.
- **MECHANISM_PATHS** (`km-crank/src/calibration.ts:65-72`):
  `minimal/{complete-gate,mutate,spec-probe,session2}.ts`,
  `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`. Never edited. Nothing
  in revision 5 references `minimal/` at all (that was D1 residue); the
  constraint is retained only because the files exist.
- **The package-prefix guard is per-RULE, not per-suite.**
  `slowCcgateTestsForChangedPaths` early-continues on
  `!/^cc-gate-plugin\//` (`:172`), which is what makes
  `gate-check-core.test.ts:155` pass. D3's rules deliberately map a
  `scripts/` path to a km-crank test and must carry no guard; ccgate's
  existing rules keep theirs.
- **The self-pull must become per-suite.** `:172`/`:174` hardcode
  `^cc-gate-plugin/`; a changed excluded test file must pull itself in for
  every narrowed suite, or editing that file selects the suite and skips it.
- **A pull-in does not select its suite.** The runner iterates `suites` only
  (`gate-check.ts:239-250`). D3's rules work because `kmcrank` is in
  `FALLBACK_SUITES` and in `TIA_MAP` for `^scripts/` after D2 — not because a
  pull-in forces selection. Any future cross-package rule must check this.
- **Coverage constraint, stated precisely:** no test file may end up running
  in *fewer situations where it could newly fail* than today. Narrowing a
  suite while pulling the file back on changes to its inputs and itself
  satisfies this; blanket exclusion does not.
- **Fail-safe direction.** When selection is uncertain, run MORE.
- **One policy site** — follow `SLOW_CCGATE_TEST_RE`'s stated rule.

## 5. Verification

- `km-crank/test/gate-check-core.test.ts` unit-tests selection and pull-in.
  `:97` and `:100` pin present `scripts/` behaviour and change under D2 —
  expected, recorded, and `:99-101`'s invariant ("fallback never DROPS a TIA
  pick") must be re-pinned with a path that is *still* unknown after D2.
- Fast-list computation is **not** observable through `KKAMAK_GATE_COMMANDS`
  (`gate-check.ts:61-65` returns the seam JSON verbatim and never calls
  `realCommands()`). Unit-test it directly; only the pull-in *append* is
  CLI-observable, which is why `gate-check-cli.test.ts:250-261` works.
- Re-measure with the Pass B method only; append as a new dated pass.
- **The live stream is home-anchored.** Read it via `gateNdjsonPath()` /
  `MAIN_GATE_NDJSON_DEFAULT` (`scripts/p0-signal-variance.ts:83-87`), which
  resolves under `~/z2/meta-harness`. A bare relative `.km/gate-outcomes.ndjson`
  read from a worktree is a different, near-empty file — the exact error
  `scripts/b3-binarization-measure.ts:46-53` records as "NEVER cwd-relative".
- **Acceptance must correlate, not just compare.** The recorded slow band is
  23.8-25.4 s, which matches *no* predicted selection (opencode 30.0, fallback
  29.7, kmcrank 16.5, ccgate 13.1). Until that cluster is attributed, a
  post-change shift cannot be assigned to D3. `gate-check.ts:237` already logs
  the selected suites per Stop; acceptance requires correlating durations with
  that line. Never claim improvement from a single Stop. The tail is governed
  by debt repayment, which nothing here touches.

## 6. Non-goals

- **Narrowing `opencode` at all** (D1 withdrawn, round 3). Requires marker
  provenance or D8; neither is designed.
- **Closing the `src/acp/index.ts` tier-0 gap** (D4 withdrawn, round 4). It
  is the documented two-hop deferral; closing it needs an amendment to two
  in-code policies.
- The stale "~47s" opencode estimate in `gate-check-core.ts:17-21`
  (measured 30.0/36.0 s). Observed, not fixed here — it sits in a comment
  whose conclusion is unaffected.
- `ccgate` stays ≈14 s — diffuse, no dominant file; the tier-0 floor for
  `cc-gate-plugin` changes on the TIA-active path.
- The fallback path (§2.3 ruling).
- Debt repayment stays synchronous (D6); `table.full` unchanged (D8).
- Concurrency (D7).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment. Unrelated.
