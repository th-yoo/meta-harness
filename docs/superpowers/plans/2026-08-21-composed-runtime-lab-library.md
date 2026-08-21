# Composed Runtime Lab Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the `poc/code-mode-gate/` proof into a reusable, verifier-agnostic lab library: a worker-isolated code-mode runtime whose only effect path is a pluggable deterministic gate, with the PoC's cost/capability claims re-proven across the isolation boundary.

**Architecture:** A Bun `Worker` executes one guest program per turn (real thread boundary, watchdog-terminated); every tool and gate interaction is an async RPC over `postMessage`, so the guest holds zero host references. The host owns commit storage and the cost meter; the verifier is a plugged-in pure function returning verdict + steering. Two bundled verifiers — kkamak's real merge gate and a domain-different source-recount verifier — prove the runtime is verifier-agnostic.

**Tech Stack:** Bun + TypeScript, `bun:test`, Bun `Worker` (structured clone messaging). Zero new dependencies. Zero model-token spend.

**Spec:** `poc/code-mode-gate/README.md` (the claims this library preserves) — read it first. The PoC stays frozen as the reference; this library is a NEW top-level dir `lab/code-mode-gate/`.

## Global Constraints

- **Zero model-token spend.** Pure code + `bun:test`. No daemonCall, no bench runs.
- **Additive only.** Create `lab/code-mode-gate/` and this plan's test files. Do NOT modify `poc/code-mode-gate/` (frozen reference), `opencode-plugin/src/**` (read-only import target), `minimal/`, or `term-bench2/`.
- **Shared checkout.** Work directly on `main`; NO branch/worktree operations. Never `git add docs/resume.md` or `minimal/HISTORY.md` (this plan never touches them). Stage exact paths only.
- **Do NOT push.** Push is its own user go.
- **Suite discipline:** after every task run `bun test lab/code-mode-gate/ poc/code-mode-gate/` (both green). The opencode-plugin suite is untouched by construction (no files there change); run it once at the end (Task 7) as a paranoia check: `cd opencode-plugin && bun test` → expect `2280 pass, 1 skip, 0 fail`.
- **NOT a security sandbox.** Worker isolation gives a thread boundary, watchdog kill, and no shared scope — it does NOT give memory limits or hostile-code safety. Every file header that mentions isolation must name QuickJS-WASI (OpenClaw `src/agents/code-mode-*`) as the hostile-guest reference. Never claim "sandbox" in code, comments, or docs.
- **Verifier-agnosticism is a REQUIREMENT, not a nice-to-have:** the runtime must never import, name, or special-case any verifier domain (no "anchor", "raman", "series" identifiers inside `lab/code-mode-gate/{types,bridge,guest-shell,runtime}.ts`). Domain words live only under `verifiers/`. Task 7 greps for this.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

```
lab/code-mode-gate/
  types.ts               — verdicts, verifier interface, limits, failure codes, cost meter (no I/O)
  guest-shell.ts         — runs INSIDE the Worker: RPC stubs, guest execution
  bridge.ts              — host side: worker lifecycle, RPC dispatch, watchdog, caps
  runtime.ts             — public API: ComposedRuntime (meter, commit storage, verifier wiring)
  verifiers/
    merge-fit.ts         — kkamak real merge verifier adapter (imports opencode-plugin reval-fit)
    source-recount.ts    — domain-different verifier: recount claim vs the task's own text
  types.test.ts  bridge.test.ts  runtime.test.ts  verifiers.test.ts  parity.test.ts
  README.md
```

## Task DAG

```
T1 types → T2 worker echo+watchdog → T3 tool RPC + caps → T4 gate + commit
T5 verifiers (needs T1 only; parallelizable in principle, but shared checkout serializes)
T6 parity (needs T4+T5) → T7 grep guard + README + paranoia suite run
```

---

### Task 1: types.ts — contracts, limits, failure codes, cost meter

**Files:**
- Create: `lab/code-mode-gate/types.ts`
- Test: `lab/code-mode-gate/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks import these exact names):
  - `export type FailureCode = "timeout" | "output_limit_exceeded" | "pending_limit_exceeded" | "guest_error"`
  - `export interface Limits { timeoutMs: number; maxPendingCalls: number; maxOutputBytes: number }`
  - `export const DEFAULT_LIMITS: Limits`  — `{ timeoutMs: 10_000, maxPendingCalls: 16, maxOutputBytes: 64 * 1024 }`
  - `export interface Steering<S = unknown> { summary: string; detail: S }`
  - `export interface Verdict<S = unknown> { ok: boolean; reason?: string; steering?: Steering<S> }`
  - `export type Verifier<C, S = unknown> = (claim: C) => Verdict<S>`
  - `export interface CostMeter { roundTrips: number; toolCalls: number; gateChecks: number; gateRejections: number; localRetries: number; approxTokens: number }`
  - `export function newMeter(): CostMeter`
  - `export function approxTokensOf(s: string): number`  — `Math.ceil(s.length / 4)`

- [ ] **Step 1: Write the failing test**

Create `lab/code-mode-gate/types.test.ts`:

```ts
import { test, expect } from "bun:test"
import { DEFAULT_LIMITS, approxTokensOf, newMeter } from "./types.ts"

test("default limits mirror the reference implementation's shape", () => {
  // Values chosen to match OpenClaw code-mode defaults (timeout 10s,
  // pending 16, output 64KB) so cost comparisons stay comparable.
  expect(DEFAULT_LIMITS).toEqual({ timeoutMs: 10_000, maxPendingCalls: 16, maxOutputBytes: 65_536 })
})

test("approxTokensOf is the ceil-quarter floor model", () => {
  expect(approxTokensOf("")).toBe(0)
  expect(approxTokensOf("abcd")).toBe(1)
  expect(approxTokensOf("abcde")).toBe(2)
})

test("a fresh meter is all zeros", () => {
  expect(newMeter()).toEqual({
    roundTrips: 0, toolCalls: 0, gateChecks: 0, gateRejections: 0, localRetries: 0, approxTokens: 0,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lab/code-mode-gate/types.test.ts`
Expected: FAIL — `Cannot find module './types.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `lab/code-mode-gate/types.ts`:

```ts
/** Contracts for the composed runtime: code-mode batching + gated effects.
 * Pure types and arithmetic — no I/O, no worker, no verifier domain content.
 * The runtime layer must stay verifier-agnostic; domain words live only under
 * verifiers/. */

export type FailureCode = "timeout" | "output_limit_exceeded" | "pending_limit_exceeded" | "guest_error"

export interface Limits {
  /** watchdog kill for one guest turn */
  timeoutMs: number
  /** max concurrently in-flight RPCs a guest may hold open */
  maxPendingCalls: number
  /** cap on total guest log bytes per turn */
  maxOutputBytes: number
}

/** Mirrors the reference implementation's defaults (OpenClaw code-mode:
 * timeout 10s, pending 16, output 64KB) so cost comparisons stay comparable.
 * NOTE: no memory limit — Bun Workers cannot enforce one. This is a thread
 * boundary with a watchdog, NOT a security sandbox; the hostile-guest
 * reference is OpenClaw's QuickJS-WASI worker. */
export const DEFAULT_LIMITS: Limits = { timeoutMs: 10_000, maxPendingCalls: 16, maxOutputBytes: 64 * 1024 }

/** Steering: what a gate rejection tells the guest so correction can happen
 * IN-TURN. `summary` is human/model-readable; `detail` is verifier-shaped. */
export interface Steering<S = unknown> {
  summary: string
  detail: S
}

export interface Verdict<S = unknown> {
  ok: boolean
  reason?: string
  steering?: Steering<S>
}

/** A verifier is a PURE deterministic function — the zero-spend property the
 * whole composition rests on. It must derive nothing from who is asking. */
export type Verifier<C, S = unknown> = (claim: C) => Verdict<S>

export interface CostMeter {
  roundTrips: number
  toolCalls: number
  gateChecks: number
  gateRejections: number
  /** rejections whose steering was consumed inside the SAME turn */
  localRetries: number
  approxTokens: number
}

export function newMeter(): CostMeter {
  return { roundTrips: 0, toolCalls: 0, gateChecks: 0, gateRejections: 0, localRetries: 0, approxTokens: 0 }
}

export function approxTokensOf(s: string): number {
  return Math.ceil(s.length / 4)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lab/code-mode-gate/types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lab/code-mode-gate/types.ts lab/code-mode-gate/types.test.ts
git commit -m "$(cat <<'EOF'
feat(lab): composed-runtime contracts — limits, verdicts, verifier, meter

Pure types and arithmetic. Defaults mirror the OpenClaw code-mode reference
(10s/16/64KB) so cost comparisons stay comparable. Explicitly documented as a
thread boundary, not a security sandbox.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: guest-shell.ts + bridge.ts — worker round trip and watchdog

**Files:**
- Create: `lab/code-mode-gate/guest-shell.ts`
- Create: `lab/code-mode-gate/bridge.ts`
- Test: `lab/code-mode-gate/bridge.test.ts`

**Interfaces:**
- Consumes: `FailureCode`, `Limits`, `DEFAULT_LIMITS` from `./types.ts` (Task 1).
- Produces:
  - `export interface BridgeCallbacks { onToolCall(name: string, args: unknown): unknown | Promise<unknown>; onGateCall(claim: unknown): unknown; onLog(msg: string): void }`
  - `export type BridgeOutcome = { status: "completed"; guestError?: string } | { status: "failed"; code: FailureCode; message: string }`
  - `export async function runGuest(src: string, toolNames: string[], limits: Limits, cb: BridgeCallbacks): Promise<BridgeOutcome>`
  - Guest-visible surface (inside the worker): global `api` with `tools.<name>(args?) → Promise`, `checkAndCommit(claim) → Promise<Verdict>`, `log(msg)`. Guest source is wrapped in an async IIFE, so top-level `await` works.
- Message protocol (internal to these two files, keep in sync):
  - host→guest: `{ type: "run", src, toolNames }` | `{ type: "result", id, ok, value?, error? }`
  - guest→host: `{ type: "call", id, target: "tool" | "gate", name?, args }` | `{ type: "log", msg }` | `{ type: "done", error? }`

- [ ] **Step 1: Write the failing test**

Create `lab/code-mode-gate/bridge.test.ts`:

```ts
import { test, expect } from "bun:test"
import { runGuest } from "./bridge.ts"
import { DEFAULT_LIMITS } from "./types.ts"

const noopCb = () => ({
  onToolCall: () => undefined as unknown,
  onGateCall: () => ({ ok: true }),
  onLog: (_: string) => {},
})

test("a trivial guest completes and its logs reach the host", async () => {
  const logs: string[] = []
  const out = await runGuest(`api.log("hello"); api.log("world");`, [], DEFAULT_LIMITS, {
    ...noopCb(),
    onLog: (m) => logs.push(m),
  })
  expect(out.status).toBe("completed")
  expect(logs).toEqual(["hello", "world"])
})

test("a guest syntax/runtime error completes with guestError, not a hang", async () => {
  const out = await runGuest(`throw new Error("boom");`, [], DEFAULT_LIMITS, noopCb())
  expect(out.status).toBe("completed")
  expect(out.status === "completed" && out.guestError).toContain("boom")
})

test("an infinite loop is killed by the watchdog with code timeout", async () => {
  const out = await runGuest(`for(;;){}`, [], { ...DEFAULT_LIMITS, timeoutMs: 300 }, noopCb())
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("timeout")
}, 10_000)

test("log flood beyond maxOutputBytes fails with output_limit_exceeded", async () => {
  const out = await runGuest(
    `for (let i = 0; i < 10000; i++) api.log("x".repeat(100));`,
    [],
    { ...DEFAULT_LIMITS, maxOutputBytes: 1024 },
    noopCb(),
  )
  expect(out.status).toBe("failed")
  expect(out.status === "failed" && out.code).toBe("output_limit_exceeded")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lab/code-mode-gate/bridge.test.ts`
Expected: FAIL — `Cannot find module './bridge.ts'`

- [ ] **Step 3: Implement guest-shell.ts**

Create `lab/code-mode-gate/guest-shell.ts`:

```ts
/** Runs INSIDE a Bun Worker. One guest program per "run" message. The guest
 * sees ONLY the `api` object; every tool/gate interaction is an async RPC to
 * the host. No host references cross the boundary (structured clone only).
 * Trusted-guest execution via new Function — the hostile-guest reference is
 * OpenClaw's QuickJS-WASI worker; this is a thread boundary, not a sandbox. */

type HostMsg =
  | { type: "run"; src: string; toolNames: string[] }
  | { type: "result"; id: number; ok: boolean; value?: unknown; error?: string }

let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function rpc(target: "tool" | "gate", name: string | undefined, args: unknown): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    postMessage({ type: "call", id, target, name, args })
  })
}

self.onmessage = async (ev: MessageEvent<HostMsg>) => {
  const msg = ev.data
  if (msg.type === "result") {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(msg.error ?? "rpc failed"))
    return
  }
  if (msg.type !== "run") return

  const tools: Record<string, (args?: unknown) => Promise<unknown>> = {}
  for (const name of msg.toolNames) {
    tools[name] = (args?: unknown) => rpc("tool", name, args)
  }
  const api = {
    tools,
    checkAndCommit: (claim: unknown) => rpc("gate", undefined, claim),
    log: (m: unknown) => postMessage({ type: "log", msg: String(m) }),
  }
  try {
    const guest = new Function("api", `"use strict"; return (async () => { ${msg.src}\n })();`)
    await guest(api)
    postMessage({ type: "done" })
  } catch (e) {
    postMessage({ type: "done", error: e instanceof Error ? e.message : String(e) })
  }
}
```

- [ ] **Step 4: Implement bridge.ts**

Create `lab/code-mode-gate/bridge.ts`:

```ts
/** Host side of the composed runtime's isolation boundary. Owns the Worker
 * lifecycle, dispatches guest RPCs to callbacks, and enforces the limits with
 * enumerated failure codes. One worker per turn (created fresh, terminated
 * always) — simplest lifecycle that is correct; snapshots/resume are YAGNI. */
import type { FailureCode, Limits } from "./types.ts"

export interface BridgeCallbacks {
  onToolCall(name: string, args: unknown): unknown | Promise<unknown>
  onGateCall(claim: unknown): unknown
  onLog(msg: string): void
}

export type BridgeOutcome =
  | { status: "completed"; guestError?: string }
  | { status: "failed"; code: FailureCode; message: string }

type GuestMsg =
  | { type: "call"; id: number; target: "tool" | "gate"; name?: string; args: unknown }
  | { type: "log"; msg: string }
  | { type: "done"; error?: string }

export function runGuest(
  src: string,
  toolNames: string[],
  limits: Limits,
  cb: BridgeCallbacks,
): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./guest-shell.ts", import.meta.url))
    let settled = false
    let inFlight = 0
    let outputBytes = 0

    const finish = (outcome: BridgeOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      worker.terminate()
      resolve(outcome)
    }

    const watchdog = setTimeout(
      () => finish({ status: "failed", code: "timeout", message: `guest exceeded ${limits.timeoutMs}ms` }),
      limits.timeoutMs,
    )

    worker.onmessage = async (ev: MessageEvent<GuestMsg>) => {
      const msg = ev.data
      if (settled) return
      if (msg.type === "log") {
        outputBytes += msg.msg.length
        if (outputBytes > limits.maxOutputBytes) {
          finish({
            status: "failed",
            code: "output_limit_exceeded",
            message: `guest output ${outputBytes}B > ${limits.maxOutputBytes}B`,
          })
          return
        }
        cb.onLog(msg.msg)
        return
      }
      if (msg.type === "done") {
        finish({ status: "completed", guestError: msg.error })
        return
      }
      // type === "call"
      inFlight += 1
      if (inFlight > limits.maxPendingCalls) {
        finish({
          status: "failed",
          code: "pending_limit_exceeded",
          message: `guest held ${inFlight} calls open > ${limits.maxPendingCalls}`,
        })
        return
      }
      try {
        const value =
          msg.target === "gate" ? cb.onGateCall(msg.args) : await cb.onToolCall(msg.name ?? "", msg.args)
        worker.postMessage({ type: "result", id: msg.id, ok: true, value })
      } catch (e) {
        worker.postMessage({
          type: "result",
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      } finally {
        inFlight -= 1
      }
    }

    worker.onerror = (e) => {
      finish({ status: "failed", code: "guest_error", message: String(e.message ?? e) })
    }

    worker.postMessage({ type: "run", src, toolNames })
  })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test lab/code-mode-gate/bridge.test.ts`
Expected: PASS, 4 tests. (The timeout test takes ~300ms; the flood test must NOT hit the 10s default.)

- [ ] **Step 6: Commit**

```bash
git add lab/code-mode-gate/guest-shell.ts lab/code-mode-gate/bridge.ts lab/code-mode-gate/bridge.test.ts
git commit -m "$(cat <<'EOF'
feat(lab): worker bridge — real thread boundary with watchdog and caps

One Bun Worker per guest turn; every tool/gate interaction is an async RPC over
structured clone, so the guest holds zero host references. Watchdog kill,
output cap, pending-call cap, each with an enumerated failure code. Thread
boundary, not a security sandbox; QuickJS-WASI named as the hostile-guest
reference.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: runtime.ts — ComposedRuntime with metered tool RPC

**Files:**
- Create: `lab/code-mode-gate/runtime.ts`
- Test: `lab/code-mode-gate/runtime.test.ts`

**Interfaces:**
- Consumes: `runGuest`, `BridgeCallbacks`, `BridgeOutcome` (Task 2); `Verifier`, `Verdict`, `Limits`, `DEFAULT_LIMITS`, `CostMeter`, `newMeter`, `approxTokensOf` (Task 1).
- Produces:
  - `export interface RuntimeOptions<C, S> { contextTokens: number; tools: Record<string, (args?: unknown) => unknown | Promise<unknown>>; verifier: Verifier<C, S>; limits?: Partial<Limits> }`
  - `export type TurnResult = ({ status: "completed"; guestError?: string } | { status: "failed"; code: string; message: string }) & { verdicts: Verdict<unknown>[]; logs: string[] }`
  - `export class ComposedRuntime<C, S = unknown> { constructor(opts: RuntimeOptions<C, S>); runTurn(src: string): Promise<TurnResult>; getCommitted(): C | null; readonly meter: CostMeter }`
  - Gate semantics (Task 4 tests these; implement them HERE): commit happens host-side iff verdict.ok; committed value is a structured clone; last accepted claim wins; guest has no commit capability.

- [ ] **Step 1: Write the failing test**

Create `lab/code-mode-gate/runtime.test.ts`:

```ts
import { test, expect } from "bun:test"
import { ComposedRuntime } from "./runtime.ts"
import type { Verifier } from "./types.ts"

/** Toy verifier for runtime tests: accepts arrays summing to 10. */
const sumTo10: Verifier<number[], { sum: number }> = (claim) => {
  const sum = claim.reduce((s, x) => s + x, 0)
  return sum === 10
    ? { ok: true }
    : { ok: false, reason: "bad-sum", steering: { summary: `sum is ${sum}, need 10`, detail: { sum } } }
}

const mkRuntime = () =>
  new ComposedRuntime<number[], { sum: number }>({
    contextTokens: 1000,
    tools: {
      double: (args) => (args as number) * 2,
      slowEcho: async (args) => {
        await new Promise((r) => setTimeout(r, 5))
        return args
      },
    },
    verifier: sumTo10,
  })

test("tool calls round-trip through the worker and are metered", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    const a = await api.tools.double(3);
    const b = await api.tools.slowEcho(4);
    api.log("a=" + a + " b=" + b);
  `)
  expect(result.status).toBe("completed")
  expect(result.logs).toEqual(["a=6 b=4"])
  expect(rt.meter.toolCalls).toBe(2)
  expect(rt.meter.roundTrips).toBe(1)
})

test("an unknown tool rejects the guest's promise but does not kill the turn", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    try { await api.tools.double(1); await api.tools["nope"]; } catch {}
    let caught = "";
    try { await api.checkAndCommit([1]); } catch {}
    api.log("survived");
  `)
  expect(result.status).toBe("completed")
  expect(result.logs).toEqual(["survived"])
})

test("token accounting: contextTokens plus program size, once per turn", async () => {
  const rt = mkRuntime()
  const src = `api.log("x");`
  await rt.runTurn(src)
  expect(rt.meter.approxTokens).toBe(1000 + Math.ceil(src.length / 4))
  await rt.runTurn(src)
  expect(rt.meter.roundTrips).toBe(2)
  expect(rt.meter.approxTokens).toBe(2 * (1000 + Math.ceil(src.length / 4)))
})

test("limits pass through: a tight timeout kills a spinning guest", async () => {
  const rt = new ComposedRuntime<number[], { sum: number }>({
    contextTokens: 10,
    tools: {},
    verifier: sumTo10,
    limits: { timeoutMs: 300 },
  })
  const result = await rt.runTurn(`for(;;){}`)
  expect(result.status).toBe("failed")
  expect(result.status === "failed" && result.code).toBe("timeout")
}, 10_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lab/code-mode-gate/runtime.test.ts`
Expected: FAIL — `Cannot find module './runtime.ts'`

- [ ] **Step 3: Implement runtime.ts**

Create `lab/code-mode-gate/runtime.ts`:

```ts
/** Public API of the composed runtime: code-mode batching (one guest program
 * = one metered round trip) + a pluggable zero-spend gate as the ONLY effect
 * path. The runtime is verifier-agnostic by construction — no verifier domain
 * content may appear in this file.
 *
 * Capability discipline: commit happens HERE, host-side, iff the plugged
 * verifier accepted. The guest api carries no commit capability; there is no
 * name a guest could call to bypass the gate, because the capability is never
 * constructed for it (authorization by object capability, not by name). */
import { runGuest } from "./bridge.ts"
import {
  DEFAULT_LIMITS,
  approxTokensOf,
  newMeter,
  type CostMeter,
  type Limits,
  type Verdict,
  type Verifier,
} from "./types.ts"

export interface RuntimeOptions<C, S> {
  /** tokens re-sent to the model on EVERY round trip (system + history + tools) */
  contextTokens: number
  tools: Record<string, (args?: unknown) => unknown | Promise<unknown>>
  verifier: Verifier<C, S>
  limits?: Partial<Limits>
}

export type TurnResult = (
  | { status: "completed"; guestError?: string }
  | { status: "failed"; code: string; message: string }
) & { verdicts: Verdict<unknown>[]; logs: string[] }

export class ComposedRuntime<C, S = unknown> {
  readonly meter: CostMeter = newMeter()
  private committed: C | null = null
  private readonly limits: Limits

  constructor(private readonly opts: RuntimeOptions<C, S>) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
  }

  getCommitted(): C | null {
    return this.committed
  }

  async runTurn(src: string): Promise<TurnResult> {
    this.meter.roundTrips += 1
    this.meter.approxTokens += this.opts.contextTokens + approxTokensOf(src)

    const verdicts: Verdict<unknown>[] = []
    const logs: string[] = []
    let rejectionsThisTurn = 0
    let acceptedThisTurn = false

    const outcome = await runGuest(src, Object.keys(this.opts.tools), this.limits, {
      onToolCall: (name, args) => {
        const tool = this.opts.tools[name]
        if (!tool) throw new Error(`unknown tool: ${name}`)
        this.meter.toolCalls += 1
        return tool(args)
      },
      onGateCall: (claim) => {
        this.meter.gateChecks += 1
        const verdict = this.opts.verifier(claim as C)
        verdicts.push(verdict)
        if (verdict.ok) {
          // the ONLY commit site; guests hold no commit capability
          this.committed = structuredClone(claim) as C
          acceptedThisTurn = true
        } else {
          this.meter.gateRejections += 1
          rejectionsThisTurn += 1
        }
        return verdict
      },
      onLog: (msg) => logs.push(msg),
    })

    if (rejectionsThisTurn > 0 && acceptedThisTurn) {
      this.meter.localRetries += rejectionsThisTurn
    }
    return { ...outcome, verdicts, logs }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lab/code-mode-gate/runtime.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lab/code-mode-gate/runtime.ts lab/code-mode-gate/runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(lab): ComposedRuntime — metered turns over the worker bridge

One guest program = one metered round trip; tools dispatched by name with an
unknown-tool rejection that fails the call, not the turn; token accounting is
context-per-trip plus program size. Verifier wiring present; gate semantics
are pinned by the next task's tests.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: gate semantics across the boundary — commit discipline pinned

**Files:**
- Test: `lab/code-mode-gate/runtime.test.ts` (append; implementation landed in Task 3 — this task PINS it)

**Interfaces:**
- Consumes: `ComposedRuntime` (Task 3), toy `sumTo10` verifier pattern from the same test file.
- Produces: nothing importable — the regression set for capability discipline. If any of these fail, Task 3's implementation is wrong and must be fixed HERE before commit.

- [ ] **Step 1: Append the failing-or-passing pin tests**

Append to `lab/code-mode-gate/runtime.test.ts`:

```ts
test("commit iff gate ok; steering flows back to the guest in-turn", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    let v = await api.checkAndCommit([1, 2, 3]);            // sum 6 → reject
    if (!v.ok) {
      api.log("steer: " + v.steering.summary);
      v = await api.checkAndCommit([1, 2, 3, 4]);           // sum 10 → accept
    }
  `)
  expect(result.status).toBe("completed")
  expect(rt.getCommitted()).toEqual([1, 2, 3, 4])
  expect(result.logs[0]).toContain("sum is 6")
  expect(rt.meter.gateRejections).toBe(1)
  expect(rt.meter.localRetries).toBe(1)
})

test("a never-passing guest commits nothing (fail-closed)", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`await api.checkAndCommit([1]); await api.checkAndCommit([2]);`)
  expect(rt.getCommitted()).toBe(null)
  expect(rt.meter.gateRejections).toBe(2)
  expect(rt.meter.localRetries).toBe(0)
})

test("guest holds no commit capability and cannot reach host state", async () => {
  const rt = mkRuntime()
  const result = await rt.runTurn(`
    api.log(String(typeof api.commit));                     // undefined
    api.log(String(typeof globalThis.process));             // worker global, NOT host state
    if (typeof api.commit === "function") api.commit([4, 6]);
  `)
  expect(result.status).toBe("completed")
  expect(result.logs[0]).toBe("undefined")
  expect(rt.getCommitted()).toBe(null)
})

test("last gate-ACCEPTED claim wins; later rejections do not un-commit", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`
    await api.checkAndCommit([5, 5]);      // accept
    await api.checkAndCommit([9, 9]);      // reject — must not clobber
  `)
  expect(rt.getCommitted()).toEqual([5, 5])
})

test("the committed value is a clone, not a live reference into guest data", async () => {
  const rt = mkRuntime()
  await rt.runTurn(`
    const claim = [5, 5];
    await api.checkAndCommit(claim);
    claim[0] = 999;                        // structured clone already crossed the boundary
  `)
  expect(rt.getCommitted()).toEqual([5, 5])
})
```

- [ ] **Step 2: Run the full file**

Run: `bun test lab/code-mode-gate/runtime.test.ts`
Expected: PASS, 9 tests. (The clone test passes trivially — postMessage already clones — but it PINS the property so a future in-process fast path cannot silently lose it.) If any pin fails, fix `runtime.ts`, never the pin.

- [ ] **Step 3: Commit**

```bash
git add lab/code-mode-gate/runtime.test.ts
git commit -m "$(cat <<'EOF'
test(lab): pin gate capability discipline across the worker boundary

Commit iff gate ok; steering consumed in-turn is metered as a local retry;
never-passing guests commit nothing; no commit capability exists on the guest
api; last ACCEPTED claim wins; committed values are clones. If a pin fails the
runtime is wrong, never the pin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: two bundled verifiers — real merge gate + domain-different recount

**Files:**
- Create: `lab/code-mode-gate/verifiers/merge-fit.ts`
- Create: `lab/code-mode-gate/verifiers/source-recount.ts`
- Test: `lab/code-mode-gate/verifiers.test.ts`

**Interfaces:**
- Consumes: `Verifier`, `Verdict`, `Steering` (Task 1); `mergeCheck`, `fitAffine` from `../../opencode-plugin/src/bench/reval-fit.ts` (read-only import of the REAL, shipped-OFF kkamak verifier — never modify it).
- Produces:
  - `export interface AnchorResidual { index: number; u: number; claimed: number; fitted: number; residual: number }`
  - `export function mergeFitVerifier(anchorsU: number[]): Verifier<number[], AnchorResidual[]>`
  - `export interface RecountClaim { lines: number; words: number }`
  - `export function sourceRecountVerifier(sourceText: string): Verifier<RecountClaim, RecountClaim>`

- [ ] **Step 1: Write the failing test**

Create `lab/code-mode-gate/verifiers.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mergeFitVerifier } from "./verifiers/merge-fit.ts"
import { sourceRecountVerifier } from "./verifiers/source-recount.ts"

const U = [1.0, 2.3, 2.9, 5.1, 7.8]
const HONEST = U.map((u) => 100 + 40 * u)
const SHIFTED = [...HONEST.slice(1), HONEST[HONEST.length - 1]! + 40]

test("merge-fit: honest accepted, shifted rejected with worst-first residual steering", () => {
  const verify = mergeFitVerifier(U)
  expect(verify(HONEST).ok).toBe(true)
  const v = verify(SHIFTED)
  expect(v.ok).toBe(false)
  expect(v.steering).toBeDefined()
  const detail = v.steering!.detail
  expect(detail.length).toBe(U.length)
  // worst-first ordering
  for (let i = 1; i < detail.length; i++) {
    expect(Math.abs(detail[i - 1]!.residual)).toBeGreaterThanOrEqual(Math.abs(detail[i]!.residual))
  }
  expect(v.steering!.summary).toContain("anchor")
})

test("merge-fit: partial coverage fails closed without fabricated steering detail", () => {
  const v = mergeFitVerifier(U)(HONEST.slice(0, 3))
  expect(v.ok).toBe(false)
  expect(v.steering).toBeUndefined()
})

test("source-recount: correct counts accepted; wrong counts rejected with actuals as steering", () => {
  const text = "alpha beta\ngamma delta epsilon\n"
  const verify = sourceRecountVerifier(text)
  expect(verify({ lines: 2, words: 5 }).ok).toBe(true)
  const v = verify({ lines: 3, words: 4 })
  expect(v.ok).toBe(false)
  expect(v.steering!.detail).toEqual({ lines: 2, words: 5 })
  expect(v.steering!.summary).toContain("lines")
})

test("the two verifiers share zero domain vocabulary — agnosticism witness", () => {
  // merge-fit knows anchors; recount knows lines/words. The runtime knows neither.
  const mv = mergeFitVerifier(U)(SHIFTED)
  const rv = sourceRecountVerifier("a b\n")({ lines: 9, words: 9 })
  expect(mv.ok).toBe(false)
  expect(rv.ok).toBe(false)
  expect(typeof mv.steering!.summary).toBe("string")
  expect(typeof rv.steering!.summary).toBe("string")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lab/code-mode-gate/verifiers.test.ts`
Expected: FAIL — `Cannot find module './verifiers/merge-fit.ts'`

- [ ] **Step 3: Implement merge-fit.ts**

Create `lab/code-mode-gate/verifiers/merge-fit.ts`:

```ts
/** Adapter over kkamak's REAL merge verifier (opencode-plugin reval-fit.ts,
 * ships OFF). Steering = per-anchor residuals worst-first, computed from the
 * fit the verifier itself ran — no new authority, no answer key. Import is
 * read-only; this file must never modify plugin behavior. */
import { fitAffine, mergeCheck } from "../../../opencode-plugin/src/bench/reval-fit.ts"
import type { Verifier } from "../types.ts"

export interface AnchorResidual {
  index: number
  u: number
  claimed: number
  fitted: number
  residual: number
}

export function mergeFitVerifier(anchorsU: number[]): Verifier<number[], AnchorResidual[]> {
  return (canonicals: number[]) => {
    const merge = mergeCheck(anchorsU, canonicals)
    if (merge.ok) return { ok: true }
    if (merge.reason !== "residual" || canonicals.length !== anchorsU.length || anchorsU.length < 3) {
      return { ok: false, reason: merge.reason }
    }
    const { a, b } = fitAffine(anchorsU, canonicals)
    const detail = anchorsU
      .map((u, index) => {
        const fitted = a + b * u
        return { index, u, claimed: canonicals[index]!, fitted, residual: fitted - canonicals[index]! }
      })
      .sort((x, y) => Math.abs(y.residual) - Math.abs(x.residual))
    return {
      ok: false,
      reason: merge.reason,
      steering: {
        summary: `worst anchor index ${detail[0]!.index}: residual ${detail[0]!.residual.toFixed(3)}`,
        detail,
      },
    }
  }
}
```

- [ ] **Step 4: Implement source-recount.ts**

Create `lab/code-mode-gate/verifiers/source-recount.ts`:

```ts
/** Domain-different verifier: recompute a text-shape claim from the task's own
 * source (the s7 source_crosscheck class — the seam that survived the §1
 * audit). Exists to WITNESS the runtime's verifier-agnosticism: zero vocabulary
 * shared with merge-fit, same Verifier contract, same steering discipline. */
import type { Verifier } from "../types.ts"

export interface RecountClaim {
  lines: number
  words: number
}

export function sourceRecountVerifier(sourceText: string): Verifier<RecountClaim, RecountClaim> {
  const actual: RecountClaim = {
    lines: sourceText.split("\n").filter((l) => l.length > 0).length,
    words: sourceText.split(/\s+/).filter((w) => w.length > 0).length,
  }
  return (claim: RecountClaim) => {
    if (claim.lines === actual.lines && claim.words === actual.words) return { ok: true }
    return {
      ok: false,
      reason: "recount-mismatch",
      steering: {
        summary: `source has ${actual.lines} lines / ${actual.words} words`,
        detail: actual,
      },
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test lab/code-mode-gate/verifiers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add lab/code-mode-gate/verifiers/merge-fit.ts lab/code-mode-gate/verifiers/source-recount.ts lab/code-mode-gate/verifiers.test.ts
git commit -m "$(cat <<'EOF'
feat(lab): two bundled verifiers — real merge gate + domain-different recount

merge-fit adapts kkamak's shipped reval-fit (read-only import) with worst-first
residual steering; source-recount recomputes a text-shape claim from the task's
own source (the s7 class). Zero shared vocabulary between them witnesses the
runtime's verifier-agnosticism.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: parity.test.ts — PoC cost claims survive the isolation boundary

**Files:**
- Test: `lab/code-mode-gate/parity.test.ts`

**Interfaces:**
- Consumes: `ComposedRuntime` (Task 3/4), `mergeFitVerifier` (Task 5). Do NOT import from `poc/` (the PoC is frozen; duplicating the five fixture constants here is deliberate so the library never depends on the PoC dir).
- Produces: nothing importable — the cost-arithmetic regression set.

- [ ] **Step 1: Write the parity tests**

Create `lab/code-mode-gate/parity.test.ts`:

```ts
/** Re-proves poc/code-mode-gate's cost and parity claims THROUGH the worker
 * boundary: same fixture, same hypotheses, real verifier. Classic arm = one
 * round trip per step (the standard agent loop); composed arm = one program.
 * If these numbers drift from the PoC's (5 trips vs 1; >3x tokens; rejection
 * absorbed in-turn), the isolation layer broke the economics. */
import { test, expect } from "bun:test"
import { ComposedRuntime } from "./runtime.ts"
import { mergeFitVerifier } from "./verifiers/merge-fit.ts"

const U = [1.0, 2.3, 2.9, 5.1, 7.8]
const HONEST = U.map((u) => 100 + 40 * u)
const SHIFTED = [...HONEST.slice(1), HONEST[HONEST.length - 1]! + 40]
const CONTEXT = 4000

const mkRt = () =>
  new ComposedRuntime<number[]>({
    contextTokens: CONTEXT,
    tools: {
      readSeries: () => ({ rows: 1500, cols: 2 }),
      detectAnchors: () => U,
      sampleStats: () => ({ min: 0.4, max: 9.9 }),
    },
    verifier: mergeFitVerifier(U),
  })

const lit = (xs: number[]) => JSON.stringify(xs)

async function runClassic() {
  const rt = mkRt()
  await rt.runTurn(`await api.tools.readSeries();`)
  await rt.runTurn(`await api.tools.detectAnchors();`)
  await rt.runTurn(`await api.tools.sampleStats();`)
  await rt.runTurn(`await api.checkAndCommit(${lit(SHIFTED)});`) // turn ends on rejection
  await rt.runTurn(`await api.checkAndCommit(${lit(HONEST)});`)
  return rt
}

async function runComposed() {
  const rt = mkRt()
  await rt.runTurn(`
    await api.tools.readSeries();
    await api.tools.detectAnchors();
    await api.tools.sampleStats();
    let v = await api.checkAndCommit(${lit(SHIFTED)});
    if (!v.ok) {
      api.log("gate: " + v.reason + " | " + v.steering.summary);
      v = await api.checkAndCommit(${lit(HONEST)});
    }
  `)
  return rt
}

test("correctness parity: both arms commit the identical verifier-accepted claim", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.getCommitted()).toEqual(HONEST)
  expect(composed.getCommitted()).toEqual(HONEST)
})

test("cost arithmetic: 5 trips vs 1; identical work; >3x token ratio", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.meter.roundTrips).toBe(5)
  expect(composed.meter.roundTrips).toBe(1)
  expect(classic.meter.toolCalls).toBe(composed.meter.toolCalls)
  expect(classic.meter.gateChecks).toBe(composed.meter.gateChecks)
  expect(composed.meter.approxTokens * 3).toBeLessThan(classic.meter.approxTokens)
})

test("anti-thrash: the rejection is absorbed in-turn only in the composed arm", async () => {
  const classic = await runClassic()
  const composed = await runComposed()
  expect(classic.meter.gateRejections).toBe(1)
  expect(composed.meter.gateRejections).toBe(1)
  expect(classic.meter.localRetries).toBe(0)
  expect(composed.meter.localRetries).toBe(1)
})
```

- [ ] **Step 2: Run the tests**

Run: `bun test lab/code-mode-gate/parity.test.ts`
Expected: PASS, 3 tests. If the token ratio fails, check that `contextTokens` is charged once per `runTurn` and NOT per tool RPC — that is the economics the whole library exists to demonstrate.

- [ ] **Step 3: Commit**

```bash
git add lab/code-mode-gate/parity.test.ts
git commit -m "$(cat <<'EOF'
test(lab): PoC cost and parity claims re-proven through the worker boundary

Same fixture, same hypotheses, real merge verifier: 5 trips vs 1, >3x token
ratio, rejection absorbed in-turn — the isolation layer preserves the
economics the composition claims.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: agnosticism grep guard, README, paranoia suite run

**Files:**
- Test: `lab/code-mode-gate/agnostic.test.ts`
- Create: `lab/code-mode-gate/README.md`

**Interfaces:**
- Consumes: file paths only.
- Produces: the enforcement that keeps the runtime verifier-agnostic as it evolves.

- [ ] **Step 1: Write the grep-guard test**

Create `lab/code-mode-gate/agnostic.test.ts`:

```ts
/** The runtime layer must stay verifier-agnostic: no verifier domain
 * vocabulary in core files. This is the guard that keeps "reusable library"
 * true as it evolves — a core file naming a domain is the 1/99 failure
 * starting over. Executable, not a review note. */
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

const CORE = ["types.ts", "guest-shell.ts", "bridge.ts", "runtime.ts"]
const DOMAIN_WORDS = /anchor|raman|series|canonical|spectr|glyph|gcode|recount|lines|words/i

test("core runtime files contain zero verifier-domain vocabulary", () => {
  const offenders: string[] = []
  for (const f of CORE) {
    const text = readFileSync(new URL(`./${f}`, import.meta.url), "utf-8")
    for (const [i, line] of text.split("\n").entries()) {
      if (DOMAIN_WORDS.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    }
  }
  expect(offenders).toEqual([])
})
```

- [ ] **Step 2: Run it; fix any offender in core files (never widen the regex to pass)**

Run: `bun test lab/code-mode-gate/agnostic.test.ts`
Expected: PASS. If it fails, the offending core line moves to a verifier or a test — the regex is the requirement, not the obstacle. (Comments count: vocabulary in a comment becomes vocabulary in the next edit.)

- [ ] **Step 3: Write README.md**

Create `lab/code-mode-gate/README.md`:

```markdown
# lab/code-mode-gate — composed runtime (worker-isolated, verifier-agnostic)

Hardened form of `poc/code-mode-gate/` (frozen reference; read its README
first). Same composition — code-mode batching + zero-spend gate as the only
effect path — now with a real thread boundary and a pluggable verifier.

## What changed vs the PoC

| | PoC | this library |
|---|---|---|
| Guest execution | in-process `new Function` | Bun Worker, structured-clone RPC, zero host references |
| Failure handling | none | watchdog timeout, output cap, pending-call cap — enumerated codes |
| Verifier | hardwired merge gate | `Verifier<C, S>` plug-in; two bundled: real merge-fit + source-recount |
| Guest API | sync | async (`await api.tools.x()`, `await api.checkAndCommit(c)`) |
| Agnosticism | n/a | enforced by executable grep guard (`agnostic.test.ts`) |

## What is preserved (pinned by `parity.test.ts`)

Correctness parity, 5-trips-vs-1, >3x token ratio at 4k context, rejection
absorbed in-turn, no guest commit capability, fail-closed commit.

## Still deliberately unclaimed

- **Actuation** — guests here are scripted; whether a real model consumes
  steering in-program is the un-bought number (prose prior 1/8).
- **Security** — thread boundary + watchdog, NOT a sandbox. No memory limit.
  Hostile-guest reference: OpenClaw QuickJS-WASI (`src/agents/code-mode-*`).
- **Snapshots/resume, TS guests, tool catalogs** — YAGNI until an experiment
  needs them.

## Run

    bun test lab/code-mode-gate/
```

- [ ] **Step 4: Full verification**

```bash
bun test lab/code-mode-gate/ poc/code-mode-gate/     # expect all pass, 0 fail
cd opencode-plugin && bun test 2>&1 | tail -3 && cd ..   # paranoia: expect 2280 pass, 1 skip, 0 fail
```

- [ ] **Step 5: Commit**

```bash
git add lab/code-mode-gate/agnostic.test.ts lab/code-mode-gate/README.md
git commit -m "$(cat <<'EOF'
feat(lab): agnosticism grep guard + README — composed runtime complete

Core runtime files are verifier-domain-free by executable test, not review
note. README maps the PoC delta, the preserved pins, and what stays
deliberately unclaimed (actuation, security, snapshots).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (against `poc/code-mode-gate/README.md` claims): real verifier → T5 merge-fit (same reval-fit import); steering on rejection → T5 + T4 in-turn consumption; correctness parity → T6; cost arithmetic → T6 (same 5-vs-1, >3x); anti-thrash localRetries → T4 + T6; capability discipline → T4 (no commit capability, fail-closed, last-accepted, clone). New hardening beyond PoC: thread boundary + watchdog/caps → T2; verifier-agnosticism → T5 witness + T7 guard; async guest API → T2/T3.

**Placeholder scan:** every step carries full code; no TBD/TODO; no "similar to Task N" references — T6 deliberately duplicates the five fixture constants instead of importing from poc/ (stated inline).

**Type consistency:** `Verifier<C,S>`/`Verdict<S>`/`Steering<S>` defined T1, consumed T3/T5 with matching shapes; `runGuest(src, toolNames, limits, cb)` signature identical in T2 definition and T3 call site; `BridgeOutcome.guestError` produced T2, surfaced through `TurnResult` T3; message protocol field names (`type/id/target/name/args/ok/value/error/msg/src/toolNames`) match between guest-shell and bridge; `mergeFitVerifier(anchorsU)` factory signature identical in T5 definition and T6 use. `sumTo10` toy verifier defined once in runtime.test.ts and used by T3+T4 appends to the same file.

**Known risks, stated:** Bun Worker + `new URL(..., import.meta.url)` resolution is exercised by T2's first test — if the runner resolves workers differently on another host, T2 fails loudly at step 5, before anything builds on it. The busy-loop timeout tests allocate 300ms watchdogs with 10s test timeouts.
