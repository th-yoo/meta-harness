# ACP Warm Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-global warm daemon holding ONE Agent-SDK streaming `Query`, exposed over the Agent Client Protocol (JSON-RPC) on a Unix socket, so every gauge derivation — live Stop-hook AND batch — pays ~20 ms of `/clear` recycling instead of ~1.25-1.46 s of CLI respawn.

**Architecture:** Three layers with the protocol as interface, not implementation: (1) `WarmSession` wraps the SDK streaming-input `Query` and owns the measured instrument invariants (isolation options, per-turn call accounting, caller-directed `/clear` recycling, `interrupt()` turn timeout); (2) `acp-daemon.ts` binds an ACP-conformant JSON-RPC dispatcher to a Unix socket with a 15-min idle self-exit; (3) `acp-client.ts` gives callers connect-or-spawn with a THREE-WAY outcome contract — `ok` / `no-call` / `call-consumed` — because a fail-open fallback is only safe when the daemon provably burned no model call. The live flip is gated exactly like §6d: registration first (§6e), paired validation on real spend (own sized go), flip with boundary ts only on a bar pass.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (already a dependency; streaming-input mode), `node:net` Unix domain sockets, hand-rolled newline-delimited JSON-RPC 2.0 conformant to the ACP wire shapes (agentclientprotocol.com — no new runtime dependency; see Task 2 rationale).

## Global Constraints

- **User-directed scope (2026-08-04).** This plan implements three verbatim user rulings quoted in full in Task 1's §6e text. They supersede §6d's "Selection is PER-CALLER" BINDING sentence and the 2026-08-03 "batch-only, live must not use it" agreed shape. They do NOT supersede the bar gate (no live flip without a §6e PASS) or the fail-open requirement. The 2026-08-04 "ask before ANY daemon implementation work" rule is SATISFIED: this plan is the user-initiated daemon work.
- **Isolation set is law, pinned server-side, never client-negotiable.** Byte-measured 2026-08-03, `agent-transport.ts:119-132`, TEN keys: `model`, `systemPrompt: ""`, `settingSources: []`, `settings: { autoMemoryEnabled: false }`, `persistSession: false`, `strictMcpConfig: true`, `tools: []`, `title: "kkamak-gauge"`, `thinking: { type: "disabled" }`, `env` (full replacement).
  **Declared delta (do not paper over it):** the one-shot lane additionally sets `maxTurns: 1` and `abortController`. Both are QUERY-scoped and cannot transfer to a many-turn warm session — `maxTurns` (sdk.d.ts:1675-1678) would stop the whole `Query` after record #1, and aborting the shared controller would kill every future turn. They are replaced by (a) a per-turn model-call accounting rule in `WarmSession` and (b) `interrupt()` as the per-turn cancel. This delta is registered in §6e; it is NOT "the §6d set verbatim" and the plan never claims so.
  Additionally pinned: an explicit neutral `cwd` (`os.tmpdir()` unless overridden) so the daemon's context does not depend on which session happened to spawn it.
- **Exactly one model call per record (§4, binding) — and the fallback must not break it.** `/clear` makes no model call (measured 2026-08-03); one prompt turn = one call. A failed turn is classified as either **`no-call`** (nothing reached the model: connect failure, queue refusal, session unknown, spawn failure) or **`call-consumed`** (a request went out: `api_retry`, turn timeout/interrupt, query death after model activity). **Fallback to the one-shot lane is permitted ONLY on `no-call`.** On `call-consumed` the deriver returns `undefined` and the record stays pending/retryable — a second lane call would make `--go N` mean up to `2N` calls.
- **Live derive path stays pinned to `"sdk"`** (test-locked, `test/gauge-refiner-cli.test.ts:105`, and asserted again at `:56-86` and `test/gauge-wiring.test.ts:102`) through Tasks 1-9. Only Task 10, after a §6e bar PASS and on its own go, may touch the pin.
- **Fail-open everywhere**: daemon absent/slow/dead → the caller degrades within ONE wall-clock budget (below); the SessionStart hook always exits 0.
- **One budget, not two.** `callModelDerive` owns a single 60 s wall-clock budget per record (the incumbent `CALL_TIMEOUT_MS`). The daemon leg gets `DAEMON_LEG_MS = 20_000` of it (the warm path answers in ~20 ms; 70 s of patience buys nothing); the fallback leg gets whatever remains. Per-record latency must never exceed today's 60 s.
- **F1/F2**: all new source under `cc-gate-plugin/src/gauge/` plus `hooks/hooks.json` and a `SessionStart` branch in `src/hook-cli.ts` — all outside every MECHANISM_PATH (`km-crank/src/calibration.ts:65-72` = `minimal/{complete-gate,mutate,spec-probe,session2}.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`); the `hook-cli.ts` wiring precedent is Phase-2 fixture harvest. Socket/lock/runtime state under `~/.config/kkamak/` — the repo's documented host-local store (CLAUDE.md; `~/.kkamak/` does NOT exist and is not a repo convention). Counts travel, prompts do not.
- **Pre-existing tests pass WITHOUT modification, with exactly two DECLARED exceptions**, both literal-list assertions that a new transport literal necessarily invalidates:
  1. `test/gauge-agent-transport.test.ts:49` — `expect(GAUGE_TRANSPORTS).toEqual(["cli","sdk","agent-sdk"])` → four literals (Task 3).
  2. The live-pin assertions at `test/gauge-refiner-cli.test.ts:56-86` / `:105` and `test/gauge-wiring.test.ts:102` → only if Task 10's flip is earned (Task 10 Step 3 enumerates all three).
  Any OTHER pre-existing test that needs editing means the change is wrong — fix the change, not the test.
- `cd cc-gate-plugin && bun test` → 0 fail and `bunx tsc --noEmit` clean at every task's end. `bun scripts/doc-check.ts` before every docs commit.
- TDD per task. Tests that spawn the bundled CLI use the existing `hasClaudeCodeCredentials()` skip-guard and the existing local-stub `ANTHROPIC_BASE_URL` harness — see Task 4 Step 0 for the mandatory helper extraction. Zero real model calls anywhere in Tasks 1-8.
- Env vars introduced here: `KKAMAK_ACP_SOCKET` (override socket path; default `~/.config/kkamak/acp.sock`), `KKAMAK_ACP_IDLE_MS` (default `900000`), `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` (selects the lane).
- **Merge discipline (7b is ARMED):** one branch, per-task reviews, whole-branch fresh-context review, merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md`. See Post-plan.

---

### Task 1: Register §6e (pre-data) — the daemon lane, its residue, the supersession, and the flip gate

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md`

**Interfaces:**
- Produces: the registered literal `"agent-sdk-daemon"`, the call-consumption rule, the bar, and the flip rule that Tasks 3-10 implement. Registration precedes build (spec-is-law).

- [ ] **Step 1: Append §6e at the END of §6d** — i.e. after the current line 744 (`**What would falsify this change.** …` paragraph, the last of §6d) and IMMEDIATELY BEFORE `## 7. Known risks` (currently line 746). Do NOT insert after the §6d OUTCOME block (line ~607): §6d continues for another ~137 lines past it, and inserting there would re-parent the schema-enforcement note, the retry/output-cap asymmetries, the PER-CALLER ruling, Deploy, context isolation, the `--bare` ruling and the residual under a §6e heading.

Content, exactly:

```markdown
## 6e. Amendment (pre-data, 2026-08-04): warm-daemon lane → `agent-sdk-daemon`

**Governing rulings (2026-08-04, user — verbatim).** This amendment exists
because the user directed it in today's session:

1. "Daemon first. Can we make it ACP server?"
2. "ACP is just interface not implementation. We do this under interface"
   — given in response to five objections to taking on the official ACP
   SDK; the direction is an OWN implementation of the ACP interface.
3. "I don't want to distinguish batch and daily use. We can hook the start
   and the end of CC process. On start, connect or instantiate ACP server.
   ACP server itself has kill timeout, say 15min, on timed out, APC server
   exit to close the ACP process."

**What these supersede, explicitly.** Ruling 3 is a UNIFIED-LANE
instruction. It withdraws, as of 2026-08-04: (a) §6d's "Selection is
PER-CALLER, not a global default" BINDING sentence — "the live path stays
pinned to `transport: "sdk"`"; and (b) the 2026-08-03 agreed daemon shape
recorded in `docs/resume.md` — "in-process singleton for BATCH only … Live
path must NOT use it". The supersession is scoped to THIS lane: the
`"sdk"` and `"agent-sdk"` literals, their records, and §6d's OUTCOME are
untouched, and `KKAMAK_GAUGE_TRANSPORT=agent-sdk` remains exactly what §6d
made it.

**What is NOT superseded.** The bar gate below still governs: no live flip
without a §6e PASS. The fail-open requirement still governs. §6c's split
rule still governs every reading. And the 2026-08-04 rule "ask the user
before ANY daemon implementation work" is SATISFIED rather than bypassed —
this amendment and its plan ARE the user-initiated daemon work.

**What changes.** A fourth derive transport literal, `transport:
"agent-sdk-daemon"`: the same Agent-SDK lane §6d validated, but through a
host-global warm daemon (one streaming CLI session, `/clear` between
records) speaking the Agent Client Protocol over a Unix socket. Selected
per process by `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon`; absent or any
other value keeps the current behaviour byte-for-byte.

**Why.** §6d measured the one-shot agent lane at +1.25-1.46 s subprocess
spawn per record (~25% end-to-end). The daemon amortizes that to one spawn
per warm period. Indicative measurement 2026-08-03 (recorded in
`docs/resume.md`, scratch probe, NO in-tree artifact and NOT taken with
this amendment's isolation option set or streaming-input `Query`): first
record 838 ms then ~20 ms per record, `/clear` handled CLI-side with no
model call. Treat those numbers as indicative only; the plan's Task 4
tests re-derive them under the real option set.

**Declared residue.** Each post-`/clear` turn carries ~423 B of constant
`<local-command-caveat>`/`<command-name>/clear</command-name>` echo that a
fresh-spawn context does not (same indicative-measurement caveat). It is
constant per record, so it cannot bias one classification against another
— but it makes the daemon context MEASURABLY DIFFERENT from the
§6d-validated fresh-spawn context, which is why this literal gets its own
bar rather than inheriting §6d's result.

**Instrument invariants (pinned in daemon code, not client-negotiable).**
The §6d isolation option set, with ONE registered delta: `maxTurns: 1` and
`abortController` are query-scoped and cannot transfer to a many-turn warm
session (`maxTurns` would stop the whole `Query` after the first record;
aborting the shared controller would kill every later turn). They are
replaced by per-turn model-call accounting plus `interrupt()` as the
per-turn cancel. Also pinned: an explicit neutral `cwd`, so the instrument
does not vary with whichever session spawned the daemon. Also pinned: the
outgoing text is built by the SAME builder the §6d one-shot lane uses,
including its trailing schema instruction — the two lanes must differ in
transport only, never in prompt bytes. One turn in flight at a time (FIFO
across all connected callers).

**Call-consumption rule (binding, and the reason the fallback is safe).**
Every daemon turn resolves as exactly one of three outcomes: `ok`,
`no-call` (nothing reached the model — connect failure, queue refusal,
unknown session, spawn failure), or `call-consumed` (a request went out —
`api_retry`, turn timeout/interrupt, query death after model activity).
A caller may fall back to the one-shot lane ONLY on `no-call`. On
`call-consumed` the deriver returns undefined and the record stays
pending/retryable. Without this split, a fail-open fallback would issue a
second model call for the same record, breaking §4's exactly-one-call rule
and making the `--go N` cost fence mean up to `2N` calls.

**Fail-open provenance rule (binding).** A caller selecting
`agent-sdk-daemon` that falls back derives via the direct lane instead and
the record stamps the transport THAT ACTUALLY RAN, and the model the lane
actually used. A stamp may therefore differ from the selection; the stamp
is the truth. Silent mislabeling here is the §6d cls-ab defect all over
again — the paired-validation partition reads stamps, so a lie in the
stamp corrupts the §6e bar itself.

**Pooling bar (reused verbatim from §6c/§6d, baseline `"sdk"`).**
- Positive agreement on C: `|C_sdk ∩ C_daemon| / |C_sdk ∪ C_daemon| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk-daemon"` calls
  not-C, `<= ceil(0.10 × |C_sdk|)`.
Both hold → pooling permitted, split still reported. Either fails → the
literal stays selectable with split readings, and the live flip DOES NOT
HAPPEN.

**Power limitation, declared pre-data.** On `yoo-dev` the entire
`"sdk"`-derived class-C stratum is 5 records (measured 2026-08-04: 109
`transport:"sdk"` records, 5 of class C), so the sample is 5 C + 5 not-C
and the cap is `ceil(0.5) = 1`. Agreement ≥ 0.80 over a union of 5 means
4/5. §6d already landed on both edges with zero slack. This bar therefore
has NO power to separate a small real effect from a single coin flip, and
that is registered here BEFORE the data rather than argued afterwards. A
PASS licenses the flip because the flip is user-directed and reversible by
one env var; it does not license a claim that the warm residue is
behaviourally neutral.

**Pooling is not transitive, and the post-flip live stream is split three
ways.** §6d permits pooling `sdk` with `agent-sdk` at exactly 0.800; a
§6e pass would permit pooling `sdk` with `agent-sdk-daemon` at ≥ 0.80.
Neither licenses pooling `agent-sdk` with `agent-sdk-daemon`. After a
flip, the live derive path emits `"agent-sdk-daemon"` when the daemon
serves the turn and `"agent-sdk"` when it fell back on a `no-call` — the
lane is chosen by daemon availability, which is not independent of host
state or time of day. Every post-flip reading is therefore split THREE
ways (`sdk` pre-boundary, `agent-sdk-daemon`, `agent-sdk`), and the
fallback mixture is itself a registered source of variance.

**Live flip gate.** The live derive path (refiner-cli.ts) stays pinned to
`"sdk"` until: (1) this bar passes, (2) the flip ships with the fail-open
fallback and the call-consumption rule above, and (3) the boundary ts is
logged in `docs/2026-08-01-gauntlet-adoption-ledger.md` at the flip commit
— behaviour changes while `pluginVersion` does not. A bar FAIL is a
complete, successful outcome: the daemon stays available for any caller
that opts in with split readings, and live keeps `"sdk"`.

**Boundary ts for batch, too.** §6d's Deploy clause requires a boundary ts
when the first BATCH caller opts in. The §6e validation run (a shadow-store
derive) is instrument validation, not a production reading, and does NOT
trigger it. The first `agent-sdk-daemon` derive against a REAL store does,
whether or not the live flip ever happens.

**Known reporting gap, re-recorded.** `cls-ab.ts`'s `transportTally`
(lines ~375-380) buckets records as `if (transport === "sdk") sdk++ else
cli++`. §6d recorded this for `"agent-sdk"`; it applies identically to
`"agent-sdk-daemon"`, which will also be miscounted as CLI in the
classifier A/B report. Display miscount only, still out of scope, fix it
when cls-ab is next opened.

**What would falsify this design.** If warm-lane derivations disagree with
fresh-spawn agent-lane derivations more than fresh-spawn disagrees with
the API lane (i.e. the `/clear` residue is NOT behaviourally neutral), the
daemon is retained as a convenience only and the live flip is off the
table for it. NOTE ON MEASURABILITY: the pv machinery compares a real-store
baseline against a shadow arm, so it cannot compare two shadow arms
directly. This criterion is therefore evaluated on the class-C stratum
ONLY — the same 5 baseline keys appear in both the §6d and §6e samples —
against the per-key classes recorded in
`docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json`. The not-C stratum
is an independent random draw in each run and is NOT comparable across
them.
```

- [ ] **Step 2: Verify no dead links**

Run: `bun scripts/doc-check.ts`
Expected: `doc-check: OK — <N> tracked file(s), 0 violations`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "docs(spec): register 6e warm-daemon lane (pre-data, user-directed supersession)"
```

### Task 2: Pin the ACP wire subset — conformance fixtures, no new dependency

**Why hand-rolled.** Per the user's ruling 2 ("ACP is just interface not
implementation. We do this under interface"): the official
`@agentclientprotocol/sdk` is stdio-first (its transport assumption is
"client spawns agent"); our primary transport is a Unix socket that
outlives any one client. We implement the ACP WIRE CONTRACT (JSON-RPC 2.0,
newline-delimited, the methods we serve) and lock it with fixtures
transcribed from the spec (agentclientprotocol.com/protocol/*). The
dispatcher is transport-agnostic, so a `--stdio` mode for standard editor
clients is a flag, not a rewrite (Task 5).

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-wire.ts`
- Test: `cc-gate-plugin/test/acp-wire.test.ts`

**Interfaces:**
- Produces:
  - `interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown }`
  - `interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: JsonRpcError }`
  - `interface JsonRpcError { code: number; message: string; data?: { callConsumed: boolean; model?: string } }`
  - `encodeFrame(msg: object): string` — `JSON.stringify(msg) + "\n"`
  - `class FrameDecoder { constructor(opts?: { maxLineBytes?: number }); push(chunk: Buffer | string): object[]; malformed: number }` — buffers partial lines; a malformed JSON line increments `malformed` and is dropped (never a throw — a broken client must not kill the daemon); a line exceeding `maxLineBytes` (default 4 MiB) also counts as malformed AND resets the buffer, so a client that never sends `\n` cannot grow the daemon's memory without bound.
  - Method-name constants: `ACP_INITIALIZE = "initialize"`, `ACP_SESSION_NEW = "session/new"`, `ACP_SESSION_PROMPT = "session/prompt"`, `ACP_SESSION_CANCEL = "session/cancel"`, `ACP_SESSION_UPDATE = "session/update"` (notification).
  - Instrument error codes (JSON-RPC application range) — these ARE the call-consumption channel:
    - `ACP_ERR_NO_CALL = -32000` — the turn never reached the model. `data.callConsumed === false`.
    - `ACP_ERR_CALL_CONSUMED = -32001` — a model request went out and the turn still failed. `data.callConsumed === true`.
  - Param/result shapes (types only, used by Tasks 5-6):
    `AcpInitializeResult { protocolVersion: number; agentCapabilities: { loadSession: false } }`,
    `AcpNewSessionResult { sessionId: string }`,
    `AcpPromptParams { sessionId: string; prompt: Array<{ type: "text"; text: string }>; _meta: { model: string } }` — `_meta.model` is REQUIRED, not optional: the daemon must never silently substitute its own env's model for the caller's (see Task 5).
    `AcpPromptResult { stopReason: "end_turn"; _meta: { model: string; callConsumed: true } }` — `_meta.model` is the model the turn ACTUALLY ran on, echoed back for the caller's stamp.
    `AcpUpdateParams { sessionId: string; update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } } }`.
  - **Deliberate protocol note:** a daemon-side failure is a JSON-RPC ERROR, never `stopReason: "refusal"`. In ACP, `refusal` means the model refused; overloading it would make "daemon died" indistinguishable from "model refused" for any real client, and would give this instrument no place to carry `callConsumed`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { FrameDecoder, encodeFrame, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED } from "../src/gauge/acp-wire.ts"

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
    expect(d.push(wire.slice(10)).length).toBe(1)
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
  test("an unterminated giant line is dropped, not buffered forever", () => {
    const d = new FrameDecoder({ maxLineBytes: 64 })
    expect(d.push("x".repeat(200)).length).toBe(0)
    expect(d.malformed).toBe(1)
    // buffer was reset: a well-formed frame right after still decodes
    expect(d.push(encodeFrame({ jsonrpc: "2.0", id: 6, method: "ok" })).length).toBe(1)
  })
  test("the two instrument error codes are distinct and stable", () => {
    expect(ACP_ERR_NO_CALL).toBe(-32000)
    expect(ACP_ERR_CALL_CONSUMED).toBe(-32001)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts`
Expected: FAIL — `Export named 'FrameDecoder' not found`

- [ ] **Step 3: Implement `acp-wire.ts`**

```typescript
// §6e ACP wire subset. Hand-rolled, dependency-free (user ruling: "ACP is
// just interface not implementation"): JSON-RPC 2.0, newline-delimited,
// the methods this daemon serves. Wire shapes transcribed from
// agentclientprotocol.com (protocol/session-setup, protocol/prompt-turn);
// fixtures in acp-wire.test.ts are the conformance record.
// Transport-agnostic: the daemon binds it to a Unix socket, and a --stdio
// flag binds the same dispatcher to stdin/stdout.
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  /** §6e call-consumption channel — see ACP_ERR_* below. */
  data?: { callConsumed: boolean; model?: string }
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export const ACP_INITIALIZE = "initialize"
export const ACP_SESSION_NEW = "session/new"
export const ACP_SESSION_PROMPT = "session/prompt"
export const ACP_SESSION_CANCEL = "session/cancel"
export const ACP_SESSION_UPDATE = "session/update"

/** The turn never reached the model — the caller MAY fall back to the
 * one-shot lane without breaking §4's exactly-one-call rule. */
export const ACP_ERR_NO_CALL = -32000
/** A model request went out and the turn still failed — the caller MUST
 * NOT fall back; the record stays pending/retryable. */
export const ACP_ERR_CALL_CONSUMED = -32001

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
}
export interface AcpNewSessionResult { sessionId: string }
export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
  /** REQUIRED: the daemon never substitutes its own env's model for the
   * caller's — a silent substitution would make the record's `model` stamp
   * a lie (§6e provenance rule). */
  _meta: { model: string }
}
export interface AcpPromptResult {
  stopReason: "end_turn"
  /** `model` is what the turn ACTUALLY ran on; the caller stamps from it. */
  _meta: { model: string; callConsumed: true }
}
export interface AcpUpdateParams {
  sessionId: string
  update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
}

export function encodeFrame(msg: object): string {
  return JSON.stringify(msg) + "\n"
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024

/** Newline-delimited JSON-RPC decoder. Malformed lines (and lines longer
 * than `maxLineBytes`, which also reset the buffer) increment `malformed`
 * and are dropped — a broken or hostile client never kills the daemon and
 * never grows its memory without bound. */
export class FrameDecoder {
  private buf = ""
  private readonly maxLineBytes: number
  malformed = 0

  constructor(opts: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

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
    if (this.buf.length > this.maxLineBytes) {
      this.malformed++
      this.buf = ""
    }
    return out
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-wire.ts cc-gate-plugin/test/acp-wire.test.ts
git commit -m "feat(gauge): ACP wire subset — framing, method constants, call-consumption codes"
```

### Task 3: Widen the transport literal to `agent-sdk-daemon`

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (`GAUGE_TRANSPORTS`, line 167)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts:49` (DECLARED EXCEPTION #1)
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (append), `cc-gate-plugin/test/paired-validation.test.ts` (append)

**Interfaces:**
- Consumes: `GAUGE_TRANSPORTS`, `GaugeTransport` (currently `["cli","sdk","agent-sdk"]`, `src/types.ts:167-168`).
- Produces: `GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const` (incumbent-first order preserved) and the derived union. Everything downstream (`parsePairFlag` at `paired-validation.ts:349-362`, `PvPairing`, `arms` fields, `derivedOn`, `parsePvCountsFile`'s arms validation) picks the new literal up structurally — the §6d plan parameterized them over `GAUGE_TRANSPORTS` for exactly this reason.

- [ ] **Step 1: Write the failing tests** (in the files that already import these symbols — `gauge-agent-transport.test.ts` owns `GAUGE_TRANSPORTS`/`selectTransport`, `paired-validation.test.ts` owns `parsePairFlag`; do NOT put them in `gauge-wiring.test.ts`, which is a hook-to-refiner E2E file that imports neither)

```typescript
// test/gauge-agent-transport.test.ts — EXTEND the existing literal-list
// assertion at line 49 (declared exception #1): a fourth registered literal
// necessarily invalidates a toEqual on the old three.
test("four transports are recognized, incumbent order preserved (§6e)", () => {
  expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk", "agent-sdk-daemon"])
})

// test/paired-validation.test.ts
test("parsePairFlag accepts the §6e literal structurally", () => {
  const p = parsePairFlag(["--pair", "sdk:agent-sdk-daemon"])!
  expect(p.shadowTransport).toBe("agent-sdk-daemon")
  expect(p.baselineLabel).toBe("sdk")
})
test("an agent-sdk-daemon record is NOT CLI-derived", () => {
  expect(isCliDerived({ derivation: { transport: "agent-sdk-daemon", class: "C" } } as never)).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts test/paired-validation.test.ts`
Expected: FAIL — array does not contain `"agent-sdk-daemon"`.

- [ ] **Step 3: Widen the literal in `types.ts:167`**

```typescript
/** §6d: a third transport joins the §6c pair. §6e: a fourth, the warm
 * daemon lane. Order is incumbent-first so existing readings that sort by
 * this array do not reshuffle. */
export const GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const
export type GaugeTransport = (typeof GAUGE_TRANSPORTS)[number]
```

- [ ] **Step 4: Full suite green**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Grep-verify no OTHER literal-list assertion exists:
`grep -rn 'GAUGE_TRANSPORTS' cc-gate-plugin/test/` — expect hits only in `gauge-agent-transport.test.ts` (import + the one updated assertion). Any other hit is an undeclared exception — stop and report.
`isCliDerived` (`paired-validation.ts:56-59`) already reads `"cli"`-or-absent, so the new literal cannot fall into the CLI baseline; the appended test pins that.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/test/gauge-agent-transport.test.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): widen transport literal to agent-sdk-daemon"
```

### Task 4: `WarmSession` — the warm streaming Query, persistent pump, lossless feed

**Files:**
- Create: `cc-gate-plugin/test/agent-cli-stub.ts` (helper extraction, Step 0)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (import the extracted helpers instead of defining them — a MOVE, no assertion changes)
- Create: `cc-gate-plugin/src/gauge/warm-session.ts`
- Test: `cc-gate-plugin/test/warm-session.test.ts`

**Interfaces:**
- Consumes: `query`, `Query`, `SDKMessage`, `SDKUserMessage` from `@anthropic-ai/claude-agent-sdk` (lazy-imported inside `ensure()`, same rationale as `agent-transport.ts:104-108`'s ~84 ms finding); the isolation option set from `agent-transport.ts:119-132` (copy the object literal, cite it — do NOT import agent-transport's private internals).
- Produces:
  ```typescript
  export type TurnOutcome =
    | { kind: "ok"; text: string; model: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  export class WarmSession {
    constructor(env: Record<string, string | undefined>, opts?: { turnTimeoutMs?: number; cwd?: string })
    /** ONE serialized turn. `recycle` is the CALLER's decision (the daemon
     * passes true when the sessionId differs from the last one served), so
     * a multi-prompt ACP session keeps its context — see Task 5. Never two
     * turns in flight: calls queue FIFO. NEVER throws. */
    oneShot(messageText: string, model: string, opts: { recycle: boolean }): Promise<TurnOutcome>
    isWarm(): boolean
    turnInFlight(): boolean
    /** ms since the last COMPLETED turn — the idle reaper reads this. */
    idleMs(): number
    /** Terminate the Query and subprocess. Idempotent. */
    close(): void
  }
  ```

**Design (locked by sdk.d.ts, not by prose):**
- ONE `query({ prompt: pushable.stream(), options })`; the same `Query` serves many turns.
- **ONE persistent pump.** `Query extends AsyncGenerator<SDKMessage, void>` (sdk.d.ts:2279). Returning or breaking out of a `for await` calls `iterator.return()` and TERMINATES the generator — so a per-turn `for await` kills the warm session at the end of turn #1. The pump is a single loop for the `Query`'s whole lifetime that never breaks and never returns; it routes each message to `this.current`.
- **Lossless feed.** The input side is a pushable queue with an optional waiting resolver, NOT a bare one-shot promise slot. Pushing `/clear` and the prompt back-to-back in one synchronous tick must deliver BOTH; a single re-armed resolver silently drops the second.
- Recycle: `/clear` is pushed only when the caller asks for it AND the `Query` is not brand-new (nothing to clear on the first turn of a warm period). `/clear` makes no model call and emits no `result` of its own; the next `result` belongs to the record's turn. Both properties are LOCKED by the tests, not trusted.
- Turn timeout: `interrupt()` (sdk.d.ts:2293) cancels the turn; the session survives. A hard grace timer force-closes if `interrupt()` itself hangs, so a stalled turn can never wedge the FIFO forever.
- **Success requires `subtype === "success" && is_error !== true`.** `SDKResultError` (sdk.d.ts:4269-4286) has NO `result` field, and an interrupted assistant message is flagged `aborted` (sdk.d.ts:2871). Falling back to accumulated partial text would persist a derivation built from a truncated turn.
- `callConsumed` is `sawModelActivity` — set on the first `assistant`/`stream_event`/`api_retry` message of the turn. Conservative by construction: if we never saw the model, nothing was spent.
- Model: `setModel(model)` (sdk.d.ts:2327, streaming-only) before a turn whose model differs from the current one; the outcome echoes the model actually used.

- [ ] **Step 0: Extract the CLI-stub helpers (a MOVE, no behaviour change)**

Move `hasClaudeCodeCredentials()` / `HAS_CLAUDE_CODE_CREDENTIALS` / `NO_CREDENTIALS_SKIP_REASON` (`test/gauge-agent-transport.test.ts:23-45`), `sseText()` (`:92-103`) and `withCaptureStub()` (`:116-145`) into `test/agent-cli-stub.ts` and re-import them in `gauge-agent-transport.test.ts`. No assertion in that file changes; `bun test` must be 0-fail before and after.
**Why this is mandatory, not tidiness:** `sseText` is load-bearing. The spawned CLI always sends `stream: true`, and a plain `Response.json(...)` makes it silently fall back to a SECOND, non-streaming request (`gauge-agent-transport.test.ts:67-84`). Every request-count assertion in Tasks 4-6 is meaningless without an SSE-shaped stub. And `withCaptureStub()` is per-test on purpose (`:107-115`): a killed test's subprocess can land mid-next-test, so a module-level shared `CAPTURED` corrupts unrelated counts.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { WarmSession } from "../src/gauge/warm-session.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText, withCaptureStub } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

const CLI_TEST_TIMEOUT_MS = 60_000

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("WarmSession (spawns bundled CLI)", () => {
  test("two records reuse one subprocess; the second context is clean; exactly one call each", async () => {
    let n = 0
    const stub = stubServer(() => sseText(`ANSWER-${++n}`))
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText(`ANSWER-${++n}`) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r1 = await ws.oneShot("first record prompt", "claude-haiku-4-5", { recycle: true })
      const r2 = await ws.oneShot("second record prompt", "claude-haiku-4-5", { recycle: true })
      expect(r1.kind).toBe("ok")
      expect(r2.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)                        // exactly 1 model call per record
      const m2 = CAPTURED[1] as { messages: unknown[] }
      expect(m2.messages.length).toBe(1)                     // /clear really reset the context
      expect(JSON.stringify(m2.messages)).not.toContain("first record prompt")
      expect(ws.isWarm()).toBe(true)                         // no respawn between records
    } finally { ws.close(); cap.stop(); stub.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("recycle:false keeps context (ACP multi-prompt session semantics)", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER") })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      await ws.oneShot("turn one marker", "claude-haiku-4-5", { recycle: true })
      await ws.oneShot("turn two", "claude-haiku-4-5", { recycle: false })
      expect(JSON.stringify((CAPTURED[1] as { messages: unknown[] }).messages)).toContain("turn one marker")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("turn timeout -> call-consumed (never partial text), session stays warm", async () => {
    let first = true
    const cap = stubServer(() => (first ? ((first = false), new Promise<Response>(() => {})) : sseText("ANSWER")))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url }, { turnTimeoutMs: 2_000 })
    try {
      const r1 = await ws.oneShot("hanging record", "claude-haiku-4-5", { recycle: true })
      expect(r1.kind).toBe("call-consumed")                  // NOT ok, NOT no-call
      expect("text" in r1).toBe(false)                       // no truncated text escapes
      const r2 = await ws.oneShot("normal record", "claude-haiku-4-5", { recycle: true })
      expect(r2.kind).toBe("ok")
      expect(ws.isWarm()).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("api_retry -> call-consumed (the retry is never consumed as a result)", async () => {
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER")))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("retry-provoking record", "claude-haiku-4-5", { recycle: true })
      expect(r.kind).toBe("call-consumed")
      expect(n).toBeLessThanOrEqual(2)   // the abort races an in-flight retry; a THIRD request means it never landed
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("no daemon-side endpoint at all -> no-call (fallback is safe)", async () => {
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, { turnTimeoutMs: 2_000 })
    try {
      const r = await ws.oneShot("x", "claude-haiku-4-5", { recycle: true })
      expect(r.kind).toBe("no-call")
    } finally { ws.close() }
  }, CLI_TEST_TIMEOUT_MS)

  test("FIFO: concurrent oneShots serialize; both resolve; two calls total", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER") })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const [a, b] = await Promise.all([
        ws.oneShot("record A", "claude-haiku-4-5", { recycle: true }),
        ws.oneShot("record B", "claude-haiku-4-5", { recycle: true }),
      ])
      expect(a.kind).toBe("ok")
      expect(b.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("the echoed model is the model that ran", async () => {
    const cap = stubServer(() => sseText("ANSWER"))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("x", "claude-haiku-4-5", { recycle: true })
      expect(r.kind === "ok" && r.model).toBe("claude-haiku-4-5")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts`
Expected: FAIL — `Export named 'WarmSession' not found`

- [ ] **Step 3: Implement `warm-session.ts`** — this skeleton is the design, not a sketch

```typescript
// §6e WarmSession: one streaming-input Query, ONE persistent message pump,
// a lossless pushable input queue, caller-directed /clear recycling, FIFO
// turns, three-way outcomes.
//
// Isolation options are the §6d set (agent-transport.ts:119-132) with ONE
// registered delta: `maxTurns: 1` and `abortController` are query-scoped
// and cannot transfer to a many-turn session — maxTurns would stop the
// whole Query after record #1, and aborting the shared controller would
// kill every later turn. Replaced by per-turn call accounting + interrupt().
// `cwd` is pinned to a neutral dir so the instrument does not vary with
// whichever session spawned the daemon.
//
// Lazy SDK import (hook processes must not pay the ~84 ms package load;
// same finding as agent-transport.ts:104-108).
import os from "node:os"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export type TurnOutcome =
  | { kind: "ok"; text: string; model: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

/** Grace beyond turnTimeoutMs before we stop waiting for interrupt() to
 * land and force-close. Without it, a hung interrupt wedges the FIFO. */
const HARD_GRACE_MS = 10_000

interface Turn {
  text: string
  model: string
  recycle: boolean
  buf: string
  sawModelActivity: boolean
  timedOut: boolean
  done: boolean
  settle: (o: TurnOutcome) => void
  timer?: ReturnType<typeof setTimeout>
  hardTimer?: ReturnType<typeof setTimeout>
}

/** Lossless pushable async iterable. N pushes in one synchronous tick all
 * land; a single re-armed promise resolver would drop every push after the
 * first (this is the defect that killed the first draft of this design). */
class Pushable {
  private queue: SDKUserMessage[] = []
  private waiter: ((m: SDKUserMessage | undefined) => void) | undefined
  private closed = false

  push(m: SDKUserMessage): void {
    if (this.closed) return
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(m)
      return
    }
    this.queue.push(m)
  }

  close(): void {
    this.closed = true
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(undefined)
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      const m = await new Promise<SDKUserMessage | undefined>((res) => {
        this.waiter = res
      })
      if (m === undefined) return
      yield m
    }
  }
}

function userMsg(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

function extractText(m: SDKMessage): string {
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b.type === "text" && typeof b.text === "string") out += b.text
  }
  return out
}

export class WarmSession {
  private q: Query | undefined
  private feed: Pushable | undefined
  private pump: Promise<void> | undefined
  private pending: Turn[] = []
  private draining = false
  private current: Turn | undefined
  private fresh = true
  private currentModel = ""
  private lastActivity = Date.now()
  private readonly turnTimeoutMs: number
  private readonly cwd: string

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: { turnTimeoutMs?: number; cwd?: string } = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 45_000
    this.cwd = opts.cwd ?? os.tmpdir()
  }

  oneShot(messageText: string, model: string, opts: { recycle: boolean }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolveCaller) => {
      const turn: Turn = {
        text: messageText,
        model,
        recycle: opts.recycle,
        buf: "",
        sawModelActivity: false,
        timedOut: false,
        done: false,
        settle: () => {},
      }
      this.pending.push(turn)
      void this.drain(turn, resolveCaller)
    })
  }

  isWarm(): boolean { return this.q !== undefined }
  turnInFlight(): boolean { return this.current !== undefined || this.pending.length > 0 }
  idleMs(): number { return Date.now() - this.lastActivity }

  close(): void { this.hardReset() }

  // ── internals ────────────────────────────────────────────────────────

  private hardReset(): void {
    try { this.q?.close() } catch { /* idempotent */ }
    this.feed?.close()
    this.q = undefined
    this.feed = undefined
    this.pump = undefined
    this.fresh = true
    this.currentModel = ""
  }

  /** FIFO driver. One `drain` runs at a time; each caller's promise is
   * resolved with its own turn's outcome. */
  private async drain(mine: Turn, resolveCaller: (o: TurnOutcome) => void): Promise<void> {
    const results = new Map<Turn, TurnOutcome>()
    if (this.draining) {
      // Another drain owns the loop; wait for our turn to be settled by it.
      const o = await new Promise<TurnOutcome>((res) => { mine.settle = res })
      resolveCaller(o)
      return
    }
    this.draining = true
    try {
      while (this.pending.length > 0) {
        const turn = this.pending.shift()!
        const outcome = await this.execute(turn)
        results.set(turn, outcome)
        this.lastActivity = Date.now()
        if (turn === mine) resolveCaller(outcome)
      }
    } finally {
      this.draining = false
    }
  }

  /** Ensure a live Query + pump. Returns false when the session cannot be
   * started at all (which is a `no-call` condition). */
  private async ensure(model: string): Promise<boolean> {
    if (this.q) return true
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk")
      const subprocessEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(this.env)) if (v !== undefined) subprocessEnv[k] = v
      const feed = new Pushable()
      const q = query({
        prompt: feed.stream(),
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
          cwd: this.cwd,
          env: subprocessEnv,
        },
      })
      this.q = q
      this.feed = feed
      this.currentModel = model
      this.fresh = true
      this.pump = this.runPump(q)
      return true
    } catch {
      this.hardReset()
      return false
    }
  }

  /** THE ONE PUMP. Never breaks, never returns early — `Query` is an
   * AsyncGenerator (sdk.d.ts:2279), so exiting a `for await` calls
   * `.return()` and terminates it. A per-turn loop would kill the warm
   * session at the end of record #1. */
  private async runPump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.route(m)
    } catch {
      /* the query died; settled below */
    } finally {
      const t = this.current
      if (t && !t.done) t.settle({ kind: t.sawModelActivity ? "call-consumed" : "no-call" })
      this.hardReset()
    }
  }

  private route(m: SDKMessage): void {
    const t = this.current
    if (!t || t.done) return

    if (m.type === "assistant" || m.type === "stream_event") t.sawModelActivity = true

    if (m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") {
      // The CLI auto-retries a 5xx internally; that retry would be call #2
      // (§6d finding, agent-transport.ts:135-145). Cancel and report the
      // call as CONSUMED so no caller falls back onto a second call.
      t.sawModelActivity = true
      void this.q?.interrupt().catch(() => this.hardReset())
      t.settle({ kind: "call-consumed" })
      return
    }

    if (m.type === "assistant") t.buf += extractText(m)

    if (m.type === "result") {
      const r = m as { subtype?: string; is_error?: boolean; result?: unknown }
      const success = r.subtype === "success" && r.is_error !== true && !t.timedOut
      if (success && typeof r.result === "string" && r.result) {
        t.settle({ kind: "ok", text: r.result, model: t.model })
        return
      }
      // SDKResultError carries no `result` (sdk.d.ts:4269-4286) and an
      // interrupted assistant message is `aborted` (sdk.d.ts:2871) — the
      // accumulated buffer is truncated text and must NEVER be persisted.
      t.settle({ kind: t.sawModelActivity ? "call-consumed" : "no-call" })
    }
  }

  private async execute(turn: Turn): Promise<TurnOutcome> {
    if (!(await this.ensure(turn.model))) return { kind: "no-call" }

    if (turn.model !== this.currentModel) {
      try {
        await this.q!.setModel(turn.model)   // streaming-only (sdk.d.ts:2327)
        this.currentModel = turn.model
      } catch {
        this.hardReset()
        return { kind: "no-call" }
      }
    }

    const settled = new Promise<TurnOutcome>((res) => {
      turn.settle = (o) => {
        if (turn.done) return
        turn.done = true
        if (turn.timer) clearTimeout(turn.timer)
        if (turn.hardTimer) clearTimeout(turn.hardTimer)
        if (this.current === turn) this.current = undefined
        res(o)
      }
    })
    this.current = turn

    turn.timer = setTimeout(() => {
      turn.timedOut = true
      void this.q?.interrupt().catch(() => this.hardReset())
    }, this.turnTimeoutMs)
    turn.hardTimer = setTimeout(() => {
      this.hardReset()
      turn.settle({ kind: turn.sawModelActivity ? "call-consumed" : "no-call" })
    }, this.turnTimeoutMs + HARD_GRACE_MS)

    // /clear makes no model call and emits no result of its own; the next
    // result belongs to this turn. Both properties are test-locked above,
    // not trusted. Recycle is the CALLER's decision so a multi-prompt ACP
    // session keeps its context.
    if (turn.recycle && !this.fresh) this.feed!.push(userMsg("/clear"))
    this.fresh = false
    this.feed!.push(userMsg(turn.text))

    return settled
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts` — 0 fail (on this credentialed host, none skipped).
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Record the measured first-record and steady-state per-record latency in the SDD progress notes — §6e registered the 838 ms / ~20 ms figures as INDICATIVE and this is where they get their in-tree measurement.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/warm-session.ts cc-gate-plugin/test/warm-session.test.ts cc-gate-plugin/test/agent-cli-stub.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): WarmSession — persistent pump, lossless feed, three-way turn outcomes"
```

### Task 5: `acp-daemon.ts` — socket server, ACP dispatcher, idle self-exit

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-daemon.ts`
- Test: `cc-gate-plugin/test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `WarmSession`, `TurnOutcome` (Task 4); everything from `acp-wire.ts` (Task 2).
- Produces:
  - Runnable: `bun src/gauge/acp-daemon.ts` (socket mode, default) and `bun src/gauge/acp-daemon.ts --stdio` (single-client stdio mode for standard ACP editor clients — the same dispatcher bound to stdin/stdout).
  - `socketPath(env: Record<string, string | undefined>): string` — the SINGLE endpoint seam: `env.KKAMAK_ACP_SOCKET` when set; else on `win32` the named pipe `\\.\pipe\kkamak-acp-${os.userInfo().username}`; else `path.join(homedir(), ".config", "kkamak", "acp.sock")` — the repo's documented host-local store (CLAUDE.md). `~/.kkamak/` is NOT used: it does not exist and is not a repo convention.
  - `ensureSocketDir(p: string): void` — `mkdirSync(dirname(p), { recursive: true, mode: 0o700 })` before any `listen`. Without this the default path fails `ENOENT` on a fresh host.
  - Filesystem hygiene is platform-gated behind `isPipe = p.startsWith("\\\\.\\pipe\\")`: `chmod 0600` and stale-file takeover apply only to the Unix path (named pipes carry no file mode and vanish with their last handle). Current hosts are WSL2 and macOS — the Unix path is what Tasks 5-10 execute and test; the win32 branch is a compile-checked seam with a unit test on the path string only. Bun named-pipe status (researched 2026-08-04): `node:net` named pipes are SUPPORTED (Bun v1.1.28; name normalization fixed v1.1.35; oven-sh/bun#11820 closed), but the neighbouring `node:http` pipe-listen bug is still open (oven-sh/bun#24682) — we use raw `node:net` only, never `node:http`, and a first native-Windows host still runs one live round-trip verify.
  - **ACP behaviour:**
    - `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false } }`.
    - `session/new` → mints a UUID sessionId and records it (cheap: no model work, no recycle — an abandoned `session/new` costs nothing).
    - `session/prompt` → requires `params._meta.model` (a string); a missing/non-string model is a `ACP_ERR_NO_CALL` error, never a silent substitution of the daemon's own env. Computes `recycle = (params.sessionId !== lastServedSessionId)` and calls `warm.oneShot(text, model, { recycle })`. **This is what keeps the ACP facade honest:** two prompts in the SAME session share context (correct ACP semantics), while the deriver — which opens a fresh session per record — always gets a clean one.
      - `ok` → emit ONE `session/update` notification with the full text as an `agent_message_chunk`, then answer `{ stopReason: "end_turn", _meta: { model: <the model that ran>, callConsumed: true } }`.
      - `no-call` → JSON-RPC error `{ code: ACP_ERR_NO_CALL, message, data: { callConsumed: false } }`, no update.
      - `call-consumed` → JSON-RPC error `{ code: ACP_ERR_CALL_CONSUMED, message, data: { callConsumed: true } }`, no update.
    - `session/cancel` → `interrupt()` on the warm session; answers `{}`.
    - Unknown method → JSON-RPC `-32601`, connection stays open.
  - Idle reaper: every 60 s, if `warm.idleMs() > KKAMAK_ACP_IDLE_MS` (default 900_000) AND `!warm.turnInFlight()` → **stop accepting new connections first**, then close open connections, then `warm.close()`, unlink the socket, `process.exit(0)`. Unlinking before draining races a client that has already written a `session/prompt`.
  - Lifecycle hygiene: `chmod 0600` after listen; `SIGTERM`/`SIGINT` → same drain-then-unlink-then-exit path.
  - **Stale-socket takeover, race-free:** the whole probe→unlink→rebind sequence runs while holding `~/.config/kkamak/acp-spawn.lock`, created with `writeFileSync(..., { flag: "wx" })` and the stale/torn rule from `corpus-store.ts:131-141`. Sequence: `listen` → on `EADDRINUSE`, `net.connect` the path → answered ⇒ another daemon is live, exit 0 quietly; `ECONNREFUSED`/`ENOENT` ⇒ unlink and ONE rebind attempt. Without the lock two starters can both see `ECONNREFUSED`, both unlink, and the loser's unlink removes the winner's LIVE path — leaving a listening-but-unreachable daemon and every caller silently falling back forever.
  - Test seam: when `env.KKAMAK_ACP_TEST_SPAWN_LOG` is set, append one line (`pid` + ISO ts) to that file at boot. Three lines; this is what makes Task 6's "exactly one daemon spawned" assertion possible.

- [ ] **Step 1: Write the failing tests** (drive the real daemon as a child over a temp socket; SSE stub for the model side; credentials skip-guard)

```typescript
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText } from "./agent-cli-stub.ts"
import { ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED } from "../src/gauge/acp-wire.ts"

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-daemon over unix socket", () => {
  test("initialize -> session/new -> session/prompt round-trip, model echoed", async () => {
    const sock = `${tmpdir()}/kkamak-acp-test-${process.pid}-${Date.now()}.sock`
    const child = spawnDaemon(sock, { ANTHROPIC_BASE_URL: stubUrl })
    try {
      const c = await connectNdjson(sock)          // helper: net.connect + FrameDecoder
      expect((await c.request("initialize", { protocolVersion: 1 })).protocolVersion).toBe(1)
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      expect(typeof s.sessionId).toBe("string")
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      const r = await c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "classify me" }],
        _meta: { model: "claude-haiku-4-5" },
      })
      expect(r.stopReason).toBe("end_turn")
      expect(r._meta.model).toBe("claude-haiku-4-5")
      expect(updates.join("")).toContain("ANSWER")
    } finally { child.kill() }
  }, 40_000)

  test("a second SESSION recycles (clean context); a second PROMPT in one session does not", async () => {
    // session/new + prompt, then session/new + prompt on the same daemon:
    // assert CAPTURED.length === 2, second request messages.length === 1, and
    // the first prompt's marker absent from the second body.
    // Then a THIRD prompt reusing the SECOND sessionId: assert the second
    // prompt's marker IS present (ACP session semantics preserved).
  }, 40_000)

  test("missing _meta.model -> ACP_ERR_NO_CALL, and no model call is made", async () => {
    // assert error.code === ACP_ERR_NO_CALL, error.data.callConsumed === false,
    // and the stub captured ZERO requests.
  }, 40_000)

  test("a 500 (api_retry) -> ACP_ERR_CALL_CONSUMED with callConsumed true, no update", async () => {
    // stub: 500 then success. assert error.code === ACP_ERR_CALL_CONSUMED.
  }, 40_000)

  test("unknown method -> -32601 and the connection survives", async () => {
    // assert the error code, then a following `initialize` still answers.
  }, 40_000)

  test("a malformed frame does not kill the daemon", async () => {
    // write "garbage\n", then a valid initialize on the SAME socket: answers.
  }, 40_000)

  test("idle reaper drains, exits, and removes the socket", async () => {
    // spawn with KKAMAK_ACP_IDLE_MS=1500, do one prompt, wait ~4s:
    // child exited 0, fs.existsSync(sock) === false
  }, 40_000)

  test("stale socket file is taken over under the lock", async () => {
    // pre-create a dead socket file at the path, spawn daemon, initialize succeeds
  }, 40_000)

  test("a LIVE socket is not taken over: the second daemon exits 0 and the first still answers", async () => {
    // this is the race the spawn lock exists to prevent
  }, 40_000)
})
```
(The sketched bodies are written out in full by the implementer following the first test's helper pattern — same helpers, different assertions; the assertions named in the comments are the required ones.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts`
Expected: FAIL — daemon entry does not exist.

- [ ] **Step 3: Implement `acp-daemon.ts`**

```typescript
// §6e ACP daemon: one WarmSession behind the ACP wire subset.
// session/new is cheap (UUID mint); the /clear recycle happens at a
// prompt whose sessionId differs from the last one served — so a
// multi-prompt ACP session keeps its context while the deriver (fresh
// session per record) always gets a clean one.
// One turn in flight globally (WarmSession FIFO).
// Failure is a JSON-RPC ERROR carrying callConsumed, never a fake
// stopReason: the caller may only fall back when callConsumed is false.
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { WarmSession, type TurnOutcome } from "./warm-session.ts"
import {
  FrameDecoder, encodeFrame,
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
} from "./acp-wire.ts"

export function socketPath(env: Record<string, string | undefined>): string {
  if (env.KKAMAK_ACP_SOCKET) return env.KKAMAK_ACP_SOCKET
  if (process.platform === "win32") return `\\\\.\\pipe\\kkamak-acp-${os.userInfo().username}`
  return path.join(os.homedir(), ".config", "kkamak", "acp.sock")
}

export function ensureSocketDir(p: string): void {
  if (p.startsWith("\\\\.\\pipe\\")) return
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
}
// ... dispatcher: switch on frame.method, per-connection FrameDecoder,
// responses via encodeFrame on the same duplex stream; sessions
// Map<string, { createdAt: number }> + `lastServedSessionId`;
// on session/prompt: validate params._meta.model is a non-empty string,
// recycle = sessionId !== lastServedSessionId, then map TurnOutcome ->
// result | ACP_ERR_NO_CALL | ACP_ERR_CALL_CONSUMED.
// Idle reaper: setInterval(60_000) -> stop accepting, drain, close, unlink, exit 0.
// SIGTERM/SIGINT -> the same drain path.
```

The implementer writes the full dispatcher (~180 lines) against the Task 2 types; every branch has a test from Step 1. **One structural rule:** the dispatcher must never `throw` across a connection handler — every error path answers a JSON-RPC error frame. The daemon dying on a bad frame is a fail-open violation.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-daemon.test.ts` — 0 fail.
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Hygiene check: `ls ~/.config/kkamak/acp.sock` — must NOT exist (every test used a temp socket).

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-daemon.ts cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(gauge): ACP daemon — socket server, session-keyed recycle, idle self-exit"
```

### Task 6: `acp-client.ts` — connect-or-spawn, three-way outcome, shared outgoing text

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-client.ts`
- Modify: `cc-gate-plugin/src/gauge/agent-transport.ts` (EXPORT the existing `buildOutgoingText`, renamed `buildAgentOutgoingText` — no behaviour change, no new logic)
- Test: `cc-gate-plugin/test/acp-client.test.ts`

**Interfaces:**
- Consumes: `socketPath`, `ensureSocketDir` (Task 5); wire pieces + error codes (Task 2); `buildAgentOutgoingText` (this task).
- Produces:
  ```typescript
  /** Mirrors WarmSession's TurnOutcome across the wire so the
   * call-consumption rule survives the process boundary. */
  export type DaemonOutcome =
    | { kind: "ok"; text: string; model: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  /** One record through the daemon. Connect (never spawn) -> initialize ->
   * session/new -> session/prompt -> collect the update -> close socket.
   * `no-call` on ANY pre-model failure (connect refused, protocol error,
   * budget exhausted before the turn began); `call-consumed` ONLY when the
   * daemon reported ACP_ERR_CALL_CONSUMED. NEVER throws. */
  export function daemonCall(
    outgoingText: string,
    model: string,
    env: Record<string, string | undefined>,
    opts?: { budgetMs?: number },   // default DAEMON_LEG_MS = 20_000
  ): Promise<DaemonOutcome>

  /** Ensure a daemon is reachable. `waitMs: 0` = kick and return false
   * immediately (the SessionStart hook's mode). Otherwise poll-connect up
   * to waitMs. Returns true when a daemon answered `initialize`. NEVER
   * throws. Spawn is wx-lock guarded at
   * ~/.config/kkamak/acp-spawn.lock (corpus-store.ts:131-141 rule). */
  export function ensureDaemon(env: Record<string, string | undefined>, opts?: { waitMs?: number }): Promise<boolean>

  export const DAEMON_LEG_MS = 20_000
  ```
- **Spawn idiom (repo-established, `hook-cli.ts:149-153`):**
  ```typescript
  const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  ```
  Bun's `spawn` has no `detached` option and no string `stdio`; and without `nohup` the daemon dies with the hook process that started it.
- **Deliberate split:** `daemonCall` never spawns. Spawning is `ensureDaemon`'s job (SessionStart hook, Task 8; batch runs call it once up front with a real `waitMs`). A Stop-hook deriver whose daemon is missing gets `no-call`, falls back this record, and the next session's hook re-ensures — no derivation ever waits out a daemon boot.
- **Shared outgoing text (§6e "the two lanes must differ in transport only"):** `agent-transport.ts`'s private `buildOutgoingText` (`:85-88`) appends the trailing schema instruction that IS the agent lane's entire schema-enforcement mechanism (spec §6d, "Schema enforcement differs between the arms"). It is exported here as `buildAgentOutgoingText(messageText, schema)` so `callModelDerive` builds ONE string used byte-identically by `daemonCall` and `agentSdkCall`. `agentSdkCall` keeps calling it internally and is byte-unchanged for its existing callers.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("acp-client", () => {
  test("daemonCall returns no-call fast when there is no daemon", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", { ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock` })
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test("daemonCall round-trips against a scripted fake daemon", async () => {
    // net.createServer on a temp socket answering the 4 methods with canned
    // frames (no real WarmSession) -> { kind:"ok", text, model }.
    // Pins the CLIENT side of the wire contract independent of Task 5.
  })
  test("ACP_ERR_CALL_CONSUMED maps to call-consumed, NOT no-call", async () => {
    // fake daemon answers session/prompt with that error code:
    // expect(r.kind).toBe("call-consumed")   // this is what stops a double call
  })
  test("ACP_ERR_NO_CALL maps to no-call", async () => {
    // expect(r.kind).toBe("no-call")
  })
  test("budget exhaustion before any answer is no-call", async () => {
    // fake daemon accepts and never answers; budgetMs 500 -> no-call, < 1.5s
  })
  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    // fake daemon captures params: _meta.model === "claude-haiku-4-5",
    // prompt[0].text === the exact outgoing string passed in
  })
  test("buildAgentOutgoingText is the SAME builder the one-shot lane uses", () => {
    const s = { type: "object" } as Record<string, unknown>
    expect(buildAgentOutgoingText("P", s)).toContain("Respond with ONLY a JSON object matching this schema")
    expect(buildAgentOutgoingText("P", undefined)).toBe("P")
  })
  test("ensureDaemon spawns exactly one daemon under concurrent callers", async () => {
    // two ensureDaemon() racing on one socket path (wx lock): both resolve
    // true, and KKAMAK_ACP_TEST_SPAWN_LOG has exactly ONE line.
  })
  test("ensureDaemon(waitMs: 0) returns false immediately and still kicks a spawn", async () => {
    // < 500ms, returns false, spawn log eventually gains a line
  })
})
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-client e2e", () => {
  test("ensureDaemon + daemonCall against the real daemon and SSE stub", async () => {
    // full path: ensureDaemon spawns real acp-daemon.ts (stub ANTHROPIC_BASE_URL),
    // daemonCall returns { kind:"ok" }; SIGTERM the daemon at the end and
    // assert the socket file is gone.
  }, 40_000)
})
```

- [ ] **Step 2: Run to verify they fail** — `bun test test/acp-client.test.ts`, FAIL on missing exports.

- [ ] **Step 3: Implement** (~150 lines: `net.connect` with its own `FrameDecoder`, request-id counter, pending-response map, notification handler collecting `session/update` text, ONE overall deadline racing everything to `{ kind: "no-call" }`; error-code → outcome mapping; `ensureDaemon` per the signature above). In `agent-transport.ts`, add `export` to `buildOutgoingText` and rename it `buildAgentOutgoingText` at its definition and its one internal call site — nothing else changes in that file.

- [ ] **Step 4: Run to verify green** — file suite, then full `bun test` 0 fail, `bunx tsc --noEmit` clean. Re-run `bun test test/gauge-agent-transport.test.ts` explicitly: the rename must leave every §6d assertion passing unmodified.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-client.ts cc-gate-plugin/src/gauge/agent-transport.ts cc-gate-plugin/test/acp-client.test.ts
git commit -m "feat(gauge): ACP client — daemonCall three-way outcome, ensureDaemon, shared outgoing text"
```

### Task 7: Route the transport — selection, safe fallback, honest stamping

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (`selectTransport` allow-list + `callModelDerive`)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts` (`deriveRecord` stamps the actual lane AND the actual model)
- Test: `cc-gate-plugin/test/gauge-transport-daemon.test.ts` (new file)

**Interfaces:**
- Consumes: `daemonCall`, `DaemonOutcome`, `buildAgentOutgoingText`, `DAEMON_LEG_MS` (Task 6); `agentSdkCall`, `sdkCall`, `resolveModelId`, `DERIVATION_SCHEMA`, `buildRefinerPrompt` (existing).
- **`selectTransport` is currently a TERNARY, not an allow-list** (`transport.ts:44-46`: `return env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk" ? "agent-sdk" : "sdk"`). This task creates the allow-list:
  ```typescript
  export function selectTransport(env: Record<string, string | undefined>): GaugeTransport {
    const v = env.KKAMAK_GAUGE_TRANSPORT
    // Explicit allow-list, never a ternary chain: "cli" is retired and must
    // stay unselectable, and an unrecognized value must fall to the
    // incumbent rather than onto whichever literal a ternary happens to
    // leave in the else branch.
    return v === "agent-sdk" || v === "agent-sdk-daemon" ? v : "sdk"
  }
  ```
  The three existing `selectTransport` tests (`gauge-agent-transport.test.ts:53-65`) must pass UNMODIFIED.
- Produces:
  ```typescript
  /** Derive-path call that reports which lane actually ran AND on which
   * model. Existing `callModelSdk` keeps its signature for every other
   * caller (cls-ab's cls-run, which is pinned to "sdk" by its own liveEnv
   * strip at cls-ab.ts:746). */
  export interface DeriveCallResult {
    raw: string
    transport: GaugeTransport
    /** The model the lane ACTUALLY ran on — the record stamps THIS, not the
     * caller's guess (§6e provenance rule). */
    model: string
  }
  export function callModelDerive(
    prompt: string,
    floorCheck: string,
    env: Record<string, string | undefined>,
    authDeps?: AuthTokenDeps,
    opts?: SdkCallOptions,
  ): Promise<DeriveCallResult | undefined>
  ```
  **Behaviour, exactly:**
  1. `model = resolveModelId(opts?.model ?? env.KKAMAK_GAUGE_MODEL ?? "haiku")`; `messageText = buildRefinerPrompt(prompt, floorCheck, opts?.promptVariant ?? "base")`; `outgoing = buildAgentOutgoingText(messageText, DERIVATION_SCHEMA)` — built ONCE, shared by both agent legs so they differ in transport only.
  2. `selectTransport(env) !== "agent-sdk-daemon"` → today's behaviour byte-for-byte (`callModelSdk`'s existing dispatch), stamped with the selected lane and `model`.
  3. Daemon selected → one 60 s wall-clock budget for the record. Daemon leg gets `DAEMON_LEG_MS` (20 s):
     - `{ kind: "ok" }` → if the echoed model !== `model`, return `undefined` (a lane that silently changed the model must not produce a stamped record); else `{ raw: text, transport: "agent-sdk-daemon", model }`.
     - `{ kind: "no-call" }` → **fall back**: `agentSdkCall(outgoing, model, env, { timeoutMs: remaining })`, stamped `"agent-sdk"`. If that also fails → `undefined`.
     - `{ kind: "call-consumed" }` → **NO fallback**, return `undefined`. The record stays pending/retryable. This is §6e's binding call-consumption rule; a fallback here would be model call #2 for one record.
- `deriveRecord` (`corpus-replay.ts:41-79`) switches from `callModelSdk` + two independent stamps to `callModelDerive`'s returned `transport` AND `model` — selection, stamp and model can no longer diverge (the §6d cls-ab lesson, now structural). `corpus-replay.ts:73`'s `model: resolveModelId(process.env.KKAMAK_GAUGE_MODEL ?? "haiku")` and `:75`'s `transport: selectTransport(process.env)` both become reads off the result.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("agent-sdk-daemon routing (§6e)", () => {
  test("selectTransport accepts the new literal; defaults and the retired literal are unchanged", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe("agent-sdk-daemon")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "nonsense" })).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })).toBe("sdk")
  })
  test("no-call fallback stamps agent-sdk, not agent-sdk-daemon", async () => {
    const r = await callModelDerive("p", "check", { ...stubEnv, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: deadSock })
    expect(r?.transport).toBe("agent-sdk")
  })
  test("call-consumed does NOT fall back — undefined, and the one-shot endpoint is never hit", async () => {
    // fake daemon answers ACP_ERR_CALL_CONSUMED; agent stub counts requests
    const r = await callModelDerive("p", "check", { ...stubEnv, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: consumedSock })
    expect(r).toBeUndefined()
    expect(agentStub.captured.length).toBe(0)   // THE binding assertion: never a second call
  })
  test("daemon success stamps agent-sdk-daemon and echoes the model", async () => {
    const r = await callModelDerive("p", "check", { ...stubEnv, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: fakeSock })
    expect(r?.transport).toBe("agent-sdk-daemon")
    expect(r?.model).toBe("claude-haiku-4-5")
  })
  test("a daemon that answers with a DIFFERENT model produces no record", async () => {
    const r = await callModelDerive("p", "check", { ...stubEnv, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: wrongModelSock })
    expect(r).toBeUndefined()
  })
  test("both agent legs receive byte-identical outgoing text", async () => {
    // fake daemon captures its prompt[0].text; agent stub captures its
    // messages[0].content; assert equal, and both contain the schema
    // instruction.
  })
  test("total budget: a dead daemon + a hung one-shot stays under 60s", async () => {
    // deadSock + silent agent stub; assert elapsed < 60_000
  })
})

describe("deriveRecord stamps the lane and model that actually ran", () => {
  test("fake daemon -> derivation.transport agent-sdk-daemon", async () => { /* ... */ })
  test("dead socket -> derivation.transport agent-sdk (fallback)", async () => { /* ... */ })
  test("default env -> derivation.transport sdk (unchanged)", async () => { /* ... */ })
})
```

- [ ] **Step 2: Run to verify they fail** — missing export.

- [ ] **Step 3: Implement.** ~70 lines in `transport.ts`, ~6 changed lines in `corpus-replay.ts`. **The live-path pin tests (`gauge-refiner-cli.test.ts:56-86`, `:105`, `gauge-wiring.test.ts:102`) must stay green untouched** — `refiner-cli.ts:54` still strips the env var, so live derives keep running `"sdk"` regardless of this task.
Grep-verify: `grep -rn 'transport: selectTransport' cc-gate-plugin/src/` — expect exactly ONE hit (`refiner-cli.ts:85`, the live pin). `corpus-replay.ts:75` must no longer appear.

- [ ] **Step 4: Full suite green** — `bun test` 0 fail, `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts cc-gate-plugin/test/gauge-transport-daemon.test.ts
git commit -m "feat(gauge): route agent-sdk-daemon, fallback only on no-call, honest lane+model stamp"
```

### Task 8: SessionStart ensure-hook (through the existing dispatcher)

**Files:**
- Modify: `cc-gate-plugin/src/hook-cli.ts` (add `"SessionStart"` to `KNOWN_EVENTS` at line 36 + one early branch)
- Modify: `cc-gate-plugin/hooks/hooks.json` (add a SessionStart entry, `timeout: 30`)
- Test: `cc-gate-plugin/test/acp-ensure.test.ts`

**Why NOT a standalone CLI.** `test/packaging.test.ts:64-75` asserts that **every** hook command references `src/hook-cli.ts` and that the file exists; `:86-95` asserts every non-`Stop` entry has `timeout === 30`. A `hooks.json` entry pointing at `src/gauge/acp-ensure-cli.ts` turns that test red, which the Global Constraints forbid. Routing through the existing dispatcher keeps both assertions green, matches the shape of all three existing entries, and is F1-clean (`hook-cli.ts` is not a MECHANISM_PATH; the Phase-2 fixture harvest set the "hook-cli.ts wiring" precedent).

**Interfaces:**
- Consumes: `ensureDaemon` (Task 6).
- Produces: `bun "${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts" SessionStart` — fire-and-forget. The branch sits **before** `readGateConfigRaw`/`FileStateStore` (a daemon kick must not depend on gate config), runs only when `process.env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk-daemon"` (any other value = instant no-op), calls `await ensureDaemon(process.env, { waitMs: 0 })` inside a try/catch, and returns. Self-budget < 500 ms; the process always exits 0 via `hook-cli.ts`'s existing `.catch(() => {})` discipline. SessionEnd needs NO hook — per the user's ruling the daemon's own 15-min idle timeout owns shutdown.
- `ensureDaemon` is imported LAZILY inside the branch (`await import("./gauge/acp-client.ts")`) so the other three hook events pay nothing for it.

- [ ] **Step 1: Write the failing tests**

```typescript
const HOOK_CLI = path.join(pluginRoot, "src/hook-cli.ts")
const SESSION_START_STDIN = JSON.stringify({ session_id: "s1", cwd: process.cwd() })

/** Build a child env by explicit deletion — spreading `{...process.env,
 * K: undefined}` into Bun.spawn does NOT reliably drop the key, and an
 * inherited KKAMAK_GAUGE_TRANSPORT would make this test fork a REAL daemon
 * at the host's default socket. */
function envWithout(keys: string[], extra: Record<string, string> = {}): Record<string, string> {
  const e = { ...process.env } as Record<string, string>
  for (const k of keys) delete e[k]
  return { ...e, ...extra }
}

describe("SessionStart ensure-daemon hook", () => {
  test("no-op exit 0 when the transport is not the daemon lane", () => {
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout(["KKAMAK_GAUGE_TRANSPORT"], { KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(fs.existsSync(SPAWN_LOG)).toBe(false)   // nothing was spawned
  })
  test("exit 0 even when the socket dir is unwritable (fail-open)", () => {
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }),
    })
    expect(p.exitCode).toBe(0)
  })
  test("armed: exits 0 fast and kicks exactly one spawn", () => {
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

test("packaging invariants still hold with the new entry", () => {
  const h = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"))
  expect(h.hooks.SessionStart).toBeDefined()
  for (const b of h.hooks.SessionStart) for (const e of b.hooks) {
    expect(e.command).toContain("src/hook-cli.ts")
    expect(e.timeout).toBe(30)
  }
})
```
Every test sets `KKAMAK_ACP_SOCKET` to a per-test temp path, and an `afterEach` kills anything listening there and removes the spawn log — no test may ever touch `~/.config/kkamak/acp.sock`.

- [ ] **Step 2: Run to verify they fail** — `SessionStart` is not in `KNOWN_EVENTS`, so the hook exits 0 silently and the packaging assertion fails on a missing key.

- [ ] **Step 3: Implement** the `KNOWN_EVENTS` addition, the early branch, and the `hooks.json` entry:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts\" SessionStart", "timeout": 30 }] }]
```

- [ ] **Step 4: Full suite green** — `bun test` 0 fail (including `packaging.test.ts` UNMODIFIED), `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/hook-cli.ts cc-gate-plugin/hooks/hooks.json cc-gate-plugin/test/acp-ensure.test.ts
git commit -m "feat(gauge): SessionStart ensure-daemon via hook-cli dispatcher (opt-in, fail-open)"
```

### Task 9: Paired validation of the daemon lane (REAL SPEND — own sized go)

- [ ] **Step 1: Preserve the §6d arm BEFORE anything else.** `pv-sample --reset` `rmSync`s the shadow root (`paired-validation.ts:218`), and `.km/gauge-corpus-shadow/` currently holds the ONLY record-level `agent-sdk` derivations on this host (verified 2026-08-04: 10 records; zero `agent-sdk` records anywhere else). Copy it aside host-locally first:

```bash
cp -a .km/gauge-corpus-shadow /mnt/d/tmp/gauge-corpus-shadow-6d-$(date +%s)
```

This is the data §6e's falsification criterion reads (C-stratum only; the not-C stratum is an independent draw in each run and is not comparable). The committed `docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json` carries the per-key classes that travel.

- [ ] **Step 2: Token-free daemon liveness gate.** A daemon that is not up when the batch starts makes record #1 fall back, and there is NO subset re-derive: `runDerive` refuses unless `go === pending.length` (`corpus-replay.ts:151-157`) and a fallback-derived record is already stage `"derived"`. The ONLY remediation is `pv-sample --reset` plus a full re-spend of all 10 records. So prove the daemon is serving before spending:

```bash
export KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon
bun -e 'import("./cc-gate-plugin/src/gauge/acp-client.ts").then(async (m) => {
  const up = await m.ensureDaemon(process.env, { waitMs: 10_000 })
  console.log("daemon ready:", up); process.exit(up ? 0 : 1)
})'
```
Expected: `daemon ready: true`, exit 0. A `false` here means STOP and fix — do not spend.

- [ ] **Step 3: STOP and report before spending.** Run `bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk-daemon --reset` (token-free) and report: the printed sample size (expected 5 C + 5 not-C = 10, since the whole sdk-derived C stratum is 5), the model (haiku unless overridden), that the shadow derive is real spend, and that §6e registers this bar as having no power to separate a small effect (5-record C stratum, cap 1, zero slack). **Do not proceed without an explicit sized go.**

- [ ] **Step 4: On a granted go:**

```bash
export KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon
bun cc-gate-plugin/src/gauge/replay-cli.ts derive /home/th-yoo/z2/meta-harness/.km/gauge-corpus-shadow --go 10
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk-daemon
```

- [ ] **Step 5: Sanity BEFORE reading the verdict:** `wrongTransport` must be 0. Non-zero means records fell back to `"agent-sdk"` (daemon died mid-batch) or the stamp plumbing broke, and `evaluatePvBar` returns NOT-EVALUATED (`paired-validation.ts:473-481`). **Be honest about the cost:** there is no partial re-derive; recovery is a full `pv-sample --reset` and a fresh 10-record spend, which needs its own new go. Diagnose the cause (check whether the daemon process is still alive and whether the idle reaper fired mid-batch) before requesting it. This is why Task 7's stamp honesty is load-bearing: the partition SEES the fallback instead of silently absorbing it.

- [ ] **Step 6: Commit the counts** to `docs/gauge-pv/<hostname>-sdk-vs-agent-sdk-daemon-pv-counts.json` (F2: counts travel, prompts do not). `bun scripts/doc-check.ts` before the docs commit.

### Task 10: Verdict, and the live flip ONLY on a pass

> **OPEN QUESTION FOR THE USER, answer before Step 3 runs.** §6e registers
> that this bar has no statistical power: the whole `"sdk"`-derived class-C
> stratum on `yoo-dev` is 5 records, the missed-C cap is 1, and agreement
> ≥ 0.80 over a union of 5 means 4/5 — §6d already landed on both edges
> with zero slack. The flip is user-directed and reversible with one env
> var, so a PASS is sufficient under the rulings as given. **Do you want
> the live flip to additionally wait until the sdk-derived C stratum is
> materially larger (more live derivations accumulated), or to proceed on
> the 10-record result?** This is a question, not a bar change: the §6e bar
> constants are registered pre-data and are not being touched either way.

- [ ] **Step 1: Script-tally the verdict** (counts only, never quote notes): re-run `pv-compare --pair sdk:agent-sdk-daemon`, record agreement and missed-C against the §6e bar.

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6e, state that the daemon stays available with split readings and that live keeps `"sdk"`, STOP. Complete outcome.

- [ ] **Step 3: If the bar PASSES (and the OPEN QUESTION is answered "proceed") — flip the live pin, WITH the safe fallback.**
In `refiner-cli.ts`: replace the `liveEnv` strip with a `liveEnv` that FORCES `KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon"` (still never mutating `process.env`), call `callModelDerive`, and stamp `transport` AND `model` from its result. The Task 7 chain — daemon → (only on `no-call`) one-shot agent → undefined — IS the live behaviour, and `call-consumed` still means "no gauge file this turn", which is already an ordinary M0 miss on this path.

**Update these THREE pre-existing live-path assertions (declared exception #2) — a `toBe("sdk")` grep alone finds two of them, so use both patterns:**
`grep -rn 'transport).toBe("sdk")' cc-gate-plugin/test/` AND `grep -rn 'transport === "sdk"' cc-gate-plugin/test/`.
  1. `test/gauge-refiner-cli.test.ts:56-86` — the default-path E2E. It asserts `gauge.transport === "sdk"`, `srv.captured.length === 1` and `body.output_config.format.type`. Post-flip the live path no longer uses the API-SDK lane at all. Repoint it: force `KKAMAK_ACP_SOCKET` to a dead path so the record takes the `no-call` fallback, assert `gauge.transport === "agent-sdk"`, and move the `output_config` assertion onto a `KKAMAK_GAUGE_TRANSPORT=sdk`-pinned sibling so the incumbent lane keeps direct coverage.
  2. `test/gauge-refiner-cli.test.ts:105` — the §6d PIN test. Its new invariant: live selection is `agent-sdk-daemon`, env-independent (an adversarial `KKAMAK_GAUGE_TRANSPORT=sdk` must NOT reroute it), and with a dead daemon socket the record is stamped `"agent-sdk"` (fallback proof, stub-only, no spend).
  3. `test/gauge-wiring.test.ts:102` — the hook→detached-refiner E2E. Same treatment as (1).
**Every one of these MUST set `KKAMAK_ACP_SOCKET` to a guaranteed-dead temp path.** Left unset they resolve to `~/.config/kkamak/acp.sock`, which the Task 8 hook makes likely to be LIVE on a dev host — the assertions would then flap between `agent-sdk` and `agent-sdk-daemon` depending on whether a daemon happened to be up.

Also: `test/corpus-replay.test.ts:86` and `:170` (`.every(...)`-shaped) assert `"sdk"` on the DEFAULT env and are unaffected — `selectTransport({})` still returns `"sdk"`. Verify, do not edit.

Log the boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` in the flip commit, and note that `KKAMAK_GAUGE_TRANSPORT=sdk`… does NOT roll this back (the live path forces its own value): the rollback is reverting the flip commit, and that must be written into the ledger row.

- [ ] **Step 4: Full suite green, commit:**

```bash
cd cc-gate-plugin && bun test && bunx tsc --noEmit
cd .. && bun scripts/doc-check.ts
git add cc-gate-plugin/src/gauge/refiner-cli.ts cc-gate-plugin/test/gauge-refiner-cli.test.ts cc-gate-plugin/test/gauge-wiring.test.ts docs/2026-08-01-gauntlet-adoption-ledger.md docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "feat(gauge): live derive flips to agent-sdk-daemon (6e bar pass, boundary ts logged)"
```

---

## Post-plan (recorded so the executor does not invent it)

1. **Branch + merge**: one branch `acp-warm-daemon`; per-task reviews; final fresh-context whole-branch review; merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md` carrying the 5 required fields (reviewed-range/reviewed-commit, reviewer, fresh-context, verdict ∈ approved|fix-first|blocked, findings-count). The 7b gate is ARMED — plain `git merge` bypasses the floor and this merge is a §6 ledger row.
2. **Ordering**: Task 1 must land before any code. Task 9's shadow-store preservation (Step 1) must land before any `pv-sample --reset`.
3. **Boundary ts obligations**: one when the first `agent-sdk-daemon` derive runs against a REAL store (§6d Deploy clause, batch opt-in), one at the live flip (§6e). They are separate rows.
4. **Not in scope**: `cls-ab.ts` and `channel-run.ts`. `cls-run` is pinned to `"sdk"` by its own `liveEnv` strip (`cls-ab.ts:746`) and stamps `ClsArmRow.transport: "sdk"` unconditionally; `channel-run.ts` calls `sdkCall` directly and is never env-routed. Neither is touched. `cls-ab.ts`'s `transportTally` miscount is re-recorded in §6e, not fixed here.
5. **Host-local artifacts that do NOT travel**: `~/.config/kkamak/acp.sock`, `acp-spawn.lock`, `.km/gauge-corpus-shadow/`, the §6d shadow copy under `/mnt/d/tmp/`. Only `docs/gauge-pv/*.json` counts travel.

## Self-Review Notes (kept in-plan deliberately)

- **Type-consistency check, re-run after revision.** `GAUGE_TRANSPORTS`/`GaugeTransport` (T3) → consumed by T7/T9. `TurnOutcome` + `WarmSession.oneShot(text, model, {recycle})`/`isWarm`/`turnInFlight`/`idleMs`/`close` (T4) → consumed by T5. `socketPath`/`ensureSocketDir` (T5) → consumed by T6. `ACP_ERR_NO_CALL`/`ACP_ERR_CALL_CONSUMED`/`AcpPromptParams._meta.model`/`AcpPromptResult._meta` (T2) → produced by T5, consumed by T6. `DaemonOutcome`/`daemonCall`/`ensureDaemon`/`DAEMON_LEG_MS`/`buildAgentOutgoingText` (T6) → consumed by T7/T8. `DeriveCallResult`/`callModelDerive` (T7) → consumed by T10. The three outcome kinds (`ok`/`no-call`/`call-consumed`) use identical spellings in T4, T2's error codes, T6's type and T7's branching.
- The §6e call-consumption rule is the plan's structural core: it is stated in the spec text, encoded in the wire (two distinct error codes), produced by `WarmSession`, mirrored by `daemonCall`, and enforced by `callModelDerive` — with a test at each layer, including the one that asserts the one-shot endpoint receives ZERO requests after a `call-consumed`.
- The Task 4 skeleton is now the design, not a sketch: the persistent pump exists because `Query` is an AsyncGenerator whose `.return()` fires on any early loop exit, and the pushable queue exists because a single re-armed resolver drops the second of two same-tick pushes. Both defects are covered by tests that a wrong implementation cannot pass.
- `/clear`-emits-no-result and one-call-per-record are 2026-08-03 indicative measurements, re-locked by Task 4's request-count and `messages[]`-length assertions rather than trusted. Every stub in this plan is SSE-shaped; a JSON-bodied stub silently doubles the observed call count.
- **Architect review 1 (31 findings: 7 critical, 16 important, 8 minor) applied in full.** The load-bearing ones: the fail-open fallback could spend a second model call per record (now split zero-call vs consumed-call at every layer); §6e contradicted a registered user BINDING (now carries the verbatim 2026-08-04 supersession rulings); the SessionStart hook would have failed `packaging.test.ts:64` (now routed through `hook-cli.ts`); the `WarmSession` skeleton killed its own Query after one turn and dropped every second same-tick push; the daemon would have silently substituted its own model and env, making the record's `model` stamp a lie; the daemon lane would have sent a different prompt than the §6d-validated lane (shared builder now exported); and an interrupted turn returned truncated text as a derivation.
