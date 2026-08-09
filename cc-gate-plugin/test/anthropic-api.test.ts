// anthropic-api.test.ts — N2 of docs/superpowers/specs/2026-08-04-send-prompt-interface.md.
// Exercises `makeAnthropicApiProvider` (src/gauge/providers/anthropic-api.ts)
// against the stub Anthropic-API server (test/sdk-stub.ts / test/agent-cli-stub.ts's
// `silentServer`) — zero real model calls, ever.
import { test, expect, describe } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeAnthropicApiProvider } from "../src/gauge/providers/anthropic-api.ts"
import type { WarmIsolation } from "@th-yoo/cc-api-daemon"
import { GAUGE_ISOLATION, REASONING_ISOLATION } from "../src/gauge/send-prompt.ts"
import { stubServer } from "./sdk-stub.ts"
import { silentServer } from "./agent-cli-stub.ts"

/** Local response builder — deliberately NOT `sdk-stub.ts`'s `okResponse`,
 * which hardcodes `model: "claude-haiku-4-5"`. Test 1 needs the stub's
 * `response.model` to differ from the requested model to prove
 * `canonicalModel` comes from the response, not an echo of the request. */
function apiResponse(text: string, model: string): Response {
  return Response.json({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function noTextResponse(model: string): Response {
  return Response.json({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: "refusal",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  })
}

const linuxAuthDeps = () => ({
  platform: "linux" as const,
  home: fs.mkdtempSync(path.join(os.tmpdir(), "km-anthropic-api-home-")),
})

describe("makeAnthropicApiProvider", () => {
  test("ok path: text extracted, model = requested literal, canonicalModel = response.model", async () => {
    const srv = stubServer(() => apiResponse("hello from stub", "claude-haiku-4-5-20260101"))
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      const outcome = await provider("say hi", { model: "haiku", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(outcome).toEqual({
        ok: true,
        text: "hello from stub",
        model: "claude-haiku-4-5", // requested literal, post-resolveModelId
        canonicalModel: "claude-haiku-4-5-20260101", // the API's own echo, NOT an echo of the request
      })
      expect(srv.captured.length).toBe(1)
      expect(srv.captured[0]!.body.model).toBe("claude-haiku-4-5")
    } finally {
      srv.stop()
    }
  })

  test("missing auth token -> no-call, and NO request arrives at the stub", async () => {
    const srv = stubServer(() => apiResponse("should never be seen", "claude-haiku-4-5"))
    try {
      const provider = makeAnthropicApiProvider(
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url }, // no KKAMAK_GAUGE_AUTH_TOKEN
        linuxAuthDeps(),
      )
      const outcome = await provider("p", { model: "haiku", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(outcome).toEqual({ ok: false, kind: "no-call" })
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("stub returns HTTP 500 -> call-consumed, exactly one request (maxRetries 0)", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      const outcome = await provider("p", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("timeout mid-response -> call-consumed", async () => {
    const srv = silentServer()
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      const outcome = await provider("p", {
        model: "claude-opus-5",
        isolation: GAUGE_ISOLATION,
        provider: "anthropic-api",
        timeoutMs: 50,
      })
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
    } finally {
      srv.stop()
    }
  }, 10_000)

  test("response with no text block -> call-consumed", async () => {
    const srv = stubServer(() => noTextResponse("claude-opus-5"))
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      const outcome = await provider("p", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("system on the wire iff isolation.systemPrompt is non-empty (both directions)", async () => {
    const srv = stubServer(() => apiResponse("ok", "claude-opus-5"))
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      // GAUGE_ISOLATION.systemPrompt === "" -> no `system` key at all.
      await provider("p1", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect("system" in srv.captured[0]!.body).toBe(false)

      // REASONING_ISOLATION.systemPrompt is non-empty -> `system` present, verbatim.
      await provider("p2", { model: "claude-opus-5", isolation: REASONING_ISOLATION, provider: "anthropic-api" })
      expect(srv.captured[1]!.body.system).toBe(REASONING_ISOLATION.systemPrompt)
    } finally {
      srv.stop()
    }
  })

  test("schema pass-through to output_config (present and absent)", async () => {
    const srv = stubServer(() => apiResponse("{}", "claude-opus-5"))
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      await provider("p1", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api", schema })
      const outputConfig = srv.captured[0]!.body.output_config as { format: { type: string; schema: unknown } }
      expect(outputConfig.format.type).toBe("json_schema")
      expect(outputConfig.format.schema).toEqual(schema)

      await provider("p2", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect("output_config" in srv.captured[1]!.body).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test("maxTokens: absent -> request carries 2048 (byte-unchanged default); present -> the value", async () => {
    const srv = stubServer(() => apiResponse("ok", "claude-opus-5"))
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      await provider("p1", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(srv.captured[0]!.body.max_tokens).toBe(2048)

      await provider("p2", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api", maxTokens: 8192 })
      expect(srv.captured[1]!.body.max_tokens).toBe(8192)
    } finally {
      srv.stop()
    }
  })

  test("thinking { type: 'enabled' } -> no-call, no request arrives (unsupported by this provider)", async () => {
    const srv = stubServer(() => apiResponse("should never be seen", "claude-opus-5"))
    const enabledThinking: WarmIsolation = { ...GAUGE_ISOLATION, thinking: { type: "enabled" } }
    try {
      const provider = makeAnthropicApiProvider({
        KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
        KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      })
      const outcome = await provider("p", { model: "claude-opus-5", isolation: enabledThinking, provider: "anthropic-api" })
      expect(outcome).toEqual({ ok: false, kind: "no-call" })
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("final-review Important 3: stop_reason 'max_tokens' fires onTruncation, but the RETURNED SendOutcome is unchanged (still ok:true, same 4 fields)", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "cut off mid-sen" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 8192 },
      }),
    )
    try {
      const seen: Array<{ stopReason: string }> = []
      const provider = makeAnthropicApiProvider(
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { onTruncation: (info) => seen.push(info) },
      )
      const outcome = await provider("p", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(seen).toEqual([{ stopReason: "max_tokens" }])
      // SendOutcome is send-prompt.ts's reviewed type and stays
      // byte-unchanged: exactly these 4 keys, still ok:true.
      expect(outcome).toEqual({
        ok: true, text: "cut off mid-sen", model: "claude-opus-5", canonicalModel: "claude-opus-5",
      })
    } finally {
      srv.stop()
    }
  })

  test("stop_reason other than 'max_tokens' never fires onTruncation", async () => {
    const srv = stubServer(() => apiResponse("complete answer", "claude-opus-5"))
    try {
      const seen: Array<{ stopReason: string }> = []
      const provider = makeAnthropicApiProvider(
        { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        {},
        { onTruncation: (info) => seen.push(info) },
      )
      await provider("p", { model: "claude-opus-5", isolation: GAUGE_ISOLATION, provider: "anthropic-api" })
      expect(seen).toEqual([])
    } finally {
      srv.stop()
    }
  })
})
