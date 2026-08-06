# Gate tier-0 narrowing — design (2026-08-06)

**Status:** design, unexecuted. **Revision 3**, after two architect rounds.
Round 1 invalidated D1's original safety argument; round 2 invalidated
revision 2's fix for it and killed D8. Reviews:
`docs/reviews/2026-08-06-gate-tier0-narrowing-rounds-1-2.md`.

**Decision index:** D1 opencode narrowing (**re-justified, unblocked**) ·
D2 fallback mapping · D3 kmcrank narrowing · D4 `index.ts` coverage ·
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

**Consequence for D1:** an excluded opencode test is not caught later by any
other tier. Its coverage must therefore be preserved by the pull-in itself,
not by an appeal to tier 1. D1 below is justified on exactly that basis.

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

**D1 — narrow `opencode`. Re-justified, no longer depends on D8.**
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

**Do NOT also exclude `bench-cmd-ab.test.ts`** (2.25 s). It value-imports
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

**D4 — close the `src/acp/index.ts` gap.** Pull-in target is
**`test/anthropic-cli-warm.test.ts`**, not `acp-client.test.ts`: the latter
imports `src/acp/acp-client.ts` and `acp-wire.ts` directly (which
`index.ts:11-13` permits for tests), so it stays green when a barrel export
is renamed. The barrel's only runtime consumer is
`src/gauge/providers/anthropic-cli-warm.ts:10`; `send-prompt.ts:29` is
`import type` and cannot break at runtime.

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

| fallback selection | cost (Pass A) |
|---|---|
| today, serial | 13.1 + 0.02 + 16.5 + 0.05 = **29.7 s** |
| serial, after D3 | 13.1 + 0.02 + 1.9 + 0.05 = **15.1 s** |
| concurrent, after D1-D4 | max(13.1, 1.9, …) = **13.1 s** |

Valid again in revision 3 because §2.3's un-narrowing is withdrawn and the
fallback keeps its narrowed argv. ≈14.6 s of value today, ≈2 s after the
narrowing — `ccgate` then dominates and is not narrowed here. Concurrency
buys nothing for single-suite selections. **Prerequisite if taken up:**
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
  `minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`,
  `minimal/session2.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`.
  Never edited. This design writes policy *about* `minimal/` paths and
  touches none of those files.
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
- Acceptance is the live stream: the slow population should separate into a
  lower band. Never claim improvement from a single Stop. The tail is
  governed by debt repayment, which nothing here touches.

## 6. Non-goals

- `ccgate` stays ≈14 s — diffuse, no dominant file; the tier-0 floor for
  `cc-gate-plugin` changes on the TIA-active path.
- The fallback path (§2.3 ruling).
- Debt repayment stays synchronous (D6); `table.full` unchanged (D8).
- Concurrency (D7).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment. Unrelated.
