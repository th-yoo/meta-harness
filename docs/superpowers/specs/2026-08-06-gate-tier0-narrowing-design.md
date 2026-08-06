# Gate tier-0 narrowing — design (2026-08-06)

**Status:** design, unexecuted. No code changed. D1-D4 were approved
2026-08-06; **architect review round 1 invalidated D1's safety argument**
(§2.2) and added D8, which D1 now depends on. Treat D1 as re-opened.

**Decision index:** D1 opencode narrowing (blocked on D8) · D2 fallback
mapping · D3 kmcrank narrowing · D4 `index.ts` coverage · D5 boundary ts
(requirement, not a choice) · D6 sync debt repayment (keep) · D7 concurrent
suites (deferred) · D8 opencode in tier 1 (**new, blocks D1**).

**Problem statement:** the two-tier gate is deployed and working as designed,
but its blocking tier is not seconds-scale for any change that touches code.
Doc-only Stops are sub-second; code Stops cost 13-30 s, and the most common
selection costs ~30 s.

## 1. What was measured

Two measurement passes exist. **They are not interchangeable and must not be
pooled.** Both are recorded; the JUnit pass is the basis for all per-file
claims and for any before/after comparison.

**Pass A — whole-suite wall clock**, host `yoo-dev`, repo `6417b7a`, single
samples, each suite invoked exactly as `scripts/gate-check.ts`'s command
table does:

| tier-0 suite | wall time |
|---|---|
| `doccheck` | 0.05 s |
| `gateplugin` | 0.02 s |
| `ccgate` (fast list) | 13.1 s |
| `kmcrank` | 16.5 s |
| `opencode` | 30.0 s |
| `FALLBACK_SUITES` union | ≈29.7 s |

**Pass B — per-file, JUnit reporter** (`bun test --reporter=junit`), repo
`487d104`, single samples. Totals differ from Pass A by 10-20 % (reporter
overhead, load, cold caches); that spread is itself a reason not to claim
small deltas from n=1.

| suite | total | dominant file | share |
|---|---|---|---|
| `opencode` | 36.0 s / 182 suites | `test/minimal-relations-desk.test.ts` **31.5 s** | **88 %** |
| `kmcrank` | 15.8 s / 65 suites | `test/gate-check-cli.test.ts` **13.9 s** | **88 %** |
| `ccgate` (fast list) | 14.4 s / 50 files | `cli.test.ts` 5.2 s, `init-cli` 2.6 s, `sensor-contract` 1.5 s | diffuse, top 3 = 65 % |

Live evidence from `.km/gate-outcomes.ndjson` (this repo, `pluginVersion`
0.3.0 regime, 2026-08-05 22:15 → 2026-08-06 10:11):

- fast Stops: 212, 226, 270, 331 ms
- slow Stops: 23800, 24027, 24185, 24482, 25357, 37430 ms
- debt-repayment Stops: 133452, 160319, 166587 ms

Three populations. §2.1 explains the third.

## 2. Root cause

`TIA_MAP` (`km-crank/src/gate-check-core.ts:98-104`) maps **directory →
suite**, not file → tests:

```
^cc-gate-plugin/  -> ccgate      ^opencode-plugin/ -> opencode
^minimal/         -> opencode    ^gate-plugin/     -> gateplugin
^km-crank/        -> kmcrank
```

Only `ccgate` is then narrowed to a file list (`ccgateFastFiles` +
`SLOW_CCGATE_TEST_RE`, `:125-128`). Every other suite runs in full.

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

### 2.1 TIA is green-marker-conditional; the sync-full tier

Path narrowing is **conditional** (`scripts/gate-check.ts:233-236`):

```js
const base = marker?.status === "green" ? marker.tree : undefined
const changed = base ? changedPathsSince(base, tree) : undefined
const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
const slowPull = changed !== undefined ? slowCcgateTestsForChangedPaths(changed) : []
```

With no green marker there are no changed paths, so TIA is skipped and
`FALLBACK_SUITES` (≈29.7 s) runs.

**Corrected in review round 1:** `base` is set whenever the marker is green
**regardless of tree** — a green marker for an older tree still enables TIA
(`decide()` at `gate-check-core.ts:81-85` returns tier0 for that case). An
earlier draft of this spec claimed otherwise. The dominant real trigger for
the fallback is a **`"running"` marker**: any Stop landing while the detached
tier-1 child from the previous Stop is still going — a ~160 s window — sees
`status: "running"`, not green, and falls back.

Above that sits a third tier. `decide()` (`:69-71`) returns `full-sync` in
exactly two cases: `forceFull`, and **`marker.status === "red"` — debt
repayment**, which runs the whole tier-1 chain in the foreground: measured
133-167 s. Normal full runs are detached (`spawnBg`, `gate-check.ts:154-161`)
and write the marker themselves — `green` on exit 0, `red` otherwise
(`:186-188`, the bg path; `:143-145` is the separate synchronous path).

Observed live 2026-08-06: a worktree created without `bun install` made
`cc-gate-plugin`'s imports fail, the background run went red, and the next
two Stops cost 160 s and 167 s. Environmental, not a code defect — the tail
cost is identical either way.

### 2.2 `opencode` runs in exactly one place (review round 1, Critical)

- **Tier 1 does not run it.** `table.full` (`gate-check.ts:56-57`) is
  `cc-gate-plugin`, `gate-plugin`, `km-crank`, `doc-check`. No opencode.
- **The fallback does not run it.** `FALLBACK_SUITES`
  (`gate-check-core.ts:22`) is the same four, deliberately — the comment at
  `:17-21` records that the incumbent check never ran opencode and that
  adding it would cost every no-baseline Stop.
- **`merge-with-gate.sh` runs no tests at all** — only
  `check-review-artifact.ts` (`:16`).

So opencode tests execute automatically **only** when TIA is active AND a
changed path matched `^opencode-plugin/` or `^minimal/`. Tier 0 is not the
fast path for them; it is the *only* path.

Two consequences, both decision-changing:

1. **Excluding an opencode test from tier 0 deletes it from automation**, it
   does not defer it. The "excluded files still run in tier 1" argument —
   true for ccgate and kmcrank — is false for opencode. D1 cannot proceed on
   that reasoning; hence **D8**.
2. **D1's headline number comes from the exceptional path.** Since the
   fallback excludes opencode, the 30-36 s opencode cost is only ever paid on
   TIA-active Stops that touched `opencode-plugin/` or `minimal/`. It is a
   real cost, but it is not on the path §2.1 identifies as most common, and
   D1 should not be ranked first on that number alone.

### 2.3 Exclusions are unconditional; pull-ins are not (review round 1, Critical)

The fast list is baked into the command table (`gate-check.ts:36-49`) and
applies on **every** run. `slowPull` is empty whenever `changed === undefined`
(`:236`). So on any no-green-marker Stop, a suite runs its fast list with
**no pull-in able to restore anything**.

This is already true for ccgate today: the fallback — whose stated purpose is
"when uncertain, run more" — runs ccgate *minus* the six slow ACP tests, and
cannot pull them back. Extending exclusions to more suites extends this hole.

**Binding rule for any implementation:** when `changed === undefined`, use the
suite's **un-narrowed** argv. Exclusion must be conditional on the same signal
the pull-in is conditional on, or the fallback runs strictly less than the
targeted path — the opposite of fail-safe.

## 3. Decisions

**D8 — put `opencode` in tier 1? (NEW, blocks D1.)** Today no automated path
runs opencode except TIA-selected tier 0 (§2.2). Options: (a) add
`opencode-plugin` to `table.full`, making the background run the genuine net
the design claims, then D1's exclusion is a deferral rather than a deletion;
(b) leave tier 1 as-is and drop D1; (c) leave tier 1 as-is and take D1 anyway,
accepting that the desk test runs nowhere automatic. **Recommendation: (a).**
It costs the *background* run ~36 s, which is the tier that is allowed to be
slow, and it removes an existing coverage gap rather than creating one. Note
the cost: `table.full` is currently "incumbent check VERBATIM" by deliberate
choice, and (a) ends that property — which is a change to what tier 1 means,
not a tuning knob. (c) is not recommended and must not be taken silently.

**D1 — narrow `opencode`.** BLOCKED on D8. If D8 takes (a): exclude
`minimal-relations-desk.test.ts` (31.5 s) with a pull-in on `^minimal/tasks/`
— verified adequate, that file reads only from `minimal/tasks`. Any second
exclusion needs its own pull-in derived from that file's actual imports;
`bench-cmd-ab.test.ts` imports nine `src/bench/*` modules and is **not**
covered by the `minimal/tasks` rule. If D8 takes (b) or (c), D1 is withdrawn
or its safety argument must be restated honestly.

**D2 — map the unmapped directories.** Add `TIA_MAP` entries for directories
whose blast radius is known, leaving genuinely unknown paths on the
fallback. **Corrected in review round 1:** `^scripts/` cannot map to
`kmcrank` alone — three ccgate tests drive files under `scripts/`
(`escape-hatch.test.ts:13` → `km-panic.sh`; `fixture-ref.test.ts:187` and
`corpus-store.test.ts:270` → `km-sensors-sync.sh`). It must map to `kmcrank`
**and** `ccgate`, or be split by filename. Never narrow `FALLBACK_SUITES`
itself.

**D3 — narrow `kmcrank`.** Exclude `gate-check-cli.test.ts` (13.9 s of
15.8 s) with pull-ins on `^scripts/gate-check\.ts$` and
`(^|/)gate-check-core\.ts$`. The pull-in is load-bearing: without it, edits to
the gate itself lose their most direct coverage. Subject to §2.3's binding
rule — otherwise the fallback silently drops the gate's own end-to-end test.

**D4 — close the `src/acp/index.ts` coverage gap.** **Corrected in review
round 1:** the pull-in target is **`test/anthropic-cli-warm.test.ts`**, not
`acp-client.test.ts`. The latter imports `src/acp/acp-client.ts` and
`acp-wire.ts` directly (as `index.ts:11-13` explicitly permits for tests), so
it stays green when a barrel export is renamed and would close nothing. The
only runtime consumer of the barrel is
`src/gauge/providers/anthropic-cli-warm.ts:10`; `send-prompt.ts:29` is
`import type` and cannot break at runtime.

**D5 — measurement boundary.** Not a decision. Any of D1-D4 changes what
`durationMs` means; a boundary ts goes in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at deploy and gated-Stop
durations never pool across it. **Corollary from review round 1:** §1's
measurement tables are a dated record. Post-change numbers are **appended**
as a new dated pass, never written over Pass A or Pass B.

**D6 — keep debt repayment synchronous.** A red full run means something is
genuinely broken, and letting turns through on a stale green is the failure
the two-tier design exists to prevent. The cost is that repayment is
indiscriminate: an environmental failure costs ~160 s per Stop until
something goes green. Revisit only with measured red-cause data (how many
reds are environmental vs real), which does not exist yet.

**D7 — concurrent tier-0 suites.** DEFERRED until D1-D4 is deployed and
measured. Tier 0 is serial: `gate-check.ts:239-250` loops `runSyncCaptured`,
which is `spawnSync` (`:132-139`). Nothing in tier 0 is async; only the
tier-1 child is detached. A multi-suite selection costs the SUM.

| fallback selection | cost (Pass A basis) |
|---|---|
| today, serial | 13.1 + 0.02 + 16.5 + 0.05 = **29.7 s** |
| serial, after D3 | 13.1 + 0.02 + 1.9 + 0.05 = **15.1 s** |
| concurrent, after D1-D4 | max(13.1, 1.9, …) = **13.1 s** |

≈14.6 s of value today, ≈2 s after the narrowing — `ccgate` then dominates
and this plan does not narrow it. Concurrency buys **nothing** for
single-suite selections, which is what successful TIA produces. Sequencing
matters: D7 first would bank most of the win and make D1-D3 look marginal;
after, D7 looks marginal. Narrowing removes work rather than overlapping it,
so it goes first. **Blocking prerequisite if taken up:** `runSyncCaptured`
writes each suite's output to `process.stdout` (`:137`), which the check
runner captures as the block reason; concurrent suites interleave it into an
unreadable failure message. Per-suite buffering lands first.

## 4. Constraints

- **`gate.json`'s `check` string MUST NOT change.** Already
  `bun scripts/gate-check.ts`, the last entry of `KKAMAK_DEV_CHECKS`
  (`km-crank/src/trial-verdict.ts:77-82`). No append is required or
  permitted; the drift guard at `trial-verdict.test.ts:199` stays green
  untouched.
- **MECHANISM_PATHS** (`km-crank/src/calibration.ts:65-72`) is
  `minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`,
  `minimal/session2.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`.
  Editing any stales the calibration registry. **Note the four `minimal/`
  entries** — D1 touches `minimal/`-adjacent policy, so the list matters.
  Nothing in this design edits those files.
- **Exclusion and pull-in must share one condition** (§2.3). Never exclude
  unconditionally while restoring conditionally.
- **Fail-safe direction.** When selection is uncertain, run MORE.
- **One policy site.** Follow `SLOW_CCGATE_TEST_RE`'s stated rule.
- **Tier 1 changes only via D8**, deliberately and once.

## 5. Verification

- `km-crank/test/gate-check-core.test.ts` unit-tests suite selection and
  pull-in over explicit path fixtures; every rule gets a case asserting over
  **current** paths. Note `:97` and `:100` pin the present `scripts/`
  behaviour and will change under D2 — that is expected, and the change is
  recorded rather than quietly edited.
- Re-measure with the **Pass B method only**, append as a new dated pass.
- The acceptance test is the live stream: the slow population should separate
  into a new lower band. Do not claim improvement from a single Stop, and
  remember the tail is governed by debt repayment, which nothing here touches.

## 6. Non-goals

- `ccgate` stays ≈14 s — diffuse, no dominant file. After this work that is
  the tier-0 floor for `cc-gate-plugin` changes.
- Debt repayment stays synchronous (D6).
- Concurrency (D7, deferred with arithmetic).
- `cc-gate-plugin/src/acp/acp-paths.ts:2-4`'s stale comment (claims
  `hook-cli.ts` imports `acp-client.ts`; it does not). Unrelated.
