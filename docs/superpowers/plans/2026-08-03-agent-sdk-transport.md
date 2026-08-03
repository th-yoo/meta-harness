# Agent SDK Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@anthropic-ai/claude-agent-sdk` as a THIRD selectable gauge
transport (`transport: "agent-sdk"`) alongside the existing `"cli"` and
`"sdk"`, measure it against the incumbent with the existing paired-validation
machinery, and only then decide whether it replaces the API SDK for
premium-model work.

**Architecture:** The Agent SDK is not dropped in as a replacement — it is
added as a peer behind the existing transport seam, selected by env var, and
stamped into every record it produces. That keeps the swap reversible, keeps
pre/post records separable in every reading (the §6c split rule), and makes
"replace" a decision the measurement earns rather than an assumption the code
bakes in. The verification order is fixed: instrument the transport → prove
call-count semantics → run paired validation against a pre-registered bar →
then, and only then, flip the default.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (bundles a
native Claude Code binary), existing gauge modules (`transport.ts`,
`paired-validation.ts`, `corpus-replay.ts`), bun:test with a local HTTP stub.

## Global Constraints

- **This is an instrument change.** §6c precedent is binding: pre-data
  amendment + boundary ts in the gauntlet ledger at deploy + per-transport
  split reporting until a pooling bar passes.
- **The amendment window is OPEN but closing.** cls-ab is at 0 labels; the
  moment the first label lands, its constants freeze. Task 1 must land before
  any cls-ab label run.
- **Explicit sized go before spend.** Every task below is buildable and
  testable with ZERO model calls (local HTTP stub). The paired-validation run
  in Task 8 is real spend and needs its own sized go.
- **F1**: `core/` is a MECHANISM_PATH — never edited. All work in
  `cc-gate-plugin/src/gauge/` + `types.ts` + `package.json`.
- **F2**: no sampled prompt text in committed artifacts; counts only.
- **Never remove the `"sdk"` path.** This plan adds a peer and changes a
  default at most. Rollback must always be one env var.
- **Measured facts this plan is built on** (wire capture 2026-08-03, recorded
  in `docs/resume.md`): with `systemPrompt: ""`, `settingSources: []`,
  `tools: []`, `title` supplied, the Agent SDK sends 1 tool
  (`StructuredOutput`, which is how schemas are enforced — `output_config` is
  absent by design), 2 harness system blocks that cannot be configured away,
  and wraps the user turn with ~200 chars of `<system-reminder>` including the
  account email and date.
- **Two questions are OPEN and this plan answers them in order**: (1) does one
  `query()` make exactly one model call? (2) does the residual harness context
  change classifications versus the API SDK?

---

### Task 1: Pre-data amendment (doc only, no code, must land first)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md` (append a `## 6d.` section after the existing `## 6c.` — match that heading style)

**Interfaces:**
- Produces: the constants Tasks 5–9 cite verbatim — the transport literal
  `"agent-sdk"`, the pooling bar, and the call-count rule.

- [ ] **Step 1: Append §6d** with exactly this content (constants are the
  §6c bar reused deliberately — a new bar invented for a second transport
  would not be comparable to the first):

```markdown
## 6d. Amendment (pre-data, 2026-08-03): third derive transport → Agent SDK

**What changes.** A third derive transport, `transport: "agent-sdk"`, using
`@anthropic-ai/claude-agent-sdk`. Selected per process by
`KKAMAK_GAUGE_TRANSPORT=agent-sdk`; absent or any other value keeps the
current `"sdk"` path byte-for-byte. The `"cli"` and `"sdk"` literals and
their records are untouched.

**Why a third transport rather than a replacement.** The subscription premium
quota is per model tier (measured 2026-08-03: haiku OK, sonnet/opus 429 on the
same token in the same second), and Agent-SDK traffic bills a separate
Agent-SDK credit rather than the premium tier. If the bar below passes, this
buys premium-model instrument work without an API key. If it fails, we keep
the incumbent and lose nothing.

**Known, accepted differences (measured on the wire, not inferred).** The
Agent SDK sends 2 harness system blocks that `systemPrompt: ""` does not
remove, enforces schemas via a forced `StructuredOutput` tool rather than
`output_config`, and wraps the user turn with ~200 characters of
`<system-reminder>` context. These are exactly what the bar below is measuring
the effect of — they are not defects to be argued about in advance.

**Call-count rule (binding).** §4's exactly-one-model-call-per-record rule
holds for this transport too. Task 4 measures calls per `query()` against a
stub; if a single classification query cannot be made to issue exactly one
model call, this transport is REJECTED for batch use and the plan stops at
Task 4. The cost fence sizes `--go N` against N records and must keep meaning
N calls.

**Pooling bar (reused verbatim from §6c, evaluated on combined counts).**
- Positive agreement on C: `|C_sdk ∩ C_agent| / |C_sdk ∪ C_agent| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk"` calls not-C,
  `<= ceil(0.10 × |C_sdk|)`.
Both hold → the transports may be pooled in one reading, split still reported.
Either fails → readings stay split by transport for the life of the window,
and `"agent-sdk"` does NOT become the default.

**Expected outcome stated up front.** The CLI→SDK paired validation on
`yoo-dev` came back SPLIT (0.625 agreement, missed-C 6 > cap 2). The Agent SDK
is CLI-family (it drives the bundled `claude` binary), so a SPLIT result here
is the likely outcome, not a surprise. Split is the default; pooling is the
exception to be earned.

**Deploy.** Boundary ts logged in `docs/2026-08-01-gauntlet-adoption-ledger.md`
at the moment the default flips, per §6b/§6c precedent — required because
behaviour changes while `pluginVersion` does not.

**Known reporting gap, acknowledged not fixed.** `cls-ab.ts`'s
`transportTally` (lines ~375-380) buckets records as `if (transport === "sdk")
sdk++ else cli++`, so any `"agent-sdk"` record it ever sees is counted as CLI.
That is a display miscount in the classifier A/B report, not a
transport-selection defect, and `cls-ab.ts` is out of scope for this
amendment. Recorded here so a later reader does not mistake it for a fresh
bug; fix it when cls-ab is next opened.

**What would falsify this change.** If the bar passes but Agent-SDK
derivations cost more wall-clock per record than the API SDK without buying
premium access (e.g. the credit is exhausted), the transport is retained as
selectable but not defaulted.
```

- [ ] **Step 2: Verify no dead links**

Run: `bun scripts/doc-check.ts`
Expected: `doc-check: OK — <N> tracked file(s), 0 violations`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "docs(spec): register §6d agent-sdk transport (pre-data)"
```

### Task 2: Widen the transport literal to three values

**Files:**
- Modify: `cc-gate-plugin/src/types.ts:162`
- Modify: `cc-gate-plugin/src/gauge/files.ts:46`
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (create)

**Interfaces:**
- Produces: `type GaugeTransport = "cli" | "sdk" | "agent-sdk"` exported from
  `cc-gate-plugin/src/types.ts`; both existing `transport?:` fields reference
  it instead of restating a literal union.

- [ ] **Step 1: Write the failing test**

```typescript
// cc-gate-plugin/test/gauge-agent-transport.test.ts
import { describe, test, expect } from "bun:test"
import { GAUGE_TRANSPORTS } from "../src/types.ts"

describe("GaugeTransport", () => {
  test("three transports are recognized, incumbent order preserved", () => {
    expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk"])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: FAIL — `Export named 'GAUGE_TRANSPORTS' not found`

- [ ] **Step 3: Minimal implementation**

In `cc-gate-plugin/src/types.ts`, replace the inline union at line 162 and add
the exported constant above it:

```typescript
/** §6d: a third transport joins the §6c pair. Order is incumbent-first so
 * existing readings that sort by this array do not reshuffle. */
export const GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk"] as const
export type GaugeTransport = (typeof GAUGE_TRANSPORTS)[number]
```

Then change the field at line 162 to `transport?: GaugeTransport`, and in
`cc-gate-plugin/src/gauge/files.ts:46` change `transport?: "cli" | "sdk"` to
`transport?: GaugeTransport` with `import type { GaugeTransport } from "../types.ts"`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — expect 0 fail (821+ tests).
Run: `cd cc-gate-plugin && bunx tsc --noEmit` — expect clean. Any existing
site that assigned `"sdk"` still typechecks; nothing else should change.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/src/gauge/files.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): widen transport literal to include agent-sdk"
```

### Task 3: Transport selection from env (pure, no SDK yet)

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (append near `resolveModelId`)
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (append)

**Interfaces:**
- Consumes: `GaugeTransport`, `GAUGE_TRANSPORTS` (Task 2).
- Produces: `selectTransport(env: Record<string, string | undefined>): GaugeTransport`
  — returns `"agent-sdk"` iff `env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk"`,
  otherwise `"sdk"`. Never returns `"cli"`: that transport is retired and only
  survives as a label on historical records.

- [ ] **Step 1: Write the failing test**

```typescript
describe("selectTransport", () => {
  test("defaults to sdk when unset, empty, or unrecognized", () => {
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "" })).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "nonsense" })).toBe("sdk")
  })
  test("selects agent-sdk only on the exact literal", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
  })
  test("never selects the retired cli transport", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })).toBe("sdk")
  })
})
```

Add a NEW import line — Task 2's test file imports only from `../src/types.ts`, so there is no transport.ts import to extend:
`import { selectTransport } from "../src/gauge/transport.ts"`

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: FAIL — `Export named 'selectTransport' not found`

- [ ] **Step 3: Minimal implementation**

```typescript
import type { GaugeTransport } from "../types.ts"

/** §6d transport selection. Fail-safe by construction: anything other than
 * the exact string "agent-sdk" keeps the incumbent SDK path, so a typo in an
 * env var can never silently retarget an instrument run. "cli" is retired and
 * deliberately not selectable. */
export function selectTransport(env: Record<string, string | undefined>): GaugeTransport {
  return env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk" ? "agent-sdk" : "sdk"
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): env-selected transport, defaults to incumbent sdk"
```

### Task 4: `agentSdkCall` + the binding call-count measurement

**Files:**
- Modify: `cc-gate-plugin/package.json` (add dependency)
- Create: `cc-gate-plugin/src/gauge/agent-transport.ts`
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks except `GaugeTransport`.
- Produces: `agentSdkCall(messageText: string, model: string, env: Record<string, string | undefined>, opts?: { schema?: Record<string, unknown>; maxTokens?: number; timeoutMs?: number }): Promise<string | undefined>`
  — same signature shape and same fail-open contract as `sdkCall` in
  `transport.ts` (undefined on ANY failure, never throws), so call sites can
  switch between them without other changes.

**This task carries the plan's stop condition.** If the call-count test in
Step 5 shows more than one model call per query and no option removes the
extra, STOP: report to the user, do not proceed to Tasks 5–7.

- [ ] **Step 1: Add the dependency**

```bash
cd cc-gate-plugin && bun add @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Write the failing test** — reuse the repo's existing stub
  helper `cc-gate-plugin/test/sdk-stub.ts` (`stubServer`, which binds
  `port: 0` so parallel test files cannot collide). Do NOT hand-roll a second
  HTTP stub on a fixed port.

```typescript
// NOTE: Tasks 2/3/4 all append to this same file. Do NOT re-import bun:test —
// extend Task 2's existing line to `import { describe, test, expect, afterAll }`.
import { stubServer } from "./sdk-stub.ts"
import { agentSdkCall } from "../src/gauge/agent-transport.ts"

const CAPTURED: Array<Record<string, unknown>> = []
// sdk-stub.ts's Captured.body is ALREADY `Record<string, unknown>` (it does
// `await req.json()`), and the stub exposes `stop`, not `close`. Do not
// re-parse or re-cast it.
const stub = stubServer((captured) => {
  CAPTURED.push(captured.body)
  return Response.json({
    id: "msg_stub", type: "message", role: "assistant", model: "stub",
    content: [{ type: "text", text: '{"channel":"C4","reason":null}' }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
})
afterAll(() => stub.stop())

// The spawned CLI reads ANTHROPIC_BASE_URL from its own environment. Read
// sdk-stub.ts for the exact field exposing the bound URL (it binds port 0, so
// the port is only known at runtime) and use that value here.
const STUB_ENV = { ...process.env, ANTHROPIC_BASE_URL: stub.url }

describe("agentSdkCall", () => {
  test("sends our prompt verbatim, with the schema tool and no built-in tools", async () => {
    CAPTURED.length = 0
    await agentSdkCall("PROBE BODY MARKER", "claude-haiku-4-5", STUB_ENV, {
      schema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"], additionalProperties: false },
    })
    expect(CAPTURED.length).toBeGreaterThan(0)
    const req = CAPTURED[0] as { tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> }
    expect(JSON.stringify(req.messages)).toContain("PROBE BODY MARKER")
    // tools: [] must drop every built-in; only the schema tool may remain
    const names = (req.tools ?? []).map((t) => t.name)
    expect(names.filter((n) => n !== "StructuredOutput")).toEqual([])
  })

  test("BINDING (§6d call-count rule): exactly one model call per query", async () => {
    CAPTURED.length = 0
    await agentSdkCall("SINGLE CALL CHECK", "claude-haiku-4-5", STUB_ENV, {
      schema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"], additionalProperties: false },
    })
    expect(CAPTURED.length).toBe(1)
  })

  test("fail-open: unreachable endpoint resolves undefined, never throws", async () => {
    const r = await agentSdkCall("x", "claude-haiku-4-5", {
      ...STUB_ENV, ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    })
    expect(r).toBeUndefined()
  })

  test("timeout aborts and resolves undefined (never hangs the batch)", async () => {
    // A stub that accepts the connection and never answers is the only way to
    // prove the abort path; without it a hung query would hang this test too,
    // which is exactly the production failure being guarded against.
    const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      const started = Date.now()
      const r = await agentSdkCall("x", "claude-haiku-4-5",
        { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${silent.port}` },
        { timeoutMs: 2000 })
      expect(r).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      silent.stop(true)
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: FAIL — `Cannot find module '../src/gauge/agent-transport.ts'`

- [ ] **Step 4: Minimal implementation**

```typescript
// cc-gate-plugin/src/gauge/agent-transport.ts
// §6d Agent-SDK transport. Peer of transport.ts's sdkCall, same contract:
// one classification in, model text out, undefined on ANY failure.
//
// Option choices are load-bearing and were established by wire capture
// (2026-08-03) rather than by reading prose docs:
//  · `tools: []`      drops built-in tool DEFINITIONS. `allowedTools: []` is
//                     only a permission filter and leaves 29 definitions on
//                     the request — do not substitute it.
//  · `title`          supplied so the SDK does not spend extra model calls
//                     auto-generating a session title.
//  · `systemPrompt: ""` minimizes, but does NOT empty, the system blocks: an
//                     `x-anthropic-billing-header` line and an agent-identity
//                     line survive. That residue is what §6d's bar measures.
//  · `settingSources: []` keeps CLAUDE.md and user/project settings out.
//  · schema arrives via `outputFormat`, enforced by a forced StructuredOutput
//                     tool — `output_config` is absent by design here.
import { query } from "@anthropic-ai/claude-agent-sdk"

export interface AgentSdkOptions {
  schema?: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
}

const CALL_TIMEOUT_MS = 60_000

export async function agentSdkCall(
  messageText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: AgentSdkOptions = {},
): Promise<string | undefined> {
  // The timeout MUST be able to cancel the query. `query()` exposes
  // `abortController` for exactly this; a bare setTimeout cannot interrupt a
  // `for await` and would let one stalled call hang an entire fenced batch.
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), opts.timeoutMs ?? CALL_TIMEOUT_MS)
  try {
    // `env` REPLACES the subprocess environment (sdk.d.ts: "this value
    // REPLACES the subprocess environment entirely — it is not merged"), so
    // callers must pass a FULL env. Undefined-valued keys are dropped rather
    // than cast away, so the subprocess never receives "undefined" strings.
    const subprocessEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined) subprocessEnv[k] = v

    const it = query({
      prompt: messageText,
      options: {
        model,
        systemPrompt: "",
        settingSources: [],
        tools: [],
        title: "kkamak-gauge",
        maxTurns: 1,
        abortController: controller,
        env: subprocessEnv,
        ...(opts.schema ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } } : {}),
      },
    })
    for await (const m of it) {
      if (m.type === "result") {
        const structured = (m as { structured_output?: unknown }).structured_output
        if (structured !== undefined) return JSON.stringify(structured)
        const text = (m as { result?: unknown }).result
        return typeof text === "string" ? text : undefined
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(deadline)
  }
}
```

**Auth note (verify during Step 5, do not assume).** `sdkCall` in
`transport.ts` reads the OAuth token explicitly via `readAuthToken` and passes
it as `authToken`. `agentSdkCall` does NOT — the spawned CLI resolves its own
credentials, most likely from `~/.claude/.credentials.json` or the keychain.
That means `KKAMAK_GAUGE_AUTH_TOKEN` has no effect here, and the stub test's
hermeticity depends on the CLI reaching the stubbed `ANTHROPIC_BASE_URL`
rather than on an injected token. Step 5 checks this empirically.

- [ ] **Step 5: Run the tests — THIS IS THE STOP GATE**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: all pass, including `exactly one model call per query`.

Two distinct failure branches, each with its own diagnosis — do not conflate
them:

- **`CAPTURED.length === 0`** (the stub was never reached): the spawned CLI
  did not route to `ANTHROPIC_BASE_URL`, or it refused before sending
  anything (no credentials on this host). Check whether the CLI honours
  `ANTHROPIC_BASE_URL` from `options.env`, and whether it needs on-disk
  credentials to get that far. If the test can only pass on a host with live
  credentials, say so explicitly in the test file — a test whose hermeticity
  depends on ambient auth must not silently claim to be hermetic.
- **`CAPTURED.length > 1`**: read
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and grep the option
  names for something that suppresses the extra call — do not guess from
  prose. (Precedent: `tools: []` vs `allowedTools: []`, and the `title`
  option, were both found this way after guessing produced wrong verdicts.)
  If no such option exists, STOP the plan here, report the measured count,
  and record it in §6d as the rejection reason. Do not continue to Task 5.

- [ ] **Step 6: Commit**

```bash
git add cc-gate-plugin/package.json cc-gate-plugin/bun.lock cc-gate-plugin/src/gauge/agent-transport.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): agentSdkCall transport + binding call-count proof"
```

### Task 5: Wire the seam into the deriver and stamp provenance

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (`callModelSdk` dispatch)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts:75` (transport stamp)
- Modify: `cc-gate-plugin/src/gauge/refiner-cli.ts:68` (transport stamp — THE
  LIVE PATH: this detached child is what the real gate hook spawns, and it
  calls the same `callModelSdk`. Leaving its hardcoded `transport: "sdk"`
  means that the moment Task 9 flips the default, every LIVE derivation runs
  on agent-sdk while its persisted record still claims "sdk" — silently
  falsifying the split rule this whole plan rests on.)
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (append)

**Interfaces:**
- Consumes: `selectTransport` (Task 3), `agentSdkCall` (Task 4).
- Produces: `callModelSdk` routes by `selectTransport(env)`; derive records
  carry `transport: "agent-sdk"` when that path ran.

- [ ] **Step 1: Write the failing test — BEHAVIORAL, not a source grep**

A source-text assertion would pass on cosmetic rewording and would also pass
if the `transport.ts` dispatch were miswired. Drive the real `deriveRecord`
against two stubs and assert on both the stamp AND which endpoint received the
request. Note `deriveRecord` reads `process.env` directly
(`corpus-replay.ts:43`), so the env var must be set on `process.env` and
restored afterwards.

Three things this test MUST get right, each verified against the real code:
`stubServerFor(derivation)` (not bare `stubServer`) wraps the payload in a
proper Anthropic message envelope — `sdkCall` iterates `response.content` and
a bare `Response.json(derivation)` makes it throw into its own swallow, so the
record would come back underived. `KKAMAK_GAUGE_AUTH_TOKEN` must be set, or
`readAuthToken` returns undefined and NO request is ever sent (see
`withSdkStub`, `test/corpus-replay.test.ts:51-65`). And the stub exposes
`stop()`, not `close()`.

```typescript
import { deriveRecord } from "../src/gauge/corpus-replay.ts"
import { stubServerFor } from "./sdk-stub.ts"
import type { CorpusRecord } from "../src/gauge/corpus-store.ts"
// Copy the `rec(over: Partial<CorpusRecord> = {})` builder from
// test/corpus-replay.test.ts:21-34 (or export it from a shared test helper);
// do not hand-roll a partial literal.

const STUB_DERIVATION = {
  goalSummary: "summarize x", class: "A2", reason: "not-shell-checkable",
  criteria: ["a summary of x exists"], check: null, horizon: null, confidence: 0.9,
}
// CorpusRecord (corpus-store.ts:85-99) requires provenance, repo, sessionId,
// promptTs, promptSha256, floorCheck, floorCheckMinedAt in addition to
// prompt/stage — a bare `as CorpusRecord` on a 2-field literal is TS2352.
// Reuse the established builder idiom from test/corpus-replay.test.ts:21-34,
// which spreads full defaults and takes a Partial override.
const minedRecord = (prompt: string): CorpusRecord => rec({ prompt, stage: "mined" })

/** Both cases share this scaffolding; only the env var and the expectations
 * differ. Restores every env key it touches. */
async function routeCase(transport: string | undefined) {
  const sdkStub = stubServerFor(STUB_DERIVATION)
  const agentStub = stubServerFor(STUB_DERIVATION)
  const prev = {
    t: process.env.KKAMAK_GAUGE_TRANSPORT,
    sdk: process.env.KKAMAK_GAUGE_SDK_BASE_URL,
    anth: process.env.ANTHROPIC_BASE_URL,
    tok: process.env.KKAMAK_GAUGE_AUTH_TOKEN,
  }
  if (transport === undefined) delete process.env.KKAMAK_GAUGE_TRANSPORT
  else process.env.KKAMAK_GAUGE_TRANSPORT = transport
  process.env.KKAMAK_GAUGE_SDK_BASE_URL = sdkStub.url
  process.env.ANTHROPIC_BASE_URL = agentStub.url
  process.env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-test"
  try {
    const out = await deriveRecord(minedRecord("write a summary of x"))
    return { out, sdkHits: sdkStub.captured.length, agentHits: agentStub.captured.length }
  } finally {
    for (const [k, v] of [
      ["KKAMAK_GAUGE_TRANSPORT", prev.t], ["KKAMAK_GAUGE_SDK_BASE_URL", prev.sdk],
      ["ANTHROPIC_BASE_URL", prev.anth], ["KKAMAK_GAUGE_AUTH_TOKEN", prev.tok],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    sdkStub.stop(); agentStub.stop()
  }
}

describe("derive routes and stamps by selected transport (§6d split rule)", () => {
  test("default: API SDK endpoint is hit, record stamped sdk", async () => {
    const { out, sdkHits, agentHits } = await routeCase(undefined)
    expect(out?.derivation?.transport).toBe("sdk")
    expect(sdkHits).toBeGreaterThan(0)
    expect(agentHits).toBe(0)
  })

  test("KKAMAK_GAUGE_TRANSPORT=agent-sdk: agent endpoint is hit, record stamped agent-sdk", async () => {
    const { out, sdkHits, agentHits } = await routeCase("agent-sdk")
    expect(out?.derivation?.transport).toBe("agent-sdk")
    expect(agentHits).toBeGreaterThan(0)
    expect(sdkHits).toBe(0)
  })
})
```

Check `stubServerFor`'s real signature before use — if it takes the derivation
and builds the envelope itself, the code above is correct as written; if it
needs `okResponse(JSON.stringify(...))`, follow whatever
`test/corpus-replay.test.ts:69` does, which is the established sibling.

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: FAIL — the agent-sdk case stamps `"sdk"` and hits the SDK stub,
because `corpus-replay.ts:75` still hardcodes the literal.

- [ ] **Step 3: Implementation**

In `transport.ts`, inside `callModelSdk`, before building the request:

```typescript
  if (selectTransport(env) === "agent-sdk") {
    return agentSdkCall(messageText, model, env, {
      schema: DERIVATION_SCHEMA as unknown as Record<string, unknown>,
    })
  }
```

In `corpus-replay.ts:75` AND in `refiner-cli.ts:68`, replace the hardcoded
`transport: "sdk",` with `transport: selectTransport(process.env),` and import
`selectTransport` in both. Grep-verify afterwards that no `transport: "sdk"`
literal survives outside `cls-ab.ts` (which is out of scope):
`grep -rn 'transport: "sdk"' cc-gate-plugin/src/` should return only cls-ab.ts.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Run the incumbent-path proof: `KKAMAK_GAUGE_TRANSPORT= bun test` — identical
result, proving the default path is untouched.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): route derive through selected transport, stamp provenance"
```

### Task 6: Make the paired-validation machinery pair ANY two transports

**Why this task is bigger than it looks (architect reviews 1 and 2).** The
existing pv tooling is hardcoded to the CLI-vs-SDK pairing in FOUR places, and
none of them takes a parameter. Missing the fourth is what made review 2's
finding 1 a repeat of review 1's blocker — an appended optional parameter
silently leaves every untouched caller on the old default forever:
- `stratify` (paired-validation.ts:66-75) calls `isCliDerived(r)` internally.
- `runPvSample` (paired-validation.ts:151-158) calls `stratify`; its
  empty-sample message (line 160) says "no CLI-derived class-C records".
- `comparePvRecords` (paired-validation.ts:339) hardcodes
  `if (shadow.derivation.transport !== "sdk" || !isCliDerived(real))` →
  `wrongTransport`.
- **`runPvCompare` (paired-validation.ts:631-783) — THE ACTUAL CLI ENTRY
  POINT** (wired at `replay-cli.ts:577`). It calls
  `comparePvRecords(manifest, realRecords, shadowRecords)` with three
  arguments at line 735 and builds `PvCountsFile` at 738-744. Parameterizing
  the first three functions and not this one means `pv-compare --pair
  sdk:agent-sdk` still runs the §6c default, every shadow record lands in
  `wrongTransport`, and `evaluatePvBar` returns NOT-EVALUATED — the exact
  guaranteed-non-result-on-real-spend failure this task exists to prevent.

An `agent-sdk` shadow run therefore lands EVERY record in `wrongTransport`,
and `evaluatePvBar` refuses to evaluate when `wrongTransport > 0` — i.e. the
naive version of this task spends real budget on a guaranteed
NOT-EVALUATED result. Also note `isCliDerived` reads `r.derivation.transport`,
NOT `r.transport`: `CorpusRecord` has no top-level transport field.

**Files:**
- Modify: `cc-gate-plugin/src/gauge/paired-validation.ts` (parameterize the
  three sites above, defaults preserving §6c behaviour byte-for-byte)
- Test: `cc-gate-plugin/test/paired-validation.test.ts` (append)

**Interfaces:**
- Consumes: `CorpusRecord`, `GaugeTransport` (Task 2).
- Produces:
  - `derivedOn(transport: GaugeTransport): (r: CorpusRecord) => boolean` —
    predicate factory reading `r.derivation?.transport`.
  - `stratify(records: CorpusRecord[], isBaseline?: (r: CorpusRecord) => boolean)`
    — third-party callers unchanged; default `isCliDerived`.
  - `runPvSample(cwd, opts, log, rand?, isBaseline?)` — default `isCliDerived`.
  - `comparePvRecords(manifest, realRecords, shadowRecords, pairing?)` where
    `pairing` is `{ baseline: (r: CorpusRecord) => boolean; shadowTransport: GaugeTransport }`,
    defaulting to `{ baseline: isCliDerived, shadowTransport: "sdk" }`.
  - `PvCountsFile` gains `arms?: { baseline: GaugeTransport; shadow: GaugeTransport }`
    — **OPTIONAL, absent meaning `{baseline:"cli", shadow:"sdk"}`**, matching
    this codebase's established absent-means-CLI convention. It MUST NOT be
    required: `docs/gauge-pv/yoo-dev-pv-counts.json` is already committed
    without it (verified: keys are comparedAt/hostname/counts/keys/bar), and
    `test/paired-validation.test.ts:501-519`'s `otherHostFile()` helper — used
    by ~15 existing `--combine` tests — builds these objects without it. A
    required field would fail `tsc` and refuse a real production artifact.
    The `cCli`/`cSdk` field NAMES stay (renaming breaks the same committed
    file); `arms` is what disambiguates them.

- [ ] **Step 1: Write the failing tests**

```typescript
import { derivedOn, stratify, comparePvRecords, isCliDerived } from "../src/gauge/paired-validation.ts"

const rec = (transport: string | undefined, cls: string, prompt: string) =>
  ({ prompt, stage: "derived", derivation: { class: cls, ...(transport ? { transport } : {}) } }) as never

describe("derivedOn (§6d pairing predicate)", () => {
  test("reads derivation.transport, not a top-level field", () => {
    expect(derivedOn("sdk")(rec("sdk", "C", "p1"))).toBe(true)
    expect(derivedOn("sdk")(rec("agent-sdk", "C", "p2"))).toBe(false)
    expect(derivedOn("sdk")(rec(undefined, "C", "p3"))).toBe(false)
    expect(derivedOn("agent-sdk")(rec("agent-sdk", "C", "p4"))).toBe(true)
  })
})

describe("stratify with an injected baseline predicate", () => {
  test("defaults to the §6c CLI baseline (unchanged behaviour)", () => {
    const s = stratify([rec("cli", "C", "a"), rec("sdk", "C", "b")])
    expect(s.c.length).toBe(1)
  })
  test("can stratify the SDK arm instead", () => {
    const s = stratify([rec("cli", "C", "a"), rec("sdk", "C", "b")], derivedOn("sdk"))
    expect(s.c.length).toBe(1)
    expect(s.c[0]!.prompt).toBe("b")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/paired-validation.test.ts`
Expected: FAIL — `Export named 'derivedOn' not found`

- [ ] **Step 3: Implementation**

```typescript
/** §6d: predicate factory for "this record was derived on <transport>".
 * Reads `derivation.transport` — CorpusRecord has no top-level transport
 * field (the §6c `isCliDerived` above reads the same path). */
export function derivedOn(transport: GaugeTransport): (r: CorpusRecord) => boolean {
  return (r) => r.derivation?.transport === transport
}
```

Then change the three hardcoded sites to accept an optional parameter whose
DEFAULT reproduces today's behaviour exactly:

```typescript
export function stratify(
  records: CorpusRecord[],
  isBaseline: (r: CorpusRecord) => boolean = isCliDerived,
): PvStrata {
  // ...body unchanged except `if (!isBaseline(r)) continue`
}

export function runPvSample(
  cwd: string,
  opts: { reset?: boolean },
  log: (m: string) => void,
  rand: () => number = Math.random,
  isBaseline: (r: CorpusRecord) => boolean = isCliDerived,
): PvSampleSummary | undefined {
  const { c, notC } = stratify(readCorpus(cwd), isBaseline)
  // ...rest unchanged
}

export interface PvPairing {
  baseline: (r: CorpusRecord) => boolean
  /** serializable name of the baseline arm — a predicate cannot be written
   * into PvCountsFile.arms, so the label travels alongside it. */
  baselineLabel: GaugeTransport
  shadowTransport: GaugeTransport
}

/** The §6c pairing, used as the default everywhere so existing callers and
 * existing records behave byte-for-byte as before. */
const PV_DEFAULT_PAIRING: PvPairing = {
  baseline: isCliDerived,
  baselineLabel: "cli",
  shadowTransport: "sdk",
}

export function comparePvRecords(
  manifest: PvManifest,
  realRecords: CorpusRecord[],
  shadowRecords: CorpusRecord[],
  pairing: PvPairing = PV_DEFAULT_PAIRING,
): PvComparison {
  // ...at line ~339:
  // if (shadow.derivation.transport !== pairing.shadowTransport || !pairing.baseline(real))
}

// THE FOURTH SITE — without this the CLI flag is parsed and then dropped.
// Only three lines of its ~150-line body change; everything else stays.
export function runPvCompare(
  cwd: string,
  opts: { combine?: string; pairing?: PvPairing },   // <- pairing added
  log: (m: string) => void,
): PvCompareSummary | undefined {
  const pairing = opts.pairing ?? PV_DEFAULT_PAIRING          // <- new line
  // ... body unchanged up to line ~735, then:
  const comparison = comparePvRecords(manifest, realRecords, shadowRecords, pairing)
  // ... and the PvCountsFile literal at ~738-744 gains one field:
  //   arms: { baseline: pairing.baselineLabel, shadow: pairing.shadowTransport },
  // ... and the renderPvReport call passes that same arms object (§3b).
}
```

All four sites take `PV_DEFAULT_PAIRING` as their default, so `stratify`'s
`isBaseline` parameter is `pairing.baseline`'s counterpart — keep `stratify`
taking a bare predicate (it needs nothing else) and the other three taking the
whole `PvPairing`.

- [ ] **Step 3b: De-CLI the operator-facing strings**

Two messages hardcode "CLI" and would mislabel any non-`cli:sdk` run:
`runPvSample`'s empty-sample log (paired-validation.ts:160, "no CLI-derived
class-C records") and `renderPvReport`'s banner (lines 566-567,
"pv-compare — CLI-vs-SDK transport comparison"). Make both name the actual
arms, e.g. `no ${baselineLabel}-derived class-C records` and
`pv-compare — ${baselineLabel}-vs-${shadowTransport} transport comparison`.
This requires the label to reach both functions. `runPvSample` takes it from
its pairing argument. `renderPvReport(manifest, c: PvCounts, bar)` has NO
access to it — `arms` lives on the outer `PvCountsFile`, not on `PvCounts` —
so give it a fourth parameter `arms: { baseline: GaugeTransport; shadow:
GaugeTransport }` defaulting to `{baseline:"cli", shadow:"sdk"}`, and pass it
from `runPvCompare`.

- [ ] **Step 4: Run to verify they pass, and that §6c is untouched**

Run: `cd cc-gate-plugin && bun test` — 0 fail. Every pre-existing
paired-validation test must pass WITHOUT modification; if any needed editing,
the defaults are wrong — fix the defaults, not the tests.
Run: `bunx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/paired-validation.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): parameterize pv pairing, defaults preserve §6c"
```

### Task 7: CLI wiring for an agent-sdk pv run (still no spend)

**Files:**
- Modify: `cc-gate-plugin/src/gauge/replay-cli.ts` (pv-sample / pv-compare arg parsing)
- Test: `cc-gate-plugin/test/paired-validation.test.ts` (append)

**Interfaces:**
- Consumes: `derivedOn`, `PvPairing` (Task 6), `GAUGE_TRANSPORTS` (Task 2).
- Produces: `--pair <baseline>:<shadow>` on both `pv-sample` and `pv-compare`,
  e.g. `--pair sdk:agent-sdk`. Absent → the §6c default (`cli:sdk`).
  `parsePairFlag(args: string[]): PvPairing | undefined` exported from
  `paired-validation.ts`; returns undefined for a malformed or unknown pair
  (caller then refuses rather than silently defaulting — a typo must not
  produce a §6c run labelled as §6d).

- [ ] **Step 1: Write the failing test**

```typescript
describe("parsePairFlag", () => {
  test("parses a valid pair", () => {
    const p = parsePairFlag(["--pair", "sdk:agent-sdk"])!
    expect(p.shadowTransport).toBe("agent-sdk")
    expect(p.baseline({ derivation: { transport: "sdk", class: "C" } } as never)).toBe(true)
  })
  test("absent flag yields undefined (caller applies the §6c default)", () => {
    expect(parsePairFlag([])).toBeUndefined()
  })
  test("unknown transports and malformed input yield undefined, never a default", () => {
    expect(parsePairFlag(["--pair", "sdk:nonsense"])).toBeUndefined()
    expect(parsePairFlag(["--pair", "sdk"])).toBeUndefined()
    expect(parsePairFlag(["--pair", ""])).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/paired-validation.test.ts`
Expected: FAIL — `Export named 'parsePairFlag' not found`

- [ ] **Step 3: Implementation**

```typescript
/** `--pair <baseline>:<shadow>`; both must be known transports. Returns
 * undefined on absent OR malformed input — the caller distinguishes those
 * two cases, so a typo can never be silently read as the §6c default. */
export function parsePairFlag(args: string[]): PvPairing | undefined {
  const i = args.indexOf("--pair")
  if (i < 0) return undefined
  const [b, s, ...rest] = (args[i + 1] ?? "").split(":")
  if (rest.length > 0 || !b || !s) return undefined
  if (!GAUGE_TRANSPORTS.includes(b as never) || !GAUGE_TRANSPORTS.includes(s as never)) return undefined
  // "cli" MUST map to isCliDerived, not derivedOn("cli"): the 586 pre-boundary
  // records carry NO transport field and isCliDerived counts absent-as-cli
  // (paired-validation.ts:51-54). A strict-equality predicate would give an
  // explicit `--pair cli:sdk` a silently smaller stratum than the identical
  // run with the flag omitted.
  const baseline = b === "cli" ? isCliDerived : derivedOn(b as GaugeTransport)
  return { baseline, baselineLabel: b as GaugeTransport, shadowTransport: s as GaugeTransport }
}
```

Also extend `parsePvCountsFile` (paired-validation.ts:510-538) to parse `arms`
when present and DEFAULT it to `{baseline:"cli", shadow:"sdk"}` when absent
(never refuse on absence — the committed §6c artifact has no `arms`), and make
the combine path refuse only when two hosts' effective arms DISAGREE — otherwise a `sdk:agent-sdk`
run on one host and a `cli:sdk` run on the other would sum into a single
meaningless combined bar. Fail closed, matching the cls-combine hard-gate
precedent (`cls-ab.ts`, provisional flag).

In `replay-cli.ts`, for both `pv-sample` and `pv-compare`: if `--pair` is
present in argv but `parsePairFlag` returns undefined, print
`REFUSING: --pair <value> is not <baseline>:<shadow> over ${GAUGE_TRANSPORTS.join("|")}`
and exit non-zero. Otherwise pass the parsed pairing (or the §6c default)
through to `runPvSample` / `runPvCompare` (replay-cli.ts:577 calls
`runPvCompare`, never `comparePvRecords` directly), and include
`arms: { baseline, shadow }` in the emitted counts file.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Token-free execute-proof of the refusal path:
`bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:bogus`
→ prints REFUSING, exit non-zero, no store read.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/replay-cli.ts cc-gate-plugin/src/gauge/paired-validation.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): --pair flag for pv-sample/pv-compare"
```

### Task 8: The paired-validation run (REAL SPEND — own sized go)

- [ ] **Step 1: STOP and report before spending**

Report to the user: the shadow-sample size that `pv-sample --pair sdk:agent-sdk`
prints, which model tier the derive will use, and that this is real spend
against the Agent-SDK credit. Do not proceed without an explicit sized go.

- [ ] **Step 2: On a granted go, run the three commands**

```bash
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk
KKAMAK_GAUGE_TRANSPORT=agent-sdk bun cc-gate-plugin/src/gauge/replay-cli.ts derive <shadow-dir> --go <n>
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk
```

- [ ] **Step 3: Sanity-check BEFORE reading the verdict**

`wrongTransport` must be 0. A non-zero count means the shadow derive did not
run on `agent-sdk` (env var not exported into the derive process, or Task 5's
stamp not wired) — fix that and re-run rather than interpreting the numbers.

- [ ] **Step 4: Commit the counts**

Copy to `docs/gauge-pv/<hostname>-sdk-vs-agent-sdk-pv-counts.json` and commit
(F2: counts travel, prompt text does not).

### Task 9: Verdict, and the default only if earned

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md` (§6d outcome)
- Modify: `docs/2026-08-01-gauntlet-adoption-ledger.md` (boundary ts, ONLY on a pass)
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (default flip, ONLY on a pass)

- [ ] **Step 1: Script-tally the verdict** (never quote notes; counts only)

```bash
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk
```

Record positive agreement and missed-C against the §6d bar
(`>= 0.80` and `<= ceil(0.10 × |C_sdk|)`).

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6d, state
  that readings stay split by transport, leave `selectTransport`'s default at
  `"sdk"`, and stop. The transport remains available via env var for anyone who
  needs premium access and accepts split readings. This is a complete,
  successful outcome of the plan.

- [ ] **Step 3: If the bar PASSES** — flip the default in `selectTransport`.
  Write it as an EXPLICIT allow-list, never a two-way ternary — a
  `=== "sdk" ? "sdk" : "agent-sdk"` form would silently map the retired
  `"cli"` value onto a live transport, reversing the invariant Task 3
  established and tested:

```typescript
export function selectTransport(env: Record<string, string | undefined>): GaugeTransport {
  const v = env.KKAMAK_GAUGE_TRANSPORT
  // Post-§6d-flip default. "cli" is retired and stays unselectable: anything
  // that is not one of the two live literals falls through to the default.
  return v === "sdk" || v === "agent-sdk" ? v : "agent-sdk"
}
```

  Then UPDATE and re-run Task 3's tests: the "defaults to sdk" cases become
  "defaults to agent-sdk", while the "never selects cli" case must still hold
  (`selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })` → `"agent-sdk"`, i.e.
  the default — never `"cli"`). Update the doc comment, log a boundary ts in
  the gauntlet ledger with the measured counts, and note that
  `KKAMAK_GAUGE_TRANSPORT=sdk` is the one-env-var rollback.

- [ ] **Step 4: Verify and commit**

```bash
cd cc-gate-plugin && bun test && bunx tsc --noEmit
cd .. && bun scripts/doc-check.ts
git add -A && git commit -m "docs(spec): §6d verdict + transport default"
```

---

## Post-plan (recorded so the executor does not invent it)

1. **Branch + merge**: one branch `agent-sdk-transport`; per-task reviews;
   final fresh-context whole-branch review; merge via
   `scripts/merge-with-gate.sh` with a committed
   `docs/reviews/<short-sha>-agent-sdk-transport.md` (the 7b gate is ARMED —
   plain `git merge` bypasses the floor and this merge is a §6 ledger row).
2. **Ordering**: Task 1 must land before any cls-ab label run, or the
   amendment window closes and this becomes a post-data change.
3. **Not in scope**: touching `cls-ab.ts` or `channel-run.ts` transports. They
   pin `claude-opus-5` deliberately (judgment seat). Route them only after the
   deriver's bar result is known.

## Self-review

- **Spec coverage**: §6d's transport literal → Task 2; selection → Task 3;
  call-count rule → Task 4 (explicit stop gate); provenance/split rule →
  Task 5; pairing machinery → Task 6; pair selection at the CLI → Task 7;
  the measured run → Task 8; pooling bar + boundary ts → Task 9.
- **Placeholder scan**: none. Every step carries real code or an exact command.
  Task 4 Step 5 names two distinct diagnostic branches rather than "handle the
  error"; Task 5's second test is explicitly required to be written out in
  full rather than left as a comment.
- **Type consistency**: `GaugeTransport`, `GAUGE_TRANSPORTS`, `selectTransport`,
  `agentSdkCall`, `AgentSdkOptions`, `derivedOn`, `PvPairing` (with
  `baselineLabel`), `parsePairFlag`, `runPvCompare`'s `opts.pairing` are used
  with identical names and signatures across Tasks 2–9. The earlier
  `isSdkDerived` was REMOVED after review: it read `r.transport`, but
  `CorpusRecord` carries the field at `r.derivation.transport`, so it would
  have returned false for every real record while its `as never` test fixture
  hid the bug from `tsc`.
- **Architect review 3 (10 findings) applied**: `refiner-cli.ts:68` — the
  LIVE derive path, missed by two prior revisions — now stamps the selected
  transport, with a grep-verify step; `PvCountsFile.arms` made OPTIONAL
  (absent = `cli:sdk`) after verifying that requiring it would fail `tsc` on
  ~15 existing tests and REFUSE the already-committed
  `docs/gauge-pv/yoo-dev-pv-counts.json`; one `PvPairing` interface and one
  `PV_DEFAULT_PAIRING` constant replace a duplicated interface and an
  undefined `pairingLabel()`; `minedRecord` uses the sibling's `rec()` builder
  instead of an invalid 2-field cast; the duplicate `bun:test` import removed;
  `renderPvReport` gets `arms` as a parameter rather than reading it off
  `PvCounts` where it does not exist; `runPvCompare`'s threading written out
  concretely; `cls-ab.ts`'s `transportTally` agent-sdk miscount recorded in
  §6d as a known, out-of-scope reporting gap.
- **Architect review 2 (9 findings) applied**: the FOURTH pv call site
  `runPvCompare` — the actual `pv-compare` entry point — is now parameterized,
  which is what would otherwise have reproduced the guaranteed-NOT-EVALUATED
  spend through an unthreaded flag; `PvPairing` gained a serializable
  `baselineLabel` because a predicate cannot be written into the counts file;
  `--pair cli:...` maps to `isCliDerived` (absent-transport records count as
  CLI) rather than strict equality; the stub API calls corrected to `stop()`
  and an already-parsed object `body`; Task 5's test rebuilt on
  `stubServerFor` + `KKAMAK_GAUGE_AUTH_TOKEN` (without either, no request is
  ever sent) and its second case written out in full; CLI-specific operator
  strings de-hardcoded; `arms` validated on `--combine`.
- **Architect review 1 (10 findings) applied in full**: pv machinery
  parameterized rather than assumed reusable (was a guaranteed
  NOT-EVALUATED run on real spend); `abortController` replaces a no-op
  `setTimeout` that could have hung a whole batch; the repo's existing
  `stubServer` (`port: 0`) replaces a hand-rolled fixed-port stub; auth path
  and its effect on test hermeticity stated rather than assumed; the flip
  ternary that would have made `"cli"` selectable replaced by an allow-list.
- **Known risk left in deliberately**: Task 4's call-count test is the plan's
  load-bearing assumption. It is written as a stop gate rather than a hope
  because the earlier wire capture measured a multi-call query and the
  single-call behaviour has not yet been proven against a real endpoint.
