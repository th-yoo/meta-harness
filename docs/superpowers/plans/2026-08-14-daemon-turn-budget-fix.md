# Daemon Turn-Budget Fix (proposer seat unblocked) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the daemon-carried proposer/promoter/curator seats run turns longer than `ACP_BUDGET.turnTimeoutMs` (16s) — the hard cap that deterministically kills every account-global propose crank — without touching the gauge lane's fail-fast budget or the judge path.

**Architecture:** Use the daemon's EXISTING `ACP_TURN_TIMEOUT_MS` env override (acp-pool.ts:184 `parseTurnTimeoutMs`, honored at session construction) instead of adding a new wire field. The env var is NOT in `ACP_ENV_DENYLIST` (acp-paths.ts:50-60), so setting it changes `envFingerprint` → the proposer worker gets its OWN daemon instance with long turns, while the gauge/judge daemon keeps the 16s default — isolation by the fingerprint mechanism that already exists. The one daemon change required is contract honesty: `initialize` currently advertises the CONSTANT `ACP_BUDGET.daemonWorstCaseMs` (acp-daemon.ts:374) even when the env override raises the real worst case, which defeats the client's §6e pre-send guard (acp-client.ts:268-269 refuses when `dw >= budgetMs`) and re-opens the double-spend window the guard exists to close. Fix: advertise the worst case computed from the EFFECTIVE turn timeout.

**Tech Stack:** Bun/TypeScript. Repos: `~/z2/cc-api-daemon` (daemon, pushed to github th-yoo/cc-api-daemon) and `~/z2/meta-harness` (seat side, `opencode-plugin/`).

**Evidence base (live-diagnosed 2026-08-14, this session):** every proposer failure = `call-consumed` at 16.0-16.2s wall / `duration_ms` 14503, daemon debug dump shows `subtype: error_during_execution`, `terminal_reason: aborted_streaming`, `duration_api_ms: 0` — the daemon's turn timer (16s) interrupting opus mid-prefill on the 40KB account-global prompt. Filler probes of 41KB with trivial replies pass; the harness session's 16KB project-global crank passed. Size/content exonerated; the constant is the cause.

## Global Constraints

- Daemon warm-lane toolless isolation guard: UNTOUCHED (no `isWellFormedIsolation` changes).
- §6e contract MUST hold per-call: client `budgetMs` > advertised `daemonWorstCaseMs`, else the client refuses pre-send (no-call). Never weaken the client-side guard.
- Gauge/judge lanes: default `ACP_BUDGET` numbers byte-unchanged (`turnTimeoutMs: 16_000`, `daemonWorstCaseMs: 32_000`, `clientBudgetMs: 36_000`). Judge continues on the default-fingerprint daemon.
- `parseTurnTimeoutMs`'s verbatim-unclamped parse rule: unchanged (session constructors own the floors).
- Worker turn budget: `WORKER_TURN_TIMEOUT_MS = 480_000`. Arithmetic that must stay true: effective worst case = 6k+4k+2k+480k+4k = **496_000** < worker attempt-1 `budgetMs` = `min(timeoutMs/2, remaining)` = 600_000 for the standard 1_200_000ms descriptor timeout (slack 104s).
- Standing rules: explicit user go before ANY merge and ANY spend; named files only; suite green before report.
- cc-api-daemon is solo-dev main-direct (no PR), but meta-harness merge still needs the user go.

## File Structure

- `~/z2/cc-api-daemon/src/acp-pool.ts` — add `effectiveDaemonWorstCaseMs(env)` next to `parseTurnTimeoutMs` (same env-parsing authority).
- `~/z2/cc-api-daemon/src/acp-daemon.ts:374` — initialize advertisement uses the helper.
- `~/z2/cc-api-daemon/src/warm-session.ts` (~line 770, the non-success `result` branch) — permanent one-line stderr diagnostic (the error detail is currently swallowed; today's 3-hour hunt happened because of it).
- `~/z2/cc-api-daemon/test/acp-pool.test.ts` — helper unit tests.
- `~/z2/cc-api-daemon/test/acp-daemon.test.ts` — initialize-advertisement test (env-override variant of the existing initialize test).
- `~/z2/meta-harness/opencode-plugin/src/adapters/claude-code/daemon-seat.ts` — `WORKER_TURN_TIMEOUT_MS` + `workerDaemonEnv(env)`.
- `~/z2/meta-harness/opencode-plugin/src/adapters/claude-code/proposer-worker.ts` — wrap env once per cycle.
- `~/z2/meta-harness/opencode-plugin/test/proposer-worker.test.ts` — env-threading assertions (file exists, owned by this session's T5 work).
- `~/z2/meta-harness/opencode-plugin/package.json` + `cc-gate-plugin/package.json` — pin bumps.

---

## Task DAG (decomposition for parallel execution)

Two tracks in two repos with ZERO file overlap — track A (`~/z2/cc-api-daemon`) and track B (`~/z2/meta-harness/opencode-plugin`) run fully parallel until the pin-bump join. Sub-task IDs map onto the task bodies below (execute the referenced steps verbatim).

| ID | What | Files (repo) | Maps to | Depends on |
|----|------|--------------|---------|------------|
| A1 | `effectiveDaemonWorstCaseMs` helper + unit tests | `src/acp-pool.ts`, `test/acp-pool.test.ts` (daemon) | Task 1 Steps 1-4 | — |
| A2 | initialize advertisement wiring + boot test | `src/acp-daemon.ts:374`, `test/acp-daemon.test.ts` (daemon) | Task 1 Steps 5-6 | A1 (imports the export) |
| A3 | warm-turn failure diagnostic | `src/warm-session.ts` (daemon) | Task 1 Step 7 | — (disjoint file) |
| A4 | daemon suite green + commit + 0.8.1 bump + **push (GATE G1: user go)** → `<SHA081>` | `package.json` (daemon) | Task 1 Steps 8-9 + Task 2 | A1+A2+A3 |
| B1 | `WORKER_TURN_TIMEOUT_MS` + `workerDaemonEnv` + arithmetic/floor tests | `daemon-seat.ts`, `test/proposer-worker.test.ts` (meta-harness) | Task 3 | — |
| B2 | worker `denv` threading (hoisted above `try`) + env-capture tests | `proposer-worker.ts`, `test/proposer-worker.test.ts` (meta-harness) | Task 4 Steps 1-4 | B1 (same test file → serial within track) |
| J1 | pin bumps → `<SHA081>`, `bun install` ×2, typecheck + full suites both plugins, commit | both `package.json`s (meta-harness) | Task 4 Steps 5-7 | A4 + B2 |
| J2 | live account-global crank end-to-end (**GATE G2: user spend go**) + close-out | — (runtime) | Task 5 | J1 |

```mermaid
graph TD
  subgraph Track A — cc-api-daemon
    A1[A1 helper + tests] --> A2[A2 initialize wiring + boot test]
    A3[A3 turn-failure diagnostic]
    A2 --> A4[A4 suite + 0.8.1 + push GATE G1]
    A3 --> A4
  end
  subgraph Track B — meta-harness seat
    B1[B1 workerDaemonEnv + floor tests] --> B2[B2 worker denv threading]
  end
  A4 --> J1[J1 pin bumps + installs + full suites]
  B2 --> J1
  J1 --> J2[J2 live crank GATE G2 + close-out]
```

- **Critical path:** A1 → A2 → A4(G1) → J1 → J2. B-track is shorter and entirely off it — schedule B concurrently with A1/A2.
- **Within-track parallelism:** A1 ∥ A3 (disjoint files, no interface between them). A2 strictly after A1. B1→B2 serial (shared test file).
- **Why B needs no daemon artifacts:** B's tests are pure (env-wrapper shape + budget arithmetic against literal constants) — no import from the daemon package changes, so B runs before `<SHA081>` exists.
- **J1 owns the only cross-repo coupling** (the pin SHA) and the node_modules refresh that evicts this session's scratch instrumentation.
- **Gates:** G1 = push of the daemon repo (publish), G2 = model spend. Both explicit user go, per standing rules. Meta-harness B-track commits land on branch `feat/daemon-turn-budget`; merge to main happens at/after J1 under the same user-go rule.
- **Agent allocation (subagent-driven):** one implementer per sub-task, fresh per task; A and B tracks may run as concurrent subagents since repos are disjoint. Suite runs stay serial per repo (A4 daemon suite and J1 plugin suites don't overlap in time with each other's repos anyway).

### Task 1: cc-api-daemon — honest worst-case advertisement + turn-error diagnostic

**Files:**
- Modify: `~/z2/cc-api-daemon/src/acp-pool.ts` (after `parseTurnTimeoutMs`, line ~185)
- Modify: `~/z2/cc-api-daemon/src/acp-daemon.ts:374`
- Modify: `~/z2/cc-api-daemon/src/warm-session.ts` (non-success `result` branch, the `this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })` site ~line 774)
- Test: `~/z2/cc-api-daemon/test/acp-pool.test.ts`, `~/z2/cc-api-daemon/test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `parseTurnTimeoutMs(env)` (acp-pool.ts:184), `ACP_BUDGET`, `CLI_SPAWN_BUDGET_MS`, `AUTH_RESOLVE_BUDGET_MS` (acp-wire.ts).
- Produces: `export function effectiveDaemonWorstCaseMs(env: Record<string, string | undefined>): number` — later tasks and the client guard rely on `initialize`'s `_meta.kkamak.daemonWorstCaseMs` reflecting it.

- [ ] **Step 1: Write the failing helper tests** in `test/acp-pool.test.ts`:

```ts
import { effectiveDaemonWorstCaseMs, parseTurnTimeoutMs } from "../src/acp-pool.ts"
import { ACP_BUDGET } from "../src/acp-wire.ts"

describe("effectiveDaemonWorstCaseMs", () => {
  test("no override -> exactly ACP_BUDGET.daemonWorstCaseMs", () => {
    expect(effectiveDaemonWorstCaseMs({})).toBe(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("override swaps the turn leg only: 480_000 -> 496_000", () => {
    expect(effectiveDaemonWorstCaseMs({ ACP_TURN_TIMEOUT_MS: "480000" })).toBe(
      ACP_BUDGET.daemonWorstCaseMs - ACP_BUDGET.turnTimeoutMs + 480_000,
    )
  })
  test("override BELOW the session floors is reported at the floored value the sessions will actually use", () => {
    // warm floor CLI_SPAWN_BUDGET_MS = 8_000, api floor AUTH_RESOLVE_BUDGET_MS = 10_000;
    // sessions clamp UP, so the honest worst case uses the larger floor.
    expect(effectiveDaemonWorstCaseMs({ ACP_TURN_TIMEOUT_MS: "1000" })).toBe(
      ACP_BUDGET.daemonWorstCaseMs - ACP_BUDGET.turnTimeoutMs + 10_000,
    )
  })
  test("garbage override falls through to the default, same as parseTurnTimeoutMs", () => {
    expect(effectiveDaemonWorstCaseMs({ ACP_TURN_TIMEOUT_MS: "banana" })).toBe(ACP_BUDGET.daemonWorstCaseMs)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `cd ~/z2/cc-api-daemon && bun test test/acp-pool.test.ts` → FAIL: `effectiveDaemonWorstCaseMs` not exported.

- [ ] **Step 3: Implement in `src/acp-pool.ts`**, directly below `parseTurnTimeoutMs` (imports for `CLI_SPAWN_BUDGET_MS`/`AUTH_RESOLVE_BUDGET_MS` join the existing acp-wire import):

```ts
/** The worst case `initialize` must ADVERTISE for this env — the §6e client
 * guard (acp-client.ts: refuse when dw >= budgetMs) is only sound if the
 * advertised number tracks the turn budget the sessions will actually run
 * with. `parseTurnTimeoutMs` is honored verbatim by design; the session
 * constructors floor it (warm: CLI_SPAWN_BUDGET_MS, api: AUTH_RESOLVE_BUDGET_MS),
 * so the honest advertisement uses the same parsed value clamped by the
 * LARGER floor — the process hosts both backends and must size off the
 * slow one (the same rule ACP_BUDGET's own doc states). */
export function effectiveDaemonWorstCaseMs(env: Record<string, string | undefined>): number {
  const turn = Math.max(parseTurnTimeoutMs(env), CLI_SPAWN_BUDGET_MS, AUTH_RESOLVE_BUDGET_MS)
  return ACP_BUDGET.daemonWorstCaseMs - ACP_BUDGET.turnTimeoutMs + turn
}
```

- [ ] **Step 4: Run to verify pass** — `bun test test/acp-pool.test.ts` → PASS.

- [ ] **Step 5: Wire the advertisement** — `src/acp-daemon.ts:374`, replace the constant:

```ts
            _meta: { kkamak: { envFingerprint: fingerprint, daemonWorstCaseMs: effectiveDaemonWorstCaseMs(env) } },
```

(`env` here is the daemon's own construction env — the same object `parseTurnTimeoutMs(env)` already reads at line 468; import `effectiveDaemonWorstCaseMs` from `./acp-pool.ts`, which acp-daemon.ts already imports `parseTurnTimeoutMs` from.)

- [ ] **Step 6: Initialize-advertisement test** — in `test/acp-daemon.test.ts`: there is no single named initialize test; use the reusable boot helper `spawnDaemon(home, spawnLog, extra, idleMs)` (acp-daemon.test.ts:218) whose `extra` param merges env into the daemon boot env. Add one test spawning with `extra = { ACP_TURN_TIMEOUT_MS: "480000" }`, send `initialize` (the `c.request("initialize", ...)` pattern used throughout the file), assert the response's `_meta.kkamak.daemonWorstCaseMs === ACP_BUDGET.daemonWorstCaseMs - ACP_BUDGET.turnTimeoutMs + 480_000` (`496_000` at today's constants); plus the no-override assertion `=== ACP_BUDGET.daemonWorstCaseMs` (piggyback on any existing initialize-asserting test).

- [ ] **Step 7: Turn-error diagnostic** — `src/warm-session.ts`, the non-success `result` branch (immediately above `this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })`):

```ts
      // Swallowing the SDK's error detail cost a multi-hour live hunt
      // (2026-08-14 turn-budget diagnosis): keep the terminal reason on
      // stderr. One line, no payload text, only ever fires on a failed turn.
      console.error(`[warm-session] turn failed: subtype=${r.subtype} terminal_reason=${(m as { terminal_reason?: string }).terminal_reason} errors=${JSON.stringify((m as { errors?: unknown }).errors)}`)
```

- [ ] **Step 8: Full daemon suite** — `bun test` in `~/z2/cc-api-daemon` → all pass (the ACP_BUDGET arithmetic tests in acp-wire.test.ts are untouched and must stay green — constants did not move).

- [ ] **Step 9: Commit**

```bash
cd ~/z2/cc-api-daemon
git add src/acp-pool.ts src/acp-daemon.ts src/warm-session.ts test/acp-pool.test.ts test/acp-daemon.test.ts
git commit -m "fix(budget): initialize advertises the EFFECTIVE daemonWorstCaseMs under ACP_TURN_TIMEOUT_MS override; log turn-failure detail

The env override (parseTurnTimeoutMs) has existed since the pool port, but
initialize kept advertising the constant ACP_BUDGET.daemonWorstCaseMs — a
long-turn daemon lied to the client's §6e pre-send guard, re-opening the
client-times-out-first double-spend window. Advertise
effectiveDaemonWorstCaseMs(env) instead (turn leg swapped, floored by the
larger backend floor). Also: one-line stderr diagnostic on failed warm
turns — the swallowed SDK error detail cost a multi-hour live hunt
(proposer 40KB prompt vs the 16s turn cap, 2026-08-14)."
```

### Task 2: cc-api-daemon — version bump + push

**Files:**
- Modify: `~/z2/cc-api-daemon/package.json` (version `0.8.0` → `0.8.1`)
- (No CHANGELOG.md exists in the repo — architect-verified; no entry to write.)

**Interfaces:**
- Produces: pushed commit SHA on main — Task 4's pin bumps consume it. Record it: `git rev-parse HEAD`.

- [ ] **Step 1:** Bump `"version": "0.8.1"` in package.json.
- [ ] **Step 2:** `bun test` → green.
- [ ] **Step 3:** Commit `chore: bump to 0.8.1 — honest worst-case advertisement under turn-budget override` and **ask the user for the push go** (push = publish; standing rule). After go: `git push`, record `git rev-parse HEAD` as `<SHA081>`.

### Task 3: meta-harness — `workerDaemonEnv` in daemon-seat.ts

**Files:**
- Modify: `~/z2/meta-harness/opencode-plugin/src/adapters/claude-code/daemon-seat.ts` (append after `seatMaxTokens`)
- Test: `~/z2/meta-harness/opencode-plugin/test/proposer-worker.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const WORKER_TURN_TIMEOUT_MS = 480_000` and `export function workerDaemonEnv(env: Record<string, string | undefined>): Record<string, string | undefined>` — Task 4 threads it through the worker; judge deliberately does NOT use it.

- [ ] **Step 1: Failing tests** in `test/proposer-worker.test.ts` (new describe at the end):

```ts
import { WORKER_TURN_TIMEOUT_MS, workerDaemonEnv } from "../src/adapters/claude-code/daemon-seat.ts"

describe("workerDaemonEnv", () => {
  test("sets ACP_TURN_TIMEOUT_MS to the worker turn budget, preserves the rest", () => {
    const e = workerDaemonEnv({ HOME: "/h", PATH: "/bin" })
    expect(e.ACP_TURN_TIMEOUT_MS).toBe(String(WORKER_TURN_TIMEOUT_MS))
    expect(e.HOME).toBe("/h")
    expect(e.PATH).toBe("/bin")
  })
  test("does not mutate the input env", () => {
    const input: Record<string, string | undefined> = { HOME: "/h" }
    workerDaemonEnv(input)
    expect(input.ACP_TURN_TIMEOUT_MS).toBeUndefined()
  })
  test("budget arithmetic: worker attempt-1 budget clears the advertised worst case with >=3s slack", () => {
    // Mirror of the daemon's five-leg sum with the turn leg swapped
    // (ACP_BUDGET at pin: queueWait 6k + clear 4k + setModel 2k + grace 4k = 16k non-turn legs).
    const advertisedWorstCase = 16_000 + WORKER_TURN_TIMEOUT_MS
    const attempt1BudgetMs = Math.floor(1_200_000 / 2) // standard descriptor timeoutMs / 2
    expect(attempt1BudgetMs).toBeGreaterThanOrEqual(advertisedWorstCase + 3_000)
  })
  test("config floor: proposerTimeoutMin has a ~17-minute floor under the 480s turn budget", () => {
    // Architect-review Important: readMhConfig clamps proposerTimeoutMin only
    // to (0, 120] — no floor tied to the turn budget. Below the floor,
    // attempt-1 budgetMs (timeoutMs/2) drops under the advertised worst case
    // and the client guard refuses EVERY cycle pre-send (no-call, free but
    // silent — the Task 1 stderr diagnostic never fires on pre-send refusal).
    // This test documents the boundary so a default change trips it.
    const advertisedWorstCase = 16_000 + WORKER_TURN_TIMEOUT_MS // 496_000
    expect(Math.floor((17 * 60_000) / 2)).toBeGreaterThan(advertisedWorstCase + 3_000)  // 17 min: clears
    expect(Math.floor((16 * 60_000) / 2)).toBeLessThan(advertisedWorstCase + 3_000)     // 16 min: refused
  })
})
```

- [ ] **Step 2:** `cd ~/z2/meta-harness/opencode-plugin && bun test test/proposer-worker.test.ts` → FAIL (no such exports).

- [ ] **Step 3: Implement** in daemon-seat.ts:

```ts
/** Turn budget for the detached worker's daemon (propose/promote/curate —
 * NOT the judge). The gauge-sized default (ACP_BUDGET.turnTimeoutMs, 16s)
 * deterministically kills real proposer turns: a 40KB account-global prompt
 * plus a multi-KB JSON reply cannot clear 16s on opus (live-diagnosed
 * 2026-08-14 — constant 16.0-16.2s call-consumed, aborted_streaming,
 * duration_api_ms 0). 480s: ample for prefill + a 16KB reply, and the
 * resulting advertised worst case (non-turn legs 16s + 480s = 496s) sits
 * under the worker's attempt-1 budgetMs (600s for the standard 20min
 * descriptor) with >=3s of §6e slack — checked by a test.
 *
 * CONFIG FLOOR (architect review): this number implies
 * cfg.proposerTimeoutMin >= 17 — attempt-1 budgetMs is timeoutMs/2, and
 * below ~998s of descriptor timeout the client guard (advertised worst
 * case >= budgetMs) refuses every cycle pre-send: silent, free, and
 * permanent until the config rises. readMhConfig clamps only to (0, 120].
 * Boundary pinned by the config-floor test in proposer-worker.test.ts. */
export const WORKER_TURN_TIMEOUT_MS = 480_000

/** Env for the worker's daemon calls. ACP_TURN_TIMEOUT_MS is deliberately
 * NOT in the daemon's ACP_ENV_DENYLIST, so setting it changes the
 * envFingerprint: the worker gets its OWN daemon instance with long turns
 * while the gauge/judge daemon (plain env, default fingerprint) keeps its
 * 16s fail-fast budget. Isolation via the existing fingerprint mechanism —
 * no daemon-side contract change beyond the honest worst-case
 * advertisement (cc-api-daemon 0.8.1). */
export function workerDaemonEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, ACP_TURN_TIMEOUT_MS: String(WORKER_TURN_TIMEOUT_MS) }
}
```

- [ ] **Step 4:** `bun test test/proposer-worker.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add opencode-plugin/src/adapters/claude-code/daemon-seat.ts opencode-plugin/test/proposer-worker.test.ts && git commit -m "feat(daemon-seat): workerDaemonEnv — fingerprint-separated long-turn daemon for the propose seats (480s), judge untouched"`

### Task 4: meta-harness — thread it through the worker + pin bumps

**Files:**
- Modify: `~/z2/meta-harness/opencode-plugin/src/adapters/claude-code/proposer-worker.ts` (runWorkerCycle, top of try block)
- Modify: `~/z2/meta-harness/opencode-plugin/package.json:15` + `~/z2/meta-harness/cc-gate-plugin/package.json:16` (pin `#33f74db07cf2d27308811666481b5e4cf4f6cbca` → `#<SHA081>` from Task 2)
- Test: `~/z2/meta-harness/opencode-plugin/test/proposer-worker.test.ts`

**Interfaces:**
- Consumes: `workerDaemonEnv` (Task 3). Judge path (`cc-host.ts runClaudeCodeTextAgent`) is NOT modified — it stays on `process.env`/default daemon.

- [ ] **Step 1: Failing test** — extend the existing `fakeDeps` capture in proposer-worker.test.ts to record the env each dep receives (`cap.envs: Record<string,string|undefined>[]`, push from ensure/call/close fakes), then:

```ts
test("worker calls ensure/call/close with the long-turn daemon env (fingerprint-separated from the judge daemon)", async () => {
  const args = workerArgs("promote", promotePaths())
  const { deps, cap } = fakeDeps([okOutcome(JSON.stringify(PROMOTE_REPLY))])
  await runWorkerCycle(args, { HOME: "/h" }, deps)
  for (const e of cap.envs) expect(e.ACP_TURN_TIMEOUT_MS).toBe(String(WORKER_TURN_TIMEOUT_MS))
  expect(cap.envs.length).toBeGreaterThanOrEqual(3) // ensure + call + close all saw it
})
```

- [ ] **Step 2:** Run → FAIL (env reaches deps without the override).
- [ ] **Step 3: Implement** — in `runWorkerCycle`, hoist the wrap ABOVE the `try` block (architect review Critical: a `const` declared inside `try` is block-scoped and NOT visible in the sibling `finally`; declaring it in-try is a tsc error, and the ad-hoc workaround — leaving `close(id, env)` unwrapped — would resolve discovery to the DEFAULT-fingerprint daemon, never close the real session on the worker's long-turn daemon, and wedge one ~140MB pool slot per cycle):

```ts
  const ensure = deps.ensure ?? ensureDaemon
  const call = deps.call ?? daemonCall
  const close = deps.close ?? closeSession
  const denv = workerDaemonEnv(env)  // hoisted: function scope, visible in try AND finally
```

Then switch all three daemon-touching call sites from `env` to `denv`: `ensure(denv, ...)` (currently :137), `call(prompt, args.model, denv, ...)` (currently :156), and `close(id, denv)` in the `finally` loop (currently :206).

- [ ] **Step 4:** Run file → PASS.
- [ ] **Step 5: Pin bumps** — both package.json lines to `git+https://github.com/th-yoo/cc-api-daemon.git#<SHA081>`; then `bun install` in `opencode-plugin/` and `cc-gate-plugin/` (side effect: replaces the node_modules copy carrying this session's `[warm-session DEBUG]` scratch instrumentation with the clean 0.8.1 tree).
- [ ] **Step 6:** `bunx tsc --noEmit` + full `bun test` in opencode-plugin, `bun test` in cc-gate-plugin → green.
- [ ] **Step 7: Commit** — `git add opencode-plugin/src/adapters/claude-code/proposer-worker.ts opencode-plugin/test/proposer-worker.test.ts opencode-plugin/package.json opencode-plugin/bun.lock cc-gate-plugin/package.json cc-gate-plugin/bun.lock && git commit -m "feat(worker): long-turn daemon env threaded through the proposer worker; cc-api-daemon pin 33f74db -> <SHA081> (0.8.1 honest worst-case advertisement)"`

### Task 5: live verification — the account-global crank end-to-end (SPEND)

**Files:** none modified (runtime verification). **Explicit user go required before this task (spend).**

- [ ] **Step 1: Clean debris from today's diagnosis** — kill any hand-launched daemon + stale discovery for this env: `DPID=$(python3 -c "import json;print(json.load(open('$HOME/.config/acpd/acp-a9d6826a9c49.json'))['pid'])" 2>/dev/null); kill $DPID 2>/dev/null; rm -f ~/.config/acpd/acp-a9d6826a9c49.json`. Verify no stale proposer lock survives: check `~/.config/kkamak/global/` for the 19:30 lock (it expired at spawnedAt+20min; `triggerPropose`'s stale-reclaim handles it, but confirm the staging dir `~/z2/meta-harness/.kkamak/staging/` carries no `account-global-v1-*` leftovers besides the prompt provenance — the staging pre-clean fix 6f3fde6 clears them on the next trigger anyway).
- [ ] **Step 2: Re-trigger** — `cd ~/z2/meta-harness && bun /private/tmp/claude-501/-Users-yoo-z2-meta-harness/d6664e82-eebc-4216-834e-5132b921274d/scratchpad/crank-account.ts` (the scratch driver from this session: ClaudeCodeHost + triggerPropose on account-global; recreate it from this plan's session notes if the scratchpad is gone — 12 lines).
- [ ] **Step 3: Watch** — background until-loop on `~/z2/meta-harness/.kkamak/staging/account-global-v*-provenance.json` appearing (worker success writes provenance; budget now 480s so allow ~10min; first cycle after an idle-reap pays a cold daemon start — not a hang). On worker failure: rerun foreground with the argsfile from `~/.config/kkamak/runtime/cc/proposer-args/` to read stderr — AND (final-review Important #3) note the Task 1 diagnostic is INVISIBLE on the auto-spawned lane: `defaultWorkerSpawn` ignores worker stderr and `spawnDaemonProcess` launches the daemon `>/dev/null 2>&1`. To actually read the diagnostic, hand-launch the worker-env daemon first (`ACP_TURN_TIMEOUT_MS=480000 bun node_modules/@th-yoo/cc-api-daemon/src/acp-daemon.ts >> <logfile> 2>&1 &` from opencode-plugin, after killing/removing the auto-spawned one's discovery entry for that fingerprint), THEN rerun the worker foreground. Follow-up candidate (recorded, not this plan): route worker/daemon stderr to a file under ccRuntimeDir().
- [ ] **Step 4: Verify the artifact** — provenance JSON has `retried` + `promptSha256`; staged ops/diagnosis parse; NO CC-harness markers in the reply (grep staged files for `CAVEMAN` and `superpowers` — must be absent; this is the migration's contamination acceptance re-run on the long-turn lane).
- [ ] **Step 5: Apply + candidate** — next hook event in a dogfood session applies the lock (`applyPendingArtifacts`); confirm `~/.config/kkamak/global/candidates/v1/` exists with playbook diff, then report the proposed bullet(s) to the user. Adoption stays gated: k=5 ab vs v0 is a SEPARATE user-approved spend.
- [ ] **Step 6: Close out** — update `docs/resume.md` (turn-budget fix landed, crank result, ab pending) and relay the daemon change + finding to the harness session (their migration artifact 77288bc gains an addendum pointer). Meta-harness merge/push per standing user-go rule.

## Architect review (2026-08-14, 1 round)

feature-dev:code-architect verified every load-bearing claim against both repos (fingerprint/denylist mechanics, spawn-env wholesale replacement, initialize `env` closure identity at acp-daemon.ts:374/468, §6e constants + existing test pins, client guard fail-closed pre-send, warm-lane turnTimeoutMs trace env→pool→session→timer, two-daemon coexistence: ephemeral ports + fingerprint-disjoint discovery/lock files). Findings, all amended inline above:
- **Critical (fixed)**: Task 4 Step 3 `denv` originally declared inside `try` — invisible in sibling `finally`; hoisted above `try`, all three call sites enumerated. Un-hoisted workaround would have closed sessions against the default daemon and wedged ~140MB pool slots on the worker daemon.
- **Important (fixed)**: `proposerTimeoutMin` has no floor tied to the turn budget — below ~17min every cycle refuses pre-send silently; documented in WORKER_TURN_TIMEOUT_MS comment + boundary test added.
- **Minor (fixed)**: Task 1 Step 6 now names the actual `spawnDaemon(home, spawnLog, extra, idleMs)` helper; Task 2 changelog step removed (file doesn't exist).
- **Noted, accepted**: second long-lived daemon costs baseline RSS (~140MB once its pool warms) until its idle timer reaps it — acceptable, now budgeted here.

## Self-Review

- **Spec coverage:** root cause (16s cap) → Tasks 1-4; client-guard soundness → Task 1 Steps 5-6; gauge/judge isolation → fingerprint mechanism (Task 3 doc comment + no judge changes anywhere); diagnosability debt → Task 1 Step 7; live proof → Task 5. Wedged-pool-slot and pool-exhaustion observations from the diagnosis are NOT fixed here — recorded as known daemon debt in Task 5 Step 6's relay (deliberate scope cut: neither blocks the crank once turns fit the budget).
- **Placeholder scan:** clean — every code step carries the code; Task 1 Step 6 names the pattern source, exact env, and exact assertion values.
- **Type consistency:** `workerDaemonEnv(env: Record<string, string | undefined>)` matches `runWorkerCycle`'s `env` param type and `envFingerprint`'s input type; `effectiveDaemonWorstCaseMs` consumes the same env shape as `parseTurnTimeoutMs`; `WORKER_TURN_TIMEOUT_MS` string-coerced at the env boundary (`String(...)`), numeric in arithmetic tests.
