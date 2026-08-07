# cc-api-daemon: ACP daemon on the API SDK — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `~/z2/cc-api-daemon` the ACP daemon of `meta-harness/cc-gate-plugin/src/acp` with `@anthropic-ai/claude-agent-sdk` replaced by `@anthropic-ai/sdk` — same socket, wire, pool, session lifecycle and outcome law, a different backend at the leaf.

**Why:** the agent SDK is too heavy. Each `WarmSession` spawns a CLI subprocess (~330 MB, per `acp-pool.ts`'s own cap rationale), costs a measured 1.25-1.46 s to boot (hence the 8 s spawn floor), pays ~84 ms just to load the package, and needs control round-trips (`setModel`, `/clear` + `conversation_reset`) that exist only because a live subprocess holds state. `messages.create` has none of that: one HTTP request, no process, no boot, no control channel.

**Architecture:** Five of the six `src/acp` modules (`acp-wire`, `acp-paths`, `acp-pool`, `acp-daemon`, `acp-client`, plus `index`) are backend-agnostic — they import nothing outside the layer and never touch the agent SDK. Only `warm-session.ts` (780 lines) does. `SessionPool` already accepts a `makeSession` factory, so the swap is a constructor injection, not surgery: port the agnostic core verbatim, and supply an `ApiSession` implementing the same dispatch contract over `messages.create`. The existing `src/call.ts` becomes that session's one-call leaf.

**Tech Stack:** Bun ≥1.0, TypeScript (raw `.ts` sources are what ships), `@anthropic-ai/sdk` 0.115.0, node builtins (`net`, `fs`, `crypto`, `os`, `path`, `string_decoder`). No agent SDK, no CLI subprocess.

## Global Constraints

- **Bun-only.** `package.json` `exports["."]` → `src/index.ts`; raw `.ts` ships. No build step.
- **One runtime dependency:** `@anthropic-ai/sdk` (`^0.115.0`). The agent SDK must not appear in `package.json` or any import after this plan.
- **`index.ts` is the only public surface.** Adding an export is a deliberate widening. Production code outside the package imports from it; tests may import internals.
- **The outcome law is load-bearing and unchanged.** `no-call` = provably nothing went toward the model. `call-consumed` = any ambiguity at or after the send boundary. Never throw out of `daemonCall`/`oneShot`.
- **`maxRetries: 0`** on every Anthropic client — exactly one HTTP call per turn, provable.
- **Ambient-env leak guards stay** (`src/call.ts:48-82`): two separately-shaped `new Anthropic(...)` constructions, not-chosen auth field explicit `null`, `baseURL` always `env.ANTHROPIC_BASE_URL ?? null`. Do not collapse them.
- **The budget contract is a contract, not a preference:** the client budget MUST exceed the daemon worst case. Drift silently converts a `call-consumed` into a `no-call` — i.e. two model calls billed for one record. Locked by a test.
- **Zero real spend in tests.** Every test drives a local `Bun.serve` stub with `ANTHROPIC_BASE_URL` pointed at it. `scripts/smoke.ts` is the only spender and never runs in CI.
- **Gate:** `bun test` and `bunx tsc --noEmit` both clean at every commit. CI runs exactly those two.

---

## Plan baseline — REFRESH REQUIRED BEFORE TASK 1

This plan was written against `cc-api-daemon` @ `bceb74e`. A concurrent dev
session (tmux `cc-api`) then landed `80ae1ea`, which moves code this plan
references. **Re-read the files before executing; the line numbers below are
from the older tree.**

What changed in `80ae1ea`:

| | |
|---|---|
| `src/client.ts` (new, 60) | `buildClient` — the ambient-env leak guards moved here out of `call.ts:48-82`. Every reference in this plan to "`call.ts:48-82`" now means `client.ts`. |
| `src/models.ts` (new, 95) | `listModels` / `retrieveModel` over `GET /v1/models`. Own outcome vocabulary (`ok`/`no-auth`/`error`/`not-found`) — deliberately NOT the no-call/call-consumed law, because that law encodes billed-call spend risk and these GETs are unbilled and idempotent. |
| `src/call.ts` | 151 → 112 lines. Every `call.ts:NNN` citation in this plan is stale. |
| `src/index.ts` | now also exports `listModels`, `retrieveModel`, `ModelListOutcome`, `ModelRetrieveOutcome`, `ModelInfo`. |

Consequences for the tasks:

- **Task 1 Step 5** ("reduce `call.ts` to the leaf") must not undo the
  `buildClient` extraction — `models.ts` depends on it. Keep `client.ts`.
- **Task 4a** renames `daemonCall` → `sendOne`. `daemonCall` and the models
  functions now share `buildClient`; the rename touches only `call.ts`.
- **Task 5 Step 5** rewrites `index.ts` and, as written, would DROP the five
  models exports. That is a regression — carry them forward verbatim.
- **Task 1 Step 4** deletes `src/types.ts`. Confirm `models.ts` does not
  import from it first.

The models surface is orthogonal to this plan: read-only metadata, no session,
no daemon. It survives the swap untouched. Worth noting, though, that it grows
the single-process library while this plan converges on the daemon — two
directions in one repo, which is a coordination question, not a technical one.

---

## Architecture: RULED — fork (option B), 2026-08-07

The registered plan (`docs/resume.md:222-233`, merge `6417b7a`) called stage two a **`git mv` + package.json** — extracting the *same* daemon. This is not that: the intent is `acp − agent-sdk + api-sdk`, a daemon with a **different backend**.

**Ruled: `cc-api-daemon` forks the core. `meta-harness` is not modified and takes no dependency on this package.**

The reason the fork is safe here — and this is the load-bearing insight, not a concession:

> **kkamak is an ACP *client*. It does not need the daemon's code, only the daemon's protocol.**

Two implementations of one wire protocol, talking over a unix socket, is what protocols are for. The coupling is **protocol-level, not code-level**. Daemon internals (pool sizing, budgets, session mechanics, cancel semantics) may diverge freely — they are private to each implementation. Only the wire must agree: frame encoding, method names (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/close`, `session/update`), error codes (`-32000` no-call, `-32001` call-consumed), and the param/result shapes in `acp-wire.ts`.

Deferred, not cancelled: converging to a shared core later stays cheap as long as the forked files keep their names and structure. Revisit once the api daemon actually runs.

### The one hazard the fork does NOT make safe

`ACP_BUDGET`'s own comment warns that splitting the budget across files silently converts a `call-consumed` into a `no-call` — two model calls billed for one record. Under the fork, **the two halves of that inequality now live in different repos**: kkamak's client budget constant, and this daemon's `daemonWorstCaseMs` (which Task 3 changes from 32 000 to 26 000). Nothing checks it at runtime.

`AcpInitializeResult` already carries a `_meta.kkamak` envelope for exactly this kind of thing:

```ts
export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
  _meta: { kkamak: { envFingerprint: string } }
}
```

**Fix, added as Task 8:** the daemon reports `daemonWorstCaseMs` in that envelope; the client asserts its own budget exceeds it and refuses pre-send (`no-call`, law L1) if not. Additive and backward-compatible — an older client ignoring the field is exactly as safe as it is today. This turns a silent cross-repo drift into a loud, checked, protocol-level contract, and it is the thing that makes the fork defensible rather than merely cheap.

## Singleton semantics — read before Tasks 4 and 5

The daemon is a singleton shared by every kkamak instance on the host. Two consequences the plan must honour.

### It is a singleton PER ENVIRONMENT FINGERPRINT, not one per host

`acp-paths.ts:73-78`:

```ts
export function socketPath(env) {
  const fp = envFingerprint(env)            // sha256 of all non-denylisted env, secrets as "KEY=set"
  return path.join(os.homedir(), ".config", "kkamak", `acp-${fp}.sock`)
}
```

The fingerprint is **in the socket filename**. Clients whose environments differ in any non-denylisted variable resolve a *different* socket and get a *different* daemon. `initialize` then re-checks the fingerprint and the client refuses a mismatch pre-send (`no-call`).

So "every kkamak instance shares one daemon" holds only for instances with identical env. This is what stops a client carrying a different `ANTHROPIC_*` credential from being silently served by a daemon holding someone else's — which matters more on this backend than upstream, because `ApiSession` resolves auth from the **daemon's** env, not the caller's. Do not weaken the fingerprint, and do not add anything to `ACP_ENV_DENYLIST` without understanding that it merges two previously-separate daemons.

### `recycle` becomes a privacy AND billing guard, not a nicety

`acp-daemon.ts:306-336`:

```ts
const { entry, mustRecycle } = acquired
const recycle = mustRecycle && lastSessionForEntry !== sessionId
const outcome = await warm.oneShot(text, model, { recycle, tag })
```

The pool reuses an idle entry whose isolation is deep-equal — **across clients**. `recycle` is what clears the carried-over conversation when the entry last served a *different* session.

Upstream, a missed recycle means a CLI subprocess retains context. On this backend it is sharper and directly billed: `ApiSession.history` is the literal `messages` array, so a missed recycle **puts another kkamak instance's prompts and replies into this client's HTTP request body**, sends them to the API, and pays input tokens for them.

Task 4c already implements `recycle: true → history = []`. Given the singleton, that is a security property and needs its own test — added as Task 4c Step 3a below. Do not treat it as covered by the history tests.

---

## File structure

**Ported unchanged (from `meta-harness/cc-gate-plugin/src/acp/`):**

| File | Lines | Responsibility |
|---|---|---|
| `src/acp-wire.ts` | 278 | JSON-RPC framing, method constants, error codes, `WarmIsolation`, `modelProvenBy`, `encodeFrame`, `FrameDecoder`, budget object |
| `src/acp-paths.ts` | 155 | socket path, spawn/bind lock paths, env fingerprint |
| `src/acp-pool.ts` | 283 | `SessionPool`, `WarmSessionLike`, `WarmConstructOpts`, `PoolEntry` |
| `src/acp-daemon.ts` | 697 | server loop, `DaemonState`, dispatch, cancel routing |
| `src/acp-client.ts` | 465 | `ensureDaemon`, `daemonCall`, `closeSession`, `DaemonOutcome` |

**Ported with edits:**
- `src/acp-wire.ts` — `GAUGE_ISOLATION` **removed** (moves caller-side; the wart `acp/index.ts:19-26` already flagged). `ACP_BUDGET`/`CLI_SPAWN_BUDGET_MS` replaced per Task 3.
- `src/acp-daemon.ts` — `DispatchableWarm` re-expressed against an interface instead of `Pick<WarmSession, …>` (Task 2).
- `src/acp-pool.ts` — default `makeSession` becomes `ApiSession` (Task 5).

**New:**
- `src/session-contract.ts` — `DispatchableSession`, `TurnOutcome`, `CancelResult`. The backend-neutral contract both sessions satisfy.
- `src/api-session.ts` — `ApiSession`, the `messages.create` backend.

**Kept, re-scoped:**
- `src/call.ts` — stays as the single-call leaf `ApiSession` invokes. Its `ensureDaemon`/`closeSession` (the in-process no-ops) are **deleted**; the real ones arrive with `acp-client.ts`.
- `src/types.ts` — `WarmIsolation`/`modelProvenBy` are deleted here; `acp-wire.ts` becomes their home. `DaemonOutcome` likewise moves to `acp-client.ts`. The file is removed entirely.

**Tests ported alongside:** `acp-wire.test.ts`, `acp-paths.test.ts`, `acp-pool.test.ts`, `acp-daemon.test.ts`, `acp-client.test.ts`, `acp-fake-daemon.ts`.

---

### Task 1: Port the agnostic core

Bring the five modules + their tests across so the package compiles and the ported tests pass, with the session backend still absent.

**Files:**
- Create: `src/acp-wire.ts`, `src/acp-paths.ts`, `src/acp-pool.ts`, `src/acp-daemon.ts`, `src/acp-client.ts` (copied from `~/z2/meta-harness/cc-gate-plugin/src/acp/`)
- Create: `test/acp-wire.test.ts`, `test/acp-paths.test.ts`, `test/acp-pool.test.ts`, `test/acp-daemon.test.ts`, `test/acp-client.test.ts`, `test/acp-fake-daemon.ts`
- Delete: `src/types.ts`, `test/types.test.ts`
- Modify: `src/call.ts` (delete `ensureDaemon` + `closeSession`, re-point type imports)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `WarmIsolation`, `modelProvenBy(key, requested, canonicalModel?)`, `ACP_*` method constants, `ACP_ERR_NO_CALL = -32000`, `ACP_ERR_CALL_CONSUMED = -32001`, `encodeFrame`, `FrameDecoder`, `SessionPool`, `WarmSessionLike { turnInFlight(): boolean; close(): void }`, `WarmConstructOpts`, `PoolEntry`, `DaemonOutcome`

- [ ] **Step 1: Copy the five modules and their tests**

```bash
cd ~/z2/cc-api-daemon
SRC=~/z2/meta-harness/cc-gate-plugin/src/acp
cp "$SRC"/acp-{wire,paths,pool,daemon,client}.ts src/
cp ~/z2/meta-harness/cc-gate-plugin/test/acp-{wire,paths,pool,daemon,client}.test.ts test/
cp ~/z2/meta-harness/cc-gate-plugin/test/acp-fake-daemon.ts test/
```

- [ ] **Step 2: Remove `GAUGE_ISOLATION` from `acp-wire.ts`**

Delete the whole `export const GAUGE_ISOLATION: WarmIsolation = { … }` block (`acp-wire.ts:159-170` in the source). A general ACP package has no business knowing what a "gauge" is. `WarmIsolation` (the type) stays. Callers supply their own value — `scripts/smoke.ts` already constructs one inline, and `README.md:29` already states "Isolation values are caller-side policy — this package ships none."

- [ ] **Step 3: Fix the resulting `warm-session.ts` references**

`acp-pool.ts` and `acp-daemon.ts` both `import … from "./warm-session.ts"`, which does not exist here.

**Every task must end green** — the repo is gated on `bun test`, so a task that lands with a broken import or a red suite blocks its own commit. Therefore create `src/session-contract.ts` NOW, in this task, with the full contents given in Task 2 Step 3, and point both files at it. Also comment out the pool's default `makeSession` and leave the parameter required — the ported pool tests all inject a fake, so they pass without a backend.

Task 2 then adds the contract's own tests and re-points the daemon's `DispatchableWarm` alias. Splitting it that way keeps each commit green; the original split did not.

- [ ] **Step 4: Strip `src/types.ts`**

`WarmIsolation` and `modelProvenBy` now live in `acp-wire.ts`; `DaemonOutcome` lives in `acp-client.ts`. Delete `src/types.ts` and `test/types.test.ts`, and re-point `src/call.ts`'s type imports at `./acp-wire.ts`.

- [ ] **Step 5: Reduce `src/call.ts` to the leaf**

Delete `ensureDaemon` (`call.ts:131-136`) and `closeSession` (`call.ts:142-151`) — both were in-process no-ops standing in for the real client, which now arrives with `acp-client.ts`. Keep `daemonCall` exactly as-is for now; Task 4 renames it to `sendOne` and narrows its role.

- [ ] **Step 6: Run the ported tests**

Run: `bun test`
Expected: PASS, all files. `acp-daemon.ts`'s `Pick<WarmSession, …>` alias must be re-pointed at `DispatchableSession` here rather than left for Task 2 — the gate blocks a red commit, so nothing may be deferred past the commit that breaks it.

- [ ] **Step 7: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean. Zero `warm-session.ts` references remain.

Run: `grep -rn "warm-session" src/`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "port ACP core from meta-harness src/acp (no backend yet)

Five backend-agnostic modules verbatim: wire, paths, pool, daemon, client,
plus their tests and the fake daemon. GAUGE_ISOLATION dropped — a general
ACP package has no business knowing what a gauge is (the wart acp/index.ts
flagged before extraction). src/types.ts folded into acp-wire.ts; call.ts
reduced to the single-call leaf now that the real client is present."
```

---

### Task 2: Backend-neutral session contract

`acp-daemon.ts:92` types dispatch as `Pick<WarmSession, "oneShot" | "cancel">` — borrowed off a concrete agent-SDK class that does not exist in this package. Re-express it as an interface both backends satisfy.

**Files:**
- Create: `src/session-contract.ts`
- Create: `test/session-contract.test.ts`
- Modify: `src/acp-daemon.ts` (the `DispatchableWarm` type alias), `src/acp-pool.ts` (imports)

**Interfaces:**
- Consumes: `WarmIsolation` (Task 1), `WarmSessionLike` (Task 1)
- Produces:
  - `TurnOutcome = {kind:"ok"; text:string; model:string; canonicalModel:string} | {kind:"no-call"} | {kind:"call-consumed"}`
  - `CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"`
  - `interface DispatchableSession extends WarmSessionLike { oneShot(messageText: string, model: string, opts: {recycle: boolean; tag?: string}): Promise<TurnOutcome>; cancel(tag: string): CancelResult; readonly isolation: WarmIsolation }`

- [ ] **Step 1: Write the failing test**

```ts
// test/session-contract.test.ts
import { test, expect } from "bun:test"
import type { DispatchableSession, TurnOutcome, CancelResult } from "../src/session-contract.ts"
import type { WarmIsolation } from "../src/acp-wire.ts"

const iso: WarmIsolation = {
  systemPrompt: "", settingSources: [], settings: { autoMemoryEnabled: false },
  persistSession: false, strictMcpConfig: true, tools: [],
  title: "t", thinking: { type: "disabled" },
}

test("a minimal object satisfies DispatchableSession structurally", () => {
  const s: DispatchableSession = {
    isolation: iso,
    turnInFlight: () => false,
    close: () => {},
    oneShot: async (): Promise<TurnOutcome> => ({ kind: "no-call" }),
    cancel: (): CancelResult => "unknown",
  }
  expect(s.turnInFlight()).toBe(false)
  expect(s.cancel("tag")).toBe("unknown")
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/session-contract.test.ts`
Expected: FAIL — `Cannot find module '../src/session-contract.ts'`

- [ ] **Step 3: Write `src/session-contract.ts`**

```ts
// session-contract.ts — the backend-neutral dispatch contract.
//
// acp-daemon.ts previously typed dispatch as
// `WarmSessionLike & Pick<WarmSession, "oneShot" | "cancel">`, borrowing
// signatures off the concrete agent-SDK class so the type could not drift
// from it. With two backends there is no single concrete class to borrow
// from, so the contract is stated once here and BOTH implementations are
// checked against it.
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

- [ ] **Step 4: Run the test**

Run: `bun test test/session-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Re-point the daemon**

In `src/acp-daemon.ts`, delete the `type DispatchableWarm = WarmSessionLike & Pick<WarmSession, "oneShot" | "cancel">` alias and the `warm-session.ts` import. Replace every `DispatchableWarm` use with `DispatchableSession` imported from `./session-contract.ts`. Keep the existing casts at the two dispatch sites (`acp-daemon.ts:336`, `:398`) — `PoolEntry.warm` is still statically `WarmSessionLike`, and the widening cast is the same interface-segregation move the original made.

- [ ] **Step 6: Full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean. Every `warm-session.ts` reference is now gone.

- [ ] **Step 7: Commit**

```bash
git add src/session-contract.ts test/session-contract.test.ts src/acp-daemon.ts src/acp-pool.ts
git commit -m "backend-neutral DispatchableSession contract

Replaces Pick<WarmSession, 'oneShot'|'cancel'>, which borrowed signatures
off a concrete agent-SDK class. With two backends there is no single class
to borrow from, so the contract is stated once and both implementations are
checked against it."
```

---

### Task 3: Re-budget for HTTP

`ACP_BUDGET`'s legs describe a CLI subprocess. Three of them have no referent over the API SDK, and one clamp is actively wrong.

| Leg | Source value | Over the API SDK |
|---|---|---|
| `CLI_SPAWN_BUDGET_MS` | 8 000 | **no spawn** — clamping `turnTimeoutMs` up to 8 s is wrong |
| `queueWaitMs` | 6 000 | keeps meaning (in-daemon FIFO wait) |
| `clearTimeoutMs` | 4 000 | **inert** — no `/clear`, no `conversation_reset` |
| `setModelMs` | 2 000 | **inert** — model is a per-request field |
| `turnTimeoutMs` | 16 000 | keeps meaning (HTTP phase) |
| `hardGraceMs` | 4 000 | keeps meaning (abort grace) |
| `daemonWorstCaseMs` | 32 000 | must be recomputed from the surviving legs |

The inert legs stay in `WarmConstructOpts` — `acp-pool.ts:197-204` names every leg explicitly and the ported pool tests assert that shape. They are accepted-and-ignored by `ApiSession`, documented as such.

**Files:**
- Modify: `src/acp-wire.ts` (`ACP_BUDGET`, `CLI_SPAWN_BUDGET_MS`)
- Modify: `test/acp-wire.test.ts` (the budget-contract test)

**Interfaces:**
- Consumes: `ACP_BUDGET` (Task 1)
- Produces: `ACP_BUDGET` with `daemonWorstCaseMs: 26_000`, `clientBudgetMs: 30_000`; `AUTH_RESOLVE_BUDGET_MS = 10_000` replacing `CLI_SPAWN_BUDGET_MS`

- [ ] **Step 1: Write the failing test**

```ts
// test/acp-wire.test.ts — add to the existing budget describe block
test("daemon worst case is the sum of the legs that survive on HTTP", () => {
  expect(ACP_BUDGET.daemonWorstCaseMs).toBe(
    ACP_BUDGET.queueWaitMs + ACP_BUDGET.turnTimeoutMs + ACP_BUDGET.hardGraceMs,
  )
})

test("client budget exceeds daemon worst case — drift here double-spends", () => {
  expect(ACP_BUDGET.clientBudgetMs).toBeGreaterThan(ACP_BUDGET.daemonWorstCaseMs)
})

test("turnTimeoutMs is floored by auth resolution, not by a CLI spawn", () => {
  expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(AUTH_RESOLVE_BUDGET_MS)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test test/acp-wire.test.ts`
Expected: FAIL — `daemonWorstCaseMs` is 32 000, not 26 000; `AUTH_RESOLVE_BUDGET_MS` is undefined.

- [ ] **Step 3: Rewrite the budget block**

```ts
// acp-wire.ts — replaces CLI_SPAWN_BUDGET_MS
/** Credential resolution (keychain exec / credentials-file read) runs BEFORE
 * the HTTP phase and carries its own 10 s worst case (auth.ts
 * EXEC_TIMEOUT_MS). A turn's timer starts at the push, so the floor exists
 * for the same reason the CLI spawn floor did upstream: without it a session
 * cannot tell "generation failed" from "auth had not resolved yet". */
export const AUTH_RESOLVE_BUDGET_MS = 10_000

/** §6e budget rule. ONE object, in the module both sides import, because
 * `clientBudgetMs > daemonWorstCaseMs` is a CONTRACT: split these across two
 * files and a drift silently converts a `call-consumed` into a `no-call` —
 * two model calls billed for one record. Locked by acp-wire.test.ts.
 *
 * `clearTimeoutMs` and `setModelMs` are INERT on this backend (no /clear, no
 * setModel round-trip — the model is a per-request field). They remain in the
 * object because WarmConstructOpts names every leg explicitly and the pool
 * passes all of them; ApiSession accepts and ignores these two. */
export const ACP_BUDGET = {
  queueWaitMs: 6_000,
  clearTimeoutMs: 4_000,   // inert on this backend
  setModelMs: 2_000,       // inert on this backend
  /** HTTP phase, measured from the push. Floored by AUTH_RESOLVE_BUDGET_MS. */
  turnTimeoutMs: 16_000,
  /** grace before abandoning an aborted request */
  hardGraceMs: 4_000,
  /** derived: 6 000 + 16 000 + 4 000. The two inert legs contribute nothing. */
  daemonWorstCaseMs: 26_000,
  /** client: MUST exceed daemonWorstCaseMs. The 4 000 ms of slack covers the
   * connect + initialize + session/new preamble. */
  clientBudgetMs: 30_000,
} as const
```

- [ ] **Step 4: Update the `turnTimeoutMs` clamp**

In `src/api-session.ts` (Task 4) the constructor clamps with `AUTH_RESOLVE_BUDGET_MS`, not `CLI_SPAWN_BUDGET_MS`. Grep the package for `CLI_SPAWN_BUDGET_MS` and confirm zero remaining references.

Run: `grep -rn "CLI_SPAWN_BUDGET_MS" src/ test/`
Expected: no output.

- [ ] **Step 5: Run the tests**

Run: `bun test test/acp-wire.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/acp-wire.ts test/acp-wire.test.ts
git commit -m "re-budget for HTTP: drop the CLI spawn floor

clearTimeoutMs and setModelMs have no referent without a CLI subprocess and
go inert (kept in the object because the pool names every leg). The spawn
floor becomes an auth-resolution floor — same reason, different pre-HTTP
cost. daemonWorstCaseMs recomputed 32s -> 26s; the
clientBudgetMs > daemonWorstCaseMs contract is re-locked by test."
```

---

### Task 4: `ApiSession` — the backend

The replacement for `warm-session.ts`. Implements `DispatchableSession` over `messages.create`, using `src/call.ts` as its one-call leaf.

Split across four commits because each half is independently rejectable.

**Files:**
- Create: `src/api-session.ts`
- Create: `test/api-session.test.ts`
- Modify: `src/call.ts` (rename `daemonCall` → `sendOne`, return the richer outcome)

**Interfaces:**
- Consumes: `DispatchableSession`, `TurnOutcome`, `CancelResult` (Task 2); `ACP_BUDGET`, `AUTH_RESOLVE_BUDGET_MS`, `WarmIsolation` (Tasks 1, 3); `resolveAuth` (existing `src/auth.ts`)
- Produces:
  - `sendOne(outgoingText, model, env, opts: {isolation; budgetMs?; maxTokens?; authDeps?; signal?}): Promise<TurnOutcome>`
  - `class ApiSession implements DispatchableSession`, constructor `(env: Record<string,string|undefined>, opts: WarmConstructOpts & {cwd?: string; authDeps?: AuthDeps})`

#### 4a — the leaf

- [ ] **Step 1: Write the failing test**

```ts
// test/api-session.test.ts
import { test, expect } from "bun:test"
import { sendOne } from "../src/call.ts"
import { ISO, stubEnv, respondWith } from "./helpers.ts"   // see Step 3

test("sendOne returns ok with the model the API echoed", async () => {
  respondWith({ content: [{ type: "text", text: "hi" }], model: "claude-haiku-4-5-20251001" })
  const out = await sendOne("say hi", "claude-haiku-4-5", stubEnv(), { isolation: ISO })
  expect(out.kind).toBe("ok")
  if (out.kind !== "ok") throw new Error("unreachable")
  expect(out.text).toBe("hi")
  expect(out.model).toBe("claude-haiku-4-5-20251001")
  expect(out.canonicalModel).toBe("claude-haiku-4-5-20251001")
})

test("an aborted request is call-consumed, never no-call", async () => {
  const ac = new AbortController()
  respondWith({ delayMs: 5_000, content: [], model: "m" })
  const p = sendOne("x", "claude-haiku-4-5", stubEnv(), { isolation: ISO, signal: ac.signal })
  ac.abort()
  expect((await p).kind).toBe("call-consumed")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test test/api-session.test.ts`
Expected: FAIL — `sendOne` is not exported (it is still named `daemonCall`), and `./helpers.ts` does not exist.

- [ ] **Step 3: Extract the stub-server helpers**

`test/call.test.ts:32-100` already holds a shared `Bun.serve` on port 0 with a per-test responder and `stubEnv()` builders. Move that block to `test/helpers.ts`, export `ISO` (a `WarmIsolation` literal), `stubEnv()`, `respondWith(body)`, and `lastRequestBody()`. Re-point `test/call.test.ts` at it — its assertions are unchanged.

- [ ] **Step 4: Rename and widen the leaf**

In `src/call.ts`: rename `daemonCall` → `sendOne`; drop the `sessionId` minting (the daemon owns session identity now — `acp-daemon.ts`'s `DaemonState.sessions`); return `TurnOutcome` (which carries `canonicalModel`) instead of `DaemonOutcome`; accept `opts.signal?: AbortSignal` and forward it as `client.messages.create({…}, { signal: opts.signal })`. Everything else — the ambient-env guards, `maxRetries: 0`, the `no-call`/`call-consumed` classification, the multi-block text concat — is unchanged.

- [ ] **Step 5: Run the tests**

Run: `bun test test/api-session.test.ts test/call.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/call.ts test/helpers.ts test/call.test.ts test/api-session.test.ts
git commit -m "call.ts becomes the session leaf: sendOne + abort signal

Session identity moves to the daemon (DaemonState.sessions), so the leaf no
longer mints one. Returns TurnOutcome and accepts an AbortSignal so the
session can implement cancel. Stub-server harness extracted to helpers.ts."
```

#### 4b — lifecycle

- [ ] **Step 1: Write the failing test**

```ts
test("a fresh session is not in flight and closes idempotently", () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  expect(s.turnInFlight()).toBe(false)
  s.close(); s.close()
  expect(s.turnInFlight()).toBe(false)
})

test("close() before a turn settles makes the turn call-consumed, not a throw", async () => {
  respondWith({ delayMs: 5_000, content: [], model: "m" })
  const s = new ApiSession(stubEnv(), warmOpts())
  const p = s.oneShot("x", "claude-haiku-4-5", { recycle: false })
  s.close()
  expect((await p).kind).toBe("call-consumed")
})

test("turnInFlight is true while a turn is outstanding", async () => {
  respondWith({ delayMs: 50, content: [{ type: "text", text: "ok" }], model: "claude-haiku-4-5" })
  const s = new ApiSession(stubEnv(), warmOpts())
  const p = s.oneShot("x", "claude-haiku-4-5", { recycle: false })
  expect(s.turnInFlight()).toBe(true)
  await p
  expect(s.turnInFlight()).toBe(false)
  s.close()
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test test/api-session.test.ts -t "fresh session"`
Expected: FAIL — `ApiSession` is not defined.

- [ ] **Step 3: Write the class skeleton**

```ts
// api-session.ts — the @anthropic-ai/sdk backend for the ACP daemon.
//
// Structural twin of meta-harness src/acp/warm-session.ts: same
// DispatchableSession contract, same §6e outcome law, same FIFO. What it is
// NOT is warm — there is no subprocess holding state. "Warm" here means the
// session owns the accumulated conversation array; the HTTP connection is
// pooled by the SDK and nothing else persists between turns.
import { sendOne } from "./call.ts"
import type { AuthDeps } from "./auth.ts"
import { ACP_BUDGET, AUTH_RESOLVE_BUDGET_MS, type WarmIsolation } from "./acp-wire.ts"
import type { WarmConstructOpts } from "./acp-pool.ts"
import type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"

interface PendingTurn {
  text: string
  model: string
  tag: string | undefined
  /** THE §6e send boundary. True once messages.create has been ENTERED for
   * this turn. `consumed(t) === t.sent` — the whole classification. */
  sent: boolean
  /** Cancelled before dispatch; settles as no-call, never ok. */
  dropped: boolean
  controller: AbortController | undefined
  settle: (o: TurnOutcome) => void
}

export class ApiSession implements DispatchableSession {
  readonly isolation: WarmIsolation
  private readonly turnTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly hardGraceMs: number
  private readonly authDeps: AuthDeps | undefined
  private pending: PendingTurn[] = []
  private current: PendingTurn | undefined
  private draining = false
  private closed = false
  /** The accumulated conversation. `messages.create` is stateless, so
   * continuity across session/prompt calls is THIS object's job — the one
   * place the swap is genuinely new code rather than a port. */
  private history: Array<{ role: "user" | "assistant"; content: string }> = []

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: WarmConstructOpts & { cwd?: string; authDeps?: AuthDeps },
  ) {
    // Floored by auth resolution for the reason the upstream floor existed
    // for CLI spawn: a turn's timer starts at the push, and without the
    // floor the session cannot tell "generation failed" from "auth had not
    // resolved yet". `clearTimeoutMs` and `setModelMs` are accepted and
    // ignored — no /clear, no setModel round-trip on this backend.
    this.turnTimeoutMs = Math.max(AUTH_RESOLVE_BUDGET_MS, opts.turnTimeoutMs ?? ACP_BUDGET.turnTimeoutMs)
    this.queueWaitMs = opts.queueWaitMs ?? ACP_BUDGET.queueWaitMs
    this.hardGraceMs = opts.hardGraceMs ?? ACP_BUDGET.hardGraceMs
    this.isolation = opts.isolation
    this.authDeps = opts.authDeps
  }

  turnInFlight(): boolean {
    return this.current !== undefined || this.pending.length > 0 || this.draining
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // A turn already sent MAY have spent — abort the HTTP request but settle
    // call-consumed, never no-call. An unsent turn provably spent nothing.
    this.current?.controller?.abort()
    for (const t of [this.current, ...this.pending]) {
      if (t) t.settle({ kind: t.sent ? "call-consumed" : "no-call" })
    }
    this.current = undefined
    this.pending = []
    this.history = []
  }
}
```

- [ ] **Step 4: Run the lifecycle tests**

Run: `bun test test/api-session.test.ts -t "fresh session"`
Expected: PASS. The `close() before settle` and `turnInFlight` tests still fail — `oneShot` is not implemented.

- [ ] **Step 5: Commit**

```bash
git add src/api-session.ts test/api-session.test.ts
git commit -m "ApiSession skeleton: construction, turnInFlight, close

close() settles outstanding turns by the send boundary — a sent turn is
call-consumed (it may have spent), an unsent one is no-call."
```

#### 4c — `oneShot` and the FIFO

- [ ] **Step 1: Write the failing test**

```ts
test("recycle: false carries history into the next turn", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ content: [{ type: "text", text: "one" }], model: "claude-haiku-4-5" })
  await s.oneShot("first", "claude-haiku-4-5", { recycle: false })
  respondWith({ content: [{ type: "text", text: "two" }], model: "claude-haiku-4-5" })
  await s.oneShot("second", "claude-haiku-4-5", { recycle: false })
  expect(lastRequestBody().messages).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "one" },
    { role: "user", content: "second" },
  ])
  s.close()
})

test("recycle: true clears history first — the /clear equivalent", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ content: [{ type: "text", text: "one" }], model: "claude-haiku-4-5" })
  await s.oneShot("first", "claude-haiku-4-5", { recycle: false })
  respondWith({ content: [{ type: "text", text: "two" }], model: "claude-haiku-4-5" })
  await s.oneShot("second", "claude-haiku-4-5", { recycle: true })
  expect(lastRequestBody().messages).toEqual([{ role: "user", content: "second" }])
  s.close()
})

test("turns run strictly FIFO, one at a time", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  const seen: string[] = []
  respondWith({ onRequest: (b: any) => seen.push(b.messages.at(-1).content),
                content: [{ type: "text", text: "r" }], model: "claude-haiku-4-5" })
  await Promise.all([
    s.oneShot("a", "claude-haiku-4-5", { recycle: true }),
    s.oneShot("b", "claude-haiku-4-5", { recycle: false }),
  ])
  expect(seen).toEqual(["a", "b"])
  s.close()
})

test("a turn that waits past queueWaitMs settles no-call — it never reached the wire", async () => {
  const s = new ApiSession(stubEnv(), { ...warmOpts(), queueWaitMs: 30 })
  respondWith({ delayMs: 300, content: [{ type: "text", text: "slow" }], model: "claude-haiku-4-5" })
  const first = s.oneShot("a", "claude-haiku-4-5", { recycle: true })
  const second = s.oneShot("b", "claude-haiku-4-5", { recycle: false })
  expect((await second).kind).toBe("no-call")
  await first
  s.close()
})

test("a failed turn does not poison history", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ status: 500 })
  expect((await s.oneShot("bad", "claude-haiku-4-5", { recycle: false })).kind).toBe("call-consumed")
  respondWith({ content: [{ type: "text", text: "ok" }], model: "claude-haiku-4-5" })
  await s.oneShot("good", "claude-haiku-4-5", { recycle: false })
  expect(lastRequestBody().messages).toEqual([{ role: "user", content: "good" }])
  s.close()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test test/api-session.test.ts`
Expected: FAIL — `s.oneShot is not a function`

- [ ] **Step 3: Implement `oneShot` + `drain`**

```ts
  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      if (this.closed) { resolve({ kind: "no-call" }); return }
      if (opts.recycle) this.history = []
      let settled = false
      const turn: PendingTurn = {
        text: messageText, model, tag: opts.tag, sent: false, dropped: false,
        controller: undefined,
        settle: (o) => { if (!settled) { settled = true; resolve(o) } },
      }
      // The queue-wait timer arms at the PUSH, matching upstream: a turn
      // still queued when it fires provably never reached the wire.
      const queueTimer = setTimeout(() => {
        if (!turn.sent && this.current !== turn) {
          turn.dropped = true
          this.pending = this.pending.filter((t) => t !== turn)
          turn.settle({ kind: "no-call" })
        }
      }, this.queueWaitMs)
      const settleOnce = turn.settle
      turn.settle = (o) => { clearTimeout(queueTimer); settleOnce(o) }
      this.pending.push(turn)
      void this.drain()
    })
  }

  /** Strict FIFO, one turn on the wire at a time. Never throws — a rejection
   * escaping here would surface as an unhandled rejection in the daemon
   * process, killing the host-global singleton. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0 && !this.closed) {
        const turn = this.pending.shift()!
        if (turn.dropped) continue
        this.current = turn
        const controller = new AbortController()
        turn.controller = controller
        const deadline = setTimeout(() => controller.abort(), this.turnTimeoutMs)
        // THE SEND BOUNDARY. Everything after this point is call-consumed.
        turn.sent = true
        const messages = [...this.history, { role: "user" as const, content: turn.text }]
        const outcome = await sendOne(turn.text, turn.model, this.env, {
          isolation: this.isolation,
          budgetMs: this.turnTimeoutMs,
          authDeps: this.authDeps,
          signal: controller.signal,
          messages,
        })
        clearTimeout(deadline)
        // History advances ONLY on a proven-ok turn: a failed or aborted turn
        // must not leave a dangling user message that every later turn
        // re-sends and re-pays for.
        if (outcome.kind === "ok") {
          this.history = [...messages, { role: "assistant", content: outcome.text }]
        }
        this.current = undefined
        turn.settle(outcome)
      }
    } finally {
      this.draining = false
      this.current = undefined
    }
  }
```

- [ ] **Step 3a: Cross-client leak test (singleton safety — do not skip)**

The daemon is shared by every kkamak instance with the same env fingerprint, and the pool hands one idle entry to whichever client asks next. This test asserts that a recycled entry carries nothing across. A failure here is one project's prompts being sent to the API inside another project's request and billed to it.

```ts
test("a recycled session leaks nothing from the previous client", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ content: [{ type: "text", text: "alpha-reply" }], model: "claude-haiku-4-5" })
  await s.oneShot("SECRET-FROM-CLIENT-A", "claude-haiku-4-5", { recycle: false })

  // the pool hands this same entry to a different session -> recycle: true
  respondWith({ content: [{ type: "text", text: "beta-reply" }], model: "claude-haiku-4-5" })
  await s.oneShot("client-B-prompt", "claude-haiku-4-5", { recycle: true })

  const sent = JSON.stringify(lastRequestBody())
  expect(sent).not.toContain("SECRET-FROM-CLIENT-A")
  expect(sent).not.toContain("alpha-reply")
  expect(lastRequestBody().messages).toEqual([{ role: "user", content: "client-B-prompt" }])
  s.close()
})

test("close() drops history so a reaped entry cannot resurrect it", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ content: [{ type: "text", text: "r" }], model: "claude-haiku-4-5" })
  await s.oneShot("SECRET", "claude-haiku-4-5", { recycle: false })
  s.close()
  expect((s as unknown as { history: unknown[] }).history).toEqual([])
})
```

Run: `bun test test/api-session.test.ts -t "leak"`
Expected: PASS (Task 4b's `close()` already empties `history`; Task 4c's `recycle` already clears it — this pins both against regression).

- [ ] **Step 4: Widen `sendOne` to take a message array**

`sendOne` currently builds `messages: [{role:"user", content: outgoingText}]` internally. Add `opts.messages?: Array<{role:"user"|"assistant"; content:string}>` and use it when present, falling back to the single-message shape otherwise so `test/call.test.ts` stays byte-unchanged.

- [ ] **Step 5: Run the tests**

Run: `bun test test/api-session.test.ts`
Expected: PASS, all of 4b and 4c.

- [ ] **Step 6: Commit**

```bash
git add src/api-session.ts src/call.ts test/api-session.test.ts
git commit -m "ApiSession.oneShot: FIFO dispatch over accumulated history

messages.create is stateless, so session continuity is the session's own
job — the one part of the swap that is new code rather than a port. History
advances only on a proven-ok turn, so a failed turn cannot leave a dangling
user message that every later turn re-sends and re-pays for."
```

#### 4d — `cancel`

- [ ] **Step 1: Write the failing test**

```ts
test("cancelling a queued turn is queued-dropped and settles no-call", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ delayMs: 200, content: [{ type: "text", text: "r" }], model: "claude-haiku-4-5" })
  const first = s.oneShot("a", "claude-haiku-4-5", { recycle: true, tag: "t1" })
  const second = s.oneShot("b", "claude-haiku-4-5", { recycle: false, tag: "t2" })
  expect(s.cancel("t2")).toBe("queued-dropped")
  expect((await second).kind).toBe("no-call")
  await first
  s.close()
})

test("cancelling the in-flight turn is interrupted and settles call-consumed", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  respondWith({ delayMs: 5_000, content: [], model: "m" })
  const p = s.oneShot("a", "claude-haiku-4-5", { recycle: true, tag: "t1" })
  await Bun.sleep(20)
  expect(s.cancel("t1")).toBe("interrupted")
  expect((await p).kind).toBe("call-consumed")
  s.close()
})

test("cancelling an unknown tag is unknown and disturbs nothing", async () => {
  const s = new ApiSession(stubEnv(), warmOpts())
  expect(s.cancel("nope")).toBe("unknown")
  s.close()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test test/api-session.test.ts -t "cancel"`
Expected: FAIL — `s.cancel is not a function`

- [ ] **Step 3: Implement `cancel`**

```ts
  /** Never settles the turn as `ok`, and never settles it AT the moment of
   * cancellation for an in-flight turn — the abort propagates and `drain`
   * settles from the terminal outcome (upstream law L7). `unsent-dropped`
   * is unreachable on this backend: a turn is either still queued (never
   * dispatched) or already past the send boundary, with no window between
   * dequeue and send. It stays in CancelResult for contract parity. */
  cancel(tag: string): CancelResult {
    if (this.current?.tag === tag) {
      this.current.controller?.abort()
      return "interrupted"
    }
    const queued = this.pending.find((t) => t.tag === tag)
    if (queued) {
      queued.dropped = true
      this.pending = this.pending.filter((t) => t !== queued)
      queued.settle({ kind: "no-call" })
      return "queued-dropped"
    }
    return "unknown"
  }
```

- [ ] **Step 4: Run the full suite**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/api-session.ts test/api-session.test.ts
git commit -m "ApiSession.cancel

Queued turns drop before the send boundary (no-call). An in-flight turn is
aborted but settles from its terminal outcome, never at the moment of
cancellation and never as ok. unsent-dropped is unreachable here — no window
exists between dequeue and send — and is kept for contract parity."
```

---

### Task 5: Wire the backend in

`ApiSession` becomes the pool's default, and `makeSession` is threaded out to the daemon entry point so meta-harness can inject `WarmSession` instead.

**Files:**
- Modify: `src/acp-pool.ts` (default `makeSession`), `src/acp-daemon.ts` (thread the option), `src/index.ts` (public surface)
- Modify: `test/acp-pool.test.ts`, `test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `ApiSession` (Task 4), `SessionPool` (Task 1)
- Produces: `serveDaemon(env, opts?: {makeSession?: (env, WarmConstructOpts) => DispatchableSession})`; `index.ts` exports `ensureDaemon`, `daemonCall`, `closeSession`, `serveDaemon`, `ApiSession`, `modelProvenBy`, and types `DaemonOutcome`, `WarmIsolation`, `DispatchableSession`, `TurnOutcome`, `CancelResult`, `AuthDeps`

- [ ] **Step 1: Write the failing test**

```ts
test("the pool builds ApiSessions by default", () => {
  const pool = new SessionPool(stubEnv(), { max: 1 })
  const got = pool.acquire(ISO, Date.now())
  expect(got.ok).toBe(true)
  if (!got.ok) throw new Error("unreachable")
  expect(got.entry.warm).toBeInstanceOf(ApiSession)
  pool.closeAll()
})

test("an injected makeSession overrides the default", () => {
  let built = 0
  const pool = new SessionPool(stubEnv(), {
    max: 1,
    makeSession: () => { built++; return { turnInFlight: () => false, close: () => {} } },
  })
  pool.acquire(ISO, Date.now())
  expect(built).toBe(1)
  pool.closeAll()
})
```

- [ ] **Step 2: Run and watch the first fail**

Run: `bun test test/acp-pool.test.ts -t "ApiSessions by default"`
Expected: FAIL — the default was commented out in Task 1 Step 3.

- [ ] **Step 3: Restore the default as `ApiSession`**

```ts
// acp-pool.ts
import { ApiSession } from "./api-session.ts"
// …
this.makeSession = opts.makeSession ?? ((e, warmOpts) => new ApiSession(e, warmOpts))
```

- [ ] **Step 4: Thread `makeSession` to the daemon entry**

`acp-daemon.ts` constructs its `SessionPool` internally. Add an optional `makeSession` to the daemon's own options and pass it straight through, so a host that wants a different backend supplies one at the top. Default stays `ApiSession` via the pool.

- [ ] **Step 5: Rewrite `src/index.ts`**

```ts
// index.ts — this package's PUBLIC surface.
//
// THE RULE: consumers import from THIS FILE. package.json's exports map
// resolves only ".", so nothing inside src/ is otherwise reachable. Adding
// an export here is a deliberate widening — do it on purpose.

/** Client side: ensure a daemon is listening, send it a turn, close a session. */
export { ensureDaemon, daemonCall, closeSession, type DaemonOutcome } from "./acp-client.ts"

/** Server side: run the daemon. `makeSession` swaps the backend. */
export { serveDaemon } from "./acp-daemon.ts"

/** The default backend. Exported so a host can construct one directly, and so
 * `makeSession` injectors have something to mirror. */
export { ApiSession } from "./api-session.ts"

/** Isolation is a VALUE that crosses the wire on session/new, not an id.
 * This package ships no isolation constant — that is caller-side policy. */
export type { WarmIsolation } from "./acp-wire.ts"

/** Model-identity check over what the wire actually reported. */
export { modelProvenBy } from "./acp-wire.ts"

/** The backend contract, for hosts injecting their own session. */
export type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"

/** Needed to type the injectable auth seam. */
export type { AuthDeps } from "./auth.ts"
```

- [ ] **Step 6: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/acp-pool.ts src/acp-daemon.ts src/index.ts test/
git commit -m "wire ApiSession as the default backend; expose makeSession

The pool's existing makeSession seam is threaded out to the daemon entry
point, so a host with a different backend (meta-harness keeps its agent-SDK
WarmSession) injects it at the top instead of forking the core."
```

---

### Task 6: End-to-end over a real socket

Prove client → unix socket → daemon → `ApiSession` → stubbed HTTP, with zero spend.

**Files:**
- Create: `test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: nothing (a test)

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e.test.ts
import { test, expect, afterEach } from "bun:test"
import { ensureDaemon, daemonCall, closeSession } from "../src/index.ts"
import { serveDaemon } from "../src/acp-daemon.ts"
import { ISO, stubEnv, respondWith } from "./helpers.ts"

let stop: (() => Promise<void>) | undefined
afterEach(async () => { await stop?.(); stop = undefined })

test("a turn round-trips client -> socket -> daemon -> ApiSession -> stub", async () => {
  const env = { ...stubEnv(), KKAMAK_ACP_SOCKET_DIR: `/tmp/cc-api-daemon-e2e-${crypto.randomUUID()}` }
  stop = await serveDaemon(env)
  expect(await ensureDaemon(env, { waitMs: 5_000 })).toBe(true)

  respondWith({ content: [{ type: "text", text: "pong" }], model: "claude-haiku-4-5-20251001" })
  const out = await daemonCall("ping", "claude-haiku-4-5", env, { isolation: ISO })

  expect(out.kind).toBe("ok")
  if (out.kind !== "ok") throw new Error("unreachable")
  expect(out.text).toBe("pong")
  expect(out.sessionId).toBeTruthy()
  expect(await closeSession(out.sessionId!, env)).toMatchObject({ closed: true })
})

test("no daemon listening -> ensureDaemon false, daemonCall no-call", async () => {
  const env = { ...stubEnv(), KKAMAK_ACP_SOCKET_DIR: `/tmp/cc-api-daemon-none-${crypto.randomUUID()}` }
  expect(await ensureDaemon(env, { waitMs: 200 })).toBe(false)
  expect((await daemonCall("x", "claude-haiku-4-5", env, { isolation: ISO })).kind).toBe("no-call")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test test/e2e.test.ts`
Expected: FAIL. Read the failure before changing anything — the likely causes are the socket-dir env var name (confirm against the ported `acp-paths.ts`, do not guess) and `serveDaemon`'s actual return shape.

- [ ] **Step 3: Fix what the failure names**

Adjust the test to the ported modules' real surface. Do not adjust the modules to the test unless the failure is a genuine defect — these five files are a verbatim port of code that already works in production.

- [ ] **Step 4: Run it**

Run: `bun test test/e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Confirm zero spend**

Run: `grep -rn "api.anthropic.com" test/`
Expected: no output. Every test must reach the local stub.

- [ ] **Step 6: Commit**

```bash
git add test/e2e.test.ts
git commit -m "e2e: client -> unix socket -> daemon -> ApiSession -> stub

Zero spend; the HTTP leg terminates at the local Bun.serve stub."
```

---

### Task 7: Documentation

`README.md` and `CLAUDE.md` currently describe a single-process library with no daemon. After Tasks 1-6 both are wrong.

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `scripts/smoke.ts`

- [ ] **Step 1: Rewrite `README.md`**

Replace "Single-process `@anthropic-ai/sdk` twin of the kkamak ACP warm-lane client surface" with what it now is: an ACP daemon — unix socket, JSON-RPC, session pool — with `messages.create` as the backend. Update Usage to show `serveDaemon` plus the client trio. Rewrite "Known limitations": `waitMs` is now real (there IS a daemon to wait for) and `closeSession` is no longer a no-op, so both entries go. Keep and update: `canonicalModel === model` always; HTTP 401 classifies as `call-consumed`; Bun-only; the `ANTHROPIC_CUSTOM_HEADERS` env-leak exception. Add the new ones: `clearTimeoutMs`/`setModelMs` accepted-and-ignored, and `unsent-dropped` unreachable.

- [ ] **Step 2: Rewrite `CLAUDE.md`**

"Architecture" becomes eight files, not four. Document the `makeSession` seam as the supported way to swap backends, the send boundary living in `ApiSession.drain` (`turn.sent = true` immediately before `sendOne`), and the history-advances-only-on-ok rule. Keep the ambient-env leak-guard section verbatim — it still applies to `call.ts`.

- [ ] **Step 3: Update `scripts/smoke.ts`**

It calls the old in-process `ensureDaemon`/`daemonCall`. Point it at the real ones and have it start a daemon first. Keep the one-haiku-call budget and the never-in-CI warning.

- [ ] **Step 4: Verify the docs against the code**

Run: `grep -rn "single-process\|no daemon process, no socket\|accepted-and-ignored" README.md CLAUDE.md`
Expected: no stale claim survives. Every `waitMs`-is-ignored and no-socket claim must be gone.

- [ ] **Step 5: Full gate**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md scripts/smoke.ts
git commit -m "docs: describe the daemon, not the single-process twin

waitMs and closeSession are real now; the no-socket/no-daemon claims are
gone. Adds the makeSession backend seam, the send boundary's location, and
the history-advances-only-on-ok rule."
```

---

### Task 8: Publish the daemon's budget on the wire

Under the fork, kkamak's client budget and this daemon's `daemonWorstCaseMs` live in different repos with nothing checking `client > daemon`. A drift converts a `call-consumed` into a `no-call` — the client concludes nothing was sent and retries, so one record is billed twice. Make the contract checkable at runtime.

**Files:**
- Modify: `src/acp-wire.ts` (`AcpInitializeResult`), `src/acp-daemon.ts` (initialize handler), `src/acp-client.ts` (initialize response handling)
- Modify: `test/acp-wire.test.ts`, `test/acp-client.test.ts`

**Interfaces:**
- Consumes: `ACP_BUDGET` (Task 3), `AcpInitializeResult` (Task 1)
- Produces: `AcpInitializeResult._meta.kkamak.daemonWorstCaseMs?: number`

- [ ] **Step 1: Write the failing test**

```ts
// test/acp-client.test.ts
test("a daemon whose worst case exceeds the client budget is refused pre-send", async () => {
  const env = fakeDaemonEnv({
    initializeMeta: { kkamak: { envFingerprint: fpOf(env), daemonWorstCaseMs: 999_000 } },
  })
  const out = await daemonCall("x", "claude-haiku-4-5", env, { isolation: ISO })
  expect(out.kind).toBe("no-call")   // law L1: refused before anything was sent
})

test("a daemon that omits the field is accepted — older daemons stay compatible", async () => {
  const env = fakeDaemonEnv({ initializeMeta: { kkamak: { envFingerprint: fpOf(env) } } })
  expect(await ensureDaemon(env, { waitMs: 2_000 })).toBe(true)
})
```

- [ ] **Step 2: Run and watch the first fail**

Run: `bun test test/acp-client.test.ts -t "worst case"`
Expected: FAIL — the client currently ignores the field and proceeds.

- [ ] **Step 3: Widen the result type**

```ts
// acp-wire.ts
export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
  _meta: {
    kkamak: {
      envFingerprint: string
      /** The daemon's own worst-case turn budget. ADDITIVE and OPTIONAL: a
       * daemon that predates this field is exactly as safe as it was, and a
       * client that ignores it is too. Present so the
       * `clientBudget > daemonWorstCase` contract survives the two sides
       * living in separate repos — a drift there bills one record twice. */
      daemonWorstCaseMs?: number
    }
  }
}
```

- [ ] **Step 4: Report it from the daemon**

In `acp-daemon.ts`'s `initialize` handler, add `daemonWorstCaseMs: ACP_BUDGET.daemonWorstCaseMs` alongside the existing `envFingerprint`.

- [ ] **Step 5: Enforce it in the client**

In `acp-client.ts`, immediately after the existing fingerprint check (same refusal path, same `no-call` classification — nothing has been sent yet):

```ts
const dw = init._meta?.kkamak?.daemonWorstCaseMs
if (typeof dw === "number" && dw >= clientBudgetMs) {
  // Pre-send refusal, law L1. Proceeding would let the client time out
  // BEFORE the daemon does, report no-call for a turn the daemon may still
  // deliver, and bill the record twice on retry.
  return { kind: "no-call" }
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/acp-wire.ts src/acp-daemon.ts src/acp-client.ts test/
git commit -m "publish daemonWorstCaseMs on initialize; client refuses a too-slow daemon

The client-budget > daemon-worst-case contract used to hold because both
numbers lived in one object. Forked from meta-harness, they now live in
separate repos with nothing checking them. The daemon reports its own worst
case and the client refuses pre-send (no-call, nothing sent) rather than
timing out first and billing the record twice on retry. Additive and
optional: daemons and clients that predate the field are unaffected."
```

---

## Open question this plan does NOT answer: who starts the singleton

`acp-client.ts:402 spawnDaemonProcess` spawns via `Bun.spawn(["bash","-c","nohup … &"])`, and `acp-client.ts:392` resolves the daemon entry point by **sibling path** inside the plugin tree. A standalone package has no such sibling. `ensureDaemon` connects-or-spawns; `daemonCall` never spawns.

So before this daemon can serve a kkamak client, someone must decide how it gets launched and how a client finds its entry point — an installed binary on `PATH`, a `bunx` invocation, a systemd/launchd unit, or a `SessionStart` hook. Cross-host matters here too: transfer is git-only, and this must work on both `yoo-dev` (WSL2) and `yoo-mac` (darwin).

Not blocking Tasks 1-8, which build and test the daemon in-process. Blocking any real kkamak-to-daemon use. Decide it before wiring a live client.

---

## Self-review

**Spec coverage.** Port the five agnostic modules → Task 1. Replace `warm-session.ts` → Task 4. Fold `call.ts` in as the leaf → Task 4a. Move `GAUGE_ISOLATION` caller-side → Task 1 Step 2. Implement `WarmSessionLike` + `TurnOutcome` → Tasks 2, 4b-4d. Drop the agent SDK → verified in Task 3 Step 4 and Task 7 Step 4.

**Gaps deliberately left, with reasons.**

1. **`isWarm()` and `idleMs()`** are on the upstream `WarmSession` but absent from `DispatchableSession`. `acp-daemon.ts:539` records that the `idleMs()` gate no longer exists, and no ported call site uses either. If the ported `acp-pool.ts` reap path does call `idleMs()`, add it to the contract in Task 2 and to `ApiSession` in Task 4b — check at Task 1 Step 6 rather than assuming.
2. **`selectEvidence` / `ModelEvidence` are not ported.** They exist to reconcile the agent SDK's `modelUsage` map, which the raw API does not return. `sendOne` reads `response.model` directly and sets `canonicalModel` to the same value. `modelProvenBy` is still exported and still correct — its `canonicalModel` branch is simply dead here, as the current README already documents.
3. **Pool sizing is not revisited — but the stated motivation puts it back in play.** A `WarmSession` holds ~330 MB (a CLI subprocess); an `ApiSession` holds a message array. The `max` cap (4) exists to bound that memory, so on this backend it is now arbitrary and far more conservative than the resource justifies. Since "the agent SDK is too heavy" is the whole reason for the swap, leaving the cap at its subprocess-era value banks the correctness win and discards most of the throughput win.

   Still not in these tasks, deliberately: the right cap is a measurement, and measuring it before the daemon runs is guesswork. Re-open it as a follow-up once Task 6 passes, with a number from an actual concurrency test rather than a guess. The same applies to `turnTimeoutMs: 16_000`, which was sized for CLI generation including subprocess boot.

**Type consistency.** `TurnOutcome` and `CancelResult` are defined once (Task 2) and imported everywhere. `sendOne` (not `daemonCall`) is the leaf from 4a onward; `daemonCall` from 5 onward means only the *client* function in `acp-client.ts`. `DispatchableSession` replaces `DispatchableWarm` at every site. `AUTH_RESOLVE_BUDGET_MS` replaces `CLI_SPAWN_BUDGET_MS` with zero survivors.

**Risks worth naming before execution.**

- **Task 1 is a large unreviewed import.** 1878 lines land in one commit. They arrive with their own tests, which is the mitigation, but a reviewer should read the diff as "does this belong here", not "is this correct".
- **The e2e test may expose port assumptions** (socket dir env var, `serveDaemon` shape). Task 6 Step 3 says to fix the test, not the modules — these five files work in production today.
- **Lane reality, unchanged by any of this:** the package rides the bare-SDK transport, which currently 429s `claude-opus-5`. Measured 2026-08-06: 429 is per-transport, and the agent-SDK lane serves opus while bare SDK does not. This daemon is a *second* lane beside meta-harness's, not a replacement — unless it runs on an API key, which is a different quota entirely (`auth.ts:57` puts `ANTHROPIC_API_KEY` first).
