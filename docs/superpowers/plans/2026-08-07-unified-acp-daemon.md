# Unified ACP Daemon Implementation Plan

> **STATUS 2026-08-07, READ BEFORE EXECUTING — the merge SHIPPED, but in the
> OTHER repo.** This plan bases the build in
> `meta-harness/cc-gate-plugin/src/acp`, per the spec's ruling. The user
> subsequently directed the work to run as a gated dogfood session in
> `~/z2/cc-api-daemon` instead, which inverts the base: rather than porting
> seven files from cc-api-daemon into cc-gate-plugin, it ports `WarmSession`
> the other way and adds the router there. That build is **done and pushed**
> — `f7488ee` (dual-backend budget floors) · `4037c8d` (WarmSession port) ·
> `0e48205` (`routeBackend`) · `7297297` (router wired into the dispatcher) ·
> `41aed77` (pool default → WarmSession) · `2d8a90c` (CLI credential-precedence
> lock) · `53bdb40` (`KKAMAK_GATE_FAST` test split). CI green, 247 tests.
>
> **What is still live in this document:** the Measured Parameters section
> (haiku billing lane, agent-lane peak concurrency, pool min=0/idle-reap
> already implemented) is authoritative and was not re-derived. So are the
> four rulings — dual-backend budget sizing, ApiSession-not-pooled,
> `models/list` via unbilled REST rather than `supportedModels()`, and the
> `WebSocket.send()` send-boundary hazard.
>
> **What is superseded:** Tasks 1–8's direction of travel. Bringing the proven
> result back into the deployed `cc-gate-plugin` is now a PORT of working code,
> not a from-scratch build — and it still requires the Task 12 discipline
> (boundary timestamp, explicit merge go, plugin version bump in the same
> change). Tasks 9–11 (the WebSocket transport swap of cc-gate-plugin's own
> client and daemon) remain unbuilt in either repo.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One ACP daemon in `cc-gate-plugin/src/acp` that routes each `session/prompt` by model — haiku to an in-process bare-SDK `ApiSession` (no subprocess), everything else to a pooled Agent-SDK `WarmSession` — over a localhost WebSocket transport, with the stdio transport preserved.

**Architecture:** Base is `meta-harness/cc-gate-plugin/src/acp` (deployed, has the subscription lane and the live consumers). `~/z2/cc-api-daemon` is the *source* of five ports: `auth.ts`, `client.ts`, `call.ts`, `api-session.ts`, `models.ts`, `jsonrpc.ts`, plus the WebSocket transport and discovery-file addressing. Both backends already satisfy the `DispatchableSession` contract, so routing is a dispatch-time selector, not a pool-construction change. The value lands in two independently deployable halves: **Tasks 1–8 = routing on the existing unix-socket transport**; **Tasks 9–11 = the WebSocket transport swap**.

**Tech Stack:** Bun (the plugin's hooks invoke `bun` directly), TypeScript, `@anthropic-ai/sdk` (bare, already a dependency), `@anthropic-ai/claude-agent-sdk` (already a dependency), `ws` (new dependency, server half only), `bun test`.

## Global Constraints

- **Base repo is `meta-harness/cc-gate-plugin`.** Never edit `~/z2/cc-api-daemon` — it is a read-only source of ports. Every path below is relative to `/home/th-yoo/z2/meta-harness` unless stated.
- **§6e send-boundary law is inviolable.** `no-call` means the prompt bytes provably never crossed toward the model. `call-consumed` means ambiguity after that boundary. Every new branch must classify into one of these, and when in doubt the answer is `call-consumed` (a wrongly-reported `no-call` makes a caller retry an already-billed turn).
- **Budgets are sized off the SLOWEST backend, never the fastest.** This daemon hosts both `WarmSession` (CLI subprocess, measured 1.25–1.46 s spawn) and `ApiSession` (HTTP, 10 s worst-case auth resolve). `ACP_BUDGET.daemonWorstCaseMs` stays **32_000** and `ACP_BUDGET.daemonLegMs` stays **36_000**. Do **not** adopt cc-api-daemon's 26_000/30_000 — those were sized for an ApiSession-only process, and importing them here under-budgets the WarmSession lane, which converts a `call-consumed` into a `no-call` (double spend).
- **Do not delete `CLI_SPAWN_BUDGET_MS`, `daemonLegMs`, `minFallbackMs`, or `recordBudgetMs`.** cc-api-daemon dropped all four. Live consumers here need them: `warm-session.ts:261`, `acp-client.ts:109`, `test/acp-wire.test.ts:104-125`, `test/acp-daemon.test.ts:1058,1077,1140`.
- **`createDispatcher` must never throw across a connection handler.** Every branch answers a JSON-RPC result or error frame, or (for a notification with no `id`) nothing.
- **Never spawn a subprocess to answer a metadata request.** `kkamak/models/list` must not grow the pool.
- **Test command:** `cd cc-gate-plugin && bun test <file>`. Typecheck: `cd cc-gate-plugin && bunx tsc --noEmit`.
- **No model-token spend in Tasks 1–11.** All tests are hermetic (stubs, fake daemons, injected `authDeps`). Task 12 is the only live-spend step and carries its own sized go.
- **Deployed instrument.** This is the live ACP daemon the review-sensor rides mid-checkpoint (due 2026-08-13). Landing requires: boundary timestamp recorded, explicit merge go, and a `cc-gate-plugin/package.json` version bump **in the same change** (merging ≠ deploying — the version-keyed plugin cache has bitten this repo twice).

## Measured Parameters (settled 2026-08-07, do not re-derive)

- **Haiku billing lane = SUBSCRIPTION, not API-tier pay-go.** On this host `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are both unset, so `resolveAuth` (cc-api-daemon `src/auth.ts:57-75`) falls through to `~/.claude/.credentials.json` and returns the Claude.ai OAuth `accessToken`, which `client.ts:44-51` sends as `authToken` plus `anthropic-beta: oauth-2025-04-20`. There is no org API key in this environment to bill pay-go against. **Caveat that Task 3 exists to enforce:** the precedence puts `ANTHROPIC_API_KEY` *first*, so any environment that sets it silently flips the lane to metered pay-go.
- **Agent-SDK-lane peak concurrency = 2.** The only `daemonCall` consumers are `src/gauge/providers/anthropic-cli-warm.ts` (serial, ~18/day) and `src/review-sensor/runner.ts` (single debounced dispatch, 30/day cap). There is no `Promise.all` over `daemonCall` anywhere. TB2 candidate runs use `term-bench2/runner.ts` with the opencode/claude-code drivers and never touch this lane. Peak 2 assumes gauge and review-sensor overlap at one Stop; realistic steady state is 1. → **pool max 4 → 2** (Task 8).
- **Adaptive pool min=0 and idle-reap already exist.** `SessionPool` never pre-spawns; `acquire()` spawns lazily under the cap (`acp-pool.ts:195-200`). `acp-daemon.ts:650-658` already ticks `pool.reap()` at `idleMs/3` and self-exits on idle+quiescent. The spec's item 3 reduces to resizing the cap.

---

### Task 1: Wire constants — dual-backend budgets and models/list codes

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-wire.ts`
- Test: `cc-gate-plugin/test/acp-wire.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AUTH_RESOLVE_BUDGET_MS: number` (10_000), `ACP_MODELS_LIST: string` (`"kkamak/models/list"`), `ACP_ERR_MODELS_NO_AUTH: number` (-32004), `ACP_ERR_MODELS_UPSTREAM_ERROR: number` (-32005), and `AcpInitializeResult._meta.kkamak.daemonWorstCaseMs?: number`. All existing exports (`ACP_BUDGET` with all seven legs, `CLI_SPAWN_BUDGET_MS`) keep their current names and values.

- [ ] **Step 1: Write the failing test**

Append to `cc-gate-plugin/test/acp-wire.test.ts`:

```ts
import {
  AUTH_RESOLVE_BUDGET_MS, ACP_MODELS_LIST,
  ACP_ERR_MODELS_NO_AUTH, ACP_ERR_MODELS_UPSTREAM_ERROR,
} from "../src/acp/acp-wire.ts"

describe("dual-backend budget floors", () => {
  test("both backend floors fit inside one turn budget", () => {
    // WarmSession floors turnTimeoutMs at CLI_SPAWN_BUDGET_MS; ApiSession
    // floors it at AUTH_RESOLVE_BUDGET_MS. One process hosts both, so the
    // shared turnTimeoutMs must clear the LARGER of the two.
    expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(CLI_SPAWN_BUDGET_MS)
    expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(AUTH_RESOLVE_BUDGET_MS)
    expect(AUTH_RESOLVE_BUDGET_MS).toBe(10_000)
  })

  test("worst case is sized off the SLOW backend, not the fast one", () => {
    // Regression guard against importing cc-api-daemon's ApiSession-only
    // numbers (26_000 / 30_000). Under-budgeting here turns a
    // call-consumed into a no-call, i.e. a retried billed turn.
    expect(ACP_BUDGET.daemonWorstCaseMs).toBe(32_000)
    expect(ACP_BUDGET.daemonLegMs).toBe(36_000)
  })

  test("models/list is namespaced and has its own non-spend error codes", () => {
    expect(ACP_MODELS_LIST).toBe("kkamak/models/list")
    expect(ACP_ERR_MODELS_NO_AUTH).toBe(-32004)
    expect(ACP_ERR_MODELS_UPSTREAM_ERROR).toBe(-32005)
    // Must NOT collide with the spend-risk codes or pool exhaustion.
    expect(new Set([ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, -32002,
      ACP_ERR_MODELS_NO_AUTH, ACP_ERR_MODELS_UPSTREAM_ERROR]).size).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts`
Expected: FAIL — `AUTH_RESOLVE_BUDGET_MS` is not exported from `acp-wire.ts`.

- [ ] **Step 3: Write minimal implementation**

In `cc-gate-plugin/src/acp/acp-wire.ts`, immediately after the existing `ACP_SESSION_CLOSE` export, add:

```ts
/** Model enumeration. Namespaced `kkamak/models/list`, NOT `models/list` —
 * ACP has `session/*` today and could plausibly add `models/*` tomorrow, so
 * a bare name would squat on one the spec might reserve. Stateless
 * metadata, not a turn: no session/new, no pool acquire, no backend
 * involvement — answered directly by the dispatcher. */
export const ACP_MODELS_LIST = "kkamak/models/list"
```

After the existing `ACP_ERR_CALL_CONSUMED` export, add:

```ts
/** `kkamak/models/list`'s own error codes — deliberately NOT the
 * no-call/call-consumed pair, which exists specifically to encode
 * BILLED-CALL spend risk. Model enumeration is unbilled and idempotent:
 * retrying costs nothing, so there is no spend boundary to protect and
 * borrowing that vocabulary would imply one. Not -32002/-32003 either:
 * -32002 already means "pool exhausted" on `session/prompt`. */
export const ACP_ERR_MODELS_NO_AUTH = -32004
export const ACP_ERR_MODELS_UPSTREAM_ERROR = -32005

/** The ApiSession backend's pre-HTTP floor, the exact structural twin of
 * `CLI_SPAWN_BUDGET_MS` for the other backend. Credential resolution
 * (keychain exec / credentials-file read) runs BEFORE the HTTP phase and
 * carries its own 10 s worst case (auth.ts's EXEC_TIMEOUT_MS), while a
 * turn's timer starts at the PUSH — so without this floor an ApiSession
 * cannot distinguish "generation failed" from "auth had not resolved yet".
 * BOTH floors are live: this process hosts both backends. */
export const AUTH_RESOLVE_BUDGET_MS = 10_000
```

In `AcpInitializeResult`, replace the `_meta` field with:

```ts
  _meta: {
    kkamak: {
      /** §6e instrument fingerprint — the client refuses a daemon whose
       * fingerprint differs from its own (pre-send => law L1 => no-call). */
      envFingerprint: string
      /** The daemon's own worst-case turn budget (`ACP_BUDGET.daemonWorstCaseMs`).
       * ADDITIVE and OPTIONAL: a daemon predating this field is exactly as
       * safe as it was, and a client ignoring it is too. Present so the
       * `daemonLegMs > daemonWorstCaseMs` contract stays checkable when a
       * client and daemon are built from different commits. */
      daemonWorstCaseMs?: number
    }
  }
```

Leave `ACP_BUDGET` and `CLI_SPAWN_BUDGET_MS` byte-for-byte unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts`
Expected: PASS, all tests including the pre-existing budget-contract tests.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/acp-wire.ts cc-gate-plugin/test/acp-wire.test.ts
git commit -m "feat(acp): dual-backend budget floors + kkamak/models/list codes"
```

---

### Task 2: `session-contract.ts` — the backend-neutral dispatch contract

**Files:**
- Create: `cc-gate-plugin/src/acp/session-contract.ts`
- Modify: `cc-gate-plugin/src/acp/acp-daemon.ts:92` (delete the local `DispatchableWarm` alias), `cc-gate-plugin/src/acp/acp-daemon.ts:113,307`
- Modify: `cc-gate-plugin/src/acp/index.ts`
- Test: `cc-gate-plugin/test/session-contract.test.ts` (create)

**Interfaces:**
- Consumes: `WarmIsolation` from `acp-wire.ts`, `WarmSessionLike` from `acp-pool.ts`.
- Produces: `TurnOutcome`, `CancelResult`, `DispatchableSession` — exported from `./session-contract.ts`. `TurnOutcome` moves here from `warm-session.ts`; `warm-session.ts` must re-export it so its existing importers do not break.

- [ ] **Step 1: Write the failing test**

Create `cc-gate-plugin/test/session-contract.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { WarmSession } from "../src/acp/warm-session.ts"
import type { DispatchableSession } from "../src/acp/session-contract.ts"
import { GAUGE_ISOLATION } from "../src/acp/acp-wire.ts"

describe("DispatchableSession", () => {
  test("WarmSession satisfies the contract structurally", () => {
    // Type-level assertion: this line fails to COMPILE if WarmSession ever
    // drifts from the contract. The runtime assertions below only prove the
    // members exist; `bunx tsc --noEmit` is what proves the signatures.
    const assertSatisfies = (s: DispatchableSession): DispatchableSession => s
    const w = new WarmSession({}, {
      isolation: GAUGE_ISOLATION,
      turnTimeoutMs: 16_000, queueWaitMs: 6_000,
      clearTimeoutMs: 4_000, setModelMs: 2_000, hardGraceMs: 4_000,
    })
    const s = assertSatisfies(w)
    expect(typeof s.oneShot).toBe("function")
    expect(typeof s.cancel).toBe("function")
    expect(typeof s.turnInFlight).toBe("function")
    expect(typeof s.close).toBe("function")
    expect(s.isolation).toEqual(GAUGE_ISOLATION)
    s.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/session-contract.test.ts`
Expected: FAIL — cannot resolve module `../src/acp/session-contract.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `cc-gate-plugin/src/acp/session-contract.ts`:

```ts
// session-contract.ts — the backend-neutral dispatch contract.
//
// acp-daemon.ts previously typed dispatch as
// `WarmSessionLike & Pick<WarmSession, "oneShot" | "cancel">`, borrowing
// signatures off the concrete agent-SDK class so the type could not drift
// from it. With two backends there is no single concrete class to borrow
// from, so the contract is stated once here and BOTH implementations
// (WarmSession, ApiSession) are checked against it.
import type { WarmIsolation } from "./acp-wire.ts"
import type { WarmSessionLike } from "./acp-pool.ts"

/** §6e send-boundary law, unchanged across backends. `model`/`canonicalModel`
 * are EVIDENCE the caller reconciles with `modelProvenBy` — never a verdict. */
export type TurnOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

/** `queued-dropped` — never reached the wire, nothing spent.
 *  `unsent-dropped` — dequeued but the request was not yet entered.
 *  `interrupted`    — the request was in flight and was aborted; MAY have spent.
 *  `unknown`        — no turn matched the tag. */
export type CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"

/** What the DAEMON needs off a session. Wider than `WarmSessionLike`, which
 * is deliberately narrow to what the POOL itself calls (reap / quiescent /
 * closeAll); `oneShot` and `cancel` are called only by whoever acquired the
 * entry, which from the pool onward is the daemon. */
export interface DispatchableSession extends WarmSessionLike {
  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome>
  cancel(tag: string): CancelResult
  readonly isolation: WarmIsolation
}
```

In `cc-gate-plugin/src/acp/warm-session.ts`, replace the local `TurnOutcome` declaration with a re-export so existing importers keep working:

```ts
export type { TurnOutcome, CancelResult } from "./session-contract.ts"
import type { TurnOutcome, CancelResult } from "./session-contract.ts"
```

In `cc-gate-plugin/src/acp/acp-daemon.ts`, delete line 92 (`type DispatchableWarm = ...`) and its now-unused `WarmSession` type import, then replace both usages:

```ts
// line 92 region — replace the local alias with the shared contract
import type { TurnOutcome, DispatchableSession } from "./session-contract.ts"

// line 113 — DaemonState.outstanding
  outstanding: Map<string, Array<{ tag: string; warm: DispatchableSession }>>

// line 307 — inside ACP_SESSION_PROMPT
          const warm = entry.warm as unknown as DispatchableSession
```

In `cc-gate-plugin/src/acp/index.ts`, add:

```ts
export type { TurnOutcome, CancelResult, DispatchableSession } from "./session-contract.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/session-contract.test.ts && bunx tsc --noEmit && bun test test/acp-daemon.test.ts test/warm-session.test.ts`
Expected: PASS on all three, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/session-contract.ts cc-gate-plugin/src/acp/warm-session.ts \
        cc-gate-plugin/src/acp/acp-daemon.ts cc-gate-plugin/src/acp/index.ts \
        cc-gate-plugin/test/session-contract.test.ts
git commit -m "refactor(acp): extract DispatchableSession contract from WarmSession"
```

---

### Task 3: `auth.ts` port + the billing-lane guard

**Files:**
- Create: `cc-gate-plugin/src/acp/auth.ts` (port of `~/z2/cc-api-daemon/src/auth.ts`, verbatim, plus one added export)
- Test: `cc-gate-plugin/test/acp-auth.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveAuth(env, deps?): ResolvedAuth | undefined`, `type ResolvedAuth = { apiKey: string } | { authToken: string }`, `type AuthDeps = { platform?, home?, exec?, readFile? }`, and `authLane(auth): "api-tier" | "subscription"`.

**Why the added export:** the measured finding is that this host resolves to the OAuth token (subscription), but the precedence puts `ANTHROPIC_API_KEY` first, so a stray env var silently flips the haiku route onto metered pay-go. `authLane` makes that observable instead of invisible; Task 6 logs it once at daemon boot.

- [ ] **Step 1: Write the failing test**

Create `cc-gate-plugin/test/acp-auth.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { resolveAuth, authLane } from "../src/acp/auth.ts"

const NOFILE = () => { throw new Error("ENOENT") }

describe("resolveAuth precedence", () => {
  test("ANTHROPIC_API_KEY wins and reports the metered lane", () => {
    const a = resolveAuth({ ANTHROPIC_API_KEY: "sk-x" }, { readFile: NOFILE })
    expect(a).toEqual({ apiKey: "sk-x" })
    expect(authLane(a!)).toBe("api-tier")
  })

  test("credentials-file OAuth token reports the subscription lane", () => {
    const a = resolveAuth(
      { HOME: "/h" },
      { platform: "linux", readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "oat-1" } }) },
    )
    expect(a).toEqual({ authToken: "oat-1" })
    expect(authLane(a!)).toBe("subscription")
  })

  test("no credential anywhere resolves undefined, never throws", () => {
    expect(resolveAuth({}, { platform: "linux", readFile: NOFILE })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-auth.test.ts`
Expected: FAIL — cannot resolve module `../src/acp/auth.ts`.

- [ ] **Step 3: Write minimal implementation**

Copy `~/z2/cc-api-daemon/src/auth.ts` to `cc-gate-plugin/src/acp/auth.ts` verbatim (79 lines, no edits needed — it has no imports outside `node:child_process`, `node:fs`, `node:os`), then append:

```ts
/** Which billing lane a resolved credential puts the bare-SDK backend on.
 * MEASURED 2026-08-07: with neither env var set, resolution falls through
 * to `~/.claude/.credentials.json` and returns the Claude.ai OAuth
 * accessToken — a subscription credential, with no org API key present to
 * bill pay-go against. An `ANTHROPIC_API_KEY` in the environment takes
 * precedence above and flips the haiku route onto METERED pay-go
 * ($1/$5 per Mtok). That flip must be observable, not silent — the daemon
 * logs this once at boot. */
export function authLane(auth: ResolvedAuth): "api-tier" | "subscription" {
  return "apiKey" in auth ? "api-tier" : "subscription"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-auth.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/auth.ts cc-gate-plugin/test/acp-auth.test.ts
git commit -m "feat(acp): port credential resolution + authLane billing guard"
```

---

### Task 4: `client.ts` + `call.ts` — the bare-SDK turn

**Files:**
- Create: `cc-gate-plugin/src/acp/api-client.ts` (port of `~/z2/cc-api-daemon/src/client.ts`, renamed to avoid colliding with the existing `acp-client.ts`)
- Create: `cc-gate-plugin/src/acp/call.ts` (port of `~/z2/cc-api-daemon/src/call.ts`)
- Test: `cc-gate-plugin/test/acp-call.test.ts` (create), reusing the stub-server helpers from `~/z2/cc-api-daemon/test/helpers.ts`

**Interfaces:**
- Consumes: `resolveAuth` / `AuthDeps` (Task 3), `TurnOutcome` (Task 2), `WarmIsolation` and `ACP_BUDGET` (Task 1).
- Produces: `buildClient(env, opts): { client: Anthropic } | { kind: "no-auth" }`, and `sendOne(text, model, env, opts): Promise<TurnOutcome>` where `opts: { isolation: WarmIsolation; budgetMs: number; authDeps?: AuthDeps; signal?: AbortSignal; messages: Array<{ role: "user" | "assistant"; content: string }> }`.

- [ ] **Step 1: Write the failing test**

Copy `~/z2/cc-api-daemon/test/helpers.ts` to `cc-gate-plugin/test/api-helpers.ts` (it stands up a local stub HTTP server and points `ANTHROPIC_BASE_URL` at it, so no real API is touched), then create `cc-gate-plugin/test/acp-call.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { sendOne } from "../src/acp/call.ts"
import { GAUGE_ISOLATION, ACP_BUDGET } from "../src/acp/acp-wire.ts"
import { startStub, stopStub, setRespond, okBody, apiKeyEnv } from "./api-helpers.ts"

beforeEach(startStub)
afterEach(stopStub)

describe("sendOne", () => {
  test("a 200 response is an ok outcome carrying model evidence", async () => {
    setRespond(() => okBody("hello", "claude-haiku-4-5-20251001"))
    const out = await sendOne("hi", "claude-haiku-4-5", apiKeyEnv(), {
      isolation: GAUGE_ISOLATION,
      budgetMs: ACP_BUDGET.turnTimeoutMs,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.text).toBe("hello")
      expect(out.canonicalModel).toBe("claude-haiku-4-5-20251001")
    }
  })

  test("missing credentials are a provable no-call — nothing reached the wire", async () => {
    const out = await sendOne("hi", "claude-haiku-4-5", { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }, {
      isolation: GAUGE_ISOLATION,
      budgetMs: ACP_BUDGET.turnTimeoutMs,
      authDeps: { platform: "linux", readFile: () => { throw new Error("ENOENT") } },
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.kind).toBe("no-call")
  })

  test("an upstream 500 AFTER the request was entered is call-consumed", async () => {
    setRespond(() => ({ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }))
    const out = await sendOne("hi", "claude-haiku-4-5", apiKeyEnv(), {
      isolation: GAUGE_ISOLATION,
      budgetMs: ACP_BUDGET.turnTimeoutMs,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.kind).toBe("call-consumed")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-call.test.ts`
Expected: FAIL — cannot resolve module `../src/acp/call.ts`.

- [ ] **Step 3: Write minimal implementation**

Copy `~/z2/cc-api-daemon/src/client.ts` to `cc-gate-plugin/src/acp/api-client.ts` and change its one relative import to the local `./auth.ts`. Copy `~/z2/cc-api-daemon/src/call.ts` to `cc-gate-plugin/src/acp/call.ts` and rewrite its import header to:

```ts
import { buildClient } from "./api-client.ts"
import type { AuthDeps } from "./auth.ts"
import { ACP_BUDGET, type WarmIsolation } from "./acp-wire.ts"
import type { TurnOutcome } from "./session-contract.ts"
```

`call.ts`'s own body needs no logic change — its outcome classification is already the §6e law this repo enforces: everything before `messages.create` is entered resolves `no-call`, everything after resolves `ok` or `call-consumed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-call.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/api-client.ts cc-gate-plugin/src/acp/call.ts \
        cc-gate-plugin/test/api-helpers.ts cc-gate-plugin/test/acp-call.test.ts
git commit -m "feat(acp): port bare-SDK client + sendOne turn"
```

---

### Task 5: `ApiSession` — the in-process backend

**Files:**
- Create: `cc-gate-plugin/src/acp/api-session.ts` (port of `~/z2/cc-api-daemon/src/api-session.ts`, 162 lines)
- Test: `cc-gate-plugin/test/api-session.test.ts` (create)

**Interfaces:**
- Consumes: `sendOne` (Task 4), `DispatchableSession` / `TurnOutcome` / `CancelResult` (Task 2), `AUTH_RESOLVE_BUDGET_MS` (Task 1), `WarmConstructOpts` from `acp-pool.ts`.
- Produces: `class ApiSession implements DispatchableSession`, constructed as `new ApiSession(env, opts)` where `opts: WarmConstructOpts & { cwd?: string; authDeps?: AuthDeps }`.

- [ ] **Step 1: Write the failing test**

Create `cc-gate-plugin/test/api-session.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ApiSession } from "../src/acp/api-session.ts"
import type { DispatchableSession } from "../src/acp/session-contract.ts"
import { GAUGE_ISOLATION, AUTH_RESOLVE_BUDGET_MS } from "../src/acp/acp-wire.ts"
import { startStub, stopStub, setRespond, okBody, apiKeyEnv } from "./api-helpers.ts"

beforeEach(startStub)
afterEach(stopStub)

const OPTS = {
  isolation: GAUGE_ISOLATION,
  turnTimeoutMs: 16_000, queueWaitMs: 6_000,
  clearTimeoutMs: 4_000, setModelMs: 2_000, hardGraceMs: 4_000,
}

describe("ApiSession", () => {
  test("satisfies DispatchableSession and floors its turn budget at the auth floor", async () => {
    const assertSatisfies = (s: DispatchableSession): DispatchableSession => s
    const s = assertSatisfies(new ApiSession(apiKeyEnv(), { ...OPTS, turnTimeoutMs: 1_000 }))
    setRespond(() => okBody("ok", "claude-haiku-4-5-20251001"))
    // A 1_000 ms request budget would be BELOW the 10 s auth floor; the
    // constructor must raise it, or a correct implementation times out.
    const out = await s.oneShot("hi", "claude-haiku-4-5", { recycle: false })
    expect(out.kind).toBe("ok")
    expect(AUTH_RESOLVE_BUDGET_MS).toBe(10_000)
    s.close()
  })

  test("history accumulates across turns and recycle clears it", async () => {
    const s = new ApiSession(apiKeyEnv(), OPTS)
    const seen: number[] = []
    setRespond((req) => {
      seen.push((JSON.parse(req.body) as { messages: unknown[] }).messages.length)
      return okBody("a", "claude-haiku-4-5-20251001")
    })
    await s.oneShot("one", "claude-haiku-4-5", { recycle: false })
    await s.oneShot("two", "claude-haiku-4-5", { recycle: false })
    await s.oneShot("three", "claude-haiku-4-5", { recycle: true })
    expect(seen).toEqual([1, 3, 1])
    s.close()
  })

  test("cancel of a queued turn is queued-dropped and settles it no-call", async () => {
    const s = new ApiSession(apiKeyEnv(), OPTS)
    let release: (() => void) | undefined
    setRespond(async () => {
      await new Promise<void>((r) => { release = r })
      return okBody("a", "claude-haiku-4-5-20251001")
    })
    const first = s.oneShot("one", "claude-haiku-4-5", { recycle: false, tag: "t1" })
    const second = s.oneShot("two", "claude-haiku-4-5", { recycle: false, tag: "t2" })
    // t2 is still queued behind the in-flight t1.
    expect(s.cancel("t2")).toBe("queued-dropped")
    expect((await second).kind).toBe("no-call")
    release?.()
    expect((await first).kind).toBe("ok")
    s.close()
  })

  test("close settles an in-flight turn call-consumed, never no-call", async () => {
    const s = new ApiSession(apiKeyEnv(), OPTS)
    setRespond(() => new Promise(() => { /* never resolves */ }))
    const p = s.oneShot("hi", "claude-haiku-4-5", { recycle: false })
    await Bun.sleep(20)
    s.close()
    expect((await p).kind).toBe("call-consumed")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/api-session.test.ts`
Expected: FAIL — cannot resolve module `../src/acp/api-session.ts`.

- [ ] **Step 3: Write minimal implementation**

Copy `~/z2/cc-api-daemon/src/api-session.ts` to `cc-gate-plugin/src/acp/api-session.ts` verbatim. Its import header already names exactly the modules this repo now has; no edits required:

```ts
import { sendOne } from "./call.ts"
import type { AuthDeps } from "./auth.ts"
import { ACP_BUDGET, AUTH_RESOLVE_BUDGET_MS, type WarmIsolation } from "./acp-wire.ts"
import type { WarmConstructOpts } from "./acp-pool.ts"
import type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/api-session.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/api-session.ts cc-gate-plugin/test/api-session.test.ts
git commit -m "feat(acp): port ApiSession in-process backend"
```

---

### Task 6: Model routing at dispatch — haiku bypasses the pool entirely

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-daemon.ts` (`DaemonState`, `createDispatcher`'s `ACP_SESSION_PROMPT` case, `runSocket`'s boot log)
- Create: `cc-gate-plugin/src/acp/route.ts`
- Test: `cc-gate-plugin/test/acp-route.test.ts` (create), `cc-gate-plugin/test/acp-daemon.test.ts` (extend)

**Interfaces:**
- Consumes: `ApiSession` (Task 5), `DispatchableSession` (Task 2), `authLane`/`resolveAuth` (Task 3).
- Produces: `routeBackend(model: string): "api" | "agent"` from `./route.ts`. `DaemonState.sessions` values gain an `api?: ApiSession` field.

**Design ruling this task locks in:** haiku sessions do **not** go through `SessionPool`. `ApiSession` holds its own conversation history, and `daemonCall` opens exactly one `initialize` + `session/new` + `session/prompt` per call (`acp-client.ts:216-240`), so a per-ACP-session `ApiSession` is born fresh, serves its turns, and dies with the session — no cross-session recycle question arises, and `recycle` is passed through as the caller sent it. The pool exists to amortize a 140 MB subprocess; an `ApiSession` is a plain object with an array in it, so pooling it would add contention for nothing.

- [ ] **Step 1: Write the failing test**

Create `cc-gate-plugin/test/acp-route.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { routeBackend } from "../src/acp/route.ts"

describe("routeBackend", () => {
  test("every haiku spelling routes to the in-process API backend", () => {
    expect(routeBackend("claude-haiku-4-5-20251001")).toBe("api")
    expect(routeBackend("claude-haiku-4-5")).toBe("api")
    expect(routeBackend("haiku")).toBe("api")
  })

  test("everything else routes to the pooled Agent-SDK backend", () => {
    // The bare-SDK transport 429s on these (measured twice, 2026-08-06 and
    // 2026-08-07) — routing them to the API backend would hard-fail every
    // opus candidate turn.
    expect(routeBackend("claude-opus-5")).toBe("agent")
    expect(routeBackend("claude-sonnet-5")).toBe("agent")
    expect(routeBackend("claude-fable-5")).toBe("agent")
    expect(routeBackend("opus")).toBe("agent")
    expect(routeBackend("")).toBe("agent")
    expect(routeBackend("some-unknown-model")).toBe("agent")
  })
})
```

Append to `cc-gate-plugin/test/acp-daemon.test.ts` (the file already builds a dispatcher against a fake pool; follow its existing `makeSession` injection style):

```ts
test("a haiku prompt never touches the pool", async () => {
  let acquires = 0
  const pool = { acquire: () => { acquires++; return { ok: false, reason: "pool-exhausted" } },
                 release: () => {}, reap: () => [], quiescent: () => true, closeAll: () => {} }
  const state = createDaemonState()
  const sent: string[] = []
  const dispatch = createDispatcher(pool as never, state, "fp", {}, {
    makeApiSession: () => ({
      isolation: GAUGE_ISOLATION,
      turnInFlight: () => false, close: () => {},
      cancel: () => "unknown" as const,
      oneShot: async (t: string) => { sent.push(t); return {
        kind: "ok" as const, text: "hi", model: "claude-haiku-4-5",
        canonicalModel: "claude-haiku-4-5-20251001" } },
    }),
  })
  const frames: unknown[] = []
  const write = (m: unknown) => { frames.push(m) }
  await dispatch({ jsonrpc: "2.0", id: 1, method: "session/new",
    params: { _meta: { kkamak: { isolation: GAUGE_ISOLATION } } } }, write)
  const sessionId = (frames[0] as { result: { sessionId: string } }).result.sessionId
  await dispatch({ jsonrpc: "2.0", id: 2, method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "q" }],
              _meta: { kkamak: { model: "claude-haiku-4-5" } } } }, write)
  expect(acquires).toBe(0)          // the pool was never asked
  expect(sent).toEqual(["q"])       // the ApiSession served it
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-route.test.ts test/acp-daemon.test.ts`
Expected: FAIL — cannot resolve `../src/acp/route.ts`; and `createDispatcher` takes 3 arguments, not 5.

- [ ] **Step 3: Write minimal implementation**

Create `cc-gate-plugin/src/acp/route.ts`:

```ts
// route.ts — which backend serves a given model.
//
// MEASURED CONSTRAINT (2026-08-06 and 2026-08-07, twice): the bare-SDK
// transport serves haiku (HTTP 200) but 429s on sonnet-5 / opus-5 /
// fable-5, while the Agent-SDK lane serves all of them. The routing is
// therefore not a preference — sending a non-haiku model to the API
// backend hard-fails the turn. DEFAULT IS `agent`: an unrecognized model
// goes to the lane that is known to serve everything, so a new model id
// degrades to "heavier than necessary", never to "429".
export function routeBackend(model: string): "api" | "agent" {
  return /(^|[-_/])haiku([-_.]|$)/i.test(model) ? "api" : "agent"
}
```

In `cc-gate-plugin/src/acp/acp-daemon.ts`, widen the session map and the dispatcher signature:

```ts
import { ApiSession } from "./api-session.ts"
import { routeBackend } from "./route.ts"
import { resolveAuth, authLane } from "./auth.ts"

// DaemonState.sessions — the ApiSession is lazily minted on the first
// haiku prompt and lives exactly as long as the ACP session does.
  sessions: Map<string, { createdAt: number; isolation: WarmIsolation; api?: DispatchableSession }>

export function createDispatcher(
  pool: SessionPool,
  state: DaemonState,
  fingerprint: string,
  env: Record<string, string | undefined> = {},
  opts?: {
    makeApiSession?: (
      env: Record<string, string | undefined>,
      warmOpts: WarmConstructOpts,
    ) => DispatchableSession
  },
) {
```

Inside the `ACP_SESSION_PROMPT` case, after the existing `text` is read and **before** `pool.acquire`, insert the route fork. The agent branch is the existing code verbatim; only the API branch is new:

```ts
          // ROUTE. The API backend is in-process (no subprocess, ~0
          // incremental RSS) and holds its own history, so it is minted
          // per ACP SESSION and never pooled — the pool exists to amortize
          // a ~140 MB subprocess, which this backend does not have.
          if (routeBackend(model) === "api") {
            if (!session.api) {
              const make = opts?.makeApiSession ?? ((e, w) => new ApiSession(e, w))
              session.api = make(env, {
                isolation: session.isolation,
                turnTimeoutMs: ACP_BUDGET.turnTimeoutMs,
                queueWaitMs: ACP_BUDGET.queueWaitMs,
                clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
                setModelMs: ACP_BUDGET.setModelMs,
                hardGraceMs: ACP_BUDGET.hardGraceMs,
              })
            }
            const apiSession = session.api
            const apiTag = crypto.randomUUID()
            const apiOutstanding = state.outstanding.get(sessionId) ?? []
            apiOutstanding.push({ tag: apiTag, warm: apiSession })
            state.outstanding.set(sessionId, apiOutstanding)
            mayHaveConsumed = true
            try {
              // `recycle: false` — this ApiSession belongs to exactly one
              // ACP session, so there is no other session's context to
              // clear. The pool's cross-session recycle rule has no
              // analogue here.
              const outcome = await apiSession.oneShot(text, model, { recycle: false, tag: apiTag })
              respondTurnOutcome(outcome, sessionId, respond, respondError, write)
            } finally {
              state.outstanding.set(
                sessionId,
                (state.outstanding.get(sessionId) ?? []).filter((o) => o.tag !== apiTag),
              )
            }
            return
          }
```

Extract the existing `outcome.kind` switch (currently inline at `acp-daemon.ts:337-...`) into a module-level `respondTurnOutcome(outcome, sessionId, respond, respondError, write)` helper and call it from **both** branches, so the two lanes cannot drift in how they report `ok` / `no-call` / `call-consumed`.

Extend `session/close` (and the `DaemonState` teardown path) to call `session.api?.close()` so an abandoned haiku session releases its history.

In `runSocket`, immediately after the pool is constructed, log the resolved lane once:

```ts
  // Boot-time billing-lane disclosure. MEASURED 2026-08-07: with no
  // ANTHROPIC_API_KEY set this resolves to the Claude.ai OAuth token
  // (subscription). An API key in the environment silently flips the
  // haiku route onto metered pay-go — this line is what makes that
  // visible in the daemon's own stderr instead of on an invoice.
  const bootAuth = resolveAuth(env)
  process.stderr.write(
    `[acp] api-backend lane: ${bootAuth ? authLane(bootAuth) : "unresolved"}\n`,
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-route.test.ts test/acp-daemon.test.ts && bunx tsc --noEmit`
Expected: PASS, including every pre-existing `acp-daemon.test.ts` case (the agent branch is unchanged).

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/route.ts cc-gate-plugin/src/acp/acp-daemon.ts \
        cc-gate-plugin/test/acp-route.test.ts cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(acp): route haiku to in-process ApiSession, others to the pool"
```

---

### Task 7: `kkamak/models/list`

**Files:**
- Create: `cc-gate-plugin/src/acp/models.ts` (port of `~/z2/cc-api-daemon/src/models.ts`)
- Modify: `cc-gate-plugin/src/acp/acp-daemon.ts` (new dispatcher case)
- Test: `cc-gate-plugin/test/acp-models.test.ts` (create)

**Interfaces:**
- Consumes: `buildClient` (Task 4), `ACP_MODELS_LIST` / `ACP_ERR_MODELS_NO_AUTH` / `ACP_ERR_MODELS_UPSTREAM_ERROR` (Task 1).
- Produces: `listModels(env, opts?): Promise<ModelListOutcome>` and `retrieveModel(id, env, opts?): Promise<ModelRetrieveOutcome>`.

**Spec deviation, stated:** the spec names `query().supportedModels()` as primary with REST as fallback. `supportedModels()` is a method on a live `Query` (`sdk.d.ts:2411`), so making it primary means **spawning a ~140 MB claude subprocess to answer a metadata request** — the exact cost this whole merge exists to avoid. This task therefore makes the unbilled in-process `GET /v1/models` primary, and reaches for `supportedModels()` only when the pool already holds an idle warm entry (never spawning one). Same information, no spawn.

- [ ] **Step 1: Write the failing test**

Create `cc-gate-plugin/test/acp-models.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { listModels } from "../src/acp/models.ts"
import { startStub, stopStub, setRespond, apiKeyEnv } from "./api-helpers.ts"

beforeEach(startStub)
afterEach(stopStub)

describe("listModels", () => {
  test("drains every page into one flat array", async () => {
    let page = 0
    setRespond(() => {
      page++
      return page === 1
        ? { status: 200, body: JSON.stringify({ data: [{ id: "claude-haiku-4-5" }], has_more: true, last_id: "claude-haiku-4-5" }) }
        : { status: 200, body: JSON.stringify({ data: [{ id: "claude-opus-5" }], has_more: false }) }
    })
    const out = await listModels(apiKeyEnv())
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.models.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-5"])
  })

  test("no credential is no-auth, never an error or a throw", async () => {
    const out = await listModels(
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      { authDeps: { platform: "linux", readFile: () => { throw new Error("ENOENT") } } },
    )
    expect(out.kind).toBe("no-auth")
  })

  test("an upstream failure reports status, never throws", async () => {
    setRespond(() => ({ status: 503, body: JSON.stringify({ error: { message: "down" } }) }))
    const out = await listModels(apiKeyEnv())
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.status).toBe(503)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-models.test.ts`
Expected: FAIL — cannot resolve `../src/acp/models.ts`.

- [ ] **Step 3: Write minimal implementation**

Copy `~/z2/cc-api-daemon/src/models.ts` to `cc-gate-plugin/src/acp/models.ts`, changing only its `buildClient` import to `./api-client.ts`.

In `acp-daemon.ts`'s dispatcher switch, add a case beside the existing ones:

```ts
        case ACP_MODELS_LIST: {
          // Stateless metadata: no session, no pool acquire, no spawn.
          // `GET /v1/models` is unbilled and idempotent, which is why this
          // case answers with its OWN error codes rather than the
          // no-call/call-consumed spend-risk pair — there is no spend
          // boundary here to protect.
          const outcome = await listModels(env)
          if (outcome.kind === "ok") { respond({ models: outcome.models }); return }
          if (outcome.kind === "no-auth") {
            respondError(ACP_ERR_MODELS_NO_AUTH, "no usable credential for model enumeration")
            return
          }
          respondError(
            ACP_ERR_MODELS_UPSTREAM_ERROR,
            `model enumeration failed${outcome.status ? ` (HTTP ${outcome.status})` : ""}`,
          )
          return
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-models.test.ts test/acp-daemon.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/models.ts cc-gate-plugin/src/acp/acp-daemon.ts \
        cc-gate-plugin/test/acp-models.test.ts
git commit -m "feat(acp): kkamak/models/list via unbilled GET /v1/models"
```

---

### Task 8: Pool cap resize — 4 → 2

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-pool.ts:71` (`DEFAULT_MAX_SESSIONS`)
- Test: `cc-gate-plugin/test/acp-pool.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `DEFAULT_MAX_SESSIONS` becomes 2; `KKAMAK_ACP_MAX_SESSIONS` still overrides.

- [ ] **Step 1: Write the failing test**

Append to `cc-gate-plugin/test/acp-pool.test.ts`:

```ts
test("default cap matches the MEASURED agent-lane peak, not the old guess", () => {
  // Measured 2026-08-07: the only daemonCall consumers are the gauge warm
  // provider (serial) and the review-sensor runner (single debounced
  // dispatch). No Promise.all over daemonCall exists anywhere, and TB2
  // candidate runs never touch this lane. Peak = 2 (both firing at one
  // Stop). The old default of 4 reserved ~280 MB of headroom for
  // concurrency that no caller can produce.
  const pool = new SessionPool({}, { makeSession: () => fakeSession() })
  const a = pool.acquire(GAUGE_ISOLATION, 1)
  const b = pool.acquire(OTHER_ISOLATION, 2)
  const c = pool.acquire(THIRD_ISOLATION, 3)
  expect(a.ok).toBe(true)
  expect(b.ok).toBe(true)
  expect(c.ok).toBe(false)
})

test("KKAMAK_ACP_MAX_SESSIONS still raises the cap", () => {
  const pool = new SessionPool({ KKAMAK_ACP_MAX_SESSIONS: "4" }, { makeSession: () => fakeSession() })
  expect(pool.acquire(GAUGE_ISOLATION, 1).ok).toBe(true)
  expect(pool.acquire(OTHER_ISOLATION, 2).ok).toBe(true)
  expect(pool.acquire(THIRD_ISOLATION, 3).ok).toBe(true)
  expect(pool.acquire(FOURTH_ISOLATION, 4).ok).toBe(true)
})
```

Reuse whatever `fakeSession()` and the distinct-isolation fixtures the existing file already defines; if it defines fewer than four distinct isolations, add them by varying one `WarmIsolation` field (the pool keys on deep equality).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-pool.test.ts`
Expected: FAIL — the third acquire succeeds because the default cap is still 4.

- [ ] **Step 3: Write minimal implementation**

In `cc-gate-plugin/src/acp/acp-pool.ts`, replace the `DEFAULT_MAX_SESSIONS` declaration and its comment:

```ts
/** Cap default 2 — MEASURED 2026-08-07, not asserted. The agent-SDK lane's
 * only callers are the gauge warm provider (serial, ~18/day) and the
 * review-sensor runner (one debounced dispatch, 30/day cap); no `Promise.all`
 * over `daemonCall` exists anywhere, and TB2 candidate runs use a different
 * driver entirely. Peak concurrency is therefore 2 — both firing at one Stop
 * — with a steady state of 1. The prior default of 4 (2026-08-05, sized off
 * host memory rather than off demand) reserved ~280 MB for concurrency no
 * caller can produce. A host that genuinely fans out raises it via
 * `KKAMAK_ACP_MAX_SESSIONS`; the memory headroom that justified 4 is
 * unchanged, this is a demand-side correction. */
const DEFAULT_MAX_SESSIONS = 2
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-pool.test.ts test/acp-daemon.test.ts`
Expected: PASS. If a pre-existing daemon test assumed a 4-deep pool, set `KKAMAK_ACP_MAX_SESSIONS: "4"` in that test's env rather than reverting the default.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/acp-pool.ts cc-gate-plugin/test/acp-pool.test.ts
git commit -m "perf(acp): pool cap 4 -> 2, sized off measured agent-lane peak"
```

**Deployable checkpoint.** Tasks 1–8 are complete and self-consistent on the existing unix-socket transport. If the transport swap is deferred, this is a landable unit — subject to the Task 12 deploy checklist.

---

### Task 9: Discovery-file addressing

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-paths.ts`
- Test: `cc-gate-plugin/test/acp-paths.test.ts`

**Interfaces:**
- Consumes: `envFingerprint` (already in the file).
- Produces: `discoveryPath(env): string`, `interface DiscoveryInfo { port: number; pid: number }`, `readDiscovery(env): DiscoveryInfo | undefined`, `writeDiscovery(env, info): void`, `wsUrl(port): string`. `spawnLockPath` / `bindLockPath` re-derive from `discoveryPath`. `socketPath`, `isPipe`, and `ensureSocketDir` are **deleted** — nothing keeps them after Tasks 10–11.

- [ ] **Step 1: Write the failing test**

Append to `cc-gate-plugin/test/acp-paths.test.ts`:

```ts
test("discovery path is fingerprint-keyed JSON beside where the socket lived", () => {
  const env = { HOME: tmpHome(), ANTHROPIC_API_KEY: "sk-secret" }
  const p = discoveryPath(env)
  expect(p.endsWith(".json")).toBe(true)
  expect(p).toContain(`${env.HOME}/.config/kkamak/acp-`)
  // The fingerprint must not leak the credential it was derived from.
  expect(p).not.toContain("sk-secret")
})

test("env.HOME beats os.homedir() so a passed-in env cannot escape isolation", () => {
  expect(discoveryPath({ HOME: "/isolated" })).toStartWith("/isolated/.config/kkamak/")
})

test("write then read round-trips; malformed and missing both read undefined", () => {
  const env = { HOME: tmpHome() }
  expect(readDiscovery(env)).toBeUndefined()
  writeDiscovery(env, { port: 41234, pid: 999 })
  expect(readDiscovery(env)).toEqual({ port: 41234, pid: 999 })
  fs.writeFileSync(discoveryPath(env), "{not json")
  expect(readDiscovery(env)).toBeUndefined()
  fs.writeFileSync(discoveryPath(env), JSON.stringify({ port: "41234" }))
  expect(readDiscovery(env)).toBeUndefined()
})

test("the discovery file is 0600 and its directory 0700", () => {
  const env = { HOME: tmpHome() }
  writeDiscovery(env, { port: 1, pid: 2 })
  expect(fs.statSync(discoveryPath(env)).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.dirname(discoveryPath(env))).mode & 0o777).toBe(0o700)
})

test("both locks hang off the discovery path, and are distinct", () => {
  const env = { HOME: tmpHome() }
  expect(spawnLockPath(env)).toBe(`${discoveryPath(env)}.spawn.lock`)
  expect(bindLockPath(env)).toBe(`${discoveryPath(env)}.bind.lock`)
  expect(spawnLockPath(env)).not.toBe(bindLockPath(env))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-paths.test.ts`
Expected: FAIL — `discoveryPath` is not exported.

- [ ] **Step 3: Write minimal implementation**

Port the `discoveryPath` / `DiscoveryInfo` / `readDiscovery` / `writeDiscovery` / `wsUrl` block from `~/z2/cc-api-daemon/src/acp-paths.ts:71-150` verbatim into `cc-gate-plugin/src/acp/acp-paths.ts`, replacing this repo's `socketPath` / `isPipe` / `ensureSocketDir`, and re-point the two lock helpers:

```ts
export function spawnLockPath(env: Record<string, string | undefined>): string {
  return `${discoveryPath(env)}.spawn.lock`
}
export function bindLockPath(env: Record<string, string | undefined>): string {
  return `${discoveryPath(env)}.bind.lock`
}
```

Delete the now-unused `KKAMAK_ACP_SOCKET` branch. Leave `envFingerprint` and the staleness/lock helpers untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-paths.test.ts`
Expected: PASS. `bunx tsc --noEmit` will still report unresolved `socketPath` imports in `acp-daemon.ts` and `acp-client.ts` — Tasks 10 and 11 close those.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/acp-paths.ts cc-gate-plugin/test/acp-paths.test.ts
git commit -m "feat(acp): discovery-file addressing replaces unix socket path"
```

---

### Task 10: WebSocket server (stdio preserved)

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-daemon.ts` (`runSocket` → `runServer`; `runStdio` untouched)
- Create: `cc-gate-plugin/src/acp/jsonrpc.ts` (port of `~/z2/cc-api-daemon/src/jsonrpc.ts`)
- Modify: `cc-gate-plugin/package.json` (add `ws` + `@types/ws`)
- Test: `cc-gate-plugin/test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `discoveryPath` / `readDiscovery` / `writeDiscovery` / `wsUrl` / `bindLockPath` (Task 9), the dispatcher (Tasks 6–7).
- Produces: `runServer(env, opts?)` bound to `127.0.0.1` on a kernel-assigned port, publishing `{port, pid}` **after** a successful bind. `validateJsonRpc(parsed)`, `createErrorResponse(id, code, message)`, `JSON_RPC_PARSE_ERROR` from `./jsonrpc.ts`.

**Dependency ruling:** add `ws` (server half only — the client half in Task 11 uses Bun's global `WebSocket`, no dependency). Bun's native `Bun.serve` WebSocket upgrade would avoid the dependency but means rewriting the one piece of this transport that is live-proven, for no functional gain. The plugin cache already installs dependencies (`~/.claude/plugins/cache/kkamak-local/kkamak/0.4.0/node_modules` exists alongside `bun.lock`, and `@anthropic-ai/sdk` already ships that way), so one more is the same class of change.

- [ ] **Step 1: Write the failing test**

Append to `cc-gate-plugin/test/acp-daemon.test.ts`:

```ts
test("runServer binds loopback, publishes discovery after bind, and serves a turn", async () => {
  const env = { HOME: tmpHome() }
  expect(readDiscovery(env)).toBeUndefined()   // nothing published before bind
  const stop = await runServer(env, { makeSession: () => fakeSession() })
  const info = readDiscovery(env)
  expect(info?.port).toBeGreaterThan(0)
  expect(info?.pid).toBe(process.pid)

  const ws = new WebSocket(wsUrl(info!.port))
  await new Promise((r) => ws.addEventListener("open", r, { once: true }))
  const reply = new Promise<Record<string, unknown>>((r) =>
    ws.addEventListener("message", (e) => r(JSON.parse(String(e.data))), { once: true }))
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }))
  const init = await reply
  expect((init.result as { _meta: { kkamak: { envFingerprint: string } } })._meta.kkamak.envFingerprint)
    .toBe(envFingerprint(env))
  ws.close()
  await stop()
})

test("a malformed frame gets a parse error, never a crashed daemon", async () => {
  const env = { HOME: tmpHome() }
  const stop = await runServer(env, { makeSession: () => fakeSession() })
  const ws = new WebSocket(wsUrl(readDiscovery(env)!.port))
  await new Promise((r) => ws.addEventListener("open", r, { once: true }))
  const reply = new Promise<Record<string, unknown>>((r) =>
    ws.addEventListener("message", (e) => r(JSON.parse(String(e.data))), { once: true }))
  ws.send("{not json")
  expect((await reply).error).toMatchObject({ code: -32700 })
  ws.close()
  await stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts`
Expected: FAIL — `runServer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add the dependency:

```bash
cd cc-gate-plugin && bun add ws@^8.21.2 && bun add -d @types/ws@^8.18.1
```

Copy `~/z2/cc-api-daemon/src/jsonrpc.ts` to `cc-gate-plugin/src/acp/jsonrpc.ts` verbatim (no imports to rewrite).

Port `~/z2/cc-api-daemon/src/acp-daemon.ts`'s `probePort` / `bindWithTakeover` / `runServer` into `cc-gate-plugin/src/acp/acp-daemon.ts`, replacing `runSocket` and its `net`-based `bindWithTakeover`. Preserve, unchanged, this repo's existing:
- bind-lock protocol (acquire before probe→bind, `process.exit(0)` on a lost race),
- reaper interval at `Math.max(250, Math.min(60_000, idleMs / 3))` calling `pool.reap()` then the idle+quiescent self-exit gate,
- shutdown ordering (stop accepting → close clients → `pool.closeAll()` → re-acquire the bind lock → unlink → release → exit), with `fs.unlinkSync(sock)` becoming `fs.unlinkSync(discoveryPath(env))`,
- the Task 6 boot-time lane log.

`runStdio` and its `FrameDecoder` stay exactly as they are — stdio is the spec-canonical ACP transport and must survive the swap. Keep `FrameDecoder` and `encodeFrame` exported from `acp-wire.ts` for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts && bunx tsc --noEmit`
Expected: PASS. `acp-client.ts` still imports the deleted `socketPath` — Task 11 closes it. If the typecheck blocks on that, run `bun test` first and complete Task 11 before the commit gate below.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/acp-daemon.ts cc-gate-plugin/src/acp/jsonrpc.ts \
        cc-gate-plugin/package.json cc-gate-plugin/bun.lock cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(acp): localhost WebSocket transport, stdio preserved"
```

---

### Task 11: WebSocket client

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-client.ts`
- Test: `cc-gate-plugin/test/acp-client.test.ts`, `cc-gate-plugin/test/acp-fake-daemon.ts`

**Interfaces:**
- Consumes: `readDiscovery` / `wsUrl` / `spawnLockPath` (Task 9), the WS server (Task 10).
- Produces: `daemonCall` and `ensureDaemon` keep their exact current signatures and their `DaemonOutcome` contract. Only the transport underneath changes.

**The one hazard to hold onto:** the global `WebSocket.send()` has **no** write-completion callback, unlike `net.Socket.write()`. This repo's `sentPrompt` boundary (`acp-client.ts:~240`) is currently assigned inside that callback. Set `sentPrompt = true` on the line immediately after `ws.send(...)` returns without throwing. That is the conservative direction: it can only over-report `call-consumed`, never under-report it, and over-reporting costs a lost retryable record while under-reporting costs a double-billed turn.

- [ ] **Step 1: Write the failing test**

Modify `cc-gate-plugin/test/acp-fake-daemon.ts` to stand up a `WebSocketServer` on an ephemeral port and publish a discovery file, keeping its existing scripted-response API. Then append to `cc-gate-plugin/test/acp-client.test.ts`:

```ts
test("no discovery file is a provable no-call", async () => {
  const out = await daemonCall("hi", "claude-haiku-4-5", { HOME: tmpHome() }, { isolation: GAUGE_ISOLATION })
  expect(out.kind).toBe("no-call")
})

test("a stale discovery file pointing at a dead port is a no-call", async () => {
  const env = { HOME: tmpHome() }
  writeDiscovery(env, { port: 1, pid: 999999 })
  const out = await daemonCall("hi", "claude-haiku-4-5", env, { isolation: GAUGE_ISOLATION })
  expect(out.kind).toBe("no-call")
})

test("a fingerprint mismatch refuses BEFORE the prompt is sent", async () => {
  const fake = await startFakeDaemon({ fingerprint: "wrong-fp" })
  const out = await daemonCall("hi", "claude-haiku-4-5", fake.env, { isolation: GAUGE_ISOLATION })
  expect(out.kind).toBe("no-call")
  expect(fake.received.some((f) => f.method === "session/prompt")).toBe(false)
  await fake.stop()
})

test("a socket dropped AFTER the prompt was sent is call-consumed", async () => {
  const fake = await startFakeDaemon({ dropAfter: "session/prompt" })
  const out = await daemonCall("hi", "claude-haiku-4-5", fake.env, { isolation: GAUGE_ISOLATION })
  expect(out.kind).toBe("call-consumed")
  await fake.stop()
})

test("a full ok turn round-trips text and model evidence", async () => {
  const fake = await startFakeDaemon({
    promptResult: { stopReason: "end_turn",
      _meta: { kkamak: { model: "claude-haiku-4-5", canonicalModel: "claude-haiku-4-5-20251001", callConsumed: true } } },
    updateText: "answer",
  })
  const out = await daemonCall("hi", "claude-haiku-4-5", fake.env, { isolation: GAUGE_ISOLATION })
  expect(out).toMatchObject({ kind: "ok", text: "answer", canonicalModel: "claude-haiku-4-5-20251001" })
  await fake.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/acp-client.test.ts`
Expected: FAIL — `acp-client.ts` still imports the deleted `socketPath`.

- [ ] **Step 3: Write minimal implementation**

Port `~/z2/cc-api-daemon/src/acp-client.ts`'s WebSocket dial into `cc-gate-plugin/src/acp/acp-client.ts`. The shape of each change:

```ts
// Address: read the discovery file instead of deriving a socket path. A
// missing or malformed file is a pre-send failure => law L1 => no-call.
const discovery = readDiscovery(env)
if (!discovery) { resolve({ kind: "no-call" }); return }
const ws = new WebSocket(wsUrl(discovery.port))

// Framing: a WebSocket message IS a frame. FrameDecoder/encodeFrame drop
// out of this file entirely (they stay in acp-wire.ts for runStdio).
ws.addEventListener("message", (e) => { handleFrame(JSON.parse(String(e.data))) })

// The send boundary. `WebSocket.send()` has no completion callback, so the
// boundary is set immediately after it returns without throwing —
// deliberately conservative: over-reporting call-consumed loses a
// retryable record, under-reporting bills a turn twice.
ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: ACP_SESSION_PROMPT, params }))
sentPrompt = true
```

Keep, unchanged: `budgetMs` defaulting to `ACP_BUDGET.daemonLegMs`, the listeners-before-connect discipline (attach `open`/`error`/`close` before the socket can fire them), the ambient error/close guard resolving through `sentPrompt` alone, and the L3 three-step post-send classification. Update `ensureDaemon`'s spawn path to poll `readDiscovery` for the published port instead of stat-ing a socket file, still under `spawnLockPath`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test && bunx tsc --noEmit`
Expected: PASS — the whole suite, and a clean typecheck with no dangling `socketPath` references.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/acp/acp-client.ts cc-gate-plugin/test/acp-client.test.ts \
        cc-gate-plugin/test/acp-fake-daemon.ts
git commit -m "feat(acp): WebSocket client dial via discovery file"
```

---

### Task 12: Live end-to-end, version bump, deploy

**Files:**
- Modify: `cc-gate-plugin/package.json` (version `0.4.0` → `0.5.0`)
- Create: `docs/2026-08-07-unified-acp-daemon-e2e.md`
- Modify: `~/z2/kkamak/docs/dogfood-log.md` (boundary timestamp entry)

**Interfaces:**
- Consumes: everything above.
- Produces: a recorded boundary timestamp and a deployed plugin version.

**This is the only task that spends model tokens.** It needs its own explicit sized go before Step 3 runs. Estimated spend: two haiku turns plus one opus turn, well under 5k tokens total.

- [ ] **Step 1: Full hermetic suite and typecheck**

Run: `cd cc-gate-plugin && bun test && bunx tsc --noEmit`
Expected: PASS, zero failures. Do not proceed on any failure.

- [ ] **Step 2: Record the boundary timestamp BEFORE anything is deployed**

```bash
date +%s%3N   # record this value; it is the instrument boundary
git log --oneline -1
```

Append to `~/z2/kkamak/docs/dogfood-log.md` an entry naming the boundary ts, the commit, and the one-line reason (`unified ACP daemon: model routing + WS transport`). Gauge and review-sensor data on either side of this timestamp must never be pooled.

- [ ] **Step 3: Live e2e — both lanes, one command (REQUIRES SIZED SPEND GO)**

```bash
cd /home/th-yoo/z2/meta-harness/cc-gate-plugin && bun -e '
  import { ensureDaemon, daemonCall } from "./src/acp/index.ts"
  import { GAUGE_ISOLATION } from "./src/acp/acp-wire.ts"
  await ensureDaemon(process.env)
  for (const m of ["claude-haiku-4-5", "claude-opus-5"]) {
    const t0 = Date.now()
    const out = await daemonCall("Reply with exactly: OK", m, process.env, { isolation: GAUGE_ISOLATION })
    console.log(m, out.kind, "canonical=" + (out.kind === "ok" ? out.canonicalModel : "-"), Date.now() - t0 + "ms")
  }
' 2>&1 | tee /home/th-yoo/z2/meta-harness/docs/2026-08-07-unified-acp-daemon-e2e.md
```

Expected: `claude-haiku-4-5 ok canonical=claude-haiku-4-5-...` and `claude-opus-5 ok canonical=claude-opus-5...`. The daemon's stderr must show `[acp] api-backend lane: subscription`. **If it shows `api-tier`, stop and report — the haiku route is on metered pay-go and the environment has an `ANTHROPIC_API_KEY` that must be accounted for before deploying.**

- [ ] **Step 4: Confirm the routing actually saved the subprocess**

While the e2e is running, in a second shell:

```bash
pgrep -af "claude" | grep -v grep | wc -l   # during the haiku turn: no NEW claude child
ps -o rss= -p "$(pgrep -f acp-daemon | head -1)"
```

Expected: the haiku turn spawns no `claude` child (host RSS ~85 MB, flat); the opus turn spawns exactly one, and it is reaped within the idle TTL afterward.

- [ ] **Step 5: Version bump and merge (REQUIRES EXPLICIT MERGE GO)**

Merging is not deploying: the plugin cache is version-keyed, so a merge without a version bump leaves the gate and the daemon running pre-merge code. Bump in the same change.

```bash
cd /home/th-yoo/z2/meta-harness
sed -i 's/"version": "0.4.0"/"version": "0.5.0"/' cc-gate-plugin/package.json
git add cc-gate-plugin/package.json docs/2026-08-07-unified-acp-daemon-e2e.md
git commit -m "chore(acp): bump plugin 0.4.0 -> 0.5.0 for unified daemon deploy"
bash scripts/merge-with-gate.sh    # never a raw git merge — the pre-merge-commit hook is unsound
```

- [ ] **Step 6: Verify the deployed cache, not the repo source**

```bash
ls -d ~/.claude/plugins/cache/kkamak-local/kkamak/0.5.0/ && \
  grep -c "routeBackend" ~/.claude/plugins/cache/kkamak-local/kkamak/0.5.0/src/acp/acp-daemon.ts && \
  ls ~/.claude/plugins/cache/kkamak-local/kkamak/0.5.0/node_modules/ws
```

Expected: the `0.5.0` cache directory exists, its `acp-daemon.ts` contains the router, and `ws` is installed there. Verifying the repo source instead of the cache is the exact mistake that has bitten this repo twice.

---

## Self-Review

**Spec coverage.** §1 Transport → Tasks 9–11 (WS + discovery), with `--stdio` explicitly preserved in Task 10. §2 Route by model → Tasks 3–6, with the blocking billing question resolved in the Measured Parameters section and enforced at runtime by `authLane` (Task 3) plus the boot log and the Task 12 Step 3 abort condition. §3 Adaptive pool → Task 8; min=0 and idle-reap were found already implemented (documented in Measured Parameters), so only the cap resize remained. `models/list` → Task 7, with the stated deviation from `supportedModels()`-primary and the reason. Ports FROM cc-api-daemon: WebSocket (10), discovery (9), `ApiSession` (5), `DispatchableSession` (2), `models/list` (7). The `.system` override listed in the spec's port list is **not** carried over — it is a cc-api-daemon-local feature with no consumer in this repo and no mention in the spec's requirements body; flagged here rather than silently dropped. Ports FROM the ACP daemon: `WarmSession` and `selectEvidence`/`ModelEvidence` stay in place untouched, which is what "base is the ACP location" means. §4 Deployed-instrument change → Task 12.

**Type consistency.** `TurnOutcome`, `CancelResult`, `DispatchableSession` are declared once in Task 2 and imported by name in Tasks 4, 5, and 6. `WarmConstructOpts` keeps its existing six-field shape from `acp-pool.ts` and is the constructor option for both backends. `routeBackend` returns `"api" | "agent"` and is used only in Task 6. `authLane` returns `"api-tier" | "subscription"` and is used in Tasks 3 and 6. `discoveryPath` / `readDiscovery` / `writeDiscovery` / `wsUrl` are declared in Task 9 and consumed in Tasks 10 and 11. `ModelListOutcome` is declared in Task 7 and consumed only there.

**Known risk, stated rather than hidden.** Tasks 10–11 swap the transport on a live instrument. The old unix-socket daemon and the new WS daemon use different addresses (`acp-<fp>.sock` vs `acp-<fp>.json`), so they cannot collide — the old one simply idles out on its 15-minute self-reap. But a Stop firing in the window between the merge and the cache refresh runs a client and daemon from different transports, which reads as `no-call` (fail-open, no spend, no false gate outcome). That is the correct degradation, and it is why Task 12 Step 6 verifies the cache rather than the source.
