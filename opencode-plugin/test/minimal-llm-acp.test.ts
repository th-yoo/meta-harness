/**
 * minimal-llm-acp.test.ts — N5 of docs/superpowers/specs/2026-08-04-send-prompt-interface.md.
 *
 * `minimal/llm-acp.ts`'s `seatCall` is the wiring seam between the
 * design-time seats (proposer/reviewer/revision) and the send-prompt
 * interface: it registers the `anthropic-api` provider (N2) closed over the
 * caller's env, calls `sendPrompt` with `REASONING_ISOLATION`, and maps the
 * outcome back onto `llmCall`'s string-or-throw contract.
 *
 * ZERO real model calls — every test points `KKAMAK_GAUGE_SDK_BASE_URL` at a
 * local stub server (`cc-gate-plugin/test/sdk-stub.ts`'s `stubServer`, the
 * same helper N2's own tests use) and supplies `KKAMAK_GAUGE_AUTH_TOKEN`
 * directly, which short-circuits the OAuth-token lookup before it ever
 * touches a keychain or `~/.claude/.credentials.json`.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { seatCall } from "../../minimal/llm-acp.ts"
import { REASONING_ISOLATION } from "../../cc-gate-plugin/src/gauge/send-prompt.ts"
import { stubServer } from "../../cc-gate-plugin/test/sdk-stub.ts"
import { fakeDaemon, type FakeDaemonHandle } from "../../cc-gate-plugin/test/acp-fake-daemon.ts"
import { envFingerprint } from "../../cc-gate-plugin/src/gauge/acp-paths.ts"

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

describe("seatCall", () => {
  test("ok path: resolves to the stub's text", async () => {
    const srv = stubServer(() => apiResponse("hello from seat"))
    try {
      const out = await seatCall("claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(out).toBe("hello from seat")
    } finally {
      srv.stop()
    }
  })

  test("REASONING_ISOLATION is the isolation set: system prompt reaches the wire", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await seatCall("claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(srv.captured[0]!.body.system).toBe(REASONING_ISOLATION.systemPrompt)
    } finally {
      srv.stop()
    }
  })

  test("prompt and model reach the wire verbatim", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await seatCall("claude-sonnet-5", "the exact prompt text", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      const body = srv.captured[0]!.body as { model: string; messages: { role: string; content: string }[] }
      expect(body.model).toBe("claude-sonnet-5")
      expect(body.messages[0]!.content).toBe("the exact prompt text")
    } finally {
      srv.stop()
    }
  })

  test("maxTokens: absent -> 8192 default (4x the gauge default, uncapped CLI path replaced)", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await seatCall("claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(srv.captured[0]!.body.max_tokens).toBe(8192)
    } finally {
      srv.stop()
    }
  })

  test("maxTokens: explicit override threads through", async () => {
    const srv = stubServer(() => apiResponse("ok"))
    try {
      await seatCall("claude-opus-5", "hi", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        maxTokens: 1234,
      })
      expect(srv.captured[0]!.body.max_tokens).toBe(1234)
    } finally {
      srv.stop()
    }
  })

  test("timeoutMs: explicit override threads through to the transport (slow stub times out)", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) }) // never responds
    try {
      await expect(
        seatCall("claude-opus-5", "hi", {
          env: { KKAMAK_GAUGE_SDK_BASE_URL: `http://localhost:${srv.port}`, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
          timeoutMs: 50,
        }),
      ).rejects.toThrow(/call-consumed/)
    } finally {
      srv.stop(true)
    }
  }, 10_000)

  test("!ok no-call (missing auth token in the provided env) -> rejects with an Error naming the kind", async () => {
    // No KKAMAK_GAUGE_AUTH_TOKEN in the provided env. `authDeps` pins the
    // NON-darwin branch (`platform: "linux"`) and an empty temp `home`, so
    // `readAuthToken` deterministically fails to resolve a token on ANY
    // host this suite runs on — a real HOME-var override alone would only
    // reach the linux branch, and would pass for the wrong reason (or
    // flake) on a MacBook that either lacks a "Claude Code-credentials"
    // keychain item (exec throws — accidentally still no-call) or, worse,
    // HAS one (a real token resolves, the call proceeds, and this test
    // fails outright). Pinning `platform` removes the host dependency
    // entirely; zero real model calls either way (`srv.captured` stays
    // empty — the request never fires).
    const srv = stubServer(() => apiResponse("must never be reached"))
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "seatcall-no-auth-home-"))
    try {
      await expect(
        seatCall("claude-opus-5", "hi", {
          env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url },
          authDeps: { platform: "linux", home: emptyHome },
        }),
      ).rejects.toThrow(/no-call/)
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test("!ok call-consumed (HTTP 500) -> rejects with an Error naming the kind", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    try {
      await expect(
        seatCall("claude-opus-5", "hi", {
          env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
        }),
      ).rejects.toThrow(/call-consumed/)
    } finally {
      srv.stop()
    }
  })

  test("final-review Important 3: a reply truncated at maxTokens (stop_reason max_tokens) throws naming truncation + the maxTokens value, never returns the cut-off text", async () => {
    const srv = stubServer(() =>
      Response.json({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "this reply was cut off mid-sen" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1234 },
      }),
    )
    try {
      let caught: unknown
      try {
        await seatCall("claude-opus-5", "hi", {
          env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
          maxTokens: 1234,
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      expect(message).toMatch(/truncat/i)
      expect(message).toContain("1234")
    } finally {
      srv.stop()
    }
  })

  test("registerProvider is safe to call across repeat seatCall invocations", async () => {
    const srv = stubServer(() => apiResponse("second call"))
    try {
      await seatCall("claude-opus-5", "first", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      const out = await seatCall("claude-opus-5", "second", {
        env: { KKAMAK_GAUGE_SDK_BASE_URL: srv.url, KKAMAK_GAUGE_AUTH_TOKEN: "tok-1" },
      })
      expect(out).toBe("second call")
      expect(srv.captured.length).toBe(2)
    } finally {
      srv.stop()
    }
  })
})

/** 2026-08-05 node — KKAMAK_SEAT_PROVIDER wiring. Every test builds its own
 * temp socket path (never the real `~/.config/kkamak` store) and stops any
 * fake daemon it starts in a `finally`, same discipline as
 * cc-gate-plugin/test/anthropic-cli-warm.test.ts. */
function tempSock(tag: string): string {
  return path.join(os.tmpdir(), `kkamak-seatcall-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
}

/** A path under an UNWRITABLE parent (root-owned, no sudo in test) so
 * `ensureDaemon`'s own `ensureSocketDir` throws EACCES and returns `false`
 * WITHOUT ever reaching `spawnDaemonProcess` — the same trick
 * acp-client.test.ts's "ensureDaemon NEVER throws on an unwritable socket
 * dir" test uses. This is what lets a warm no-call be exercised here
 * without actually spawning a real `bun acp-daemon.ts` background process. */
function unwritableSock(tag: string): string {
  return `/nonexistent-dir-${tag}/x.sock`
}

describe("seatCall — KKAMAK_SEAT_PROVIDER (2026-08-05 warm-lane wiring node)", () => {
  test("1. KKAMAK_SEAT_PROVIDER absent -> default path untouched: no daemon probe, purely HTTP (a broken KKAMAK_ACP_SOCKET is never even read)", async () => {
    const srv = stubServer(() => apiResponse("default path, no daemon"))
    try {
      const out = await seatCall("claude-opus-5", "hi", {
        env: {
          KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
          KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
          // Points at a socket under a dir that does not exist and cannot
          // be created (unwritable parent). If the default path wrongly
          // still probed/spawned a daemon, `ensureDaemon` would either
          // throw or hang on this path; the default path must never reach
          // that code at all, so the call simply succeeds over HTTP.
          KKAMAK_ACP_SOCKET: unwritableSock("t1"),
        },
      })
      expect(out).toBe("default path, no daemon")
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("2. KKAMAK_SEAT_PROVIDER=anthropic-cli-warm + working fake daemon -> warm lane serves the call, zero HTTP requests", async () => {
    const sock = tempSock("t2-warm-ok")
    const srv = stubServer(() => apiResponse("must never be reached"))
    const env = {
      KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
      KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      KKAMAK_SEAT_PROVIDER: "anthropic-cli-warm",
      KKAMAK_ACP_SOCKET: sock,
    }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok", text: "warm lane answer" })
    try {
      const out = await seatCall("claude-opus-5", "hi", { env })
      expect(out).toBe("warm lane answer")
      expect(srv.captured.length).toBe(0)
    } finally {
      fake.stop()
      srv.stop()
    }
  })

  test("3. warm no-call (no daemon reachable) -> api fallback: exactly one HTTP request, caller gets its text", async () => {
    const srv = stubServer(() => apiResponse("fallback answer"))
    const env = {
      KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
      KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      KKAMAK_SEAT_PROVIDER: "anthropic-cli-warm",
      // Unwritable parent -> ensureDaemon's probe fails AND its spawn path
      // is refused (EACCES) rather than actually spawning a real daemon
      // process in the test suite -> daemonCall itself also fails to
      // connect -> a clean, fast no-call.
      KKAMAK_ACP_SOCKET: unwritableSock("t3"),
    }
    try {
      const out = await seatCall("claude-opus-5", "hi", { env })
      expect(out).toBe("fallback answer")
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("4. warm call-consumed (fake daemon answers -32001, callConsumed:true) -> THROWS naming call-consumed, ZERO HTTP requests (no-double-spend pin)", async () => {
    const sock = tempSock("t4-warm-consumed")
    const srv = stubServer(() => apiResponse("must never be reached"))
    const env = {
      KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
      KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
      KKAMAK_SEAT_PROVIDER: "anthropic-cli-warm",
      KKAMAK_ACP_SOCKET: sock,
    }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "call-consumed" })
    try {
      await expect(seatCall("claude-opus-5", "hi", { env })).rejects.toThrow(/call-consumed/)
      expect(srv.captured.length).toBe(0)
    } finally {
      fake.stop()
      srv.stop()
    }
  })

  test("5. garbage KKAMAK_SEAT_PROVIDER value -> throws naming the value", async () => {
    const srv = stubServer(() => apiResponse("must never be reached"))
    try {
      await expect(
        seatCall("claude-opus-5", "hi", {
          env: {
            KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
            KKAMAK_GAUGE_AUTH_TOKEN: "tok-1",
            KKAMAK_SEAT_PROVIDER: "definitely-not-a-real-provider",
          },
        }),
      ).rejects.toThrow(/definitely-not-a-real-provider/)
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })
})
