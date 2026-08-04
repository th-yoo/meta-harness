import { test, expect, describe } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  resolveModelId,
  readAuthToken,
  DERIVATION_SCHEMA,
  LABEL_SCHEMA,
  callModelSdk,
  callModelSdkLabel,
  sdkCall,
  sdkCallOutcome,
} from "../src/gauge/transport.ts"
import { buildRefinerPrompt, buildLabelPrompt } from "../src/gauge/refiner.ts"
import { stubServer, okResponse } from "./sdk-stub.ts"

// ── resolveModelId ──────────────────────────────────────────────────────

describe("resolveModelId", () => {
  test("maps the CLI alias 'haiku' to the API model id", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5")
  })

  test("passes any other value through verbatim (a bad id fails loud at the API, never silently remapped)", () => {
    expect(resolveModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5")
    expect(resolveModelId("claude-opus-5")).toBe("claude-opus-5")
    expect(resolveModelId("sonnet")).toBe("sonnet")
  })
})

// ── readAuthToken ───────────────────────────────────────────────────────

const WRAPPED = JSON.stringify({ claudeAiOauth: { accessToken: "tok-wrapped", expiresAt: 1 } })
const FLAT = JSON.stringify({ accessToken: "tok-flat" })

describe("readAuthToken", () => {
  test("KKAMAK_GAUGE_AUTH_TOKEN env override wins over everything", () => {
    const token = readAuthToken(
      { KKAMAK_GAUGE_AUTH_TOKEN: "tok-env" },
      {
        platform: "darwin",
        exec: () => {
          throw new Error("must not touch keychain when env token set")
        },
      },
    )
    expect(token).toBe("tok-env")
  })

  test("darwin: reads the keychain item and parses the wrapped shape", () => {
    let cmd: string[] | undefined
    const token = readAuthToken(
      {},
      {
        platform: "darwin",
        exec: (argv) => {
          cmd = argv
          return WRAPPED
        },
      },
    )
    expect(token).toBe("tok-wrapped")
    expect(cmd).toEqual(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])
  })

  test("darwin: parses the flat shape too", () => {
    const token = readAuthToken({}, { platform: "darwin", exec: () => FLAT })
    expect(token).toBe("tok-flat")
  })

  test("linux: reads ~/.claude/.credentials.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-"))
    fs.mkdirSync(path.join(home, ".claude"))
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), WRAPPED)
    const token = readAuthToken({}, { platform: "linux", home })
    expect(token).toBe("tok-wrapped")
  })

  test("undefined on keychain failure / missing file / malformed JSON — never throws", () => {
    expect(
      readAuthToken(
        {},
        {
          platform: "darwin",
          exec: () => {
            throw new Error("keychain locked")
          },
        },
      ),
    ).toBeUndefined()
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-"))
    expect(readAuthToken({}, { platform: "linux", home: emptyHome })).toBeUndefined()
    expect(readAuthToken({}, { platform: "darwin", exec: () => "{broken" })).toBeUndefined()
  })
})

// ── DERIVATION_SCHEMA — anyOf-never-union (§6c binding constraint) ──────

/** Walk every nested object/array; collect each `type` value seen. */
function collectTypeValues(node: unknown, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTypeValues(item, out)
    return
  }
  if (typeof node !== "object" || node === null) return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "type") out.push(v)
    collectTypeValues(v, out)
  }
}

describe("DERIVATION_SCHEMA", () => {
  test("no `type` anywhere in the schema is a union array — nullables use anyOf (API rejects [\"string\",\"null\"])", () => {
    const types: unknown[] = []
    collectTypeValues(DERIVATION_SCHEMA, types)
    expect(types.length).toBeGreaterThan(0)
    for (const t of types) expect(Array.isArray(t)).toBe(false)
  })

  test("covers every GaugeDerivation field, all required, closed object", () => {
    const s = DERIVATION_SCHEMA as unknown as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    const fields = ["goalSummary", "class", "reason", "criteria", "check", "horizon", "confidence"]
    expect(Object.keys(s.properties).sort()).toEqual([...fields].sort())
    expect([...s.required].sort()).toEqual([...fields].sort())
    expect(s.additionalProperties).toBe(false)
  })
})

// ── callModelSdk — stub HTTP server (test/sdk-stub.ts), zero real calls ──

const RESULT_JSON = JSON.stringify({
  goalSummary: "g",
  class: "C",
  reason: null,
  criteria: ["c1"],
  check: "test -f done.txt",
  horizon: "single-turn",
  confidence: 0.9,
})

describe("callModelSdk", () => {
  test("success: sends refiner prompt + structured-output config, returns the text block", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      const out = await callModelSdk("create done.txt", "bun test", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBe(RESULT_JSON)
      expect(srv.captured.length).toBe(1)
      const c = srv.captured[0]!
      expect(c.authorization).toBe("Bearer tok-1")
      expect(c.beta ?? "").toContain("oauth-2025-04-20")
      expect(c.body.model).toBe("claude-haiku-4-5")
      const messages = c.body.messages as Array<{ role: string; content: string }>
      expect(messages.length).toBe(1)
      expect(messages[0]!.role).toBe("user")
      expect(messages[0]!.content).toBe(buildRefinerPrompt("create done.txt", "bun test"))
      const outputConfig = c.body.output_config as { format: { type: string; schema: unknown } }
      expect(outputConfig.format.type).toBe("json_schema")
      expect(outputConfig.format.schema).toEqual(DERIVATION_SCHEMA as unknown as Record<string, unknown>)
    } finally {
      srv.stop()
    }
  })

  test("KKAMAK_GAUGE_MODEL is resolved through resolveModelId", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
        KKAMAK_GAUGE_MODEL: "haiku",
      })
      expect(srv.captured[0]!.body.model).toBe("claude-haiku-4-5")
    } finally {
      srv.stop()
    }
  })

  test("API error (non-2xx) → undefined, no throw, no retry (exactly one request)", async () => {
    const srv = stubServer(() =>
      Response.json({ type: "error", error: { type: "invalid_request_error", message: "nope" } }, { status: 400 }),
    )
    try {
      const out = await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("server 500 → undefined and STILL exactly one request (maxRetries 0 — §4 exactly-1-call)", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      const out = await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("no auth token resolvable → undefined WITHOUT any request", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      const out = await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        // no token env; platform/home injected so the real keychain is never touched
      }, { platform: "linux", home: fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-")) })
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("stray ANTHROPIC_API_KEY in process env is SUPPRESSED — OAuth-only auth, no x-api-key header (review finding 1)", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray-key"
    try {
      const out = await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBe(RESULT_JSON)
      expect(srv.captured.length).toBe(1)
      expect(srv.captured[0]!.apiKey).toBeNull()
      expect(srv.captured[0]!.authorization).toBe("Bearer tok-1")
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
      srv.stop()
    }
  })

  test("response with no text block → undefined", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    )
    try {
      const out = await callModelSdk("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
    } finally {
      srv.stop()
    }
  })

  // ── Task 2 (gauge-classifier 2×2 A/B): opts.model / opts.promptVariant ──

  test("omitting opts (pre-T2 call shape) is BYTE-IDENTICAL to before this param existed", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      await callModelSdk("create done.txt", "bun test", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
        KKAMAK_GAUGE_MODEL: "haiku",
      })
      const c = srv.captured[0]!
      // same model resolution as before (env KKAMAK_GAUGE_MODEL through resolveModelId)...
      expect(c.body.model).toBe("claude-haiku-4-5")
      // ...and the same prompt text (buildRefinerPrompt's own "base" default).
      const messages = c.body.messages as Array<{ role: string; content: string }>
      expect(messages[0]!.content).toBe(buildRefinerPrompt("create done.txt", "bun test"))
    } finally {
      srv.stop()
    }
  })

  test("opts.model overrides KKAMAK_GAUGE_MODEL with the exact literal (no re-aliasing)", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      await callModelSdk(
        "p",
        "",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1", KKAMAK_GAUGE_MODEL: "haiku" },
        {},
        { model: "claude-sonnet-5" },
      )
      expect(srv.captured[0]!.body.model).toBe("claude-sonnet-5")
    } finally {
      srv.stop()
    }
  })

  test("opts.promptVariant 'patched' sends the trap-augmented prompt; default stays 'base'", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      await callModelSdk(
        "create done.txt",
        "bun test",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { promptVariant: "patched" },
      )
      const messages = srv.captured[0]!.body.messages as Array<{ role: string; content: string }>
      expect(messages[0]!.content).toBe(buildRefinerPrompt("create done.txt", "bun test", "patched"))
      expect(messages[0]!.content).not.toBe(buildRefinerPrompt("create done.txt", "bun test", "base"))
    } finally {
      srv.stop()
    }
  })
})

// ── sdkCall — the generalized shared transport (stub server, zero real calls)

describe("sdkCall", () => {
  test("schema present: sends structured-output config + OAuth-only client shape, returns the text block", async () => {
    const srv = stubServer(() => okResponse(RESULT_JSON))
    try {
      const out = await sdkCall(
        "raw message",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { schema: DERIVATION_SCHEMA as unknown as Record<string, unknown> },
      )
      expect(out).toBe(RESULT_JSON)
      expect(srv.captured.length).toBe(1)
      const c = srv.captured[0]!
      expect(c.authorization).toBe("Bearer tok-1")
      expect(c.beta ?? "").toContain("oauth-2025-04-20")
      expect(c.apiKey).toBeNull()
      expect(c.body.model).toBe("claude-opus-5")
      expect(c.body.max_tokens).toBe(2048)
      const messages = c.body.messages as Array<{ role: string; content: string }>
      expect(messages).toEqual([{ role: "user", content: "raw message" }])
      const outputConfig = c.body.output_config as { format: { type: string; schema: unknown } }
      expect(outputConfig.format.type).toBe("json_schema")
      expect(outputConfig.format.schema).toEqual(DERIVATION_SCHEMA as unknown as Record<string, unknown>)
    } finally {
      srv.stop()
    }
  })

  test("schema absent: PLAIN text call — no output_config key in the request body at all", async () => {
    const srv = stubServer(() => okResponse("plain text answer"))
    try {
      const out = await sdkCall("nudge prompt", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBe("plain text answer")
      expect(srv.captured.length).toBe(1)
      expect("output_config" in srv.captured[0]!.body).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test("maxTokens override lands as the request's max_tokens", async () => {
    const srv = stubServer(() => okResponse("ok"))
    try {
      await sdkCall(
        "p",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { maxTokens: 512 },
      )
      expect(srv.captured[0]!.body.max_tokens).toBe(512)
    } finally {
      srv.stop()
    }
  })

  test("no auth token resolvable → undefined WITHOUT any request", async () => {
    const srv = stubServer(() => okResponse("ok"))
    try {
      const out = await sdkCall(
        "p",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url },
        { platform: "linux", home: fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-")) },
      )
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("server 500 → undefined, no throw, STILL exactly one request (maxRetries 0)", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      const out = await sdkCall("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("response with no text block → undefined", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    )
    try {
      const out = await sdkCall("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
    } finally {
      srv.stop()
    }
  })
})

// ── sdkCallOutcome — N2's outcome-aware core (transport.ts) ──────────────
// `sdkCall` above is now a thin wrapper over this. These tests exercise the
// no-call/call-consumed split directly, independent of `anthropic-api.ts`'s
// isolation mapping (test/anthropic-api.test.ts covers that layer).

describe("sdkCallOutcome", () => {
  test("no auth token resolvable -> { ok: false, kind: 'no-call' }, WITHOUT any request", async () => {
    const srv = stubServer(() => okResponse("ok"))
    try {
      const outcome = await sdkCallOutcome(
        "p",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url },
        { platform: "linux", home: fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-")) },
      )
      expect(outcome).toEqual({ ok: false, kind: "no-call" })
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("server 500 -> { ok: false, kind: 'call-consumed' }, exactly one request (maxRetries 0)", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      const outcome = await sdkCallOutcome("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("response with no text block -> { ok: false, kind: 'call-consumed' }", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    )
    try {
      const outcome = await sdkCallOutcome("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
    } finally {
      srv.stop()
    }
  })

  test("ok path: { ok: true, text, model, stopReason } where model is response.model, NOT the requested literal", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-20260101",
        content: [{ type: "text", text: "answer" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    try {
      const outcome = await sdkCallOutcome("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(outcome).toEqual({ ok: true, text: "answer", model: "claude-opus-5-20260101", stopReason: "end_turn" })
    } finally {
      srv.stop()
    }
  })

  test("final-review Important 3: response.stop_reason 'max_tokens' is surfaced verbatim on the ok arm (stub simulates a truncated reply)", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "this reply got cut off mid-sen" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 8192 },
      }),
    )
    try {
      const outcome = await sdkCallOutcome("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      }, {}, { maxTokens: 8192 })
      // `ok: true` here is DELIBERATE (this layer never adjudicates
      // truncation, see makeAnthropicApiProvider/seatCall for the caller
      // that does) -- the assertion is narrowly that `stopReason` carries
      // the true value through so a caller CAN adjudicate it.
      expect(outcome).toEqual({
        ok: true, text: "this reply got cut off mid-sen", model: "claude-opus-5", stopReason: "max_tokens",
      })
    } finally {
      srv.stop()
    }
  })

  test("a never-responding server -> { ok: false, kind: 'call-consumed' } (SDK timeout, core-level — previously only exercised through the provider layer)", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) }) // never responds
    try {
      const outcome = await sdkCallOutcome(
        "p",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: `http://localhost:${srv.port}`, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { timeoutMs: 50 },
      )
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
    } finally {
      srv.stop(true)
    }
  }, 10_000)

  test("opts.system present -> request carries `system`; absent -> no `system` key at all", async () => {
    const srv = stubServer(() => okResponse("ok"))
    try {
      await sdkCallOutcome(
        "p",
        "claude-opus-5",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { system: "be terse" },
      )
      expect(srv.captured[0]!.body.system).toBe("be terse")

      await sdkCallOutcome("p", "claude-opus-5", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect("system" in srv.captured[1]!.body).toBe(false)
    } finally {
      srv.stop()
    }
  })
})

// ── LABEL_SCHEMA — anyOf-never-union (same §6c constraint) ───────────────

describe("LABEL_SCHEMA", () => {
  test("no `type` anywhere in the schema is a union array", () => {
    const types: unknown[] = []
    collectTypeValues(LABEL_SCHEMA, types)
    expect(types.length).toBeGreaterThan(0)
    for (const t of types) expect(Array.isArray(t)).toBe(false)
  })

  test("covers label + class, both required, closed object", () => {
    const s = LABEL_SCHEMA as unknown as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(Object.keys(s.properties).sort()).toEqual(["class", "label"])
    expect([...s.required].sort()).toEqual(["class", "label"])
    expect(s.additionalProperties).toBe(false)
  })
})

// ── callModelSdkLabel — stub HTTP server, zero real calls ─────────────────

const LABEL_RESULT_JSON = JSON.stringify({ label: "C", class: "C" })

describe("callModelSdkLabel", () => {
  test("success: sends the LABEL rubric prompt + LABEL_SCHEMA, defaults to claude-opus-5", async () => {
    const srv = stubServer(() => okResponse(LABEL_RESULT_JSON))
    try {
      const out = await callModelSdkLabel("fix src/auth.ts", "bun test", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBe(LABEL_RESULT_JSON)
      const c = srv.captured[0]!
      expect(c.body.model).toBe("claude-opus-5")
      const messages = c.body.messages as Array<{ role: string; content: string }>
      expect(messages[0]!.content).toBe(buildLabelPrompt("fix src/auth.ts", "bun test"))
      const outputConfig = c.body.output_config as { format: { type: string; schema: unknown } }
      expect(outputConfig.format.schema).toEqual(LABEL_SCHEMA as unknown as Record<string, unknown>)
    } finally {
      srv.stop()
    }
  })

  test("is NEVER routed through KKAMAK_GAUGE_MODEL — a live-refiner env var cannot retarget the labeler", async () => {
    const srv = stubServer(() => okResponse(LABEL_RESULT_JSON))
    try {
      await callModelSdkLabel("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
        KKAMAK_GAUGE_MODEL: "haiku",
      })
      expect(srv.captured[0]!.body.model).toBe("claude-opus-5")
    } finally {
      srv.stop()
    }
  })

  test("opts.model overrides the claude-opus-5 default", async () => {
    const srv = stubServer(() => okResponse(LABEL_RESULT_JSON))
    try {
      await callModelSdkLabel(
        "p",
        "",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { model: "claude-opus-5-override" },
      )
      expect(srv.captured[0]!.body.model).toBe("claude-opus-5-override")
    } finally {
      srv.stop()
    }
  })

  test("no auth token resolvable → undefined WITHOUT any request", async () => {
    const srv = stubServer(() => okResponse(LABEL_RESULT_JSON))
    try {
      const out = await callModelSdkLabel(
        "p",
        "",
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url },
        { platform: "linux", home: fs.mkdtempSync(path.join(os.tmpdir(), "km-transport-home-")) },
      )
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("API error (non-2xx) → undefined, no throw, no retry (exactly one request)", async () => {
    const srv = stubServer(() =>
      Response.json({ type: "error", error: { type: "invalid_request_error", message: "nope" } }, { status: 400 }),
    )
    try {
      const out = await callModelSdkLabel("p", "", {
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      expect(out).toBeUndefined()
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })
})
