# Hook-Rule P2 — Telemetry Contract Rev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sensor line gains OPTIONAL `hookRules` outcomes `{id, matched, mode, ms}` (spec §5) — the 0.4.6 `ruleChecks` contract-rev playbook rerun exactly: golden vectors updated in BOTH repos (meta-harness km-crank embedded + kkamak canonical fixture) in one window, hard-fail guard on half-updated fixtures, cc-gate-plugin version bump 0.4.6→0.4.7, boundary ts stamped in the adoption ledger. Zero model spend.

**Architecture (one new mechanism, everything else is precedent):** hook-rule matches happen per-PreToolUse in opencode-plugin's dispatch processes, but the sensor line is emitted by cc-gate-plugin's Stop path — so a session-scoped accumulator file bridges them: dispatch appends matched outcomes to `.km/hook-rule-outcomes-<sessionID>.ndjson`; the Stop path reads it, attaches `hookRules` to the sensor line, and unlinks the file (crash-safe: a leftover file is picked up by that session's next Stop; other sessions never touch it). F2 holds end-to-end: the accumulator and the sensor field carry id/matched/mode/ms only — never input text.

**Tech Stack:** TypeScript (bun), bun:test, three git repos touched (meta-harness, ~/z2/kkamak) — kkamak commit lands in the SAME window (0.4.6 precedent, kkamak `5efa3ab`).

## Global Constraints

- Zero model spend. Workers never commit — orchestrator commits at barriers (meta-harness) and makes the kkamak commit itself.
- **Required sensor fields are UNTOUCHED** — `hookRules` is an additive optional field like `ruleChecks` (types.ts:301 precedent). `REQUIRED_FIELDS` in both conformance tests stays byte-identical.
- Lines with `pluginVersion >= 0.4.7` may carry `hookRules`; earlier lines never do. Boundary ts = the ledger entry's stamp, recorded at K2.
- F2: `.km/hook-rule-outcomes-*.ndjson` and `.km/hook-rules.json` must NEVER enter km-sensors-sync's FILES list (repos-parity lock extended).
- Suites serial at barriers: `cd cc-gate-plugin && bun test`, `cd km-crank && bun test`, `cd opencode-plugin && bun test`.

## Frozen cross-lane contracts

**1. Sensor field (cc-gate-plugin types.ts, beside ruleChecks):**

```ts
/** hook-rule evolution P2: per-session PreToolUse hook-rule outcomes,
 * aggregated from the dispatch-side accumulator at Stop. Additive optional
 * — absent when no rule matched this session (or table absent). */
hookRules?: { id: string; matched: boolean; mode: string; ms: number }[]
```

**2. Accumulator file:** `<projectRoot>/.km/hook-rule-outcomes-<sessionID>.ndjson`; one line per PreToolUse event that had ≥1 match: `{"ts":<ms>,"outcomes":[{"id":"b12","matched":true,"mode":"shadow","ms":0.05}]}`. Writer: opencode-plugin dispatch.ts (append, best-effort try/catch — a write failure never affects the tool call). Reader: cc-gate-plugin Stop path (read → flatten outcomes arrays in line order → cap at 200 entries (truncation drops the tail, logged to stderr) → attach if non-empty → unlink; every step fail-open).

**3. Golden vector (6th, IDENTICAL BYTES in both repos' fixtures):**

```
{"ts":1786780000000,"sessionID":"gv-hookrules-1","check":"bun test","accepted":true,"gateExhausted":false,"interrupted":false,"marker":"none","durationMs":1200,"host":"test","app":"cc","rounds":1,"pluginVersion":"0.4.7","hookRules":[{"id":"b12","matched":true,"mode":"shadow","ms":0.05},{"id":"b3","matched":true,"mode":"warn","ms":0.2}]}
```

(Exact required-field values mirror the existing CLEAN_ACCEPT vector's conventions; the line above is normative for the `hookRules` portion — the vector author copies required-field values from the repo's existing 5th vector to stay style-consistent, keeping `hookRules` exactly as written here.)

## Runner assignment

- **Orchestrator (me):** cc-gate-plugin consumer side (T1–T2), kkamak canonical fixture commit (T5), ledger boundary entry (T5), all meta-harness commits.
- **Peer `minimal`:** opencode-plugin producer side (T3) + km-crank vector/guard/parity lock (T4). Disjoint file sets (peer: `opencode-plugin/src/adapters/claude-code/dispatch.ts`, `opencode-plugin/test/cc-dispatch.test.ts`, `km-crank/test/sensor-contract.test.ts`, `km-crank/test/repos-parity.test.ts`; orchestrator: `cc-gate-plugin/*`).
- T1/T3/T4 all start immediately off the frozen contracts. T2 needs T1. K1 needs all; K2 (ledger + kkamak) last.

---

### Task 1: cc-gate-plugin — SensorLine field + Stop-path aggregation

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (~301, beside ruleChecks)
- Create: `cc-gate-plugin/src/hook-rule-outcomes.ts`
- Modify: `cc-gate-plugin/src/hook-cli.ts` (~370-371, beside the evaluateRuleChecks attach)
- Test: `cc-gate-plugin/test/hook-rule-outcomes.test.ts` (create)

**Interfaces:**
- Produces: `readAndConsumeHookRuleOutcomes(cwd: string, sessionID: string): {id: string; matched: boolean; mode: string; ms: number}[] | null` — frozen contract 2 semantics (read/flatten/cap-200/unlink, every step try/catch → null). hook-cli Stop path: `const hookRules = readAndConsumeHookRuleOutcomes(cwd, sessionID); if (hookRules) line = { ...line, hookRules }` — mirroring the ruleChecks attach at hook-cli.ts:370-371 exactly.

- [ ] Step 1: failing tests — accumulator file with 2 lines × outcomes → flattened array in order + file unlinked; absent file → null, no throw; malformed line skipped, valid lines survive; 201+ outcomes → 200 + stderr truncation note; other session's file untouched.
- [ ] Step 2: run — fail. Step 3: implement (~40 lines). Step 4: run — pass.

### Task 2: cc-gate-plugin — conformance test + version bump

**Files:**
- Modify: `cc-gate-plugin/test/sensor-contract.test.ts` (shape check for optional hookRules, REQUIRED_FIELDS untouched; SHADOW test: no accumulator file → emitted line has NO hookRules key — byte-identity precedent at :250)
- Modify: `cc-gate-plugin/package.json` (0.4.6 → 0.4.7)

- [ ] Step 1: failing tests — `assertConformsToSensorContract` accepts a line with well-formed hookRules, rejects malformed entries (missing ms, non-boolean matched); absent-accumulator Stop emits no key.
- [ ] Step 2–4: TDD cycle; then FULL `bun test` in cc-gate-plugin.

### Task 3 (peer): opencode-plugin — dispatch accumulator writer

**Files:**
- Modify: `opencode-plugin/src/adapters/claude-code/dispatch.ts` (PreToolUse case — beside the existing `host.log("info", "hookRules ...")` line)
- Test: extend `opencode-plugin/test/cc-dispatch.test.ts`

**Interfaces:** appends frozen-contract-2 lines to `.km/hook-rule-outcomes-<session_id>.ndjson` under `input.cwd ?? host.projectRoot` when `ruleDecision.outcomes.length > 0`; best-effort try/catch; the host.log line stays (local debuggability).

- [ ] Step 1: failing tests — matched shadow rule → accumulator file exists with one line, parsed outcomes match the eval result; no match → no file; two calls same session → two lines appended; write path failure (`.km` replaced by a file) → tool call output unchanged (fail-open).
- [ ] Step 2–4: TDD cycle; then FULL cc-dispatch suite.

### Task 4 (peer): km-crank — 6th golden vector + hard-fail guard + parity lock

**Files:**
- Modify: `km-crank/test/sensor-contract.test.ts` (add CLEAN_ACCEPT_WITH_HOOK_RULES 6th vector — frozen contract 3 bytes; extend `assertFixtureHasRuleChecksVector` pattern with `assertFixtureHasHookRulesVector` hard-fail (:156-162 precedent); parseSensorLines accepts all 6)
- Modify: `km-crank/test/repos-parity.test.ts` (:72-78 precedent — lock `hook-rules.json` AND `hook-rule-outcomes` out of km-sensors-sync's FILES list)

- [ ] Step 1: failing tests first, then implement, then FULL `bun test` in km-crank. NOTE: the advisory parity byte-compare (:186-210) will WARN until the orchestrator lands the kkamak fixture (T5) — expected mid-window state, report it, don't chase it.

### Task 5 (orchestrator): kkamak canonical fixture + ledger boundary + barriers

- [ ] K1 (after T1–T4): all three meta-harness suites green → two commits: cc-gate-plugin consumer (`feat(sensor): hookRules optional field + Stop-path accumulator aggregation, 0.4.7`) and producer+vectors (`feat(hook-rules): dispatch accumulator writer + 6th golden vector + parity locks`).
- [ ] T5a: append the SAME 6th vector line (frozen contract 3, byte-identical) to `~/z2/kkamak/test/fixtures/sensor-contract.ndjson`; run kkamak's own suite if present; commit kkamak: `test(contract): hookRules rev — 6th golden vector (CLEAN_ACCEPT_WITH_HOOK_RULES), byte-equal to meta-harness km-crank counterpart` (5efa3ab wording precedent). Same window as K1 — do not end the session between K1 and T5a.
- [ ] T5b: re-run km-crank advisory parity test → now byte-green.
- [ ] K2: stamp boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` (ruleChecks entry :711-731 as template): new entry — hookRules field live at pluginVersion 0.4.7, boundary ts = Date.now() at stamp time, pre/post comparability note (lines before the ts never carry the field). Commit: `docs(ledger): hookRules sensor boundary — 0.4.7 contract rev stamped`.

## Self-review notes

- Spec §5 P2 coverage: sensor field (T1+T3), golden vector both repos (T4+T5a), conformance (T2+T4), boundary ts (K2). Ramp/kill-switch/FP-sidecar correctly absent (P3+/user ruling).
- The one new mechanism (accumulator) is stated in Architecture with crash-safety + F2 reasoning; everything else cites the 0.4.6 precedent file:line.
- Contract 3's vector is normative only for the hookRules portion — avoids brittle cross-repo required-field drift while keeping the hookRules bytes identical (the parity test compares whole lines, hence "copy required-field conventions from the repo's own 5th vector, hookRules bytes exactly as frozen" — if the two repos' 5th vectors are already byte-identical (they are, 5efa3ab), the 6th will be too).
- Disjoint file sets hold; the only shared FILE across lanes is none; the shared CONTRACT is frozen above.
