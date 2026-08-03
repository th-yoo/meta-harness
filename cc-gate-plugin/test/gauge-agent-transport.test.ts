import { describe, test, expect } from "bun:test"
import { GAUGE_TRANSPORTS } from "../src/types.ts"
import { selectTransport } from "../src/gauge/transport.ts"
import { stubServer } from "./sdk-stub.ts"
import { agentSdkCall } from "../src/gauge/agent-transport.ts"

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
function sseStructuredOutput(output: Record<string, unknown>): Response {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", content: [], model: "claude-haiku-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_stub1", name: "StructuredOutput", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(output) } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } } },
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
    // Every caller of this helper passes `opts.schema`, so the CLI always
    // forces the StructuredOutput tool — answer with a tool_use SSE stream
    // carrying exactly the schema's required shape (`additionalProperties:
    // false` on `channel` only — no extra fields).
    return sseStructuredOutput({ channel: "C4" })
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
  test("sends our prompt verbatim, with the schema tool and no built-in tools", async () => {
    const { CAPTURED, stub, env } = withCaptureStub()
    try {
      await agentSdkCall("PROBE BODY MARKER", "claude-haiku-4-5", env, { schema: SCHEMA })
      expect(CAPTURED.length).toBeGreaterThan(0)
      const req = CAPTURED[0] as { tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> }
      expect(JSON.stringify(req.messages)).toContain("PROBE BODY MARKER")
      // tools: [] must drop every built-in; only the schema tool may remain
      const names = (req.tools ?? []).map((t) => t.name)
      expect(names.filter((n) => n !== "StructuredOutput")).toEqual([])
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
