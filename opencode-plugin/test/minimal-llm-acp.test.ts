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
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { seatCall } from "../../minimal/llm-acp.ts"
import { REASONING_ISOLATION } from "../../cc-gate-plugin/src/gauge/send-prompt.ts"
import { stubServer } from "../../cc-gate-plugin/test/sdk-stub.ts"
import { resetAcpClientSingleton } from "../../cc-gate-plugin/src/acp-client-singleton.ts"
import { envFingerprint } from "@th-yoo/cc-api-daemon"
import {
  fakeDaemon, tempEnv, cleanupTempHomes, reapDaemons, readDiscovery, waitForLines, LIVE_DAEMONS,
} from "@th-yoo/cc-api-daemon/testing"

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

/** 2026-08-05 node — KKAMAK_SEAT_PROVIDER wiring.
 *
 * gauge-cliwarm-swap: ported off the OLD in-repo unix-socket stack. This
 * block used to isolate via `KKAMAK_ACP_SOCKET` (a per-test socket path) +
 * `cc-gate-plugin/test/acp-fake-daemon.ts`'s unix-socket fake. Both
 * mechanisms are dead against the client `anthropic-cli-warm.ts` now uses
 * (it routes through `cc-gate-plugin/src/acp-client-singleton.ts`, which
 * pins ONE env onto the package's `ensureDaemon`/`daemonCall`):
 * `KKAMAK_ACP_SOCKET` is RETIRED upstream (on `@th-yoo/cc-api-daemon`'s
 * fingerprint denylist, no implementation reads it as an address anymore),
 * and the new client speaks WebSocket, which the in-repo unix fake cannot
 * serve. This block now uses the package's OWN published test machinery
 * (`@th-yoo/cc-api-daemon/testing`) — the same `fakeDaemon`/`tempEnv` the
 * package's own suite and `cc-gate-plugin/test/anthropic-cli-warm.test.ts`
 * (ported in the previous commit on this branch) use.
 *
 * THE ENVFINGERPRINT REVERSAL: this block used to import `envFingerprint`
 * from the DEEP internal `cc-gate-plugin/src/acp/acp-paths.ts` (the OLD
 * client's own copy), a choice earlier in this project measured and kept
 * deliberately — the two implementations' denylists diverge the moment
 * `ACP_IDLE_MS` is set (old hashes it into the fingerprint, new denylists
 * it as a daemon OPERATING parameter, not an instrument parameter), so a
 * test driving the OLD client had to fingerprint with the OLD function or
 * risk a mismatch. That reasoning no longer applies: the provider under
 * test now calls the package's OWN `ensureDaemon`/`daemonCall`
 * (`acp-client.ts`), which computes its own `fp` via the package's
 * `envFingerprint` (`acp-paths.ts`, imported into `index.ts` and re-exported
 * — this is what `acp-client-singleton.ts` itself imports). A fake built
 * with the OLD function would echo a fingerprint the NEW client never
 * computes, and every call would silently degenerate into a `no-call`. So
 * this block now imports `envFingerprint` from `@th-yoo/cc-api-daemon`
 * itself, matching `cc-gate-plugin/test/anthropic-cli-warm.test.ts`'s own
 * import exactly.
 *
 * ISOLATION IS NOT OPTIONAL (package CLAUDE.md + this file's own prior
 * bare-env bug): `discoveryPath` falls back to the REAL `os.homedir()` when
 * `env.HOME` is absent, and a fake's `stop()` DELETES the discovery file it
 * published. This host may run a live daemon with a populated
 * `~/.config/acpd/` — an ungoverned env here could read, and on cleanup
 * DELETE, that daemon's own discovery entry. Every env below therefore
 * comes from `tempEnv` (throwaway `HOME`), never a bare object with only
 * the 2-3 gauge keys the way this block's tests used to be written; the
 * `afterEach` below also runs a delta check against the REAL
 * `~/.config/acpd/`, in both directions, as a second line of defense.
 *
 * ALSO NOT OPTIONAL: `acp-client-singleton.ts` pins ONE env for the life of
 * the process (first caller wins), and `bun test` shares a module registry
 * across files in one run — a `capturedEnv` leaked from an earlier test (or
 * a future earlier FILE) would silently redirect a later test's
 * `ensureDaemon`/`daemonCall` away from ITS OWN `tempEnv`-scoped fake, which
 * can fall through to `ensureDaemon` actually spawning a REAL daemon
 * process (see `resetAcpClientSingleton`'s own doc comment for the full
 * hazard). Reset in both `beforeEach` and `afterEach` below — belt and
 * suspenders, since either alone is sufficient today (this is the only file
 * in this package importing the singleton) but a second consumer added
 * later must not silently reintroduce the hazard by relying on this file's
 * afterEach alone. */
const REAL_ACPD_DIR = path.join(os.homedir(), ".config", "acpd")
const realAcpdFilesNow = (): string[] =>
  fs.existsSync(REAL_ACPD_DIR) ? fs.readdirSync(REAL_ACPD_DIR).filter((f) => f.startsWith("acp-")) : []
const PRE_EXISTING_REAL_ACPD = new Set(realAcpdFilesNow())

/** A HOME under an UNWRITABLE, nonexistent parent (root-owned, no sudo in
 * test) — deliberately NOT `tempEnv` (which always creates a real, WRITABLE
 * temp dir). `ensureDaemon`'s spawn-lock sequence (`acp-client.ts`) calls
 * `spawnDaemonProcess()` — a REAL `bun acp-daemon.ts` background process —
 * whenever the client wins the client-side spawn lock, REGARDLESS of
 * `waitMs` (`waitMs=0`, the provider's own default, only skips the
 * post-spawn POLL, not the spawn itself). A writable-but-empty `tempEnv`
 * HOME with no discovery file published would therefore make "no daemon
 * reachable" tests actually launch a real daemon. Pointing HOME at an
 * unwritable parent instead makes `acquireAcpLock`'s own `fs.mkdirSync`
 * throw EACCES, which `ensureDaemon`'s outer `try/catch` turns into a clean
 * `false` WITHOUT ever reaching `spawnDaemonProcess` — the new-client
 * analogue of the old `unwritableSock` trick this block used to rely on
 * (there is no `KKAMAK_ACP_SOCKET` successor to point instead). */
function unwritableHomeEnv(tag: string): Record<string, string | undefined> {
  return {
    ...process.env,
    KKAMAK_ACP_TEST_MARKER: "acp-client-test",
    HOME: `/nonexistent-dir-${tag}/home`,
  }
}

describe("seatCall — KKAMAK_SEAT_PROVIDER (2026-08-05 warm-lane wiring node)", () => {
  beforeEach(() => {
    resetAcpClientSingleton()
  })

  afterEach(() => {
    reapDaemons()
    cleanupTempHomes()
    resetAcpClientSingleton()

    // Delta check against the REAL host's ~/.config/acpd/, both directions:
    // a NEW file appearing is exactly what a mis-homed fake would leave
    // behind; a PRE-EXISTING file (including a live daemon's own entry)
    // going MISSING is exactly what a mis-homed fake's `stop()` would do to
    // it.
    const nowFiles = new Set(realAcpdFilesNow())
    const leaked = [...nowFiles].filter((f) => !PRE_EXISTING_REAL_ACPD.has(f))
    expect(leaked).toEqual([])
    const missing = [...PRE_EXISTING_REAL_ACPD].filter((f) => !nowFiles.has(f))
    expect(missing).toEqual([])
  })

  test("1. KKAMAK_SEAT_PROVIDER absent -> default path untouched: no daemon probe, purely HTTP", async () => {
    // The property this test pins is unchanged from before the port: the
    // default path (no KKAMAK_SEAT_PROVIDER) must never touch ACP at all —
    // no discovery read/write, no daemon spawn. The OLD mechanism (point a
    // broken KKAMAK_ACP_SOCKET at an unwritable path so an accidental probe
    // would fail loudly) has no successor: the env var is retired and
    // nothing reads it as an address anymore, so pointing it anywhere would
    // prove nothing. Proven structurally instead: this env carries a
    // throwaway HOME (`tempEnv`) that nothing else in this test touches, so
    // if `seatCall` ever reached `ensureDaemon`/`daemonCall`/`fakeDaemon`
    // for this env, it would have to publish or read a discovery file
    // there — `readDiscovery` returning undefined and no `.config/acpd` dir
    // ever appearing is the same proof "no daemon probe" always was, just
    // aimed at the new client's own artifact instead of the old socket.
    //
    // That discovery-file check alone is not sufficient, though: it runs
    // immediately after `seatCall` resolves, and if the default path ever
    // DID regress into reaching `ensureDaemon`, the no-daemon leg returns
    // near-instantly (`readDiscovery` -> undefined -> `{kind:"no-call"}` in
    // milliseconds) while `spawnDaemonProcess` is a detached, un-awaited
    // `Bun.spawn(...).unref()` — a real cold start (loading
    // @anthropic-ai/sdk, ws) takes far longer than the window between that
    // spawn call and this test's assertions. The HTTP fallback would still
    // succeed AND the discovery checks would still read empty at assertion
    // time, a near-deterministic false pass, not a rare race — all while a
    // real `bun acp-daemon.ts` carrying this host's ambient credentials
    // (`tempEnv`'s own `...process.env`) sits orphaned for the full 900s
    // idle budget. Same spawn-log backstop test 2 below uses, wired BEFORE
    // the call: poll it after and assert it STAYS empty, so a regression is
    // both detected and (via `reapDaemons()` in `afterEach`) cleaned up.
    const srv = stubServer(() => apiResponse("default path, no daemon"))
    const env = tempEnv("t1-default")
    env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
    env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-1"
    // `tempEnv` spreads the REAL `process.env` (needed so the rest of a
    // real shell's PATH etc. survives) — on a host that has activated the
    // warm lane for its own shell (this env var's whole point per
    // minimal/llm-acp.ts's header is being "a separate, separately-logged
    // decision" someone opts into), that ambient value would silently ride
    // along here and defeat "absent" outright. Force it undefined so this
    // test's premise holds on every host, not just ones with a clean shell.
    env.KKAMAK_SEAT_PROVIDER = undefined
    const spawnLog = path.join(env.HOME!, "spawnlog")
    env.ACP_TEST_SPAWN_LOG = spawnLog
    LIVE_DAEMONS.push({ spawnLog })
    try {
      const out = await seatCall("claude-opus-5", "hi", { env })
      expect(out).toBe("default path, no daemon")
      expect(srv.captured.length).toBe(1)
      expect(readDiscovery(env)).toBeUndefined()
      expect(fs.existsSync(path.join(env.HOME!, ".config", "acpd"))).toBe(false)
      expect(await waitForLines(spawnLog, 1, 100)).toEqual([])
      expect(fs.existsSync(spawnLog)).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test("2. KKAMAK_SEAT_PROVIDER=anthropic-cli-warm + working fake daemon -> warm lane serves the call, zero HTTP requests", async () => {
    const env = tempEnv("t2-warm-ok")
    const srv = stubServer(() => apiResponse("must never be reached"))
    env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
    env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-1"
    env.KKAMAK_SEAT_PROVIDER = "anthropic-cli-warm"
    // The fake's discovery file is published BEFORE seatCall ever runs, so
    // ensureDaemon's step-1 probe succeeds immediately — nothing is ever
    // spawned. Defensive backstop, matching
    // cc-gate-plugin/test/anthropic-cli-warm.test.ts's own precedent: SHOULD
    // never be written to; if that assumption were ever wrong, this makes
    // the fallback spawn loggable and reapable instead of a silent 900s-idle
    // leak.
    const spawnLog = path.join(env.HOME!, "spawnlog")
    env.ACP_TEST_SPAWN_LOG = spawnLog
    LIVE_DAEMONS.push({ spawnLog })
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok", text: "warm lane answer" })
    try {
      const out = await seatCall("claude-opus-5", "hi", { env })
      expect(out).toBe("warm lane answer")
      expect(srv.captured.length).toBe(0)
      expect(await waitForLines(spawnLog, 1, 100)).toEqual([])
      expect(fs.existsSync(spawnLog)).toBe(false)
    } finally {
      fake.stop()
      srv.stop()
    }
  })

  test("3. warm no-call (no daemon reachable) -> api fallback: exactly one HTTP request, caller gets its text", async () => {
    const srv = stubServer(() => apiResponse("fallback answer"))
    const env = unwritableHomeEnv("t3-unreachable")
    env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
    env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-1"
    env.KKAMAK_SEAT_PROVIDER = "anthropic-cli-warm"
    try {
      const out = await seatCall("claude-opus-5", "hi", { env })
      expect(out).toBe("fallback answer")
      expect(srv.captured.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test("4. warm call-consumed (fake daemon answers -32001, callConsumed:true) -> THROWS naming call-consumed, ZERO HTTP requests (no-double-spend pin)", async () => {
    const env = tempEnv("t4-warm-consumed")
    const srv = stubServer(() => apiResponse("must never be reached"))
    env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
    env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-1"
    env.KKAMAK_SEAT_PROVIDER = "anthropic-cli-warm"
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "call-consumed" })
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
    const env = tempEnv("t5-garbage-provider")
    env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
    env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-1"
    env.KKAMAK_SEAT_PROVIDER = "definitely-not-a-real-provider"
    try {
      await expect(seatCall("claude-opus-5", "hi", { env })).rejects.toThrow(/definitely-not-a-real-provider/)
      expect(srv.captured.length).toBe(0)
    } finally {
      srv.stop()
    }
  })
})
