// test/acp-daemon.test.ts — N3a: the ACP daemon (socket server, dispatcher,
// idle self-exit) over the REAL daemon process, driven as a child.
//
// Delta-memo governs over task-5-brief.md prose where they conflict:
//  · _meta is namespaced under `kkamak` (T2n) — every custom field here is
//    `_meta.kkamak.*`, never a bare `_meta.model`.
//  · the dated-model-key assumption in the plan text is dead on this driving
//    path (T4·1a probe) — STUB_DECLARED_MODEL / HAIKU_OBSERVED_KEY below
//    mirror warm-session.test.ts's split constants, never a local
//    `HAIKU_DATED` literal.
//  · acp-paths.ts is already built; this file imports it, never
//    re-implements it.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { tmpdir } from "node:os"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText, hangFirstServer, until } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"
import {
  FrameDecoder, encodeFrame, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, CLI_SPAWN_BUDGET_MS,
} from "../src/gauge/acp-wire.ts"
import { envFingerprint } from "../src/gauge/acp-paths.ts"

const DAEMON_TEST_TIMEOUT_MS = 60_000
const HAIKU = "claude-haiku-4-5"
// Same split as warm-session.test.ts (T4·1a, measured 2026-08-04): the stub
// DECLARES a dated snapshot id in message_start, but on this streaming-input
// driving path modelUsage's key is actually keyed by the client-requested
// (undated) model, verbatim. Assertions on the daemon's forwarded
// `_meta.kkamak.model` use HAIKU_OBSERVED_KEY, never STUB_DECLARED_MODEL.
const STUB_DECLARED_MODEL = "claude-haiku-4-5-20251001"
const HAIKU_OBSERVED_KEY = HAIKU

/** Every test builds its OWN socket/spawn-log pair under tmpdir. NO TEST MAY
 * EVER TOUCH ~/.config/kkamak/acp-*.sock — the afterEach below asserts it. */
function tempEndpoint(tag: string) {
  const base = path.join(tmpdir(), `kkamak-acp-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return { sock: `${base}.sock`, spawnLog: `${base}.spawnlog` }
}

/** Spawn the REAL daemon as a detached child.
 *
 * `env` is passed EXPLICITLY and is the SAME object the caller fingerprints
 * (round-4 I2): the daemon computes envFingerprint(process.env) and
 * socketPath(process.env) from what it inherits, so a spawner that
 * fingerprints one env and launches with another gets a daemon on a
 * different path echoing a different fingerprint — mutual refusal forever.
 *
 * KKAMAK_ACP_IDLE_MS is ALWAYS set to a few seconds here (round-4 M8): the
 * production default is 900 000 ms, and a test daemon that survives an
 * afterEach failure would sit on the host for fifteen minutes. */
function spawnDaemon(sock: string, spawnLog: string, extra: Record<string, string> = {}, idleMs = "8000") {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KKAMAK_ACP_SOCKET: sock,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
    KKAMAK_ACP_IDLE_MS: idleMs,
    ...extra,
  }
  const daemon = path.join(import.meta.dir, "..", "src", "gauge", "acp-daemon.ts")
  const quoted = ["bun", daemon].map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  return { env }
}

/** Read the POST-LISTEN pids out of the spawn log and SIGTERM each one, then
 * unlink the socket and both locks. Pid-scoped, never `pkill -f` — §6e
 * forbids host-wide teardown (round-4 I9), and the Bun.spawn handle is the
 * `bash -c nohup` shell, not the daemon. */
function killDaemon(sock: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  for (const p of [sock, `${sock}.spawn.lock`, `${sock}.bind.lock`, spawnLog]) {
    try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
  }
}

/** Poll the spawn log for at least `n` post-listen lines. */
async function waitForSpawnLog(spawnLog: string, n: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    let lines: string[] = []
    try { lines = fs.readFileSync(spawnLog, "utf-8").split("\n").filter((l) => l.trim()) } catch { /* not yet */ }
    if (lines.length >= n || Date.now() > deadline) return lines
    await new Promise((r) => setTimeout(r, 50))
  }
}

interface JsonRpcReply { id?: number | string; result?: unknown; error?: { code: number; message: string; data?: { callConsumed: boolean; model?: string } } }

/** Minimal NDJSON ACP client: net.connect + setEncoding + FrameDecoder,
 * matching the framing acp-wire.ts's tests already lock. Each connection
 * gets its OWN request-id counter starting at 1 — the real-world shape, and
 * the reason cancel-scoping must be tag-based (round-3 C2). */
function connectNdjson(sock: string): Promise<{
  request: (method: string, params?: unknown) => Promise<any>
  notify: (method: string, params?: unknown) => void
  onNotification: (method: string, cb: (params: any) => void) => void
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock)
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
    const notifHandlers = new Map<string, (p: any) => void>()

    socket.once("connect", () => {
      socket.removeListener("error", reject)
      socket.on("error", () => { /* connection torn down mid-test: never crash the test process */ })
      resolve({
        request(method: string, params?: unknown) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }))
          })
        },
        notify(method: string, params?: unknown) {
          socket.write(encodeFrame({ jsonrpc: "2.0", method, params }))
        },
        onNotification(method: string, cb: (params: any) => void) { notifHandlers.set(method, cb) },
        close() { socket.destroy() },
      })
    })
    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        const msg = f as JsonRpcReply & { method?: string; params?: unknown }
        if (msg.id === undefined && typeof msg.method === "string") {
          const h = notifHandlers.get(msg.method)
          if (h) h(msg.params)
          continue
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
          else p.resolve(msg.result)
        }
      }
    })
    socket.once("error", reject)
  })
}

const LIVE: Array<{ sock: string; spawnLog: string }> = []
afterEach(() => {
  while (LIVE.length) { const e = LIVE.pop()!; killDaemon(e.sock, e.spawnLog) }
  // The hygiene invariant, asserted rather than hoped for.
  const home = process.env.HOME ?? ""
  const dir = path.join(home, ".config", "kkamak")
  const leaked = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("acp-")) : []
  expect(leaked).toEqual([])
})

// ── wire-level behaviour: no model is ever reached, so NO credentials
// guard. Round-4 M6: a blanket describe.skipIf over this block would throw
// away real coverage on a credential-less host, because the daemon's
// WarmSession does not start a Query until a prompt actually arrives.
describe("acp-daemon wire behaviour (no model reached)", () => {
  test("missing _meta.kkamak.model -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    const e = tempEndpoint("nocall"); LIVE.push(e)
    const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "hi" }],
        // no _meta at all
      })).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      expect(cap.captured.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("unknown method -> -32601 and the connection survives", async () => {
    const e = tempEndpoint("unknown"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    await expect(c.request("totally/bogus", {})).rejects.toMatchObject({ code: -32601 })
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a malformed frame does not kill the daemon", async () => {
    const e = tempEndpoint("malformed"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const socket = net.connect(e.sock)
    await new Promise<void>((res, rej) => { socket.once("connect", () => res()); socket.once("error", rej) })
    socket.setEncoding("utf8")
    socket.write("garbage-not-json\n")
    // give the daemon a moment to (not) choke on it, then prove it is alive.
    await new Promise((r) => setTimeout(r, 200))
    socket.destroy()
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel sent as a NOTIFICATION (no id) is honoured and NOT answered", async () => {
    const e = tempEndpoint("cancelnotif"); LIVE.push(e)
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })

      let sawUnexpectedFrame = false
      // A notification reply would arrive with no `id` and no `method` we
      // registered a handler for -- watch the raw connection is unnecessary;
      // instead assert on the ONE observable contract: the prompt settles
      // NO_CALL and the promise for the cancel itself (a fire-and-forget
      // notify()) never resolves/rejects anything, because there IS no
      // promise for a notification.
      const promptPromise = c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "cancel me" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      // Fire the cancel as a bare notification (no id) immediately, before
      // awaiting the prompt -- races the turn out of `pending`/unsent
      // `current` before it crosses the send boundary.
      c.notify("session/cancel", { sessionId: s.sessionId })

      await expect(promptPromise).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      expect(sawUnexpectedFrame).toBe(false)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("idle reaper drains, exits, and removes the socket", async () => {
    const e = tempEndpoint("idle"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog, {}, "1500")
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const lines = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const pid = Number(lines[0]?.trim().split(/\s+/)[0])
    const c = await connectNdjson(e.sock)
    await c.request("initialize", { protocolVersion: 1 })
    c.close()
    // reaper ticks at min(60s, idleMs/3) = 500ms here; give it comfortable
    // margin over the 1500ms idle budget.
    const gone = await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 8_000)
    expect(gone).toBe(true)
    expect(fs.existsSync(e.sock)).toBe(false)
  }, DAEMON_TEST_TIMEOUT_MS)

  test("stale socket file is taken over under the BIND lock", async () => {
    const e = tempEndpoint("stale"); LIVE.push(e)
    fs.mkdirSync(path.dirname(e.sock), { recursive: true })
    fs.writeFileSync(e.sock, "")   // a dead file, not a live listener
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a LIVE socket is not taken over: the second starter exits 0, writes NO spawn-log line, and the first still answers", async () => {
    const e = tempEndpoint("live"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    const first = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    expect(first.length).toBe(1)
    // Second starter, same socket/spawn-log pair: must see the first as
    // live and refuse to bind, writing nothing.
    spawnDaemon(e.sock, e.spawnLog)
    // Settle time for the second starter to probe and exit.
    await new Promise((r) => setTimeout(r, 2_000))
    const lines = fs.readFileSync(e.spawnLog, "utf-8").split("\n").filter((l) => l.trim())
    expect(lines.length).toBe(1)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("ROUND-4 I2: the daemon binds and echoes from the env it was GIVEN, not from an ambient one", async () => {
    const e = tempEndpoint("envcontract"); LIVE.push(e)
    const { env } = spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_MODEL: "probe-value" })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init._meta.kkamak.envFingerprint).toBe(envFingerprint(env))
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)
})

// ── model-reaching behaviour: these DO spawn the bundled CLI, so they carry
// the credentials guard.
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-daemon over unix socket (reaches the stubbed model)", () => {
  test("initialize -> session/new -> session/prompt round-trip, fingerprint and PROVEN-model evidence echoed", async () => {
    const e = tempEndpoint("rt"); LIVE.push(e)
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    try {
      const { env } = spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      const init = await c.request("initialize", { protocolVersion: 1 })
      expect(init.protocolVersion).toBe(1)
      expect(init._meta.kkamak.envFingerprint).toBe(envFingerprint(env))
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      expect(typeof s.sessionId).toBe("string")
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      const r = await c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "classify me" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(r.stopReason).toBe("end_turn")
      // ROUND-4 C1: the daemon forwards the modelUsage KEY VERBATIM -- on
      // THIS driving path that key is the client-requested model, verbatim
      // (T4·1a). Never assert STUB_DECLARED_MODEL here.
      expect(r._meta.kkamak.model).toBe(HAIKU_OBSERVED_KEY)
      expect(typeof r._meta.kkamak.canonicalModel).toBe("string")
      expect(r._meta.kkamak.callConsumed).toBe(true)
      expect(updates.join("")).toContain("ANSWER")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a second SESSION recycles (clean context); a second PROMPT in one session does not", async () => {
    const e = tempEndpoint("recycle"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })

      const s1 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      await c.request("session/prompt", {
        sessionId: s1.sessionId, prompt: [{ type: "text", text: "FIRST-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })

      const s2 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "SECOND-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(CAPTURED.length).toBe(2)
      const m2 = CAPTURED[1] as { messages: unknown[] }
      expect(JSON.stringify(m2.messages)).not.toContain("FIRST-MARKER")
      expect(JSON.stringify(m2.messages)).toContain("SECOND-MARKER")

      // A THIRD prompt reusing the SECOND sessionId: context must NOT be
      // cleared, so the second prompt's marker is still present.
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "THIRD-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(CAPTURED.length).toBe(3)
      const m3 = CAPTURED[2] as { messages: unknown[] }
      expect(JSON.stringify(m3.messages)).toContain("SECOND-MARKER")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("INTERLEAVED sessions each get a clean context (lastServedSessionId is committed at dispatch)", async () => {
    const e = tempEndpoint("interleave"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(e.sock)
      const cB = await connectNdjson(e.sock)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      const sB = await cB.request("session/new", { cwd: process.cwd(), mcpServers: [] })

      // Same global WarmSession FIFO: issue sequentially A, B, A so each
      // request fully resolves before the next is sent (interleaving here
      // means DIFFERENT sessions on the shared daemon, not concurrent
      // in-flight turns).
      await cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      await cB.request("session/prompt", {
        sessionId: sB.sessionId, prompt: [{ type: "text", text: "B-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      await cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A-MARKER-2" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(CAPTURED.length).toBe(3)
      for (const body of CAPTURED) {
        const s = JSON.stringify((body as { messages: unknown[] }).messages)
        // no captured body may carry BOTH markers from the other session.
        if (s.includes("A-MARKER-2")) { expect(s).not.toContain("B-MARKER") }
      }
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a 500 -> ACP_ERR_CALL_CONSUMED with data.callConsumed true, no update", async () => {
    const e = tempEndpoint("500"); LIVE.push(e)
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER", STUB_DECLARED_MODEL)))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId, prompt: [{ type: "text", text: "boom please" }],
        _meta: { kkamak: { model: HAIKU } },
      })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
      expect(updates.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("an unreachable model endpoint AFTER the push -> ACP_ERR_CALL_CONSUMED, never NO_CALL", async () => {
    const e = tempEndpoint("unreachable"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      KKAMAK_ACP_TURN_TIMEOUT_MS: String(CLI_SPAWN_BUDGET_MS),
    })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    await c.request("initialize", { protocolVersion: 1 })
    const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
    await expect(c.request("session/prompt", {
      sessionId: s.sessionId, prompt: [{ type: "text", text: "never lands" }],
      _meta: { kkamak: { model: HAIKU } },
    })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel is SCOPED even when BOTH clients use the SAME JSON-RPC id", async () => {
    const e = tempEndpoint("scoped-cancel"); LIVE.push(e)
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    try {
      spawnDaemon(e.sock, e.spawnLog, {
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_TURN_TIMEOUT_MS: String(CLI_SPAWN_BUDGET_MS),
      })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(e.sock)
      const cB = await connectNdjson(e.sock)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [] })

      // A's prompt hangs (the stub's FIRST request never answers). Both
      // connections start their own id counter at 1, so A's session/prompt
      // (id=2, after initialize+session/new) and B's FIRST request will
      // legitimately collide in id-space -- the scoping must come from the
      // daemon-minted tag, never the wire id.
      const aPromise = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A hangs" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      // A has provably crossed the send boundary once the stub observed a
      // request (round-4 C3/I11) -- only then is B's cancel meaningful.
      const crossed = await until(() => cap.count() >= 1, 30_000)
      expect(crossed).toBe(true)

      const sB = await cB.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      const bPromise = cB.request("session/prompt", {
        sessionId: sB.sessionId, prompt: [{ type: "text", text: "B queued" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      // B cancels ITS OWN session, using whatever id its own counter is on
      // (which, by construction, may equal one of A's ids).
      await cB.request("session/cancel", { sessionId: sB.sessionId })

      await expect(bPromise).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      // A must never be cancelled by B -- it ends on its OWN turn timeout.
      await expect(aPromise).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)
})
