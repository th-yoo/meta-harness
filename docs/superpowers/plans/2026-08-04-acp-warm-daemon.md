# ACP Warm Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-global warm daemon holding ONE Agent-SDK streaming `Query`, exposed over the Agent Client Protocol (JSON-RPC) on a Unix socket, so every gauge derivation — live Stop-hook AND batch — pays ~20 ms of `/clear` recycling instead of ~1.25-1.46 s of CLI respawn.

**Architecture:** Three layers with the protocol as interface, not implementation: (1) `WarmSession` wraps the SDK streaming-input `Query` and owns the measured instrument invariants (isolation options, exactly-one-model-call, `/clear` recycling, `interrupt()` turn timeout); (2) `acp-daemon.ts` binds an ACP-conformant JSON-RPC dispatcher to a Unix socket (`session/new` = warm recycle behind the interface, full respawn only when no Query is alive) with a 15-min idle self-exit; (3) `acp-client.ts` gives callers connect-or-spawn with a hard fail-open contract — daemon trouble NEVER blocks a caller, it falls back to the direct one-shot transport and the record stamps the lane that actually ran. The live flip is gated exactly like §6d: registration first (§6e), paired validation on real spend (own sized go), flip with boundary ts only on a bar pass.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (already a dependency; streaming-input mode), `node:net` Unix domain sockets, hand-rolled newline-delimited JSON-RPC 2.0 conformant to the ACP wire shapes (agentclientprotocol.com — no new runtime dependency; see Task 2 rationale).

## Global Constraints

- **Isolation set is law, pinned server-side, never client-negotiable** (byte-measured 2026-08-03, agent-transport.ts): `systemPrompt: ""`, `settingSources: []`, `settings: { autoMemoryEnabled: false }`, `persistSession: false`, `strictMcpConfig: true`, `tools: []`, `thinking: { type: "disabled" }`, `title: "kkamak-gauge"`. The daemon's `Query` uses exactly this set; an ACP client cannot loosen it.
- **Exactly one model call per record** (§4, binding): `/clear` makes no model call (measured 2026-08-03); one prompt turn = one call; on an `api_retry` system message the turn is failed and the record stays pending — never a second call consumed as a result.
- **Live derive path stays pinned to `"sdk"`** (test-locked, `test/gauge-refiner-cli.test.ts:105`) through Tasks 1-8. Only Task 10, after a §6e bar PASS and on its own go, may touch the pin — and then to `"agent-sdk-daemon"` WITH fallback, stamping the actual lane.
- **Fail-open everywhere**: daemon absent/slow/dead → caller falls back to the direct transport within its existing timeout budget; the SessionStart ensure-hook always exits 0.
- **F1/F2**: all new source under `cc-gate-plugin/src/gauge/` (outside every MECHANISM_PATH); socket/lock/runtime state under `~/.kkamak/` (host-local, never synced); counts travel, prompts do not.
- Every pre-existing test passes WITHOUT modification. `cd cc-gate-plugin && bun test` → 0 fail and `bunx tsc --noEmit` clean at every task's end. `bun scripts/doc-check.ts` before every docs commit.
- TDD per task. Tests that spawn the bundled CLI use the existing `hasClaudeCodeCredentials()` skip-guard pattern (`test/gauge-agent-transport.test.ts`) and the existing local-stub `ANTHROPIC_BASE_URL` harness — zero real model calls anywhere in Tasks 1-8.
- Env vars introduced here: `KKAMAK_ACP_SOCKET` (override socket path; default `~/.kkamak/acp.sock`), `KKAMAK_ACP_IDLE_MS` (default `900000`), `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` (selects the lane).

---

### Task 1: Register §6e (pre-data) — the daemon lane, its residue, and the flip gate

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md` (append §6e after the §6d OUTCOME block)

**Interfaces:**
- Produces: the registered literal `"agent-sdk-daemon"`, the bar, and the flip rule that Tasks 3-10 implement. Registration precedes build (spec-is-law).

- [ ] **Step 1: Append §6e** with exactly this content:

```markdown
## 6e. Amendment (pre-data, 2026-08-04): warm-daemon lane → `agent-sdk-daemon`

**What changes.** A fourth derive transport literal, `transport:
"agent-sdk-daemon"`: the same Agent-SDK lane §6d validated, but through a
host-global warm daemon (one streaming CLI session, `/clear` between
records) speaking the Agent Client Protocol over a Unix socket. Selected
per process by `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon`; absent or any
other value keeps the current behaviour byte-for-byte.

**Why.** §6d measured the one-shot agent lane at +1.46 s subprocess
spawn per record (~25% end-to-end). The daemon amortizes that to one
spawn per warm period: measured 2026-08-03, first record 838 ms then
~20 ms per record, `/clear` handled CLI-side with no model call. The §6d
outcome (POOLING-PERMITTED, at the exact bar edge) plus this amortization
is what makes a live flip worth validating at all.

**Declared residue (measured 2026-08-03, re-verified in this plan's
tests).** Each post-`/clear` turn carries ~423 B of constant
`<local-command-caveat>`/`<command-name>/clear</command-name>` echo that a
fresh-spawn context does not. It is constant per record, so it cannot bias
one classification against another — but it makes the daemon context
MEASURABLY DIFFERENT from the §6d-validated fresh-spawn context, which is
why this literal gets its own bar rather than inheriting §6d's result.

**Instrument invariants (pinned in daemon code, not client-negotiable).**
The §6d isolation option set verbatim; exactly-one-model-call per record
(`/clear` makes none; `api_retry` fails the turn, never consumes a retry
as a result); one turn in flight at a time (FIFO across all connected
callers — a shared warm context is serialized by construction).

**Fail-open provenance rule (binding).** A caller selecting
`agent-sdk-daemon` that falls back (daemon unreachable, turn timeout,
queue refusal) derives via the direct lane instead and the record stamps
the transport THAT ACTUALLY RAN. A stamp may therefore differ from the
selection; the stamp is the truth. Silent mislabeling here is the §6d
cls-ab defect all over again — the paired-validation partition reads
stamps, so a lie in the stamp corrupts the §6e bar itself.

**Pooling bar (reused verbatim from §6c/§6d, baseline `"sdk"`).**
- Positive agreement on C: `|C_sdk ∩ C_daemon| / |C_sdk ∪ C_daemon| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk-daemon"` calls
  not-C, `<= ceil(0.10 × |C_sdk|)`.
Both hold → pooling permitted, split still reported. Either fails → the
literal stays selectable for batch use with split readings, and the live
flip (below) DOES NOT HAPPEN.

**Live flip gate.** The live derive path (refiner-cli.ts) stays pinned to
`"sdk"` until: (1) this bar passes, (2) the flip ships with the fail-open
fallback above, and (3) the boundary ts is logged in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at the flip commit —
behaviour changes while `pluginVersion` does not. A bar FAIL is a
complete, successful outcome of this amendment: batch keeps the daemon,
live keeps `"sdk"`.

**What would falsify this design.** If warm-lane derivations disagree
with fresh-spawn agent-lane derivations more than fresh-spawn disagrees
with the API lane (i.e. the `/clear` residue is NOT behaviourally
neutral), the daemon is retained as a batch convenience only and the
live flip is permanently off the table for it.
```

- [ ] **Step 2: Verify no dead links**

Run: `bun scripts/doc-check.ts`
Expected: `doc-check: OK — <N> tracked file(s), 0 violations`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "docs(spec): register 6e warm-daemon lane (pre-data)"
```

### Task 2: Pin the ACP wire subset — conformance fixtures, no new dependency

**Why hand-rolled.** The official `@agentclientprotocol/sdk` is stdio-first
(its transport assumption is "client spawns agent"); our primary transport
is a Unix socket that outlives any one client. Rather than adopt a
dependency and fight its transport layer, we implement the ACP WIRE CONTRACT
(JSON-RPC 2.0, newline-delimited, the four methods we serve) and lock it
with fixtures transcribed from the spec (agentclientprotocol.com/protocol/*).
The dispatcher is transport-agnostic, so a `--stdio` mode for standard
editor clients is a flag, not a rewrite (Task 5). If a later need arises to
interop with a strict client, the fixtures are the compatibility test bed.

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-wire.ts`
- Test: `cc-gate-plugin/test/acp-wire.test.ts`

**Interfaces:**
- Produces:
  - `interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown }`
  - `interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } }`
  - `encodeFrame(msg: object): string` — `JSON.stringify(msg) + "\n"`
  - `class FrameDecoder { push(chunk: Buffer | string): object[] }` — buffers partial lines, returns complete parsed frames; malformed JSON line → emits nothing for that line and records it on `decoder.malformed: number` (a counter, never a throw — a broken client must not kill the daemon).
  - ACP method name constants: `ACP_INITIALIZE = "initialize"`, `ACP_SESSION_NEW = "session/new"`, `ACP_SESSION_PROMPT = "session/prompt"`, `ACP_SESSION_CANCEL = "session/cancel"`, `ACP_SESSION_UPDATE = "session/update"` (notification).
  - Param/result shapes (types only, used by Tasks 5-6):
    `AcpInitializeResult { protocolVersion: number; agentCapabilities: { loadSession: false } }`,
    `AcpNewSessionResult { sessionId: string }`,
    `AcpPromptParams { sessionId: string; prompt: Array<{ type: "text"; text: string }> }`,
    `AcpPromptResult { stopReason: "end_turn" | "cancelled" | "refusal" }`,
    `AcpUpdateParams { sessionId: string; update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } } }`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { FrameDecoder, encodeFrame } from "../src/gauge/acp-wire.ts"

describe("acp-wire framing", () => {
  test("round-trips a request frame", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    expect(frames.length).toBe(1)
    expect((frames[0] as { method: string }).method).toBe("initialize")
  })
  test("reassembles frames split across chunks", () => {
    const d = new FrameDecoder()
    const wire = encodeFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x" } })
    expect(d.push(wire.slice(0, 10)).length).toBe(0)
    const frames = d.push(wire.slice(10))
    expect(frames.length).toBe(1)
  })
  test("two frames in one chunk", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 3, method: "a" }) + encodeFrame({ jsonrpc: "2.0", id: 4, method: "b" }))
    expect(frames.length).toBe(2)
  })
  test("malformed line counts, never throws, stream survives", () => {
    const d = new FrameDecoder()
    const frames = d.push("not json\n" + encodeFrame({ jsonrpc: "2.0", id: 5, method: "ok" }))
    expect(frames.length).toBe(1)
    expect(d.malformed).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts`
Expected: FAIL — `Export named 'FrameDecoder' not found`

- [ ] **Step 3: Implement `acp-wire.ts`**

```typescript
// §6e ACP wire subset. Hand-rolled, dependency-free: JSON-RPC 2.0,
// newline-delimited, the four ACP methods this daemon serves. Wire shapes
// transcribed from agentclientprotocol.com (protocol/session-setup,
// protocol/prompt-turn); fixtures in acp-wire.test.ts are the conformance
// record. Transport-agnostic: the daemon binds it to a Unix socket, and a
// --stdio flag can bind the same dispatcher to stdin/stdout for standard
// editor clients.
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

export const ACP_INITIALIZE = "initialize"
export const ACP_SESSION_NEW = "session/new"
export const ACP_SESSION_PROMPT = "session/prompt"
export const ACP_SESSION_CANCEL = "session/cancel"
export const ACP_SESSION_UPDATE = "session/update"

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
}
export interface AcpNewSessionResult { sessionId: string }
export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
}
export interface AcpPromptResult { stopReason: "end_turn" | "cancelled" | "refusal" }
export interface AcpUpdateParams {
  sessionId: string
  update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
}

export function encodeFrame(msg: object): string {
  return JSON.stringify(msg) + "\n"
}

/** Newline-delimited JSON-RPC decoder. Malformed lines increment
 * `malformed` and are dropped — a broken client never kills the daemon. */
export class FrameDecoder {
  private buf = ""
  malformed = 0

  push(chunk: Buffer | string): object[] {
    this.buf += chunk.toString()
    const out: object[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === "object" && parsed !== null) out.push(parsed)
        else this.malformed++
      } catch {
        this.malformed++
      }
    }
    return out
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts` — 0 fail.
Run: `bunx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-wire.ts cc-gate-plugin/test/acp-wire.test.ts
git commit -m "feat(gauge): ACP wire subset — framing, method constants, shapes"
```

### Task 3: Widen the transport literal to `agent-sdk-daemon`

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (the `GAUGE_TRANSPORTS` array and `GaugeTransport` union)
- Test: `cc-gate-plugin/test/gauge-wiring.test.ts` (append)

**Interfaces:**
- Consumes: `GAUGE_TRANSPORTS`, `GaugeTransport` (currently `["cli","sdk","agent-sdk"]`).
- Produces: `GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const` and the widened union. Everything downstream (`parsePairFlag`, `PvPairing`, `arms` fields, `derivedOn`) picks the new literal up structurally — Task 6/7 of the §6d plan parameterized them over `GAUGE_TRANSPORTS` for exactly this reason.

- [ ] **Step 1: Write the failing test**

```typescript
test("agent-sdk-daemon is a registered transport literal (§6e)", () => {
  expect(GAUGE_TRANSPORTS).toContain("agent-sdk-daemon")
  // parsePairFlag accepts it structurally — no per-literal wiring needed.
  const p = parsePairFlag(["--pair", "sdk:agent-sdk-daemon"])!
  expect(p.shadowTransport).toBe("agent-sdk-daemon")
})
```
(Imports: `GAUGE_TRANSPORTS` from `../src/types.ts`, `parsePairFlag` from `../src/gauge/paired-validation.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-wiring.test.ts`
Expected: FAIL — array does not contain `"agent-sdk-daemon"`.

- [ ] **Step 3: Widen the literal in `types.ts`**

Change the array to `["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const` (the union type derives from it or is widened alongside, matching how `"agent-sdk"` was added — mirror that commit's shape, `f98e4eb`).

- [ ] **Step 4: Full suite green**

Run: `cd cc-gate-plugin && bun test` — 0 fail (pre-existing `isCliDerived` tests must pass untouched: the new literal is not `"cli"`/absent so it is not CLI-derived by the existing implementation). `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/test/gauge-wiring.test.ts
git commit -m "feat(gauge): widen transport literal to agent-sdk-daemon"
```

### Task 4: `WarmSession` — the warm streaming Query with `/clear` recycling

**Files:**
- Create: `cc-gate-plugin/src/gauge/warm-session.ts`
- Test: `cc-gate-plugin/test/warm-session.test.ts`

**Interfaces:**
- Consumes: `query`, `Query`, `SDKUserMessage` from `@anthropic-ai/claude-agent-sdk` (lazy-imported inside the class, same rationale as agent-transport.ts's ~84 ms finding); the isolation option set verbatim from `agent-transport.ts` (copy the object literal, cite it — do NOT import agent-transport's private internals).
- Produces:
  ```typescript
  class WarmSession {
    constructor(env: Record<string, string | undefined>, opts?: { turnTimeoutMs?: number })  // default 60_000
    /** Serialized one-shot: [ensure Query alive] -> [/clear unless fresh] ->
     * [send prompt] -> [collect text until this turn's result]. Returns
     * undefined on ANY failure (fail-open, caller falls back). Never two
     * turns in flight: calls queue FIFO internally. */
    oneShot(messageText: string, model?: string): Promise<string | undefined>
    /** True while the underlying CLI subprocess is alive. */
    isWarm(): boolean
    /** ms since last completed activity — the idle reaper reads this. */
    idleMs(): number
    /** Terminate the Query and subprocess. Idempotent. */
    close(): void
  }
  ```

**Design (locked by the 2026-08-03 measurements and sdk.d.ts):**
- One `query({ prompt: pushableStream, options })` where `pushableStream` is an async generator fed by an internal queue; the same `Query` serves many turns.
- Recycle = push `{ type: "user", message: { role: "user", content: "/clear" }, parent_tool_use_id: null }` then immediately push the record's prompt message. `/clear` is handled CLI-side with no model call and no `result` message of its own; the next `result` message belongs to the record's turn. The stub tests below LOCK both properties (request count and `messages[]` length) rather than trusting this prose.
- Turn timeout: `interrupt()` (sdk.d.ts: aborts the current turn, session survives) → `oneShot` resolves undefined; if `interrupt()` itself rejects, `close()` (session dies; next `oneShot` respawns).
- `api_retry` system message during a turn → `interrupt()` and resolve undefined (mirrors agent-transport.ts's guard; the record stays pending/retryable; never consume a retry's result).
- First turn after spawn does NOT send `/clear` (nothing to clear; saves the echo bytes on the first record of every warm period).
- Model: `options.model` is set at spawn from the first `oneShot`'s `model` argument (default `KKAMAK_GAUGE_MODEL ?? "haiku"` resolution stays the CALLER's job — `WarmSession` takes the resolved string). A subsequent `oneShot` with a DIFFERENT model calls `setModel(model)` before its turn (sdk.d.ts:2327, streaming-mode only) — and the test locks that the next request goes out with the new model.

- [ ] **Step 1: Write the failing tests** (reuse the stub-server harness pattern from `test/gauge-agent-transport.test.ts` — a local `Bun.serve` on `ANTHROPIC_BASE_URL` returning canned SSE completions, capturing every request body; and the same `hasClaudeCodeCredentials()` skip-guard, since these tests spawn the bundled CLI):

```typescript
import { describe, expect, test } from "bun:test"
import { WarmSession } from "../src/gauge/warm-session.ts"
// stubEnv(): copy the existing helper usage in gauge-agent-transport.test.ts —
// full process env minus ANTHROPIC_API_KEY, plus ANTHROPIC_BASE_URL at the stub.

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("WarmSession (spawns bundled CLI)", () => {
  test("two oneShots reuse one subprocess; second context is clean", async () => {
    // stub returns "ANSWER-1" then "ANSWER-2"
    const ws = new WarmSession(stubEnv())
    try {
      const r1 = await ws.oneShot("first record prompt", "claude-haiku-4-5")
      const r2 = await ws.oneShot("second record prompt", "claude-haiku-4-5")
      expect(r1).toContain("ANSWER-1")
      expect(r2).toContain("ANSWER-2")
      expect(CAPTURED.length).toBe(2)                       // exactly 1 model call per record
      const m2 = JSON.parse(CAPTURED[1]!.body).messages
      expect(m2.length).toBe(1)                             // /clear really reset the context
      expect(JSON.stringify(m2)).not.toContain("first record prompt")
      expect(ws.isWarm()).toBe(true)                        // no respawn between records
    } finally { ws.close() }
  }, 30_000)

  test("turn timeout interrupts but keeps the session warm", async () => {
    // stub: first request hangs 10s, second returns normally
    const ws = new WarmSession(stubEnv(), { turnTimeoutMs: 2_000 })
    try {
      const r1 = await ws.oneShot("hanging record", "claude-haiku-4-5")
      expect(r1).toBeUndefined()
      const r2 = await ws.oneShot("normal record", "claude-haiku-4-5")
      expect(r2).toContain("ANSWER")
      expect(ws.isWarm()).toBe(true)
    } finally { ws.close() }
  }, 30_000)

  test("api_retry fails the turn, never consumes the retry", async () => {
    // stub: 500 then success (the CLI auto-retries; guard must interrupt)
    const ws = new WarmSession(stubEnv())
    try {
      const r = await ws.oneShot("retry-provoking record", "claude-haiku-4-5")
      expect(r).toBeUndefined()
    } finally { ws.close() }
  }, 30_000)

  test("FIFO: concurrent oneShots serialize, both resolve", async () => {
    const ws = new WarmSession(stubEnv())
    try {
      const [a, b] = await Promise.all([
        ws.oneShot("record A", "claude-haiku-4-5"),
        ws.oneShot("record B", "claude-haiku-4-5"),
      ])
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect(CAPTURED.length).toBe(2)
    } finally { ws.close() }
  }, 30_000)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts`
Expected: FAIL — `Export named 'WarmSession' not found`

- [ ] **Step 3: Implement `warm-session.ts`**

Core skeleton (the implementer verifies every SDK call against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before writing the message-loop details — read-types-first is repo law):

```typescript
// §6e WarmSession: one streaming-input Query, /clear recycling, FIFO turns.
// Isolation options are the §6d set VERBATIM (agent-transport.ts) — pinned
// here, never caller-supplied. Lazy SDK import (hook processes must not pay
// the ~84 ms package load; same finding as agent-transport.ts).
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

interface Turn {
  text: string
  model: string
  resolve: (r: string | undefined) => void
}

export class WarmSession {
  private q: Query | undefined
  private queue: Turn[] = []
  private running = false
  private fresh = true            // no /clear before the first turn of a warm period
  private currentModel = ""
  private lastActivity = Date.now()
  private feed: ((m: SDKUserMessage) => void) | undefined
  private readonly turnTimeoutMs: number

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: { turnTimeoutMs?: number } = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 60_000
  }

  oneShot(messageText: string, model: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.queue.push({ text: messageText, model, resolve })
      void this.drain()
    })
  }

  isWarm(): boolean { return this.q !== undefined }
  idleMs(): number { return Date.now() - this.lastActivity }

  close(): void {
    try { this.q?.close() } catch { /* idempotent */ }
    this.q = undefined
    this.fresh = true
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!
        turn.resolve(await this.runTurn(turn))
        this.lastActivity = Date.now()
      }
    } finally {
      this.running = false
    }
  }

  private userMsg(text: string): SDKUserMessage {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
  }

  private async ensure(model: string): Promise<void> {
    if (this.q) return
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const subprocessEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined) subprocessEnv[k] = v
    const self = this
    async function* stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const m = await new Promise<SDKUserMessage>((res) => { self.feed = res })
        yield m
      }
    }
    this.q = query({
      prompt: stream(),
      options: {
        model,
        systemPrompt: "",
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        persistSession: false,
        strictMcpConfig: true,
        tools: [],
        title: "kkamak-gauge",
        thinking: { type: "disabled" },
        env: subprocessEnv,
      },
    })
    this.currentModel = model
    this.fresh = true
  }

  private async runTurn(turn: Turn): Promise<string | undefined> {
    try {
      await this.ensure(turn.model)
      if (turn.model !== this.currentModel) {
        await this.q!.setModel(turn.model)
        this.currentModel = turn.model
      }
      if (!this.fresh) this.feed!(this.userMsg("/clear"))
      this.fresh = false
      // NOTE to implementer: /clear yields no `result` message (verified by
      // the two-oneShot test's CAPTURED/messages[] assertions). Feed order
      // and the single pending-`feed` slot need care: with the generator
      // above, push /clear and the prompt sequentially as the generator
      // re-arms. Verify the exact re-arm timing against the SDK's consumption
      // behaviour; a two-slot buffer is acceptable if needed — the tests are
      // the contract, this skeleton is not.
      this.feed!(this.userMsg(turn.text))
      const deadline = setTimeout(() => { void this.q?.interrupt().catch(() => this.close()) }, this.turnTimeoutMs)
      try {
        let out = ""
        for await (const m of this.q!) {
          if (m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") {
            await this.q!.interrupt().catch(() => this.close())
            return undefined
          }
          if (m.type === "assistant") {
            // accumulate text blocks; exact shape per sdk.d.ts SDKAssistantMessage
            out += extractText(m)
          }
          if (m.type === "result") {
            const r = (m as { result?: unknown }).result
            return typeof r === "string" && r ? r : (out || undefined)
          }
        }
        return undefined
      } finally {
        clearTimeout(deadline)
      }
    } catch {
      this.close()               // fail-open: dead session, caller falls back
      return undefined
    }
  }
}
```

**Iteration caveat for the implementer (load-bearing):** a single `for await` loop over `this.q` must NOT be re-entered per turn if the SDK's async iterator does not support multiple consumers — hold ONE persistent message-pump loop for the Query's lifetime and route messages to the current turn (a small dispatcher), rather than `for await` inside `runTurn`. The skeleton shows intent; the tests (2 records → 2 requests → clean context) are the binding contract. Measure, don't argue.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts` — 0 fail (on this credentialed host, none skipped).
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/warm-session.ts cc-gate-plugin/test/warm-session.test.ts
git commit -m "feat(gauge): WarmSession — warm streaming Query, /clear recycling, FIFO"
```

### Task 5: `acp-daemon.ts` — socket server, ACP dispatcher, idle self-exit

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-daemon.ts`
- Test: `cc-gate-plugin/test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `WarmSession` (Task 4), everything from `acp-wire.ts` (Task 2).
- Produces:
  - Runnable: `bun src/gauge/acp-daemon.ts` (socket mode, default) and `bun src/gauge/acp-daemon.ts --stdio` (single-client stdio mode for standard ACP editor clients — same dispatcher bound to stdin/stdout).
  - `socketPath(env: Record<string, string | undefined>): string` — the SINGLE platform seam for the endpoint: `env.KKAMAK_ACP_SOCKET` when set; else on `process.platform === "win32"` the named pipe `\\\\.\\pipe\\kkamak-acp-${os.userInfo().username}` (Node/Bun `net` accepts pipe names through the same `listen`/`connect` calls — framing and dispatcher identical); else `join(homedir(), ".kkamak", "acp.sock")`. All filesystem-only hygiene is platform-gated behind `isPipe = p.startsWith("\\\\\\\\.\\\\pipe\\\\")`: `chmod 0600` and stale-file unlink apply only to the Unix path (named pipes carry no file mode and vanish with their last handle, so takeover logic short-circuits). Current hosts are WSL2 and macOS — the Unix path is what Tasks 5-10 execute and test; the win32 branch is a compile-time-checked seam with a unit test on the path string only. Bun named-pipe status (researched 2026-08-04): `node:net` named pipes are SUPPORTED — shipped Bun v1.1.28 ("Named pipes on Windows", bun.sh/blog/bun-v1.1.28), name-normalization fixed v1.1.35, and the exact `net.Server.listen("\\\\.\\pipe\\…")` ENOENT bug is closed completed (oven-sh/bun#11820); however the NEIGHBORING `node:http` pipe-listen bug is still open as of 2026-02 (oven-sh/bun#24682) — evidence the area has live rough edges, so a first native-Windows host still runs one live round-trip verify (server+client over the pipe) before relying on it. We use raw `node:net` only, never `node:http`, on this path.
  - ACP behaviour: `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false } }`; `session/new` → mints a UUID sessionId (the WARM RECYCLE happens lazily at that session's first `session/prompt` — recycling at prompt time, not session/new time, means an abandoned session/new costs nothing); `session/prompt` → runs `WarmSession.oneShot` (model from `params._meta?.model` when a string, else `KKAMAK_GAUGE_MODEL ?? "claude-haiku-4-5"` resolved from the daemon's env), emits ONE `session/update` notification with the full response text as an `agent_message_chunk`, then answers `{ stopReason: "end_turn" }`; a failed/undefined oneShot answers `{ stopReason: "refusal" }` with NO update (the ACP-level signal for "record stays pending"); `session/cancel` → `interrupt()` on the warm session.
  - Idle reaper: every 60 s, if `WarmSession.idleMs() > KKAMAK_ACP_IDLE_MS` (default 900_000) AND no turn in flight → `close()` the session, unlink the socket, `process.exit(0)`.
  - Lifecycle hygiene: socket file `chmod 0600`; stale-socket takeover (bind fails `EADDRINUSE` → try connecting; connection refused ⇒ unlink and rebind — the corpus-store wx-lock precedent adapted to sockets); `SIGTERM`/`SIGINT` → close + unlink + exit.

- [ ] **Step 1: Write the failing tests** (drive the real daemon as a child process over a temp socket; stub API server for the model side; credentials skip-guard since the CLI spawns underneath):

```typescript
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-daemon over unix socket", () => {
  test("initialize -> session/new -> session/prompt round-trip", async () => {
    const sock = `${tmpdir()}/kkamak-acp-test-${Date.now()}.sock`
    const child = spawnDaemon(sock)          // helper: Bun.spawn with env {KKAMAK_ACP_SOCKET: sock, ANTHROPIC_BASE_URL: stubUrl, KKAMAK_ACP_IDLE_MS: "900000"}
    try {
      const c = await connectNdjson(sock)    // helper: net.connect + FrameDecoder
      const init = await c.request("initialize", { protocolVersion: 1 })
      expect(init.protocolVersion).toBe(1)
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      expect(typeof s.sessionId).toBe("string")
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      const r = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "classify me" }] })
      expect(r.stopReason).toBe("end_turn")
      expect(updates.join("")).toContain("ANSWER")
    } finally { child.kill() }
  }, 40_000)

  test("second session recycles warm (2 requests total, clean context)", async () => {
    // session/new + prompt, then AGAIN session/new + prompt on the same daemon:
    // assert stub CAPTURED.length === 2 and second request messages.length === 1
    // and first prompt's text absent from the second request body.
  }, 40_000)

  test("failed oneShot answers stopReason refusal, no update", async () => {
    // stub returns 500-then-success (api_retry guard) -> refusal
  }, 40_000)

  test("idle reaper exits and removes the socket", async () => {
    // spawn with KKAMAK_ACP_IDLE_MS=1500, do one prompt, wait ~4s:
    // child exited, fs.existsSync(sock) === false
  }, 40_000)

  test("stale socket file is taken over", async () => {
    // pre-create a dead socket file at the path, spawn daemon, initialize succeeds
  }, 40_000)
})
```
(The three sketched bodies are written out fully by the implementer following the first test's helper pattern — same helpers, different assertions; the assertions named in the comments are the required ones.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts`
Expected: FAIL — daemon entry does not exist.

- [ ] **Step 3: Implement `acp-daemon.ts`**

Structure (dispatcher is a pure function over frames; `net.createServer` in socket mode, stdin/stdout in `--stdio` mode):

```typescript
// §6e ACP daemon: one WarmSession behind the ACP wire subset. session/new
// is cheap (UUID mint); the warm /clear recycle happens at that session's
// FIRST session/prompt. One turn in flight globally (WarmSession FIFO).
// Fail-open: an undefined oneShot -> stopReason "refusal", record pending.
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { WarmSession } from "./warm-session.ts"
import { FrameDecoder, encodeFrame, ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE } from "./acp-wire.ts"

export function socketPath(env: Record<string, string | undefined>): string {
  return env.KKAMAK_ACP_SOCKET ?? path.join(os.homedir(), ".kkamak", "acp.sock")
}
// ... dispatcher: switch on frame.method, per-connection FrameDecoder,
// responses via encodeFrame on the same duplex stream; sessions Map
// {sessionId -> { cleared: boolean }}; on session/prompt: if session not
// yet cleared and WarmSession has served a prior turn, oneShot handles the
// /clear internally (WarmSession.fresh flag) — the daemon only tracks
// which sessionId is active so a second session's first prompt triggers
// recycle. Idle reaper: setInterval(60_000) checking idleMs().
// SIGTERM/SIGINT handlers + socket unlink on every exit path.
```

The implementer writes the full dispatcher (~150 lines) against the Task 2 types; every branch has a test from Step 1. **One structural rule:** the dispatcher must never `throw` across a connection handler — every error path answers a JSON-RPC error frame or `stopReason: "refusal"`. The daemon dying on a bad frame is a fail-open violation.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts` — 0 fail.
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-daemon.ts cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(gauge): ACP daemon — socket server, warm recycle, idle self-exit"
```

### Task 6: `acp-client.ts` — connect-or-spawn, fail-open contract

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-client.ts`
- Test: `cc-gate-plugin/test/acp-client.test.ts`

**Interfaces:**
- Consumes: `socketPath` (Task 5), wire pieces (Task 2).
- Produces:
  ```typescript
  /** One record through the daemon. Connect (never spawn) -> initialize ->
   * session/new -> session/prompt -> collect updates -> close socket.
   * Returns undefined on ANY failure within `timeoutMs` (default 70_000 —
   * the daemon's 60s turn budget plus protocol slack). NEVER throws. */
  export function daemonCall(messageText: string, model: string, env: Record<string, string | undefined>, opts?: { timeoutMs?: number }): Promise<string | undefined>

  /** Ensure a daemon is reachable: try connect; on failure, wx-lock spawn
   * (Bun.spawn(["bun", <abs acp-daemon.ts>], {stdio: "ignore", detached: true}).unref())
   * and poll-connect up to `waitMs` (default 3_000). Returns true when a
   * daemon answered initialize. NEVER throws. Lock: ~/.kkamak/acp-spawn.lock,
   * wx-atomic with stale takeover (corpus-store.ts precedent). */
  export function ensureDaemon(env: Record<string, string | undefined>, opts?: { waitMs?: number }): Promise<boolean>
  ```
- **Deliberate split:** `daemonCall` never spawns. Spawning is `ensureDaemon`'s job (SessionStart hook, Task 8; batch CLIs call it once up front). A Stop-hook deriver whose daemon is missing falls back to the direct lane THIS record and the hook re-ensures for the next — no derivation ever waits out a daemon boot.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("acp-client", () => {
  test("daemonCall returns undefined fast when no daemon (fail-open)", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", { ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock` })
    expect(r).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test("daemonCall round-trips against a scripted fake daemon", async () => {
    // net.createServer on a temp socket answering the 4 methods with canned
    // frames (no real WarmSession) -> daemonCall returns the update text.
    // This pins the CLIENT side of the wire contract independent of Task 5.
  })
  test("ensureDaemon spawns exactly one daemon under concurrent callers", async () => {
    // two ensureDaemon() racing on one socket path (wx lock): both resolve
    // true, exactly one daemon process spawned (count via a spawn-wrapper
    // env marker: KKAMAK_ACP_TEST_SPAWN_LOG=<file> appended by the daemon
    // at boot — add that 3-line hook to acp-daemon.ts in this task).
  })
})
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-client e2e", () => {
  test("ensureDaemon + daemonCall against the real daemon and stub API", async () => {
    // full path: ensureDaemon spawns real acp-daemon.ts (stub ANTHROPIC_BASE_URL),
    // daemonCall returns stubbed text; kill daemon via SIGTERM at the end.
  }, 40_000)
})
```

- [ ] **Step 2: Run to verify they fail** — `bun test test/acp-client.test.ts`, FAIL on missing exports.

- [ ] **Step 3: Implement** (~120 lines: net.connect with its own FrameDecoder, request-id counter, pending-response map, notification handler collecting `session/update` text, overall deadline racing everything to `undefined`; `ensureDaemon` per the signature above).

- [ ] **Step 4: Run to verify green** — file suite, then full `bun test` 0 fail, `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-client.ts cc-gate-plugin/test/acp-client.test.ts cc-gate-plugin/src/gauge/acp-daemon.ts
git commit -m "feat(gauge): ACP client — daemonCall + ensureDaemon, fail-open"
```

### Task 7: Route the transport — selection, fallback, honest stamping

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (selection + the derive-call seam)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts` (`deriveRecord` stamps the actual lane)
- Test: `cc-gate-plugin/test/gauge-transport-daemon.test.ts` (new file)

**Interfaces:**
- Consumes: `daemonCall` (Task 6), `agentSdkCall` (existing), `selectTransport` (existing exact-literal allow-list — extend, never a ternary).
- Produces:
  ```typescript
  /** Derive-path call that reports which lane actually ran. Existing
   * callModelSdk keeps its signature for all other callers. */
  export interface DeriveCallResult { raw: string; transport: GaugeTransport }
  export function callModelDerive(prompt: string, floorCheck: string, env: Record<string, string | undefined>): Promise<DeriveCallResult | undefined>
  ```
  Behaviour: `selectTransport(env)` returns `"agent-sdk-daemon"` → try `daemonCall`; on `undefined` → fall back to `agentSdkCall` (the one-shot §6d lane) and, if that also fails, `undefined`. Stamp: `"agent-sdk-daemon"` only when the DAEMON produced the text; the fallback path stamps `"agent-sdk"`. All other selections behave exactly as today and stamp the selected lane. `deriveRecord` switches from `callModelSdk` + separate stamp to `callModelDerive`'s returned transport — selection and stamp can no longer diverge (the §6d cls-ab lesson, now structural).

- [ ] **Step 1: Write the failing tests**

```typescript
describe("agent-sdk-daemon routing (§6e)", () => {
  test("selectTransport accepts the new literal, default unchanged", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe("agent-sdk-daemon")
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })).toBe("sdk")   // retired literal stays unselectable
  })
  test("fallback stamps agent-sdk, not agent-sdk-daemon", async () => {
    // dead socket path + stub API for the one-shot lane:
    const r = await callModelDerive("p", "check", { ...stubEnv(), KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: deadSock })
    expect(r?.transport).toBe("agent-sdk")
  })
  test("daemon success stamps agent-sdk-daemon", async () => {
    // scripted fake daemon (Task 6 helper) answering the wire:
    const r = await callModelDerive("p", "check", { ...stubEnv(), KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: fakeSock })
    expect(r?.transport).toBe("agent-sdk-daemon")
  })
})
```
Plus one `deriveRecord`-level test: a record derived with the fake daemon carries `derivation.transport === "agent-sdk-daemon"`; with the dead socket it carries `"agent-sdk"`.

- [ ] **Step 2: Run to verify they fail** — missing export.

- [ ] **Step 3: Implement.** `callModelDerive` composes the existing prompt-building/`sdkCall`/`agentSdkCall` paths; ~40 lines. **The live-path pin test (`gauge-refiner-cli.test.ts:105`) must stay green untouched** — refiner-cli.ts still strips the env var, so live derives keep running `"sdk"` regardless of this task.

- [ ] **Step 4: Full suite green** — `bun test` 0 fail, `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts cc-gate-plugin/test/gauge-transport-daemon.test.ts
git commit -m "feat(gauge): route agent-sdk-daemon with fail-open fallback + honest stamp"
```

### Task 8: SessionStart ensure-hook

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-ensure-cli.ts`
- Modify: `cc-gate-plugin/hooks/hooks.json` (add a SessionStart entry)
- Test: `cc-gate-plugin/test/acp-ensure.test.ts`

**Interfaces:**
- Consumes: `ensureDaemon` (Task 6).
- Produces: `bun ${CLAUDE_PLUGIN_ROOT}/src/gauge/acp-ensure-cli.ts` — fire-and-forget: reads nothing from stdin, calls `ensureDaemon(process.env, { waitMs: 0 })` variant that SPAWNS but does not wait for boot (`waitMs: 0` means "kick and exit"), always exits 0, total self-budget < 500 ms. SessionEnd needs NO hook — the idle reaper owns shutdown.
- Gating: the hook entry only acts when `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` is set for the host (otherwise instant no-op exit 0) — a host that has not opted into the daemon lane spawns nothing.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("acp-ensure-cli", () => {
  test("no-op exit 0 when transport not daemon", async () => {
    const p = Bun.spawnSync(["bun", ENSURE_CLI], { env: { ...process.env, KKAMAK_GAUGE_TRANSPORT: undefined as never } })
    expect(p.exitCode).toBe(0)
  })
  test("exit 0 even when spawn target is broken (fail-open)", async () => {
    const p = Bun.spawnSync(["bun", ENSURE_CLI], { env: { ...process.env, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" } })
    expect(p.exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — file missing.

- [ ] **Step 3: Implement the CLI + hooks.json entry** (mirror the existing hooks.json entry shapes exactly; SessionStart command uses `${CLAUDE_PLUGIN_ROOT}` like the others).

- [ ] **Step 4: Full suite green** — `bun test` 0 fail, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-ensure-cli.ts cc-gate-plugin/hooks/hooks.json cc-gate-plugin/test/acp-ensure.test.ts
git commit -m "feat(gauge): SessionStart ensure-daemon hook (opt-in, fail-open)"
```

### Task 9: Paired validation of the daemon lane (REAL SPEND — own sized go)

- [ ] **Step 1: STOP and report before spending.** Run `bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk-daemon --reset` (token-free) and report: the printed sample size, the model (haiku unless overridden), and that the shadow derive is real spend. **Do not proceed without an explicit sized go.**

- [ ] **Step 2: On a granted go:**

```bash
bun cc-gate-plugin/src/gauge/acp-ensure-cli.ts   # with KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon exported
KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon bun cc-gate-plugin/src/gauge/replay-cli.ts derive /home/th-yoo/z2/meta-harness/.km/gauge-corpus-shadow --go <n>
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk-daemon
```

- [ ] **Step 3: Sanity BEFORE reading the verdict:** `wrongTransport` must be 0. Non-zero means records fell back to `"agent-sdk"` (daemon died mid-batch) or the stamp plumbing broke — DIAGNOSE AND RE-RUN the affected records; a verdict over fallback-contaminated arms is not the §6e bar. (This is why Task 7's stamp honesty is load-bearing: the partition SEES the fallback instead of silently absorbing it.)

- [ ] **Step 4: Commit the counts** to `docs/gauge-pv/<hostname>-sdk-vs-agent-sdk-daemon-pv-counts.json` (F2: counts travel, prompts do not). `bun scripts/doc-check.ts` before the docs commit.

### Task 10: Verdict, and the live flip ONLY on a pass

- [ ] **Step 1: Script-tally the verdict** (counts only, never quote notes): re-run `pv-compare --pair sdk:agent-sdk-daemon`, record agreement and missed-C against the §6e bar.

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6e, state that the daemon stays batch-only-by-outcome (selectable, split readings), live keeps `"sdk"`, STOP. Complete outcome.

- [ ] **Step 3: If the bar PASSES — flip the live pin, WITH fallback.** In `refiner-cli.ts`: stop stripping `KKAMAK_GAUGE_TRANSPORT`; instead pin the live derive to `callModelDerive` with env forced to `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` — the Task 7 fallback chain (daemon → one-shot agent → undefined) plus honest stamping IS the live behaviour. Update the pin test (`gauge-refiner-cli.test.ts:105`) to its new invariant: live selection is `agent-sdk-daemon`, env-independent, and a dead daemon still produces a derivation stamped `"agent-sdk"` (fallback proof, stub-only, no spend). Log the boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` in the flip commit.

- [ ] **Step 4: Full suite green, commit:**

```bash
git add cc-gate-plugin/src/gauge/refiner-cli.ts cc-gate-plugin/test/gauge-refiner-cli.test.ts docs/2026-08-01-gauntlet-adoption-ledger.md docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "feat(gauge): live derive flips to agent-sdk-daemon (6e bar pass, boundary ts logged)"
```

---

## Self-Review Notes (kept in-plan deliberately)

- The Task 4 skeleton's message-pump caveat is the plan's highest-risk point; its stub tests (request count, `messages[]` length, cross-record contamination absence) are the binding contract and were chosen so a wrong pump design CANNOT pass them.
- `/clear`-emits-no-result is a 2026-08-03 measurement, re-locked by those same tests rather than trusted.
- Names used across tasks were cross-checked: `WarmSession.oneShot/isWarm/idleMs/close` (T4) consumed by T5; `socketPath` (T5) consumed by T6; `daemonCall/ensureDaemon` (T6) consumed by T7/T8; `callModelDerive` (T7) consumed by T10. `GAUGE_TRANSPORTS` widening (T3) is what makes `--pair sdk:agent-sdk-daemon` (T9) parse with zero pv-code changes — that machinery was parameterized in the §6d plan precisely so a new literal costs one array entry.
