/**
 * minimal-llm.test.ts — llmCall's async contract and per-driver behaviour.
 *
 * ZERO real model calls on either driver.
 *
 * `claude-code` driver (N5, docs/superpowers/specs/2026-08-04-send-prompt-interface.md):
 * as of the sendPrompt migration this branch no longer spawns a CLI — it
 * delegates to `minimal/llm-acp.ts`'s `seatCall`, which drives the
 * `anthropic-api` provider over HTTP. The seam that keeps these tests
 * hermetic is therefore no longer `opts.binPath` (there is no binary on this
 * branch any more) but `opts.env`'s `KKAMAK_GAUGE_SDK_BASE_URL` /
 * `KKAMAK_GAUGE_AUTH_TOKEN` pair, pointed at a local stub server
 * (`cc-gate-plugin/test/sdk-stub.ts`'s `stubServer` — the same helper N2's
 * own tests use). Deep coverage of `seatCall` itself (isolation, maxTokens,
 * timeoutMs, outcome mapping) lives in minimal-llm-acp.test.ts; these tests
 * only prove llmCall's claude-code branch reaches that seam correctly.
 *
 * `opencode` driver: unchanged by N5 (byte-untouched — opencode has no
 * send-prompt provider and is not part of this migration), and its fake-CLI
 * seam is still `opts.binPath`. MEASURED 2026-08-04 on Bun 1.3.1: an
 * executable is resolved from the PATH captured at PROCESS START, NOT from a
 * mutated `process.env.PATH` — a fake reachable only via a mutated PATH
 * throws ENOENT, while the same fake resolves fine via an explicit `env` or
 * an absolute path. So a test that prepends a temp dir to `process.env.PATH`
 * and lets this spawn `"opencode"` would run the REAL CLI, silently and at
 * real cost. Injecting the path is the only honest way to fake this.
 *
 * Why llmCall became async: it was `Bun.spawnSync`, which blocks the event
 * loop for the whole call, and the design-time seats routinely spend minutes
 * in one. The call sites in propose.ts/review.ts were already
 * async-tolerant — `reviewBullet.call` is typed `string | Promise<string>`
 * and awaited at review.ts:262 — so the signature change is the migration.
 */
import { describe, expect, test } from "bun:test"

import { llmCall, PROPOSER_DRIVERS } from "../../minimal/llm.ts"
import { stubServer } from "../../cc-gate-plugin/test/sdk-stub.ts"

function apiResponse(text: string): Response {
  return Response.json({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

describe("llmCall (claude-code driver — stubbed HTTP transport, no CLI, no model)", () => {
  test("is async: returns a Promise, not a string", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      const r = llmCall("claude-code", "claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(typeof (r as { then?: unknown }).then).toBe("function")
      expect(await r).toBe("ok")
    } finally {
      srv.stop()
    }
  })

  test("resolves to the stub's reply text", async () => {
    const srv = stubServer(() => apiResponse("HELLO-FROM-STUB"))
    try {
      const out = await llmCall("claude-code", "claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(out).toBe("HELLO-FROM-STUB")
    } finally {
      srv.stop()
    }
  })

  test("the prompt is delivered on the wire verbatim (no argv/stdin limit on the HTTP path)", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await llmCall("claude-code", "claude-opus-5", "PROMPT-ON-THE-WIRE", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      const body = srv.captured[0]!.body as { messages: { content: string }[] }
      expect(body.messages[0]!.content).toBe("PROMPT-ON-THE-WIRE")
    } finally {
      srv.stop()
    }
  })

  test("the model reaches the request body", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await llmCall("claude-code", "claude-sonnet-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(srv.captured[0]!.body.model).toBe("claude-sonnet-5")
    } finally {
      srv.stop()
    }
  })

  test("a provider failure REJECTS with an Error naming the outcome kind — never resolves empty", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      await expect(
        llmCall("claude-code", "claude-opus-5", "hi", {
          env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        }),
      ).rejects.toThrow(/call-consumed/)
    } finally {
      srv.stop()
    }
  })

  test("binPath is irrelevant on this branch — the HTTP stub is honoured regardless — the no-real-call guarantee", async () => {
    // If this branch ever regresses to spawning "claude" from PATH, this
    // test would silently start running the real CLI. Passing a bogus
    // binPath and still landing on the stub is the loud proof that this
    // branch no longer looks at binPath at all.
    const srv = stubServer(() => apiResponse("FAKE-ONLY-MARKER"))
    try {
      const out = await llmCall("claude-code", "claude-opus-5", "hi", {
        binPath: "/nonexistent/not-a-real-binary",
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(out).toBe("FAKE-ONLY-MARKER")
    } finally {
      srv.stop()
    }
  })
})

describe("PROPOSER_DRIVERS", () => {
  test("claude-code defaults to opus — design-time seats are judgment", () => {
    expect(PROPOSER_DRIVERS["claude-code"].defaultModel).toBe("claude-opus-5")
  })
})
