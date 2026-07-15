# Loop-3 — Timeout Blind-Spot Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bench wall-timeout a first-class, proposer-visible, *diagnosed* signal — without also recording auth-failure / transient-outage noise — and give the agent a symmetric time budget it can react to, while keeping the loop's progress ledger honest across a budget change. This translates the settled design [`docs/loop-3-timeout-design.md`](../../loop-3-timeout-design.md) (§4 record-timeouts, §5 budget-inject, §6 re-baseline) into TDD tasks T1→T7 (design §8).

**Architecture:** A wall-timeout today produces an *identical* `{ turnCount: 0, … }` `AgentRunOutput` for three distinct outcomes (timeout / auth-fail / transient-exhaustion), and the `record.ts` skip-guard drops all three before they reach the store, so the proposer never sees a timeout (design §1, §2). The fix plumbs a **`timedOut` discriminator** from `runAgent` (`agent-run.ts`) → `RunTaskResult` (`cmd-run.ts`) → `SessionRecord` (`harness-store.ts`) so the guard can record the timeout while still dropping auth/transient; then surfaces the record in the proposer prompt (`propose.ts` / `buildProposerContext`), injects a symmetric budget line into the bench `instruction.md`, and stamps the budget into `ab-verdict.json` / results for a re-baseline gate. `SessionRecord` gains only *additive-optional* fields (`timedOut?`, `elapsed?`), no `schemaVersion` bump, mirroring the existing `platform?`/`judge?` precedent.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`. All tests hermetic: temp store dirs under `tmpdir()`, `META_HARNESS_HOME` set per-test, injected `ExecResult`/`execFn` fakes — no real podman, opencode, or network.

## PATH / LINE CORRECTIONS (design line-refs verified against commit `f519bc5`)

The design cites two files under the wrong directory. **Use these corrected paths throughout this plan:**

| Design cites | ACTUAL location (verified) |
|---|---|
| `opencode-plugin/src/drivers/types.ts` | **`opencode-plugin/src/bench/drivers/types.ts`** |
| `opencode-plugin/src/bench/harness-store.ts` | **`opencode-plugin/src/harness-store.ts`** (repo `src` root, NOT under `bench/`) |

All other cited paths are correct: `bench/agent-run.ts`, `bench/record.ts`, `bench/cmd-run.ts`, `bench/cmd-ab.ts`, `bench/results.ts`, `bench/report-loop.ts`, `propose.ts`, `engine.ts`.

Minor **+1 line drift** in `cmd-ab.ts` (all cited refs land one line later than the design says): record-mirror guard is `:331` (design `:330`); `agentTimeout` `:311` (`:310`); arm re-run `:317-319` (`:316-318`); reward push `:326-327` (`:325-326`). The verdictDict is `:273-300` and the newly-added top-level `driver` field is at `:280` (as the design notes). Non-material; corrected inline per task.

All other cited line numbers verified accurate: `agent-run.ts:183/:206/:155`; `drivers/types.ts:15-19`; `cmd-run.ts:53/:229/:249/:258/:403-419`; `record.ts:236/:249/:281/:299/:305`; `harness-store.ts:112/:129/:133/:634/:640/:641/:1300/:1333/:421/:204-218`; `propose.ts:65/:141/:617-620/:683/:697/:712/:727/:782`; `results.ts:26/:138`; `report-loop.ts:63/:121-129`; `engine.ts:713-727`.

## Global Constraints

- **[Discriminator invariant — DO NOT delete the skip-guard.]** `runAgent` returns a byte-identical `{ turnCount: 0, toolUsage: {}, events: [] }` for **all three** 0-turn outcomes: wall-timeout (`agent-run.ts:183`), unrecoverable auth-fail (`:206`), and transient-exhaustion (`:221`, the fall-through). The `record.ts:299` guard `if (turnCount === 0)` drops all three **on purpose** — auth/transient are "not a verdict on the harness." The fix MUST plumb a `timedOut` discriminator and change the guard to `turnCount === 0 && !timedOut`; you may **never** simply delete the guard (that would re-introduce auth/transient noise into `score.json`). Every task preserves this invariant; T1's unit test asserts auth/normal outputs leave `timedOut` unset.

- **[Additive-optional schema, no version bump.]** `SessionRecord` (`harness-store.ts:112`) gains only `timedOut?: boolean` and `elapsed?: number`, both optional, mirroring the established `platform?` (`:129`) and `judge?` (`:133`) precedent — each documented "Optional so pre-… records keep parsing." `CandidateScore` has no `schemaVersion`; do **not** add one. Back-compat rule for every reader: **absent `timedOut` ⇒ `false`, absent `elapsed` ⇒ unknown.** T3 includes a dedicated back-compat test (a pre-Loop-3 `score.json` with neither field still parses and renders), modeled on `test/session-record-platform.test.ts`.

- **[Budget-inject placement = `instruction.md`, a CONTROLLED CONSTANT.]** The advisory budget line (T5) is injected in `runAgent` into the bench task `instruction.md` (`agent-run.ts:155`), **NOT** into the evolvable composed `AGENTS.md` harness. It is derived from the already-computed `agentTimeout` param, which both `ab` arms receive identically from `taskTimeouts` (`cmd-ab.ts:311`). The injected line must be **byte-identical on both `ab` arms** (arm A active harnessA, arm B candidate harnessB) — a controlled constant, never an A/B lever. T5 asserts arm-symmetry explicitly. (A candidate that *additionally* evolves a budget-management rule in its own `system.md` is a legitimate, separately-tested arm-B-only lever — that is the proposer reaction T4 unblocks, and is out of scope for the injected line itself.)

- **[Timeout-recording rollout is FLAG-GATED, default-OFF.]** Counting timeouts as stored fails (the `record.ts:299` guard change) lands behind a new config flag **`recordTimeouts`** on `MhConfig` (`harness-store.ts:235`), default **`false` (OFF)**, read by `readMhConfig` (`harness-store.ts:259`) from `<accountMetaRoot()>/config.json` via `raw.recordTimeouts ?? false` — the same default-OFF idiom as the judge (`judgeModel ?? ""`) and the other `MhConfig` fields. Introduced in **T3**. When OFF, behavior is byte-identical to today (timeouts skipped). Flipping the flag ON + running the first manual re-baseline (T7) is one deliberate operator cutover. Hermetic tests pass the boolean directly into `recordToStores`; a separate small test covers `readMhConfig`'s default + override.

- **[Re-baseline trigger = MANUAL operator step, NOT automatic.]** T7 provides the re-score/reset *mechanism* and documents the operator runbook step; it does **not** auto-fire on a detected budget change. The loop stays human-triggered. (Automatic auto-tuning of the wall is explicitly DEFERRED, design §9.)

- **[ab internal decision is already self-fair — re-baseline protects only the longitudinal ledger.]** Within one `ab` invocation, arm A (active) is re-run fresh alongside arm B (candidate) at the *same* `agentTimeout` (`cmd-ab.ts:311, 317-319`), so accept/reject is apples-to-apples by construction (design §6.1). Re-baseline (T6/T7) guards the cross-generation **progress ledger and activation provenance** (design §6.2), not the internal math. Do not touch the internal `abDecision`.

- **Tests run with:** `bun test test/<file>.test.ts` from `opencode-plugin/`. Never spawn real processes — inject `ExecResult` (`{ rc, stdout, stderr, timedOut }`) into `execFn`, as `test/bench-agent-run.test.ts` already does (`{ rc: 124, stdout: "", stderr: "", timedOut: true }` for a wall-timeout).

---

### Task 1: plumb the `timedOut` discriminator through `runAgent`

**Files:**
- Modify: `opencode-plugin/src/bench/drivers/types.ts` (the `AgentRunOutput` interface, `:15-19`)
- Modify: `opencode-plugin/src/bench/agent-run.ts` (the timeout branch `:181-184`; leave auth `:206` and the normal `parseOutput` return `:219-221` UNCHANGED)
- Test: `opencode-plugin/test/bench-agent-run.test.ts` (append inside the existing describe)

**Interfaces:**
- `AgentRunOutput` gains two optional fields (so every driver's `parseOutput` — `drivers/types.ts:39` — keeps compiling and no on-disk shape changes):
  ```ts
  export interface AgentRunOutput {
    turnCount: number
    toolUsage: ToolUsage
    events: TrajEvent[]
    /** True ONLY on the wall-timeout branch (agent-run.ts:183). Absent ⇒ not a timeout.
     *  Distinguishes a timeout 0-turn from auth-fail/transient 0-turns, which stay unset. */
    timedOut?: boolean
    /** Agent-phase wall-clock seconds (agent-run.ts:179 elapsedSec). Optional; agent-phase only. */
    agentElapsedSec?: number
  }
  ```
- `runAgent(...)` return type is unchanged (`Promise<AgentRunOutput>`); only the timeout-branch object literal changes.

- [ ] **Step 1: Write the failing test.** Append to `test/bench-agent-run.test.ts` (import `ExecResult` already present):
  - `"runAgent sets timedOut:true on a wall-timeout"` — inject `execFn` returning `{ rc: 124, stdout: "", stderr: "", timedOut: true }`; assert the returned output has `timedOut === true`, `turnCount === 0`, and (if asserting) `agentElapsedSec` a finite number ≥ 0.
  - `"runAgent leaves timedOut unset on auth-fail and on a normal parse"` — inject an auth-error `ExecResult` (stdout matching `AUTH_ERROR_RE`, e.g. `authentication_failed`, `timedOut: false`); assert output `timedOut === undefined` and `turnCount === 0`. Then a normal multi-turn stdout (`timedOut: false`); assert output `timedOut === undefined` and `turnCount > 0`. This is the discriminator-invariant guard.
- [ ] **Step 2: Run test to verify it fails.** `bun test test/bench-agent-run.test.ts` — expected FAIL: the timeout branch returns `{ turnCount: 0, toolUsage: {}, events: [] }` with no `timedOut`, so the assertion `timedOut === true` fails.
- [ ] **Step 3: Implement.** In `agent-run.ts:181-184`, set the flag (and carry the already-measured `elapsedSec`):
  ```ts
  if (result.timedOut) {
    log(`  ${TIMEOUT_MARK} ${pyFixed(agentTimeout, 0)}s`)
    return { turnCount: 0, toolUsage: {}, events: [], timedOut: true, agentElapsedSec: elapsedSec }
  }
  ```
  Add the two optional fields to `AgentRunOutput` in `drivers/types.ts:15-19`. Leave the auth return (`:206`) and normal return (`:219-221`) untouched — they stay `timedOut`-absent.
- [ ] **Step 4: Run test to verify it passes.** `bun test test/bench-agent-run.test.ts` — expected PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/bench/drivers/types.ts opencode-plugin/src/bench/agent-run.ts opencode-plugin/test/bench-agent-run.test.ts
  git commit -m "feat(bench): T1 plumb timedOut discriminator through runAgent (Loop-3)"
  ```

---

### Task 2: carry `timedOut` through `RunTaskResult` and split the error union

**Files:**
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (the `RunTaskResult` interface `:46-58`; the `runAgent` destructure `:229`; the result object `:251-260`; the `failResult` helper if present)
- Test: `opencode-plugin/test/bench-cmd-run.test.ts`

**Interfaces:**
- `RunTaskResult` (`cmd-run.ts:46-58`) gains `timedOut: boolean` and widens `error` to include `"timeout"`:
  ```ts
  export interface RunTaskResult {
    sessionId: string
    reward: number
    elapsed: number
    turns: number
    toolUsage: ToolUsage
    events: TrajEvent[]
    timedOut: boolean                                        // NEW — from runAgent
    error: "" | "setup_failed" | "agent_no_output" | "timeout"   // NEW label
    selfScore?: number | null
  }
  ```
- `error` computation stops conflating a wall-timeout with a generic no-output:
  `error: timedOut ? "timeout" : turnCount === 0 ? "agent_no_output" : ""` (replaces `cmd-run.ts:258`). `elapsed` is already present (`:254`, `round1(elapsed)`); no new elapsed wiring here.

- [ ] **Step 1: Write the failing test.** In `test/bench-cmd-run.test.ts`, drive `runOneTask` with an injected `execFn` that returns a timed-out `ExecResult` for the agent step (`{ rc: 124, timedOut: true, stdout: "", stderr: "" }`) and any verifier result. Assert the `RunTaskResult` has `timedOut === true`, `turns === 0`, `error === "timeout"` (not `"agent_no_output"`), and `elapsed > 0`. Add a second case: a genuine 0-turn no-output (agent stdout empty, `timedOut: false`) yields `timedOut === false`, `error === "agent_no_output"`.
- [ ] **Step 2: Run test to verify it fails.** Expected FAIL — `RunTaskResult` has no `timedOut`; `error` is `"agent_no_output"` for the timeout case.
- [ ] **Step 3: Implement.** Destructure `timedOut` at `cmd-run.ts:229` (`const { turnCount, toolUsage, events, timedOut } = await runAgent(...)`, with `timedOut` defaulting to `false` if absent: `timedOut ?? false`). Thread it into the returned `RunTaskResult` and change the `error` expression per the interface above. Ensure the `setup_failed` early-return path (`failResult("setup_failed")`) sets `timedOut: false`.
- [ ] **Step 4: Run test to verify it passes.** Expected PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/bench/cmd-run.ts opencode-plugin/test/bench-cmd-run.test.ts
  git commit -m "feat(bench): T2 carry timedOut through RunTaskResult; split timeout vs agent_no_output (Loop-3)"
  ```

---

### Task 3: record timeouts as stored fails (flag-gated) + additive `SessionRecord` fields

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (`SessionRecord` `:112-146`; `MhConfig` `:235-251` + `readMhConfig` `:259-275` for the `recordTimeouts` flag)
- Modify: `opencode-plugin/src/bench/record.ts` (`sessionRecord` builder `:249-273`; `recordToStores` signature + guard `:281-302`)
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (the `recordToStores` call site `:403-419` — thread `res.timedOut`, `res.elapsed`, and the flag)
- Modify: `opencode-plugin/src/bench/cmd-ab.ts` (the arm-B record mirror `:331-348` — thread the same + change guard)
- Test: `opencode-plugin/test/bench-record.test.ts` (record + back-compat); optional `test/harness-store-config.test.ts` or reuse an existing config test for the flag default

**Interfaces:**
- `SessionRecord` (`harness-store.ts:112`) gains, alongside `platform?`/`judge?`:
  ```ts
  /** Wall-clock seconds this session consumed (cmd-run.ts elapsed). Optional so
   *  pre-Loop-3 records keep parsing; absent ⇒ unknown. */
  elapsed?: number
  /** True iff the agent phase hit the wall timeout (turnCount will be 0). Optional;
   *  absent ⇒ false. */
  timedOut?: boolean
  ```
- `MhConfig` gains `recordTimeouts: boolean`; `readMhConfig` returns `recordTimeouts: raw.recordTimeouts ?? false` (default OFF).
- `sessionRecord(task, sessionId, passed, turnCount, toolUsage, model, variant, env, elapsed?, timedOut?)` — two new optional trailing params, stamped onto the record only when provided (keeps the existing 8-arg callers compiling; matches how `platform` is derived from `env` today at `:259/:271`).
- `recordToStores(...)` gains a `timedOut: boolean` and a `recordTimeouts: boolean` parameter (and an `elapsed?: number`); the guard becomes:
  ```ts
  // record.ts:299 (new) — timeout falls through ONLY when the flag is on
  if (turnCount === 0 && !(timedOut && recordTimeouts)) {
    log("  skip store record: 0 agent turns (auth/transient agent failure)")
    return
  }
  // a recorded timeout: passed=false, turnCount=0, timedOut=true, elapsed set;
  // events:[] so the saveTraj branch (record.ts:305) is a natural no-op
  ```
  A timeout record is a genuine fail (`passed=false` ⇒ `nFail++` in `recordSession`, `harness-store.ts:640`).

- [ ] **Step 1: Write the failing tests** in `test/bench-record.test.ts`:
  - `"recordToStores writes a timeout fail when recordTimeouts is on"` — call with `turnCount=0, passed=false, timedOut=true, elapsed=638.4, recordTimeouts=true`; assert `readScore(...)` has one session with `passed===false`, `turnCount===0`, `timedOut===true`, `elapsed===638.4`, and `nFail===1`.
  - `"recordToStores still drops a timeout when recordTimeouts is off (default)"` — same call, `recordTimeouts=false`; assert `readScore(...).sessions` is empty (byte-identical to today).
  - `"recordToStores still drops an auth/transient 0-turn even when recordTimeouts is on"` — `turnCount=0, timedOut=false, recordTimeouts=true`; assert nothing recorded (discriminator invariant).
  - `"back-compat: a score.json with neither elapsed nor timedOut parses and renders"` — hand-write a pre-Loop-3 `score.json` (no `elapsed`, no `timedOut`), read it via `readScore`, and pass through `buildProposerContext`; assert no throw and the FAIL/PASS line renders (mirrors `test/session-record-platform.test.ts`).
  - Flag default test: `readMhConfig` on an empty/absent `config.json` returns `recordTimeouts === false`; with `{"recordTimeouts":true}` returns `true`.
- [ ] **Step 2: Run tests to verify they fail.** Expected FAIL — `recordToStores` has no `recordTimeouts`/`timedOut` params; the guard drops all 0-turn runs; `SessionRecord` has no `timedOut`/`elapsed`; `MhConfig` has no `recordTimeouts`.
- [ ] **Step 3: Implement.**
  - Add `elapsed?`/`timedOut?` to `SessionRecord`; add `recordTimeouts` to `MhConfig` + `readMhConfig`.
  - Extend `sessionRecord` to stamp `elapsed`/`timedOut` when provided.
  - Add `timedOut`, `elapsed?`, `recordTimeouts` params to `recordToStores`; change the guard as above; pass `elapsed`/`timedOut` into `sessionRecord`.
  - At `cmd-run.ts:403-419`, read `const { recordTimeouts } = readMhConfig()` (import `readMhConfig`, `accountMetaRoot` default) once near the run loop and thread `res.timedOut`, `res.elapsed`, `recordTimeouts` into the `recordToStores(...)` call.
  - At `cmd-ab.ts:331`, change the guard `recordArmB && !noStore && resB.turns > 0` → `recordArmB && !noStore && (resB.turns > 0 || (recordTimeouts && resB.timedOut))`, read `recordTimeouts` from `readMhConfig()` once in the phase closure, and pass `resB.elapsed`/`resB.timedOut` into the `sessionRecord(...)` mirror call (`:332-341`).
- [ ] **Step 4: Run tests to verify they pass.** `bun test test/bench-record.test.ts` (+ the config test) — expected PASS. Then `bun test test/bench-cmd-ab.test.ts test/bench-cmd-run.test.ts` — expected still green (default-OFF ⇒ no behavior change).
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/harness-store.ts opencode-plugin/src/bench/record.ts opencode-plugin/src/bench/cmd-run.ts opencode-plugin/src/bench/cmd-ab.ts opencode-plugin/test/bench-record.test.ts
  git commit -m "feat(bench): T3 record wall-timeouts as fails behind recordTimeouts flag (default off) (Loop-3)"
  ```

---

### Task 4: surface + diagnose — timeout marker in the proposer's view

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (`buildProposerContext` trace-line render `:1329-1337`)
- Modify: `opencode-plugin/src/propose.ts` (a "timed-out sessions" note in `buildProposerPrompt`, near the context/failingSection assembly `:782-788`)
- Test: `opencode-plugin/test/proposer-store-access.test.ts` (context render) and `test/cc-proposer.test.ts` or a focused prompt test (the note)

**Interfaces:**
- `buildProposerContext(storeRoot, higherRoots)` — signature unchanged; the per-session line (`:1333`) appends a timeout marker when `s.timedOut`:
  ```ts
  // in the traceLines map, when s.timedOut:
  //   … | FAIL | model=… | turns=0 | TIMEOUT ${s.elapsed ?? "?"}s / ${env.maxAgentTimeout ?? "?"}s budget
  ```
  (Read the budget from `s.env?.maxAgentTimeout`, already recorded by `envBlock` at `record.ts:236`.) Back-compat: `s.timedOut` absent ⇒ ordinary FAIL line, unchanged.
- `buildProposerPrompt` — add a short **"Timed-out sessions"** note (only when ≥1 stored session has `timedOut`) that: names the taxonomy label `resource-limit` (`propose.ts:65`); points at the existing `agent-config.json` / `env-policy.json` timeout ops (`propose.ts:697, :727`); and explicitly says the wall is the **bench agent wall** (`--max-agent-timeout`), NOT the plugin bash-tool `fastTimeoutMs`, so a `resource-limit` diagnosis does not misfire the wrong knob (design §6/§7 two-timeouts conflation). Timeouts have `events: []` and so appear in *no* failing-trajectory excerpt (`buildFailureExcerpts`, `:421`) — this note *is* the evidence (elapsed vs budget).

- [ ] **Step 1: Write the failing tests.**
  - Context render: seed a store (via `recordToStores` with `recordTimeouts=true`, or a hand-written `score.json`) containing one `timedOut:true, elapsed:638.4, env.maxAgentTimeout:600` session; call `buildProposerContext`; assert the output string contains `TIMEOUT` and `638.4` and `600`.
  - Prompt note: build a proposer prompt for a layer whose sessions include a timeout; assert the prompt text contains the "Timed-out sessions" heading and the word `resource-limit`. Add a negative case: a layer with no timeouts omits the note.
- [ ] **Step 2: Run tests to verify they fail.** Expected FAIL — no TIMEOUT marker, no note.
- [ ] **Step 3: Implement** the marker in `buildProposerContext` and the conditional note in `buildProposerPrompt`.
- [ ] **Step 4: Run tests to verify they pass.** Expected PASS; re-run `bun test test/proposer-store-access.test.ts test/cc-proposer.test.ts` for no regression on non-timeout paths.
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/harness-store.ts opencode-plugin/src/propose.ts opencode-plugin/test/proposer-store-access.test.ts opencode-plugin/test/cc-proposer.test.ts
  git commit -m "feat(propose): T4 surface timeouts as resource-limit signal in proposer context+prompt (Loop-3)"
  ```

---

### Task 5: budget-inject — symmetric advisory budget line into `instruction.md`

**Files:**
- Modify: `opencode-plugin/src/bench/agent-run.ts` (instruction assembly, before `driver.buildArgv`, `:154-155`)
- Test: `opencode-plugin/test/bench-agent-run.test.ts`

**Interfaces:**
- `runAgent(...)` — signature unchanged. After reading `instruction` (`:149-153`) and before `driver.buildArgv({ …, instruction })` (`:155`), append one advisory line derived from the already-computed `agentTimeout` param:
  ```ts
  const budgetLine = `\n\nYou have roughly ${pyFixed(agentTimeout, 0)}s of wall-clock for this task. `
    + `Budget it: prefer a simpler approach that finishes over an ambitious one that risks running out of time.`
  instruction = instruction + budgetLine
  ```
  No schema change; no new provenance field (the wall is already in `env.maxAgentTimeout`, `record.ts:236`). The line is **advisory** (never a hard "stop at N") and the real wall is unchanged, mitigating premature-termination (design §7).

- [ ] **Step 1: Write the failing tests.**
  - `"runAgent injects an advisory budget line carrying agentTimeout into the instruction"` — inject an `execFn` that captures the argv/instruction the driver received (use a fake driver whose `buildArgv` records `opts.instruction`); call `runAgent(..., agentTimeout=600, ...)`; assert the captured instruction contains `600s` and the advisory wording.
  - **Arm-symmetry test** (the load-bearing one): call `runAgent` twice with the *same* `agentTimeout` but different harness markdown (simulating arm A vs arm B); assert the injected budget substring is **byte-identical** across both — i.e. the budget line is a function of `agentTimeout` only, never of the harness. This proves the constant is not an A/B lever.
- [ ] **Step 2: Run tests to verify they fail.** Expected FAIL — no budget line in the instruction.
- [ ] **Step 3: Implement** the append in `runAgent` (note `instruction` must become `let`, currently declared `let instruction` at `:149` — already mutable).
- [ ] **Step 4: Run tests to verify they pass.** Expected PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/bench/agent-run.ts opencode-plugin/test/bench-agent-run.test.ts
  git commit -m "feat(bench): T5 inject symmetric advisory budget line into instruction.md (Loop-3)"
  ```

---

### Task 6: budget provenance + activation-time re-baseline gate

**Files:**
- Modify: `opencode-plugin/src/bench/cmd-ab.ts` (verdictDict `d`, add fields near `:280` where `driver` was just added)
- Modify: `opencode-plugin/src/harness-store.ts` (`AbVerdict` interface `:204-218` — additive-optional fields; a `budgetIdentityMatches` helper)
- Modify: `opencode-plugin/src/bench/results.ts` (`RunResultsMeta` `:118-130` + `writeRunResults` `:138-155`)
- Modify: `opencode-plugin/src/engine.ts` (the `/mh-activate` gate `:713-727` — belt-and-suspenders budget-identity check)
- Test: `opencode-plugin/test/bench-cmd-ab.test.ts` (verdict stamp), `test/bench-results.test.ts` (results stamp), and an activation-gate test (engine)

**Interfaces:**
- `ab-verdict.json` gains, in the verdictDict `d` (`cmd-ab.ts:273-300`, alongside `splitHash`/`activeFold`/`driver`):
  ```ts
  maxAgentTimeout: maxAgentTimeout,   // budget-identity guard (in scope at cmd-ab; used at :311)
  timeoutRecording: recordTimeouts,   // whether timeouts counted as fails when this verdict was measured
  ```
- `AbVerdict` (`harness-store.ts:204`) gains `maxAgentTimeout?: number` and `timeoutRecording?: boolean` (additive-optional, matching the v2 additive block; old verdicts still parse).
- `RunResultsMeta` + `writeRunResults` (`results.ts`) gain `maxAgentTimeout: number` and `timeoutRecording: boolean`, written into the results JSON alongside `driver` (`:152`).
- `budgetIdentityMatches(verdict, activeBudget)` helper in `harness-store.ts`: `true` iff `verdict.maxAgentTimeout` is undefined (pre-Loop-3, treat as compatible) OR equals the budget the active/baseline sessions carry in `env.maxAgentTimeout`.
- `/mh-activate` gate (`engine.ts:713-727`): after `abAccepted(verdict)` succeeds and before `activateCandidate`, for account scopes without `--force`, compare `verdict.maxAgentTimeout` to the active layer's baseline budget (read from the active version's `score.json` sessions' `env.maxAgentTimeout`). On mismatch, refuse with a toast naming both budgets and instructing a re-baseline (T7) — a hard, detectable condition, not a silent Goodhart. `--force` overrides, consistent with the existing gate.

- [ ] **Step 1: Write the failing tests.**
  - Verdict stamp: drive `ab` (with the existing test's injected seam) and assert the written `ab-verdict.json` contains `maxAgentTimeout` (= the run's `--max-agent-timeout`) and `timeoutRecording` (= the flag).
  - Results stamp: call `writeRunResults` with the new meta fields; assert they appear in the JSON.
  - Activation gate: seed an account layer whose active sessions carry `env.maxAgentTimeout=600` and a candidate `ab-verdict.json` with `maxAgentTimeout=900`; assert `/mh-activate account vN` (no `--force`) is refused with a budget-mismatch toast; assert `--force` activates; assert a matching (600/600) verdict activates without force; assert a pre-Loop-3 verdict (no `maxAgentTimeout`) still activates (back-compat).
- [ ] **Step 2: Run tests to verify they fail.** Expected FAIL — verdict/results lack the fields; the gate has no budget check.
- [ ] **Step 3: Implement** the stamps, the `AbVerdict`/`RunResultsMeta` additive fields, the `budgetIdentityMatches` helper, and the gate check.
- [ ] **Step 4: Run tests to verify they pass.** Expected PASS; re-run `bun test test/bench-cmd-ab.test.ts test/bench-results.test.ts` for no regression (pre-Loop-3 verdicts without the fields must still parse and activate).
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/bench/cmd-ab.ts opencode-plugin/src/harness-store.ts opencode-plugin/src/bench/results.ts opencode-plugin/src/engine.ts opencode-plugin/test/bench-cmd-ab.test.ts opencode-plugin/test/bench-results.test.ts
  git commit -m "feat(bench): T6 stamp maxAgentTimeout/timeoutRecording into verdict+results; activation budget-identity gate (Loop-3)"
  ```

---

### Task 7: re-baseline trigger in the loop ledger (manual) + runbook step

**Files:**
- Modify: `opencode-plugin/src/bench/report-loop.ts` (the baseline the loop trusts — `baselineRate` in `MetaMetricEvent` `:63`, consumed by `isStrictImprovement` `:121-129`)
- Modify: the loop runbook / operator docs (e.g. `docs/` loop-N-state or the runbook referenced by MEMORY; add the manual re-baseline step)
- Test: `opencode-plugin/test/bench-report-loop.test.ts`

**Interfaces:**
- A re-baseline is a **manual operator step**, not an auto-fire. T7 provides the *mechanism*: when the operator changes the budget-identity (bumps `--max-agent-timeout` OR flips `recordTimeouts` ON), they re-score the active version at the new budget and reset the `report-loop` baseline ledger to that figure, so a subsequent generation's `trialRate > baselineRate` (`isStrictImprovement`, `report-loop.ts:121-129`) compares like-for-like.
- Concretely, `report-loop` should ignore/segment `MetaMetricEvent`s whose `maxAgentTimeout`/`timeoutRecording` (stamped in T6) differ from the current budget-identity when computing the plateau/improvement window — OR the operator resets the ledger and the loop starts a fresh window. Provide whichever is minimal: a `budgetIdentity` field on the event (from T6's stamp) and a filter in `benchLayerVerdict`/`plateauVerdict` so a pre-change baseline event is not treated as a comparable point.

- [ ] **Step 1: Write the failing test** in `test/bench-report-loop.test.ts`: build a `MetaMetricEvent` stream that mixes pre-change (`maxAgentTimeout=600`) and post-change (`900`) events; assert the improvement/plateau verdict does NOT count a 900s `trialRate` as a strict improvement over a 600s `baselineRate` (i.e. cross-budget deltas are excluded from the window).
- [ ] **Step 2: Run test to verify it fails.** Expected FAIL — today the window mixes budgets.
- [ ] **Step 3: Implement** the budget-identity segmentation in the report-loop window computation (keyed off the T6-stamped fields), plus document the manual re-baseline operator step in the runbook (re-score active at the new budget; reset the ledger; then flip `recordTimeouts` ON as the one deliberate cutover, sequenced with the budget bump per design §6.2 item 2).
- [ ] **Step 4: Run test to verify it passes.** Expected PASS; `bun test test/bench-report-loop.test.ts` green.
- [ ] **Step 5: Commit.**
  ```bash
  git add opencode-plugin/src/bench/report-loop.ts opencode-plugin/test/bench-report-loop.test.ts docs/
  git commit -m "feat(loop): T7 segment report-loop baseline by budget-identity + manual re-baseline runbook (Loop-3)"
  ```

---

## Notes / scope boundaries

- **Order matters (design §8):** T1→T2→T3 is the minimal proposer-visible slice (a timeout becomes a stored, discriminated fail); T4→T5 make it actionable (the proposer reads it as `resource-limit` and has a symmetric budget to react to); T6→T7 keep the longitudinal claim honest. T3 is the load-bearing task and the one gated behind `recordTimeouts` (default OFF).
- **The cutover is deliberate and paired:** flipping `recordTimeouts` ON is *itself* a budget-identity change (timeout-excluded vs timeout-included pass-rates are not comparable, design §6.2 item 2). Sequence the flag flip together with the first manual re-baseline (T7). Until then, every task is a no-op on live behavior (default-OFF).
- **`elapsed` is stamped on all records, not only timeouts** (design §4.2c) — this makes latency *visible* on passing sessions too, enabling the deferred latency-as-selection follow-up. It does **not** make latency *selective* here.
- **Two-timeouts stay distinct:** this plan touches only the bench **agent wall** (`--max-agent-timeout` → `taskTimeouts` → `withTimeout`). It never touches the plugin **bash-tool** timeout (`agent-config.json fastTimeoutMs`, `propose.ts:693`); T4's note names the wall explicitly so a `resource-limit` diagnosis does not misfire the bash-tool knob.
- **All tests hermetic:** injected `ExecResult`/`execFn`, temp store dirs, per-test `META_HARNESS_HOME`. No task requires a real podman/opencode drive.

## DEFERRED (design §9 — out of scope for Loop-3)

- **Partial-trajectory capture on timeout.** `runAgent` discards `events` on the wall (`agent-run.ts:183` returns `events: []`); recovering the NDJSON emitted before the kill would give the proposer a real trajectory to diagnose *where* the agent got stuck. Higher value, higher effort — separate increment. (Loop-3 diagnoses from the score line + elapsed/budget only.)
- **Latency as a first-class selection signal.** Now that `elapsed` is persisted, a future gate could prefer a faster candidate on a tie. Loop-3 only makes latency visible, not selective; the `abDecision` stays binary-reward.
- **Auto-tuning the wall.** Automatically raising `--max-agent-timeout` per task from observed `elapsed` distributions. Requires the re-baseline machinery (T6/T7) as a prerequisite AND accumulated timeout signal; defer. (This is why the re-baseline trigger is manual in Loop-3.)
- **Plugin bash-tool timeout (`fastTimeoutMs`) evolution.** Already supported (`propose.ts:693`) and project-layer-scoped; Loop-3 deliberately does not touch it beyond keeping it distinct from the wall.
