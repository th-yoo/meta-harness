import { describe, test, expect } from "bun:test"
import { GAUGE_TRANSPORTS } from "../src/types.ts"
import { selectTransport } from "../src/gauge/transport.ts"
import { stubServer, stubServerFor } from "./sdk-stub.ts"
import { agentSdkCall } from "../src/gauge/agent-transport.ts"
import { deriveRecord } from "../src/gauge/corpus-replay.ts"
import type { CorpusRecord } from "../src/gauge/corpus-store.ts"

describe("GaugeTransport", () => {
  test("three transports are recognized, incumbent order preserved", () => {
    expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk"])
  })
})

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

// Wire-capture finding (2026-08-03): the CLI process the Agent SDK spawns
// ALWAYS sends `stream: true` on /v1/messages — this is not toggled by any
// `Options` field (checked sdk.d.ts; no such option exists). A stub that
// answers with `Response.json(...)` (a plain, non-streaming body — the shape
// `sdkCall`'s stub in this same file's earlier tests correctly uses for the
// non-agent-sdk transport, since @anthropic-ai/sdk's `messages.create`
// defaults to non-streaming) fails Bun's `fetch()`-based SSE parsing inside
// the spawned CLI, which then silently FALLS BACK to a second, non-streaming
// request. That fallback is what first measured 2+ calls here — it is a test
// double defect, not a real extra model call: against the real Anthropic API
// (which always answers a `stream:true` request with a valid SSE body) the
// fallback path is never exercised. The fix is an SSE-shaped response, not a
// loosened assertion. Confirmed by wire capture: the CLI also separately
// issues a `HEAD /api/hello` connectivity probe before the real call; the
// shared `stubServer` helper's `body: (await req.json())` throws on that
// bodiless HEAD (visible as a benign "HEAD - /api/hello failed" stderr line)
// but the throw happens before `captured.push`, so it never reaches our
// `handler` callback and does not inflate CAPTURED.
//
// Fix round 3 (2026-08-03): `agentSdkCall` no longer sends `outputFormat`,
// so the CLI no longer forces a `StructuredOutput` tool — the model just
// emits plain text (our schema requirement now rides in the prompt text
// instead, and `parseRefinerOutput`/`parseChannelOutput` tolerate it). The
// stub therefore answers with a plain TEXT SSE stream, not a `tool_use`
// block — replaces the old `sseStructuredOutput` helper.
function sseText(text: string): Response {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", content: [], model: "claude-haiku-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const SCHEMA = { type: "object", properties: { channel: { type: "string" } }, required: ["channel"], additionalProperties: false }

// Coordinator fix-round-1 finding (2026-08-03): spawning the bundled CLI
// takes long enough that a test whose earlier attempt was killed by bun:
// test's 5s default per-test timeout can still have its subprocess request
// land AFTER the timeout, mid-flight into whatever test runs next — a
// shared module-level `stub`/`CAPTURED` pair lets that stale arrival corrupt
// an unrelated test's count. Fix is structural, not just a longer timeout:
// every test that spawns the CLI gets its OWN `stubServer` instance created
// and stopped inside the test body, so a late arrival from a prior test's
// abandoned subprocess has no live capture array left to land in.
function withCaptureStub() {
  const CAPTURED: Array<Record<string, unknown>> = []
  // sdk-stub.ts's Captured.body is ALREADY `Record<string, unknown>` (it
  // does `await req.json()`), and the stub exposes `stop`, not `close`. Do
  // not re-parse or re-cast it.
  const stub = stubServer((captured) => {
    CAPTURED.push(captured.body)
    // Fix round 3: no forced tool anymore — plain text carrying the JSON
    // our schema instruction (appended to the prompt by `agentSdkCall`)
    // asked for.
    return sseText('{"channel":"C4"}')
  })
  // The spawned CLI reads ANTHROPIC_BASE_URL from its own environment. The
  // stub binds port: 0, so the port is only known at runtime; `stub.url`
  // exposes it.
  //
  // Auth note (verified empirically, not assumed): agentSdkCall does not
  // pass an authToken — the spawned CLI resolves its own credentials from
  // ~/.claude/.credentials.json (confirmed by wire capture: the captured
  // `authorization` header carries this host's real oauth token). That
  // means these tests are hermetic against making a real MODEL call (every
  // request is intercepted by ANTHROPIC_BASE_URL pointing at the local
  // stub) but are NOT hermetic against needing live on-disk Claude Code
  // credentials to reach that point at all — a host with no
  // `~/.claude/.credentials.json` and no keychain entry will see
  // CAPTURED.length stay 0 (the CLI refuses before sending), not a passing
  // test.
  const env = { ...process.env, ANTHROPIC_BASE_URL: stub.url }
  return { CAPTURED, stub, env }
}

// Every test below spawns the real bundled CLI subprocess (only its HTTP
// calls are stubbed), which is far slower than an in-process call — bun:
// test's 5s default per-test timeout is shorter than observed spawn+call
// latency, so each gets an explicit, generously-headroomed timeout as the
// 3rd `test()` argument.
const CLI_TEST_TIMEOUT_MS = 60_000

describe("agentSdkCall", () => {
  // Fix round 3 (2026-08-03): `outputFormat` (and the `StructuredOutput`
  // tool it forced) is gone — the schema requirement now rides as a terse
  // trailing instruction on the prompt text, and `parseRefinerOutput` /
  // `parseChannelOutput`'s existing tolerant first-`{`-to-last-`}` scan
  // handles the reply. This test is the wire-level proof that change
  // actually landed: no `tools` entries, no `output_config` key, and the
  // schema instruction text is present in the outgoing message alongside
  // our prompt marker.
  test("sends our prompt + schema instruction verbatim, no tools, no output_config", async () => {
    const { CAPTURED, stub, env } = withCaptureStub()
    try {
      await agentSdkCall("PROBE BODY MARKER", "claude-haiku-4-5", env, { schema: SCHEMA })
      expect(CAPTURED.length).toBeGreaterThan(0)
      const req = CAPTURED[0] as { tools?: unknown[]; output_config?: unknown; messages: Array<{ content: unknown }> }
      const userTurn = JSON.stringify(req.messages)
      expect(userTurn).toContain("PROBE BODY MARKER")
      expect(userTurn).toContain("Respond with ONLY a JSON object matching this schema")
      // tools: [] must drop every built-in AND no forced StructuredOutput
      // tool is added anymore — the array is empty (or the key absent).
      expect(req.tools ?? []).toEqual([])
      expect("output_config" in req).toBe(false)
    } finally {
      stub.stop()
    }
  }, CLI_TEST_TIMEOUT_MS)

  test("BINDING (§6d call-count rule): exactly one model call per query", async () => {
    const { CAPTURED, stub, env } = withCaptureStub()
    try {
      await agentSdkCall("SINGLE CALL CHECK", "claude-haiku-4-5", env, { schema: SCHEMA })
      expect(CAPTURED.length).toBe(1)
    } finally {
      stub.stop()
    }
  }, CLI_TEST_TIMEOUT_MS)

  // Fix round 2 (2026-08-03): pins the context-isolation fix
  // (settings.autoMemoryEnabled: false / persistSession: false /
  // strictMcpConfig: true). Before the fix, every call shipped this
  // project's auto-memory MEMORY.md index (containing notes about
  // gauge/classifier/class-C rules) into the model's context — a
  // measurement instrument contaminated by notes about the thing it
  // measures. The byte-size assertion is the regression guard: it fails
  // loudly if a future SDK version reintroduces bulk context injection, even
  // if the specific "MEMORY.md" / "claudeMd" substrings it happens to use
  // change.
  test("context isolation: no auto-memory/CLAUDE.md bleed, request stays small", async () => {
    const { CAPTURED, stub, env } = withCaptureStub()
    try {
      await agentSdkCall("ISOLATION PROBE MARKER", "claude-haiku-4-5", env, { schema: SCHEMA })
      expect(CAPTURED.length).toBeGreaterThan(0)
      const req = CAPTURED[0] as { messages: Array<{ content: unknown }> }
      const serialized = JSON.stringify(req)
      const userTurn = JSON.stringify(req.messages)
      expect(userTurn).toContain("ISOLATION PROBE MARKER")
      expect(serialized).not.toContain("MEMORY.md")
      expect(serialized).not.toContain("claudeMd")
      // Known residual (do not chase): a ~369-byte <system-reminder> with
      // the account email + current date survives every documented
      // isolation option — see agent-transport.ts's header comment. Fix
      // round 3 also dropped `outputFormat` (the forced-tool definition,
      // ~352 bytes) and added `thinking: {type:"disabled"}` (~86 bytes),
      // shrinking the payload further — measured ~1.35KB for this exact
      // call post-round-3 (was ~1.6KB post-round-2, ~10.7KB pre-round-2).
      // 2000 bytes leaves comfortable headroom above the measured size while
      // still catching bulk reinjection (memory bleed). It does NOT catch a
      // reappearing forced-tool definition (~1790B total, still under the
      // threshold) — the sibling request-shape test's tools/output_config
      // assertions cover that case.
      expect(serialized.length).toBeLessThan(2000)
    } finally {
      stub.stop()
    }
  }, CLI_TEST_TIMEOUT_MS)

  test("fail-open: unreachable endpoint resolves undefined, never throws", async () => {
    // Wire-capture finding: unlike a plain TCP connect (which fails
    // instantly with ECONNREFUSED — verified with curl against the same
    // port), the spawned CLI does not surface that failure fast; it retries
    // internally and this call is only bounded by our own AbortController
    // deadline (opts.timeoutMs, default CALL_TIMEOUT_MS = 60_000ms — ~62s
    // measured end-to-end). No timeoutMs override is passed here on purpose,
    // to exercise that real default path; the bun test timeout below gives
    // it enough wall-clock budget to finish instead of being killed early,
    // which would otherwise misreport this correctly-fail-open call as a
    // hang.
    const r = await agentSdkCall("x", "claude-haiku-4-5", {
      ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    })
    expect(r).toBeUndefined()
  }, 65_000)

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
  }, CLI_TEST_TIMEOUT_MS)
})

// Task 5: prove the seam is actually wired — deriveRecord routes through
// whichever transport selectTransport(env) picks, AND stamps the record
// with that same transport, driven against real stub servers rather than a
// source-text grep (which would pass on cosmetic rewording or a miswired
// dispatch). Reuses the `rec` builder idiom from corpus-replay.test.ts:21-34
// (CorpusRecord has ~9 required fields; no hand-rolled partial literal).
function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "mined",
    repo: "/repo/a",
    sessionId: "sess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "",
    floorCheckMinedAt: 1000,
    ...over,
  }
}

const STUB_DERIVATION = {
  goalSummary: "summarize x", class: "A2", reason: "not-shell-checkable",
  criteria: ["a summary of x exists"], check: null, horizon: null, confidence: 0.9,
}

const minedRecord = (prompt: string): CorpusRecord => rec({ prompt, stage: "mined" })

/** Both cases share this scaffolding; only the env var and the expectations
 * differ. Restores every env key it touches.
 *
 * The two stubs are deliberately NOT both `stubServerFor`: the sdk endpoint
 * (plain @anthropic-ai/sdk `messages.create`) is happy with a bare
 * non-streaming text-block response, but the agent-sdk endpoint's spawned
 * CLI always sends `stream: true` on the wire (see the `sseText` comment
 * above) regardless of whether a schema is involved, so it needs an
 * SSE-shaped reply or the CLI falls back to a second request. Fix round 3
 * removed `outputFormat`/the forced `StructuredOutput` tool entirely, so the
 * agent stub now answers with the same plain-text SSE envelope
 * (`sseText`) as the `agentSdkCall` tests above, carrying
 * `DERIVATION_SCHEMA`-shaped JSON as ordinary text — exactly what
 * `parseRefinerOutput`'s tolerant parse expects. */
async function routeCase(transport: string | undefined) {
  const sdkStub = stubServerFor(STUB_DERIVATION)
  const agentStub = stubServer(() => sseText(JSON.stringify(STUB_DERIVATION)))
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
  }, CLI_TEST_TIMEOUT_MS)
})
