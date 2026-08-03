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
  in Task 6 is real spend and needs its own sized go.
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
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md` (append a §6d section after §6c)

**Interfaces:**
- Produces: the constants Tasks 5–7 cite verbatim — the transport literal
  `"agent-sdk"`, the pooling bar, and the call-count rule.

- [ ] **Step 1: Append §6d** with exactly this content (constants are the
  §6c bar reused deliberately — a new bar invented for a second transport
  would not be comparable to the first):

```markdown
## §6d Agent-SDK transport (registered 2026-08-03, pre-data)

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

Add `selectTransport` to the existing import from `../src/gauge/transport.ts`.

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

- [ ] **Step 2: Write the failing test** (stub server, zero model calls —
  the same interception technique already used by `gauge-transport.test.ts`)

```typescript
import { describe, test, expect, afterAll } from "bun:test"
import http from "node:http"
import { agentSdkCall } from "../src/gauge/agent-transport.ts"

const CAPTURED: Array<Record<string, unknown>> = []
const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    if (req.url?.includes("/v1/messages")) {
      try { CAPTURED.push(JSON.parse(body)) } catch { /* non-JSON probe call */ }
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id: "msg_stub", type: "message", role: "assistant", model: "stub",
      content: [{ type: "text", text: '{"channel":"C4","reason":null}' }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
})
await new Promise<void>((r) => server.listen(4601, "127.0.0.1", () => r()))
afterAll(() => server.close())

const STUB_ENV = {
  ...process.env,
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4601",
  KKAMAK_GAUGE_AUTH_TOKEN: "stub-token",
}

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
  try {
    const it = query({
      prompt: messageText,
      options: {
        model,
        systemPrompt: "",
        settingSources: [],
        tools: [],
        title: "kkamak-gauge",
        maxTurns: 1,
        env: { ...env } as Record<string, string>,
        ...(opts.schema ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } } : {}),
      },
    })
    const deadline = setTimeout(() => { /* abort below via race */ }, opts.timeoutMs ?? CALL_TIMEOUT_MS)
    try {
      for await (const m of it) {
        if (m.type === "result") {
          const structured = (m as { structured_output?: unknown }).structured_output
          if (structured !== undefined) return JSON.stringify(structured)
          const text = (m as { result?: unknown }).result
          return typeof text === "string" ? text : undefined
        }
      }
      return undefined
    } finally {
      clearTimeout(deadline)
    }
  } catch {
    return undefined
  }
}
```

- [ ] **Step 5: Run the tests — THIS IS THE STOP GATE**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: all pass, including `exactly one model call per query`.

If the call-count test fails with a count greater than 1: read
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and search for an
option that suppresses the extra call (grep the option names, do not guess).
If no such option exists, STOP the plan here, report the measured count, and
record it in the §6d section as the rejection reason. Do not continue to
Task 5.

- [ ] **Step 6: Commit**

```bash
git add cc-gate-plugin/package.json cc-gate-plugin/bun.lock cc-gate-plugin/src/gauge/agent-transport.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): agentSdkCall transport + binding call-count proof"
```

### Task 5: Wire the seam into the deriver and stamp provenance

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (`callModelSdk` dispatch)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts:75` (transport stamp)
- Test: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (append)

**Interfaces:**
- Consumes: `selectTransport` (Task 3), `agentSdkCall` (Task 4).
- Produces: `callModelSdk` routes by `selectTransport(env)`; derive records
  carry `transport: "agent-sdk"` when that path ran.

- [ ] **Step 1: Write the failing test**

```typescript
describe("derive transport stamping (§6d split rule)", () => {
  test("stamp follows the selected transport, not a hardcoded literal", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
    expect(selectTransport({})).toBe("sdk")
  })
  test("a record derived under agent-sdk is not counted as sdk", () => {
    const rec = { derivation: { class: "C" }, transport: "agent-sdk" as const }
    expect(rec.transport).not.toBe("sdk")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts`
Expected: FAIL until `selectTransport` is imported in this describe block —
if it already passes because Task 3 exported it, extend the test to assert the
`corpus-replay.ts` stamp is not the literal `"sdk"`:
`expect(await import("../src/gauge/corpus-replay.ts")).toBeDefined()` and grep
the source in the assertion, e.g.
`expect(await Bun.file("src/gauge/corpus-replay.ts").text()).not.toContain('transport: "sdk",')`

- [ ] **Step 3: Implementation**

In `transport.ts`, inside `callModelSdk`, before building the request:

```typescript
  if (selectTransport(env) === "agent-sdk") {
    return agentSdkCall(messageText, model, env, {
      schema: DERIVATION_SCHEMA as unknown as Record<string, unknown>,
    })
  }
```

In `corpus-replay.ts:75`, replace the hardcoded `transport: "sdk",` with
`transport: selectTransport(process.env),` and import `selectTransport`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Run the incumbent-path proof: `KKAMAK_GAUGE_TRANSPORT= bun test` — identical
result, proving the default path is untouched.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): route derive through selected transport, stamp provenance"
```

### Task 6: Paired validation against the §6d bar (REAL SPEND — own go)

**Files:**
- Modify: `cc-gate-plugin/src/gauge/paired-validation.ts` (`isCliDerived` companion)
- Test: `cc-gate-plugin/test/paired-validation.test.ts` (append)

**Interfaces:**
- Consumes: `evaluatePvBar`, `missedCCap`, `comparePvRecords`, `stratify`,
  `runPvSample` — all already exported from `paired-validation.ts`.
- Produces: `isSdkDerived(r: CorpusRecord): boolean` (mirrors the existing
  `isCliDerived` at line 51) so the shadow sample can be drawn from
  `"sdk"`-derived records instead of `"cli"`-derived ones.

- [ ] **Step 1: Write the failing test**

```typescript
describe("isSdkDerived (§6d pairing baseline)", () => {
  test("selects sdk-derived records only", () => {
    expect(isSdkDerived({ transport: "sdk", derivation: { class: "C" } } as never)).toBe(true)
    expect(isSdkDerived({ transport: "cli", derivation: { class: "C" } } as never)).toBe(false)
    expect(isSdkDerived({ transport: "agent-sdk", derivation: { class: "C" } } as never)).toBe(false)
    expect(isSdkDerived({ derivation: { class: "C" } } as never)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/paired-validation.test.ts`
Expected: FAIL — `Export named 'isSdkDerived' not found`

- [ ] **Step 3: Implementation** (mirror `isCliDerived`, do not generalize it —
  two named predicates read better at the call sites than one parameterized one)

```typescript
/** §6d pairing baseline: the incumbent SDK records the agent-sdk arm is
 * measured against. Absent transport means pre-§6c and is NOT sdk. */
export function isSdkDerived(r: CorpusRecord): boolean {
  return r.transport === "sdk"
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/paired-validation.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): isSdkDerived predicate for the agent-sdk pairing"
```

- [ ] **Step 6: STOP — request a sized go before the run**

Report to the user: the shadow-sample size (`pv-sample` prints it), the model
tier the run will use, and that this is real spend. Do not run without an
explicit sized go. When granted:

```bash
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample
KKAMAK_GAUGE_TRANSPORT=agent-sdk bun cc-gate-plugin/src/gauge/replay-cli.ts derive <shadow-dir> --go <n>
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare
```

Then copy the counts to `docs/gauge-pv/<hostname>-agent-sdk-pv-counts.json`
and commit them (F2: counts travel, prompt text does not).

### Task 7: Verdict, and the default only if earned

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md` (§6d outcome)
- Modify: `docs/2026-08-01-gauntlet-adoption-ledger.md` (boundary ts, ONLY on a pass)
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (default flip, ONLY on a pass)

- [ ] **Step 1: Script-tally the verdict** (never quote notes; counts only)

```bash
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare
```

Record positive agreement and missed-C against the §6d bar
(`>= 0.80` and `<= ceil(0.10 × |C_sdk|)`).

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6d, state
  that readings stay split by transport, leave `selectTransport`'s default at
  `"sdk"`, and stop. The transport remains available via env var for anyone who
  needs premium access and accepts split readings. This is a complete,
  successful outcome of the plan.

- [ ] **Step 3: If the bar PASSES** — flip the default in `selectTransport`
  (`env.KKAMAK_GAUGE_TRANSPORT === "sdk" ? "sdk" : "agent-sdk"`), update its
  doc comment, log a boundary ts in the gauntlet ledger with the measured
  counts, and note that `KKAMAK_GAUGE_TRANSPORT=sdk` is the one-env-var
  rollback.

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
  call-count rule → Task 4 (with an explicit stop gate); provenance/split rule
  → Task 5; pooling bar → Tasks 6–7; boundary ts → Task 7.
- **Placeholder scan**: none. Every step carries real code or an exact command.
  Task 4 Step 5's failure branch names the concrete next action (grep sdk.d.ts)
  rather than "handle the error".
- **Type consistency**: `GaugeTransport`, `GAUGE_TRANSPORTS`, `selectTransport`,
  `agentSdkCall`, `AgentSdkOptions`, `isSdkDerived` are used with identical
  names and signatures across Tasks 2–7.
- **Known risk left in deliberately**: Task 4's call-count test is the plan's
  load-bearing assumption. It is written as a stop gate rather than a hope
  because the earlier wire capture measured a multi-call query and the
  single-call behaviour has not yet been proven against a real endpoint.
