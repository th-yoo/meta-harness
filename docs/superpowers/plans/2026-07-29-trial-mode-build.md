# §4.3 Trial-Mode Prerequisite Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ten §11 prerequisite items of the registered §4.3 trial-mode spec (`docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md`) — salted arms, exposure log, snapshot-composed baseline arm, gate-outcomes trial authority, verdict engine in km-crank, calibration registry, scorecard surfacing, snapshot script, panic verb — WITHOUT changing any registered semantics.

**Architecture:** The spec is a PRE-REGISTRATION — it is law. Code implements §2 (exposure/join/exclusions), §3 (salted assignment + snapshot compose), §5 (three-floor fixed-N decision rule), §6 (authority split: `trial-verdict.ts` computes, `resolveGateTrial` enacts, old `resolveTrial` stands down), §9 (guards + A/A machinery). Where the spec text and code seams conflict, STOP and surface it — a deviation needs a pre-data amendment, never a silent code choice. One deviation is already known and authorized: the spec's §2 cites `dispatch.ts:12,152-168` — the file lives at `opencode-plugin/src/adapters/claude-code/dispatch.ts` (not under cc-gate-plugin); this is a citation clarification, not a semantic change.

**Tech Stack:** Bun + TypeScript, `bun:test`. Suites baseline at task-1 start: opencode-plugin ~1672 pass/1 skip, cc-gate-plugin 332, km-crank 70, gate-plugin 26 — record exact numbers before starting; every task holds or exceeds.

## Global Constraints

- **Spec is law; pre-data amendments only.** Any behavior the spec pins (§2 dedupe/void/time-bound, §3 salt, §5 floors `MIN_N=20`/`≥5 sessions`/`E_MIN=5`/`T_MAX=28d`, KEEP-3-clause rule, §6 stand-down, §9 guards) must be implemented byte-faithfully. Deviations discovered mid-build → STOP, report, amendment first.
- `SensorLine` (`cc-gate-plugin/src/types.ts`) is the frozen shared contract — its amendment (Task 1) happens FIRST and alone, then everything else builds on it.
- Exposure log path: `.km/trial-arms.ndjson` under the project cwd (sibling of `gate-outcomes.ndjson`). One row per session: `{ts, sessionID, trialId, layer, arm, forced}`.
- Salt: `arm = FNV-1a("${trialId}:${sessionID}") % 2` — REUSE the existing FNV-1a implementation (`cc-gate-plugin/src/reinject.ts:30-37` constants 0x811c9dc5/0x01000193); a second divergent hash impl is a defect. 0 → "baseline", 1 → "trial".
- `KKAMAK_TRIAL_ARM` forcing mirrors `KKAMAK_REINJECT` (`reinject.ts:44-51`) but the exposure row records `forced:true` — exclusion is enforced from the exposure record at join time (§2), never sensor-side convention.
- Old `resolveTrial` stand-down = literally the FIRST branch after `readTrial` null-check, BEFORE any `readScore` (`harness-store.ts:1322`) — it fires on every `/mh-score` (`engine.ts:607`).
- `resolveGateTrial` verdict enactment reuses `writeActive`/`clearTrial`/`appendMetaMetric` only; new ledger `action` values on the existing `event:"trial"` stream: `"keep" | "rollback" | "insufficient-events" | "deferred" | "abandoned"`. A §4.3 ROLLBACK writes NO rejected-ledger entry.
- Trial START stays human-go (v0). Nothing in this build may auto-start a trial.
- kkamak-dev check group, gauge-only lines, forced rows, unmatched sensor lines: excluded from every metric (§2). Pooling only explicit.
- **Build-time decision (spec flags it; plan resolves it):** the queued golden window reuses `.trial` — `TrialState` gains optional `golden?: true` and `awaitingGo?: true`. Rationale (record in code comment): `readTrial != null` already blocks clobber from every existing path (crank skip-trial, propose isProject guard), so a second state file would need a parallel guard net; layering on `.trial` inherits the whole net for free. `awaitingGo` rows are inert: compose ignores them (no arm assignment until go), verdict engine ignores them, only the human-go path activates them.
- Commit convention: every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Direct to main.

## File Structure

- Modify: `cc-gate-plugin/src/types.ts` (SensorLine + `forced`/`pluginVersion`), `cc-gate-plugin/src/core/sensor.ts`, `cc-gate-plugin/src/hook-cli.ts` (stamp site)
- Create: `opencode-plugin/src/trial-arm.ts` (salted arm + exposure append + read; shared import for engine and km-crank)
- Modify: `opencode-plugin/src/compose.ts` (snapshot param), `opencode-plugin/src/engine.ts` (`composeInjection` arm-aware), `opencode-plugin/src/adapters/claude-code/dispatch.ts` (exposure appender call)
- Modify: `opencode-plugin/src/harness-store.ts` (`rewardMode`, stand-down guard, `resolveGateTrial`, TrialState `golden`/`awaitingGo`)
- Create: `km-crank/src/trial-verdict.ts`; Modify: `km-crank/src/crank.ts`, `km-crank/src/sitrep.ts`
- Create: `km-crank/src/calibration.ts` + committed `km-crank/calibration.json`
- Modify: `cc-gate-plugin/src/score-cli.ts` (per-arm session counts + exposure guard surface)
- Create: `scripts/km-sensors-sync.sh`; Modify: `scripts/km-panic.sh` (`trial-off`)
- Tests: one new/extended test file per task, named per each package's convention.

---

### Task 1: SensorLine contract amendment — `forced` + `pluginVersion`

**Files:**
- Modify: `cc-gate-plugin/src/types.ts:123-139` (SensorLine), `cc-gate-plugin/src/core/sensor.ts:3-29` (`buildSensorLine`), `cc-gate-plugin/src/hook-cli.ts:282-292` (stamp site)
- Test: extend the existing sensor/types tests (find via `grep -rl buildSensorLine cc-gate-plugin/test/`)

**Interfaces — Produces:**
```ts
// types.ts additions (optional, backward-compatible — old lines parse fine):
forced?: boolean          // true iff KKAMAK_REINJECT or KKAMAK_TRIAL_ARM forced this session
pluginVersion?: string    // from cc-gate-plugin/.claude-plugin/plugin.json at build of the line
```
This IS the frozen-contract amendment the types.ts header demands — the commit message must say so.

**Behavior contracts:**
1. `buildSensorLine` accepts and passes through the two new optional fields.
2. `hook-cli.ts` Stop stamping sets `forced: true` when `KKAMAK_REINJECT` forced the reinject arm (detect: env value is "v0"|"v1") — Task 3 extends the same flag for `KKAMAK_TRIAL_ARM`.
3. `pluginVersion` read once per process from the plugin.json actually shipped (locate it; vendor-safe path resolution — remember the plugin runs from a COPIED install dir, so resolve relative to the module, not the repo).
4. Old sensor lines without the fields still parse everywhere (`scan.ts`, `score.ts` untouched and green).

- [ ] Steps: failing tests → implement → cc-gate-plugin suite 332+ green → commit `feat(kkamak): SensorLine amendment — forced + pluginVersion fields (frozen-contract amendment, §11 item 6)`.

---

### Task 2: `trial-arm.ts` — salted assignment + exposure log append/read

**Files:**
- Create: `opencode-plugin/src/trial-arm.ts`
- Test: `opencode-plugin/test/trial-arm.test.ts`

**Interfaces — Produces:**
```ts
export type TrialArm = "baseline" | "trial"
export interface ExposureRow {
  ts: number
  sessionID: string
  trialId: string
  layer: string          // scope, e.g. "project-global"
  arm: TrialArm
  forced: boolean
}
export function fnv1a(s: string): number                      // exact constants from reinject.ts
export function pickTrialArm(trialId: string, sessionID: string,
  env?: NodeJS.ProcessEnv): { arm: TrialArm; forced: boolean } // KKAMAK_TRIAL_ARM ∈ {"baseline","trial"} forces
export function appendExposureRow(cwd: string, row: ExposureRow): "appended" | "already-enrolled"
  // any-row-for-sessionID dedupe (ANY trialId) — reads .km/trial-arms.ndjson, scans for sessionID, appends only if absent
export function readExposureRows(pathOrCwd: string): ExposureRow[]  // tolerant parse, skip corrupt lines
```

**Behavior contracts (each = a test):**
1. Salt decorrelation (§11 item 10, named test): over ≥200 synthetic sessionIDs, `pickTrialArm(trialId, sid)` vs reinject's `hash(sid)%2` agree on ~50% (assert within [0.35, 0.65]) — and for a FIXED sid, different trialIds can produce different arms (find a witness pair).
2. Same (trialId, sessionID) → always same arm (determinism).
3. `KKAMAK_TRIAL_ARM=baseline|trial` forces + `forced:true`; invalid value ignored (hash path, forced:false).
4. Dedupe: append row for sid under trial-A; second append for same sid under trial-B → "already-enrolled", file unchanged (the §2 resumed-session re-enrollment trap).
5. `readExposureRows` skips corrupt lines, returns typed rows.
6. Append creates `.km/` dir if missing; file is plain ndjson.

- [ ] Steps: TDD → opencode-plugin suite green → commit `feat(kkamak): trial-arm — salted assignment (decorrelated from reinject axis) + exposure log with any-row dedupe (§11 items 1-2)`.

---

### Task 3: Snapshot compose + arm-aware injection + exposure wiring

**Files:**
- Modify: `opencode-plugin/src/compose.ts:59-76`, `opencode-plugin/src/engine.ts:337-343` (`composeInjection`), `opencode-plugin/src/adapters/claude-code/dispatch.ts:153-171` (SessionStart)
- Test: extend `opencode-plugin/test/compose.test.ts` + new `opencode-plugin/test/trial-compose.test.ts`

**Design (from spec §3 + surface map):**
```ts
// compose.ts — new optional param; ComposedLayer unchanged:
export interface SnapshotOverride { scope: string; system: string; tools: string; playbook: Playbook | null }
export function composeHarness(layers, pins = {}, model?, snapshot?: SnapshotOverride): ComposedLayer[]
// when snapshot && layer.scope === snapshot.scope: use snapshot fields instead of readActive*/readPlaybook
```
```ts
// engine.ts composeInjection — arm-aware path (only when a gate-outcomes trial is live):
// pg = project-global layer root
const trial = readTrial(pg.root)
let snapshot: SnapshotOverride | undefined
if (trial?.rewardMode === "gate-outcomes" && !trial.awaitingGo) {
  const { arm } = pickTrialArm(trial.trialId ?? trial.trial, sessionId)
  if (arm === "baseline")
    snapshot = { scope: "project-global", system: trial.baselineSystem, tools: trial.baselineTools,
                 playbook: trial.baselinePlaybook ?? null }
}
const composed = composeHarness(layerRefs, {}, st.model, snapshot)
```
Exposure append in `dispatch.ts` SessionStart, AFTER `composeInjection` returns (compose read the trial; appender records what was composed):
- read trial state via a small engine accessor or direct `readTrial(layersFor(...)[1].root)` — implementer picks the cleaner seam, must be the SAME trial read compose used (no TOCTOU between compose and append: read once, thread through — restructure composeInjection to RETURN the enrollment info `{trialId, arm, forced} | undefined` alongside blocks if needed; that is the cleanest and is authorized).
- call `appendExposureRow(cwd, {...})`; "already-enrolled" → do NOT overwrite; a resumed session keeps its original row (its sensor lines void at join time per §2 — the VOID is enforced in Task 6's join, not here).
- non-participating roles / child sessions (`MH_CHILD_ENV`) never append.

**Behavior contracts:**
1. No live trial → compose byte-identical to today (regression: existing compose tests untouched and green).
2. Live gate-outcomes trial: baseline-arm session composes from snapshot fields; trial-arm session composes active. Legacy (no rewardMode) trials: compose stays active-only (today's behavior — legacy trials never had arms).
3. `awaitingGo` trials: no arm, no exposure row, active compose.
4. Exposure row appended exactly once per session incl. across SessionStart re-fires (resume/compaction — the `:163-165` idempotency note).
5. Forced arm (KKAMAK_TRIAL_ARM) → row has forced:true and the forced arm composes accordingly.
6. Child/non-participating sessions: no row.

- [ ] Steps: TDD → suites green → commit `feat(kkamak): arm-aware compose from TrialState snapshot + SessionStart exposure wiring (§11 items 1-2)`.

---

### Task 4: `rewardMode` + stand-down guard + `resolveGateTrial` enactment authority

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (`TrialState:235-248`, `startTrial:1257-1281`, `resolveTrial:1312+`, new `resolveGateTrial`)
- Test: `opencode-plugin/test/gate-trial-store.test.ts`

**Interfaces — Produces:**
```ts
// TrialState additions:
rewardMode?: "gate-outcomes"   // absent = legacy score-rate trial
trialId?: string               // unique salt id, e.g. `${trial}-${startedAt}`; REQUIRED when rewardMode set
golden?: boolean               // golden-baseline window (build-time decision — see Global Constraints)
awaitingGo?: boolean           // queued, not started; inert everywhere until human go

// startTrial gains an options tail (backward-compatible):
startTrial(storeRoot, trialVersion, system, tools, minSessions, playbook?, agentConfig?, envPolicy?,
  opts?: { rewardMode?: "gate-outcomes"; golden?: boolean; awaitingGo?: boolean })

// The enactment authority (verdict math lives in km-crank Task 6; this ENACTS):
export type GateTrialVerdict =
  | { verdict: "keep" }
  | { verdict: "rollback"; reason: string }          // incl. "insufficient-events" T_MAX case
  | { verdict: "deferred"; reason: string }           // floors met, metric null — no enactment
  | { verdict: "abandoned"; reason: string }
export function resolveGateTrial(storeRoot: string, v: GateTrialVerdict):
  { action: "kept" | "rolled-back" | "deferred" | "abandoned" | "none" }
```
`resolveGateTrial` behavior: reads trial; `action:"none"` if no gate-outcomes trial; keep → `clearTrial` + ledger `action:"keep"`; rollback → `writeActive(baseline snapshot fields)` + `clearTrial` + ledger `action:"rollback"` (or `"insufficient-events"` when reason says so); deferred → NO state change, ledger `action:"deferred"`; abandoned → clearTrial + revert?? — NO: abandon mirrors today's abandon precedent (`:1316-1320`): clearTrial WITHOUT writeActive (active version already changed / superseded), ledger `action:"abandoned"`. Internal abandon check: `activeVersion(storeRoot) !== trial.trial` → abandoned before any enactment.

**Behavior contracts:**
1. Stand-down: `resolveTrial` on a store with `rewardMode:"gate-outcomes"` returns `{action:"none"}` with ZERO score reads (spy/instrument `readScore` via a score-file-absent fixture that would throw or via call ordering — make the test genuinely fail if the guard moves below the score read).
2. Legacy trials: `resolveTrial` behavior byte-identical (existing 4 trial test files green untouched).
3. `resolveGateTrial` keep/rollback/deferred/abandoned each: correct store end-state + correct ledger action value on `meta-metrics.jsonl` (read the file, assert the row).
4. rollback restores ALL snapshot fields (system, tools, playbook, agentConfig, envPolicy) — the revert-restores-snapshot test (§11 item 10).
5. abandoned-on-active-changed fires inside `resolveGateTrial` before enactment.
6. `awaitingGo` trial: `resolveGateTrial` → `none`; `readTrial` still non-null (clobber net intact).

- [ ] Steps: TDD → suites green → commit `feat(kkamak): rewardMode gate-outcomes — resolveTrial stand-down guard + resolveGateTrial enactment authority (§11 item 3)`.

---

### Task 5: Calibration registry + computed staleness

**Files:**
- Create: `km-crank/src/calibration.ts`, committed `km-crank/calibration.json`
- Test: `km-crank/test/calibration.test.ts`

**Registry content (initial, from the registered numbers — spec §4 rule 1):**
```json
{
  "rate": 0.105,
  "numerator": 2,
  "denominator": 19,
  "wilson95CI": [0.03, 0.31],
  "coveredMechanismRev": "<git log -1 --format=%H -- <MECHANISM_PATHS> at build time>",
  "date": "2026-07-29",
  "note": "cross-host pooled C2+C1+G1, not independently certified (HISTORY.md FA1 CLOSED BY MATH)"
}
```
**Interfaces — Produces:**
```ts
export const MECHANISM_PATHS: string[]  // probe + completion-gate mechanism paths:
  // minimal/complete-gate.ts, minimal/mutate.ts, minimal/cover.ts, minimal/probes* (verify actual probe file names),
  // cc-gate-plugin/src/core/, cc-gate-plugin/vendor/ — implementer verifies the vendor copies are included
  // (the SHIPPED gate runs from vendor/) and records the final list in a comment.
export interface Calibration { rate: number; numerator: number; denominator: number;
  wilson95CI: [number, number]; coveredMechanismRev: string; date: string; note?: string }
export function readCalibration(repoRoot: string): Calibration | null
export function calibrationStale(repoRoot: string, cal: Calibration,
  gitLastRev?: (paths: string[]) => string): boolean
  // stale := pathScopedLastCommit(MECHANISM_PATHS) !== cal.coveredMechanismRev — NEVER repo HEAD
```
**Behavior contracts:** (1) fresh when path-scoped rev matches; (2) stale when a mechanism path changed (inject fake gitLastRev); (3) docs-only commits do NOT stale it (the gitLastRev is path-scoped by construction — test with injected fn); (4) missing/corrupt registry file → treated as stale (verdicts refused); (5) the committed json matches the registered numbers exactly.

- [ ] Steps: TDD → km-crank suite green → commit `feat(km-crank): calibration registry + path-scoped computed staleness (§11 item 5)`.

---

### Task 6: `trial-verdict.ts` + crank wiring + SitrepAction kinds

**Files:**
- Create: `km-crank/src/trial-verdict.ts`
- Modify: `km-crank/src/crank.ts` (before `:158-171`), `km-crank/src/sitrep.ts:25-33` union + `:74-117` render
- Test: `km-crank/test/trial-verdict.test.ts` (the big one)

**`trial-verdict.ts` owns (spec §6):** the `(sessionID, trialId)` join, §2 exclusions, §5 floors + 3-clause rule, futility projection, calibration-staleness refusal. Per-arm scoring via `scoreLines(subset, {pool:true, minN:20})` from `cc-gate-plugin/src/score.ts:93` (km-crank already crosses packages — mirror its existing import style; if cc-gate-plugin exports need a vendor-safe path, note it).

**Interfaces — Produces:**
```ts
export interface TrialEvaluationInput {
  trial: TrialState               // rewardMode gate-outcomes, not awaitingGo
  sensorLines: SensorLineIn[]     // full stream(s), union of repos/hosts
  exposureRows: ExposureRow[]
  now: number
  calibration: Calibration | null
  calibrationIsStale: boolean
}
export interface TrialEvaluation {
  verdict: GateTrialVerdict | { verdict: "pending"; projection: string }
  perArm: { baseline: ArmReport; trial: ArmReport }   // cycleCount, sessionCount, sessionsWithGateCycle, scores
  exposureGuard: { densityBaseline: number; densityTrial: number; voided: boolean }
  reinjectBalance: { baseline: {v0:number; v1:number}; trial: {v0:number; v1:number} }
}
export function evaluateGateTrial(i: TrialEvaluationInput): TrialEvaluation
```
**Join + exclusion rules (§2, each = named test):**
- inner join sensor.sessionID → exposure row; NO exposure row → excluded.
- exposure row `forced:true` → excluded.
- gauge-only lines (`rounds: []`) → excluded from metrics, COUNTED for the exposure-density guard.
- kkamak-dev check group → excluded (reuse the scorecard's dev-check identification — find how score.ts/score-cli marks it; if it is a check-string convention, encode the same constant, single-sourced).
- time bound: sensor `ts` outside `[trial.startedAt, now]` → excluded.
- session enrolled under a DIFFERENT trialId (row.trialId ≠ trial.trialId) → that session's lines VOID for this trial (the §2 boundary class).

**Decision (§5, truth-table test — §11 item 10):**
- floors: both arms gateCycles ≥ 20 AND sessionsWithGateCycle ≥ 5 per arm AND pooled block-class (catch+exhausted+interrupted) ≥ 5.
- floors unmet + now-startedAt < 28d → `pending` with futility projection (days-to-floors at current rate; rate 0 → "∞").
- floors unmet + ≥28d → rollback `"insufficient-events"`.
- floors met + any metric null → `deferred` (never coerce null to 0).
- floors met: KEEP iff `mExhaust(T) ≤ mExhaust(B) && mInterrupt(T) ≤ mInterrupt(B) && mCatch(T) ≥ mCatch(B)`, else rollback.
- calibrationIsStale → refuse (pending with reason "calibration-stale", enact nothing) — comes BEFORE floor evaluation.
- exposure-density gross divergence (>3x either way with both ≥5 sessions — pick and COMMENT the threshold; spec says "gross", plan pins 3x as the v0 constant) → verdict abandoned `"exposure-divergence"` (VOID for the trial per §9).
- **A/A machinery test (§11 item 10):** synthetic identical-arm stream meeting all floors → KEEP by tie (all three clauses hold with equality).

**Crank wiring (§5 acceptance criterion):** before target selection AND before `decideGate` — scan `readTrial` across ALL `REPOS`' project-global layers; if a live gate-outcomes trial exists (not awaitingGo): load that repo's sensor stream(s) + exposure rows (via existing `readNewSensorLines`-style FULL read — verdict wants the whole window, not the offset tail; write a full-file reader or reuse `parseSensorLines` on full content), call `evaluateGateTrial`, enact via `resolveGateTrial`, emit the new SitrepAction, and only fall through to `decideGate` when nothing enacted. New `SitrepAction` kinds:
```ts
| { kind: "trial-keep"; scope: string; trial: string }
| { kind: "trial-rollback"; scope: string; trial: string; reason: string }
| { kind: "trial-deferred"; scope: string; reason: string }
| { kind: "trial-pending"; scope: string; projection: string }
| { kind: "trial-abandoned"; scope: string; reason: string }
```
each with a render case (SITREP shows per-arm N_eff triplet + per-host coverage note).

**Behavior contracts:** every exclusion rule, every truth-table row, A/A, futility projection string, non-winning-repo trial still evaluated (two-repo fixture), calibration-stale refusal, enactment called exactly once per verdict, `pending` enacts nothing.

- [ ] Steps: TDD (this is the largest test file — write the truth table as table-driven cases) → km-crank suite green → commit `feat(km-crank): trial-verdict engine + crank wiring before decideGate + trial SitrepActions (§11 items 4,10)`.

---

### Task 7: Scorecard surfacing — per-arm session counts + exposure guard

**Files:**
- Modify: `cc-gate-plugin/src/score-cli.ts` (render block `:72-88` region)
- Test: extend the score-cli test file (find existing)

**Contracts:** (1) when `.km/trial-arms.ndjson` exists beside the target sensor file, the CLI prints a `§4.3 trial` block: per-arm cycle count / session count / sessions-with-≥1-gate-cycle (the §3 N_eff triplet) + exposure-density per arm + forced-row count (excluded); (2) no exposure file → block absent, output byte-identical to today (regression); (3) READ-ONLY stays true.

- [ ] Steps: TDD → suite green → commit `feat(kkamak): scorecard surfaces per-arm N_eff + exposure guard (§11 item 7)`.

---

### Task 8: Snapshot script + `km-panic.sh trial-off`

**Files:**
- Create: `scripts/km-sensors-sync.sh`; Modify: `scripts/km-panic.sh` (usage `:23-37`, case `:39-113`)
- Test: shell-level — a bats-style or plain bash test script is overkill here; verify by running against a tmp fixture in the task (document the run + output in the report). The panic verb DOES get a bun test if km-panic logic is testable via a dry-run flag; otherwise fixture-run evidence.

**`km-sensors-sync.sh` (§7):** verbs `export | import | diff [--dry-run]`, mirroring `term-bench2/store-sync.sh:33-79` discipline. Source: `<repo>/.km/{gate-outcomes,trial-arms}.ndjson` for each of the three REPOS; destination `evidence/kkamak-sensors/<host>/<basename-of-repo>.{gate-outcomes,trial-arms}.ndjson` in THIS repo (git-tracked). Export = APPEND-ONLY union with dedupe by full-line identity (ndjson lines are immutable appends — a diff-first check REFUSES export if the committed snapshot contains lines absent from the local file (that would mean local truncation/rot; never silently shrink history). Import is not a store overwrite — it only reports (the runtime files stay host-local; import verb = print what the union would add, for verification). `--dry-run` on export prints the would-add count per file.

**`km-panic.sh trial-off` (§11 item 9):** for the cwd's project-global store root: if a gate-outcomes `.trial` exists → enact rollback via a small bun one-liner calling `resolveGateTrial(root, {verdict:"rollback", reason:"km-panic trial-off"})` (manual command supersedes — §6 authority); legacy `.trial` → print instructions (legacy trials belong to resolveTrial, do not touch). No trial → no-op message. Update usage text + header verb list.

- [ ] Steps: implement → fixture-run both scripts, capture output → suites still green (panic changes no TS) → commit `feat(kkamak): km-sensors-sync snapshot script + km-panic trial-off verb (§11 items 8-9)`.

---

## Self-Review Notes (author-run)

- §11 coverage: item 1 → T2+T3; item 2 → T2+T3; item 3 → T4; item 4 → T6; item 5 → T5; item 6 → T1; item 7 → T7; item 8 → T8; item 9 → T8; item 10 → named tests inside T2 (salt-decorrelation), T3 (exposure cases), T4 (stand-down, revert-restores-snapshot), T6 (exclusion matrix, truth table, A/A).
- The spec's golden-window build-time decision is resolved (layered on `.trial`) with rationale recorded.
- Deliberately NOT built (spec §10 non-goals): auto trial-start, SPRT, cross-host auto-sync, concurrent trials, opencode-session arms.
- Order matters: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 (T5 can swap with T3/T4; T6 needs T2, T4, T5).
- After all tasks: whole-branch final review (requesting-code-review), then HISTORY.md/resume.md updates happen OUTSIDE this plan (verdict-style docs stay with the coordinator).
