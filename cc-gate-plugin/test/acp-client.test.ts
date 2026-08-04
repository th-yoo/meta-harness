// test/acp-client.test.ts — N3b: acp-client.ts's `daemonCall` and
// `ensureDaemon` over SCRIPTED FAKE daemons (no WarmSession, no CLI, no
// credentials, no model) plus one real-daemon e2e smoke test.
//
// Delta-memo governs over task-6-brief.md prose where they conflict:
//  · `_meta` is namespaced under `kkamak` (T2n) — acp-fake-daemon.ts already
//    produces that shape; nothing here constructs a bare `_meta.model`.
//  · the observed modelUsage key on the REAL driving path is UNDATED —
//    the e2e test uses HAIKU_OBSERVED_KEY, never a fabricated dated
//    literal. The FAKE daemon's own default (dated) is a DIFFERENT,
//    deliberately-scripted fixture per task-6-brief.md, not a claim about
//    the real API.
//  · `daemonCall`'s public signature has no session-bearing surface —
//    sessions are internal (user ruling, send-prompt-interface.md §4).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { daemonCall, ensureDaemon } from "../src/gauge/acp-client.ts"
import { buildAgentOutgoingText } from "../src/gauge/agent-transport.ts"
import { ACP_BUDGET, modelProvenBy } from "../src/gauge/acp-wire.ts"
import { envFingerprint, spawnLockPath, tryCreateLock } from "../src/gauge/acp-paths.ts"
import { fakeDaemon } from "./acp-fake-daemon.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

const HAIKU = "claude-haiku-4-5"

/** Every test builds its OWN socket path under tmpdir — no test may ever
 * touch the real ~/.config/kkamak store (asserted in afterEach below). */
function tempSock(tag: string): string {
  return path.join(tmpdir(), `kkamak-acp-client-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
}

/** The base env every fake-daemon test starts from. `envFingerprint` is
 * computed from THIS object, and every fake in this file MUST be built
 * with `envFingerprint(ENV)` (or a deliberately-mismatched variant) so a
 * fake's echo can never silently disagree with what the client itself
 * fingerprints. */
const ENV: Record<string, string | undefined> = { ...process.env, KKAMAK_ACP_TEST_MARKER: "acp-client-test" }

const LIVE_FAKES: Array<{ stop: () => void }> = []
const LIVE_DAEMONS: Array<{ sock: string; spawnLog: string }> = []

function killDaemonByPid(sock: string, spawnLog: string): void {
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

afterEach(() => {
  while (LIVE_FAKES.length) { const f = LIVE_FAKES.pop()!; try { f.stop() } catch { /* ignore */ } }
  while (LIVE_DAEMONS.length) { const d = LIVE_DAEMONS.pop()!; killDaemonByPid(d.sock, d.spawnLog) }
  const dir = path.join(process.env.HOME ?? "", ".config", "kkamak")
  const leaked = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("acp-")) : []
  expect(leaked).toEqual([])
})

async function waitForLines(file: string, n: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    let lines: string[] = []
    try { lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()) } catch { /* not yet */ }
    if (lines.length >= n || Date.now() > deadline) return lines
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("acp-client (fake daemons only — no CLI, no model)", () => {
  test("law L1: no daemon at all -> no-call, fast", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", {
      ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock`,
    })
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("round-trips against a scripted fake daemon -> ok, text, DATED model evidence", async () => {
    const sock = tempSock("ok")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("hello", HAIKU, env)
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") throw new Error("unreachable")
    expect(r.text).toBe("ANSWER")
    expect(r.model).toBe("claude-haiku-4-5-20251001")
    expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
  })

  test("law L3(i): ACP_ERR_CALL_CONSUMED maps to call-consumed, NOT no-call", async () => {
    const sock = tempSock("consumed")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "call-consumed" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L3(i): ACP_ERR_NO_CALL maps to no-call", async () => {
    const sock = tempSock("nocall")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "no-call" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("no-call")
  })

  test("law L3(i): data.callConsumed OVERRIDES a mismatched code", async () => {
    const sock = tempSock("mismatched")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "mismatched-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("call-consumed")   // the data field is authoritative
  })

  test("law L3(ii): a RECOGNIZED code with `data` ABSENT is HONOURED, both ways", async () => {
    const sockA = tempSock("codenodata-nocall")
    const envA = { ...ENV, KKAMAK_ACP_SOCKET: sockA }
    const fakeA = fakeDaemon(sockA, { fingerprint: envFingerprint(envA), answer: "no-call-code-no-data" })
    LIVE_FAKES.push(fakeA)
    expect((await daemonCall("x", HAIKU, envA)).kind).toBe("no-call")

    const sockB = tempSock("codenodata-consumed")
    const envB = { ...ENV, KKAMAK_ACP_SOCKET: sockB }
    const fakeB = fakeDaemon(sockB, { fingerprint: envFingerprint(envB), answer: "consumed-code-no-data" })
    LIVE_FAKES.push(fakeB)
    expect((await daemonCall("x", HAIKU, envB)).kind).toBe("call-consumed")
  })

  test("law L2: a NON-BOOLEAN data.callConsumed is an ambiguity, not a value", async () => {
    const sock = tempSock("nonboolean")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "nonboolean-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L2: an UNRECOGNIZED error code after the prompt was sent is call-consumed", async () => {
    const sock = tempSock("unknowncode")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "unknown-code" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("call-consumed")   // never no-call — that would double-spend
  })

  test("law L2: budget expiry after the prompt was sent is call-consumed", async () => {
    const sock = tempSock("hang")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "hang" })
    LIVE_FAKES.push(fake)
    const t0 = Date.now()
    const r = await daemonCall("x", HAIKU, env, { budgetMs: 500 })
    expect(r.kind).toBe("call-consumed")
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(fake.sawPrompt()).toBe(true)   // it really did cross the boundary
  })

  test("law L1: a daemon that dies before session/prompt is written is no-call", async () => {
    const sock = tempSock("die")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "die-before-prompt" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("law L1: a fingerprint mismatch refuses BEFORE sending anything", async () => {
    const sock = tempSock("fpmismatch")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint({ ...env, ANTHROPIC_BASE_URL: "http://other" }), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("ROUND-4 I4: lane selection and socket path do NOT change the client's fingerprint", async () => {
    const sock = tempSock("i4")
    const envA = { ...ENV, KKAMAK_ACP_SOCKET: sock, KKAMAK_GAUGE_TRANSPORT: "sdk" }
    const envB = { ...ENV, KKAMAK_ACP_SOCKET: sock, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" }
    expect(envFingerprint(envA)).toBe(envFingerprint(envB))
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(envA), answer: "ok" })
    LIVE_FAKES.push(fake)
    const rA = await daemonCall("x", HAIKU, envA)
    expect(rA.kind).toBe("ok")
    expect(fake.sawPrompt()).toBe(true)
    const rB = await daemonCall("x", HAIKU, envB)
    expect(rB.kind).toBe("ok")
  })

  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    const sock = tempSock("verbatim")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const outgoing = "the exact outgoing string"
    await daemonCall(outgoing, HAIKU, env)
    const params = fake.promptParams()
    expect(params?._meta.model).toBe(HAIKU)
    expect(params?.prompt[0]?.text).toBe(outgoing)
  })

  test("the default budget is the contract constant, not a local literal", () => {
    expect(ACP_BUDGET.daemonLegMs).toBe(36_000)
  })

  test("buildAgentOutgoingText is the SAME builder the one-shot lane uses", () => {
    const s = { type: "object" } as Record<string, unknown>
    expect(buildAgentOutgoingText("P", s)).toContain("Respond with ONLY a JSON object matching this schema")
    expect(buildAgentOutgoingText("P", undefined)).toBe("P")
  })

  test("ensureDaemon spawns exactly ONE serving daemon under concurrent callers", async () => {
    const sock = tempSock("concurrent")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const [a, b] = await Promise.all([
      ensureDaemon(env, { waitMs: 10_000 }),
      ensureDaemon(env, { waitMs: 10_000 }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    const lines = await waitForLines(spawnLog, 1, 2_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ROUND-4 I2: the spawned daemon binds the socket the CALLER named", async () => {
    const sock = tempSock("i2")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const ok = await ensureDaemon(env, { waitMs: 10_000 })
    expect(ok).toBe(true)
    expect(fs.existsSync(sock)).toBe(true)
    const dir = path.join(process.env.HOME ?? "", ".config", "kkamak")
    const leaked = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("acp-")) : []
    expect(leaked).toEqual([])
  }, 30_000)

  test("ensureDaemon() defaults to waitMs 0: returns false immediately and still kicks a spawn", async () => {
    const sock = tempSock("waitms0")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const t0 = Date.now()
    const ok = await ensureDaemon(env)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    const lines = await waitForLines(spawnLog, 1, 15_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ensureDaemon NEVER throws on an unwritable socket dir", async () => {
    await expect(ensureDaemon({ ...ENV, KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }, { waitMs: 0 }))
      .resolves.toBe(false)
  })

  test("a caller that LOSES the spawn lock never unlinks it", async () => {
    const sock = tempSock("loselock")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const lockPath = spawnLockPath(env)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const created = tryCreateLock(lockPath, { pid: 999_999, ts: Date.now() })
    expect(created).toBe(true)
    try {
      const ok = await ensureDaemon(env, { waitMs: 0 })
      expect(ok).toBe(false)
      expect(fs.existsSync(lockPath)).toBe(true)
    } finally {
      try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
    }
  })
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-client e2e (real daemon + SSE stub)", () => {
  test("ensureDaemon + daemonCall against the real daemon", async () => {
    const sock = tempSock("e2e")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const cap = stubServer(() => sseText("ANSWER"))
    try {
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_SOCKET: sock,
        KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
        KKAMAK_ACP_IDLE_MS: "8000",
      }
      const started = await ensureDaemon(env, { waitMs: 15_000 })
      expect(started).toBe(true)
      const r = await daemonCall("hello", HAIKU, env)
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") throw new Error("unreachable")
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally {
      cap.stop()
    }
    // SIGTERM by PID from the spawn log (never pkill -f, §6e / round-4 I9).
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
    const gone = await (async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (!fs.existsSync(sock)) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return !fs.existsSync(sock)
    })()
    expect(gone).toBe(true)
  }, 60_000)
})
