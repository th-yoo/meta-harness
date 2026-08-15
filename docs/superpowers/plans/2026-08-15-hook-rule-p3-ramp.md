# Hook-Rule P3 — Ramp Machinery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec §4 machinery, zero spend: the `hookRuleTransition` store writer (mode-only mutation + transition ledger + table re-export, lock-aware skip-and-retry), the ramp scan at session close (shadow→warn promotion on N=20/K=5/θ=0.25 evidence from the sensor stream; automatic deny→shadow demotion on FP breach), the system-generated warn→deny transition-candidate constructor (provenance-marked, review-gate-skipping by construction — ab arms themselves are P4), and the global kill-switch. No arm runs; nothing leaves shadow without evidence that cannot exist yet (fleet has zero hookRule bullets).

**Architecture:** Transition writer lives in harness-store (mode is store-owned state); it never touches `applyPlaybookOps` or the proposal pipeline — nothing proposer-authored changes. Evidence comes from `.km/gate-outcomes.ndjson` sensor lines (P2's `hookRules` outcomes + `accepted`), aggregated per rule: FP-proxy = matched-sessions-that-passed / matched-sessions (a match in a passing session is false-positive evidence; promotion wants this LOW). Scan triggers in `engine.sessionIdle` after `recordSession` — evidence only changes when a session lands. Contention: skip when the proposer lock (`proposer.ts:42-87` lock-per-root) is in flight; transitions are idempotent evidence re-checks, never queued.

## Global Constraints

- Zero model spend; workers never commit; orchestrator commits at K1 (single barrier — smaller phase than P1/P2).
- Spec §4 values: N=20 matched observations, K=5 distinct sessions, θ=0.25 FP-proxy, all plan-tunable via MhConfig with these defaults, thresholds recorded per transition.
- warn→deny is NEVER automatic — the constructor builds the candidate; running its ab arm is P4 (explicit go + spend).
- Deny-cap check before constructing a warn→deny candidate (spec §4: an arm the table would truncate is never built).
- F2: transition ledger carries counts/rates/session ids only.
- Standing P4 blockers restated (NOT solved here): bench sed-extraction gate item (spec §8) and the §5 FP-adjudication sidecar user ruling.

## Frozen cross-lane contracts

**1. MhConfig additions (harness-store.ts, orchestrator-owned file):**

```ts
/** hook-rule ramp thresholds (spec §4; defaults N=20/K=5/θ=0.25) */
hookRuleRampN?: number
hookRuleRampK?: number
hookRuleRampTheta?: number
/** global kill-switch: deny evaluated as warn on both surfaces while true */
hookRulesKillSwitch?: boolean
```

**2. Transition writer (harness-store.ts, orchestrator):**

```ts
export interface HookRuleTransitionEvidence {
  matchedSessions: number; matchedObs: number; fpRate: number; sessionIDs: string[]
}
export function hookRuleTransition(
  storeRoot: string, bulletId: string,
  from: "shadow" | "warn" | "deny", to: "shadow" | "warn" | "deny",
  evidence: HookRuleTransitionEvidence,
): boolean  // false = bullet/mode precondition unmet (stale evidence) — never throws
```
Appends `{ts, bulletId, from, to, evidence, thresholds:{n,k,theta}}` to `<storeRoot>/hook-rule-transitions.jsonl`; rewrites active `playbook.json` atomically (mode field only). Caller re-exports the table.

**3. Kill-switch setter (peer lane, new file `opencode-plugin/src/hook-rules-kill.ts`):**

```ts
export function setHookRulesKillSwitch(repoRoot: string, storeRoot: string, on: boolean): void
```
Persists `hookRulesKillSwitch` into the store-root config (readMhConfig's file), then re-exports via `exportHookRules` so `.km/hook-rules.json` flips immediately ("instantly" = the next hook process reads the new table). `exportHookRules` reads the config flag for its `killSwitch` field (replacing the P1 hardcoded `false`).

**4. Transition-candidate constructor (peer lane, new file `opencode-plugin/src/hook-rule-transition-candidate.ts`):**

```ts
export function buildHookRuleTransitionCandidate(
  storeRoot: string, bulletId: string,
): { version: string } | { error: string }
```
Reads active playbook; requires the bullet's hookRule.mode === "warn"; refuses when the flip would exceed HOOK_RULES_DENY_MAX among exportable rules ("deny-cap"); copies the playbook with ONLY that mode flipped to "deny"; `createCandidate(storeRoot, vN, renderPlaybook(pb), activeTools, pb)` with the next free version; `writeCandidateMeta` gains a provenance field `{transition: {bulletId, from: "warn", to: "deny"}}` — this marker is what makes the candidate system-generated (it never passes through propose/review-gate; the ab gate treats it like any candidate). Version numbering: existing next-vN convention from the store.

**5. Ramp scan (orchestrator, new file `opencode-plugin/src/hook-rule-ramp.ts`):**

```ts
export interface RampTransition { bulletId: string; from: string; to: string; evidence: HookRuleTransitionEvidence }
export function rampScan(repoRoot: string, storeRoot: string): RampTransition[]  // applied transitions
```
Reads `.km/gate-outcomes.ndjson` (tolerant line-parse, last 5000 lines cap), aggregates lines carrying `hookRules` per rule id → {matchedObs, distinct sessionIDs, passed-session count}; for each ACTIVE bullet with a hookRule: shadow + obs≥N + sessions≥K + fpRate≤θ → transition to warn; deny + fpRate>θ (with sessions≥K) → transition to shadow (automatic demotion). Applies via `hookRuleTransition`, re-exports table once if any applied. Never throws.

## Runner assignment

- **Orchestrator:** T1 (MhConfig + transition writer + ledger, harness-store.ts), T2 (ramp scan module), T3 (engine.sessionIdle trigger + lock-skip), tests for each. Owns ALL harness-store.ts and engine.ts edits.
- **Peer `minimal`:** T4 (kill-switch: hook-rules-kill.ts + exportHookRules config read + tests), T5 (transition-candidate constructor + provenance meta + tests). Files: `src/hook-rules-kill.ts` (new), `src/hook-rules-export.ts`, `src/hook-rule-transition-candidate.ts` (new), matching test files. Peer treats contracts 1–2 as given (import from harness-store once orchestrator lands T1 — START with T4's export/config read using `readMhConfig` which already exists; T5 imports `HOOK_RULES_DENY_MAX` from hook-rules-export and store functions that already exist. The ONLY cross-lane import is `MhConfig`'s new optional fields, additive — safe to code against immediately).
- All tasks start immediately; K1 after both lanes.

---

### T1 (orchestrator): MhConfig fields + `hookRuleTransition`
- Test: `opencode-plugin/test/hook-rule-transition.test.ts` — happy path (shadow→warn: playbook mode updated atomically, ledger line appended with evidence+thresholds, returns true); precondition miss (bullet absent / mode≠from → false, no writes); pruned bullet → false; ledger accumulates across transitions; F2 (ledger line has ids/counts/rates, no pattern text — pattern stays in the playbook, which is fine, but the LEDGER line itself carries only bulletId).
- TDD cycle, then `bun test test/harness-store-hook-rules.test.ts` regression.

### T2 (orchestrator): `rampScan`
- Test: `opencode-plugin/test/hook-rule-ramp.test.ts` — synth sensor stream fixtures: promotion fires exactly at N=20/K=5/fp≤0.25 (19 obs → no; 20 obs 4 sessions → no; 20/5/fp 0.2 → yes); fp counts SESSIONS not obs; deny demotes on fp breach; warn rules untouched (no auto warn→deny); missing/garbage stream → no transitions, no throw; thresholds read from MhConfig overrides; table re-export happens when a transition applied.
- TDD cycle.

### T3 (orchestrator): sessionIdle trigger
- Modify `engine.ts` sessionIdle: after recordSession succeeds, for each participating layer root: if `proposerInFlight(worktree, root)` → skip (log line `ramp: skipped (proposer in flight)`); else `rampScan(worktree, root)`; log applied transitions. Wrap whole thing try/catch (a ramp failure must never break scoring).
- Test: extend an existing engine/sessionIdle test file with: transition applies at idle when evidence present; skipped under a live proposer lock (write a fresh lock file via the proposer.ts helpers).

### T4 (peer): kill-switch
- `setHookRulesKillSwitch` per contract 3; `exportHookRules` reads `readMhConfig(...).hookRulesKillSwitch === true` for the table field (default false — P1 behavior preserved).
- Tests: toggle on → table killSwitch true (immediate); off → false; config persisted; export without config → false (regression: existing hook-rules-export tests stay green).

### T5 (peer): transition-candidate constructor
- Per contract 4. Tests: builds candidate with only the target mode flipped (byte-diff of playbooks = one field); meta.json carries the transition provenance; refuses non-warn bullet; refuses when deny cap would be exceeded (4 deny rules already exportable); version numbering follows the store convention; constructed candidate does NOT appear in rejected ledger / never touches review-gate code paths (assert no import).

### K1 (orchestrator): full opencode-plugin suite + tsc → commits: (1) orchestrator lane `feat(hook-rules): ramp machinery — transition writer + evidence scan at session close (P3)`; (2) peer lane `feat(hook-rules): kill-switch + warn→deny transition-candidate constructor (P3)`. Close-out: spec §4 back-annotation only if anything deviated; restate P4 blockers in the report.

## Self-review notes
- Spec §4 coverage: transition writer (T1), trigger+lock (T3), shadow→warn + deny→shadow evidence rules (T2), warn→deny measured-treatment constructor + deny-cap pre-check (T5), kill-switch both-surface via table field (T4 — evaluators already honor it from P1/P2). Boundary: FIRST actual enforcement activation (any rule leaving shadow live) is an actuator-class boundary ts — that stamp belongs to the moment it happens (P4/live), not to this build; noted, not stamped.
- File disjointness: orchestrator = harness-store.ts, engine.ts, hook-rule-ramp.ts + 2-3 test files; peer = hook-rules-kill.ts, hook-rules-export.ts, hook-rule-transition-candidate.ts + test files. No overlap; contracts frozen above.
- FP-proxy direction stated explicitly (LOW fp = promote) to prevent the inversion bug class.
