// test/anthropic-cli-warm.test.ts — N3c-iv: `makeAnthropicCliWarmProvider`
// (src/gauge/providers/anthropic-cli-warm.ts) wraps the ACP warm lane as a
// `SendPromptProvider`. Fake daemons only — no WarmSession, no CLI, no
// credentials, no model, zero spend.
//
// gauge-cliwarm-swap: ported off the OLD in-repo unix-socket stack (this
// file used to isolate via `KKAMAK_ACP_SOCKET` + `test/acp-fake-daemon.ts`'s
// unix-socket fake). Both mechanisms are dead against the client
// `anthropic-cli-warm.ts` now uses: `KKAMAK_ACP_SOCKET` is RETIRED upstream
// (on `@th-yoo/cc-api-daemon`'s fingerprint denylist, no implementation
// reads it), and the new client speaks WebSocket, which the in-repo unix
// fake cannot serve. This file now uses the package's OWN published test
// machinery (`@th-yoo/cc-api-daemon/testing`) — the same `fakeDaemon` the
// package's own suite and `test/review-sensor-runner-daemon.test.ts` use —
// over a real loopback WebSocket, plus `tempEnv` for a throwaway `HOME` per
// test.
//
// ISOLATION IS NOT OPTIONAL (package CLAUDE.md + task brief): `discoveryPath`
// falls back to the REAL `os.homedir()` when `env.HOME` is absent, and a
// fake's `stop()` DELETES the discovery file it published. This host runs a
// live daemon with a populated `~/.config/acpd/` — an ungoverned env here
// could read, and on cleanup DELETE, that daemon's own discovery entry. The
// file's old socket-name leak check (retired with the socket) is replaced
// below by a delta check against the REAL `~/.config/acpd/` (see
// `PRE_EXISTING_REAL_ACPD`), checked in both directions: no new file
// appeared, and nothing pre-existing (including the live daemon's own entry)
// went missing.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeAnthropicCliWarmProvider } from "../src/gauge/providers/anthropic-cli-warm.ts"
import { buildAgentOutgoingText } from "../src/gauge/agent-transport.ts"
import { GAUGE_ISOLATION, type WarmIsolation } from "../src/acp/acp-wire.ts"
import { resolveProvider } from "../src/gauge/send-prompt.ts"
import { resetAcpClientSingleton } from "../src/acp-client-singleton.ts"
import { ACP_BUDGET, envFingerprint } from "@th-yoo/cc-api-daemon"
import {
  fakeDaemon,
  tempEnv,
  cleanupTempHomes,
  reapDaemons,
  readDiscovery,
  waitForLines,
  discoveryPath,
  LIVE_DAEMONS,
  type FakeDaemonHandle,
} from "@th-yoo/cc-api-daemon/testing"

const HAIKU = "claude-haiku-4-5"

const LIVE_FAKES: FakeDaemonHandle[] = []

/** The REAL host's discovery dir — deliberately `os.homedir()`, never any
 * test env's `HOME` — mirrors exactly the fallback path `discoveryPath`
 * itself takes when an env's `HOME` is absent (acp-paths.ts). Nothing this
 * file does should ever touch it; the delta below proves that, in both
 * directions, every test. */
const REAL_ACPD_DIR = path.join(os.homedir(), ".config", "acpd")
const realAcpdFilesNow = (): string[] =>
  fs.existsSync(REAL_ACPD_DIR) ? fs.readdirSync(REAL_ACPD_DIR).filter((f) => f.startsWith("acp-")) : []
const PRE_EXISTING_REAL_ACPD = new Set(realAcpdFilesNow())

afterEach(() => {
  while (LIVE_FAKES.length) {
    const f = LIVE_FAKES.pop()!
    try {
      f.stop()
    } catch {
      /* ignore */
    }
  }
  // Defensive backstop (matches review-sensor-runner-daemon.test.ts's own
  // precedent): if `ensureDaemon` ever fell through to actually spawning a
  // real daemon, this reaps it by pid rather than leaving it alive for the
  // full 900s idle budget.
  reapDaemons()
  cleanupTempHomes()
  // Every consumer routing through the singleton (this file now does, via
  // anthropic-cli-warm.ts) must reset it between tests, or a `capturedEnv`
  // pinned by an earlier test — or an earlier FILE in the same `bun test`
  // process — silently redirects a later test's `ensureDaemon`/`daemonCall`
  // away from ITS OWN `tempEnv`-scoped fake (acp-client-singleton.ts's own
  // header explains why in detail).
  resetAcpClientSingleton()

  // The replacement for the old socket-leak delta check (retired with
  // KKAMAK_ACP_SOCKET): the analogous hazard on this client is the REAL
  // host's ~/.config/acpd/ (see this file's header). Both directions
  // checked — a NEW file appearing is exactly what a mis-homed fake would
  // leave behind; a PRE-EXISTING file (including the live daemon's own
  // acp-40b79c7ed346.json) going MISSING is exactly what a mis-homed fake's
  // `stop()` would do to it.
  const nowFiles = new Set(realAcpdFilesNow())
  const leaked = [...nowFiles].filter((f) => !PRE_EXISTING_REAL_ACPD.has(f))
  expect(leaked).toEqual([])
  const missing = [...PRE_EXISTING_REAL_ACPD].filter((f) => !nowFiles.has(f))
  expect(missing).toEqual([])
})

/** The fake daemon is already listening — and its discovery file already
 * published — BEFORE the provider is ever called, so `ensureDaemon`'s
 * step-1 probe succeeds immediately and nothing is ever spawned: every test
 * here is zero-CLI, zero-spend, zero-real-daemon by construction. Every env
 * comes from `tempEnv` (throwaway `HOME`) — never a bare `{...process.env}`
 * spread, which is the exact pattern that made the OLD version of this file
 * a live-daemon hazard. */
async function envWithFake(
  tag: string,
  answer: Parameters<typeof fakeDaemon>[1]["answer"],
  fakeOpts: Partial<Parameters<typeof fakeDaemon>[1]> = {},
): Promise<{ env: Record<string, string | undefined>; fake: FakeDaemonHandle }> {
  const env = tempEnv(tag)
  const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer, ...fakeOpts })
  LIVE_FAKES.push(fake)
  expect(readDiscovery(env)).toBeTruthy()
  return { env, fake }
}

describe("makeAnthropicCliWarmProvider (fake daemons only — no CLI, no model)", () => {
  test("1. ok path end-to-end: UNDATED evidence key for the requested undated model -> ok, model=requested, canonicalModel per rule", async () => {
    const { env } = await envWithFake("ok-undated", "ok", { model: HAIKU, canonicalModel: "" })

    // Defensive, matching review-sensor-runner-daemon.test.ts's own
    // precedent: SHOULD never be written to (the fake's discovery is
    // already published, so ensureDaemon's probe finds it immediately) — if
    // that assumption were ever wrong, this makes the fallback spawn
    // loggable and reapable instead of a silent 900s-idle leak.
    const spawnLog = path.join(env.HOME!, "spawnlog")
    env.ACP_TEST_SPAWN_LOG = spawnLog
    LIVE_DAEMONS.push({ spawnLog })

    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({
      ok: true,
      text: "ANSWER",
      model: HAIKU, // requested literal
      canonicalModel: HAIKU, // daemon's canonicalModel was "" -> falls back to the evidence key
    })

    // No real daemon was ever spawned.
    expect(await waitForLines(spawnLog, 1, 100)).toEqual([])
    expect(fs.existsSync(spawnLog)).toBe(false)
  })

  test("1b. canonicalModel primary branch: a NON-EMPTY daemon canonicalModel passes through verbatim", async () => {
    // Distinct from BOTH the evidence key and the requested string, so the
    // primary branch (`outcome.canonicalModel || outcome.model`'s left
    // side) is exercised, not merely reachable. Proven via the dated-key
    // prefix rule (modelProvenBy's second branch: key.startsWith(`${requested}-`)).
    const { env } = await envWithFake("canonical-nonempty", "ok", {
      model: `${HAIKU}-20251001`,
      canonicalModel: "claude-haiku-4-5-canonical-marker",
    })
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({
      ok: true,
      text: "ANSWER",
      model: HAIKU,
      canonicalModel: "claude-haiku-4-5-canonical-marker", // the daemon's own value, untouched
    })
  })

  test("1c. canonicalModel fallback branch: \"\" + a DATED evidence key DIFFERING from the requested string -> canonicalModel = the evidence key, NOT the requested string", async () => {
    // Test 1 alone cannot distinguish the correct fallback (evidence key)
    // from a subtly wrong one (requested string) because there the evidence
    // key EQUALS the requested model. Here the evidence key is dated
    // ("claude-haiku-4-5-20251001", the fake's own DEFAULT) while the
    // requested model is undated ("claude-haiku-4-5") -- proven via
    // modelProvenBy's dated-prefix branch, and the two candidate
    // canonicalModel values are now observably different.
    const { env } = await envWithFake("canonical-fallback-dated", "ok", { canonicalModel: "" })
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({
      ok: true,
      text: "ANSWER",
      model: HAIKU, // still the requested literal
      canonicalModel: `${HAIKU}-20251001`, // the evidence key -- NOT `HAIKU` (the requested string)
    })
  })

  test("2. modelProvenBy failure: evidence for a DIFFERENT model family -> call-consumed, not ok, not no-call", async () => {
    const { env } = await envWithFake("wrong-family", "ok", { model: "claude-opus-4-1", canonicalModel: "" })
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("3a. daemon no-call maps through unchanged", async () => {
    const { env } = await envWithFake("nocall", "no-call")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "no-call" })
  })

  test("3b. daemon call-consumed maps through unchanged", async () => {
    const { env } = await envWithFake("consumed", "call-consumed")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("4. -32002 pool-exhausted from the fake -> no-call (wire-contract regression, through daemonCall's own L3 step-i)", async () => {
    const { env } = await envWithFake("pool-exhausted", "pool-exhausted")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "no-call" })
  })

  test("5. schema present -> captured prompt carries buildAgentOutgoingText's trailing instruction; absent -> bare prompt", async () => {
    const { env, fake } = await envWithFake("schema", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }

    await provider("bare prompt text", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(fake.promptParams()?.prompt[0]?.text).toBe("bare prompt text")

    await provider("with schema", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm", schema })
    expect(fake.promptParams()?.prompt[0]?.text).toBe(buildAgentOutgoingText("with schema", schema))
    expect(fake.promptParams()?.prompt[0]?.text).toContain("Respond with ONLY a JSON object matching this schema")
  })

  test("6. isolation passed through deep-equal (fake asserts _meta.kkamak.isolation)", async () => {
    const { env, fake } = await envWithFake("isolation", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const customIsolation: WarmIsolation = {
      ...GAUGE_ISOLATION, systemPrompt: "CLI-WARM-PROVIDER-ISOLATION-MARKER", title: "kkamak-cli-warm-test",
    }
    await provider("x", { model: HAIKU, isolation: customIsolation, provider: "anthropic-cli-warm" })
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).toEqual(customIsolation)
    // discriminates on VALUE, not just presence
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).not.toEqual(GAUGE_ISOLATION)
  })

  test("7. timeoutMs mapping is observable: an ABOVE-floor budget threads verbatim onto daemonCall's budgetMs; omitted leaves it unset", async () => {
    // The old version of this test proved the mapping by racing a SHORT
    // timeoutMs (500ms) against a hanging fake daemon over the real wire.
    // That race is no longer reachable: gauge-cliwarm-swap Task 2 added a
    // floor guard to anthropic-cli-warm.ts that short-circuits to `no-call`
    // for ANY `timeoutMs <= ACP_BUDGET.daemonWorstCaseMs` (32_000) BEFORE
    // ensureDaemon/daemonCall are ever invoked (see that file's header) —
    // exercising the wire-level mapping now requires a value ABOVE the
    // floor, and this suite should not pay a real 32s+ wait per run just to
    // prove a pass-through assignment. This test instead intercepts the
    // REAL `daemonCall` the provider invokes via the singleton's own
    // injectable seam (`resetAcpClientSingleton`) — the wire-level
    // wait-for-a-real-timeout behavior is the PACKAGE's own concern,
    // already covered by its own suite, not something this file re-proves.
    const seenOpts: Array<{ budgetMs?: number }> = []
    resetAcpClientSingleton({
      ensureDaemon: async () => true,
      daemonCall: async (_text, _model, _env, opts) => {
        seenOpts.push(opts)
        return { kind: "ok", text: "ANSWER", model: HAIKU, canonicalModel: "" }
      },
    })
    const provider = makeAnthropicCliWarmProvider(tempEnv("timeout-mapping"))

    const aboveFloor = ACP_BUDGET.daemonWorstCaseMs + 4_000
    await provider("x", {
      model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm", timeoutMs: aboveFloor,
    })
    expect(seenOpts[0]?.budgetMs).toBe(aboveFloor)

    await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(seenOpts[1]?.budgetMs).toBeUndefined()
  })

  test("8. maxTokens ignored: passing it changes NOTHING on the wire (session/new + prompt frames byte-stable)", async () => {
    const { env, fake } = await envWithFake("maxtokens", "ok")
    const provider = makeAnthropicCliWarmProvider(env)

    // `sessionId` itself is minted fresh PER CALL by the daemon (spec §4:
    // "internally, one per request") — comparing it would fail even a
    // correct implementation. Everything else on the wire, including the
    // prompt text and `_meta`, must be byte-stable regardless of maxTokens.
    await provider("same text", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    const withoutMaxTokens = { sessionNew: fake.sessionNewParams(), prompt: fake.promptParams()?.prompt, meta: fake.promptParams()?._meta }

    await provider("same text", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm", maxTokens: 8192 })
    const withMaxTokens = { sessionNew: fake.sessionNewParams(), prompt: fake.promptParams()?.prompt, meta: fake.promptParams()?._meta }

    expect(withMaxTokens).toEqual(withoutMaxTokens)
  })

  test("9. no registration side effect: constructing the provider changes nothing in the registry", () => {
    // Order-independent by construction, unlike the old "must be undefined"
    // form: `resolveProvider` for this id is process-global (send-prompt.ts's
    // module-level `registry` Map), and `bun test` runs every test file in
    // one process — opencode-plugin/test/minimal-llm-acp.test.ts legitimately
    // registers this exact id (via minimal/llm-acp.ts's seatCall) and never
    // unregisters it, so whether this id already resolves to something by
    // the time this test runs depends on which OTHER files ran first. That
    // is not this test's business either way. What IS this test's business:
    // does constructing the provider, here, add or change a registration?
    // `before`/`after` bracket exactly one synchronous
    // `makeAnthropicCliWarmProvider` call with no `await` between them, so
    // no other test file's code can run in the gap — whatever the registry
    // already holds for this id (undefined, or another file's function) is
    // irrelevant; only a `registerProvider` call triggered by THIS
    // construction could move `after` away from `before`.
    const before = resolveProvider("anthropic-cli-warm")
    makeAnthropicCliWarmProvider(tempEnv("registry"))
    const after = resolveProvider("anthropic-cli-warm")
    expect(after).toBe(before)
  })
})

describe("budgetMs floor guard (gauge-cliwarm-swap Task 2 — live now that this file left the old client)", () => {
  test("timeoutMs AT the floor (ACP_BUDGET.daemonWorstCaseMs) short-circuits to no-call BEFORE the daemon is ever touched, and logs a diagnostic naming the value and the floor", async () => {
    // `<=` mirrors the package's own refusal condition (`dw >= budgetMs`)
    // exactly — equality is already a failure there, so the boundary value
    // itself (not floor-1) is what proves the guard's comparison operator is
    // right, not just its ballpark.
    const { env, fake } = await envWithFake("floor-guard-at-floor", "ok")
    const provider = makeAnthropicCliWarmProvider(env)

    const originalConsoleError = console.error
    const errorCalls: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    let outcome: Awaited<ReturnType<typeof provider>>
    try {
      outcome = await provider("x", {
        model: HAIKU,
        isolation: GAUGE_ISOLATION,
        provider: "anthropic-cli-warm",
        timeoutMs: ACP_BUDGET.daemonWorstCaseMs,
      })
    } finally {
      console.error = originalConsoleError
    }

    expect(outcome).toEqual({ ok: false, kind: "no-call" })
    // Never even reached the wire: the fake would have answered "ok" for
    // real (session/new -> session/prompt), so either having happened here
    // would prove the guard did NOT short-circuit before ensureDaemon.
    expect(fake.sessionNewParams()).toBeUndefined()
    expect(fake.sawPrompt()).toBe(false)

    expect(errorCalls.length).toBe(1)
    const message = String(errorCalls[0]![0])
    expect(message).toContain("anthropic-cli-warm")
    expect(message).toContain(String(ACP_BUDGET.daemonWorstCaseMs))
  })

  test("timeoutMs strictly ABOVE the floor does not trigger the guard: reaches the wire normally", async () => {
    const { env, fake } = await envWithFake("floor-guard-above", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", {
      model: HAIKU,
      isolation: GAUGE_ISOLATION,
      provider: "anthropic-cli-warm",
      timeoutMs: ACP_BUDGET.daemonWorstCaseMs + 1,
    })
    expect(outcome.ok).toBe(true)
    expect(fake.sawPrompt()).toBe(true)
  })

  test("timeoutMs omitted entirely never triggers the guard (undefined is not <= the floor)", async () => {
    const { env, fake } = await envWithFake("floor-guard-omitted", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome.ok).toBe(true)
    expect(fake.sawPrompt()).toBe(true)
  })
})

describe("HOME isolation (gauge-cliwarm-swap Task 3 — the live-daemon-safety guard)", () => {
  test("negative: discoveryPath(env) for this file's envs never resolves under the real host's os.homedir()", () => {
    // The exact hazard the task brief names: `discoveryPath` (acp-paths.ts)
    // falls back to `os.homedir()` when `env.HOME` is absent, and a fake's
    // `stop()` DELETES the discovery file it published — so an ungoverned
    // env here could read, and on cleanup DELETE, the live daemon's own
    // discovery entry on this host. Every env this file hands to
    // ensureDaemon/daemonCall/fakeDaemon comes from `tempEnv`, which always
    // sets a throwaway `HOME` — this proves that structurally, not just by
    // convention (the file's own `PRE_EXISTING_REAL_ACPD` delta check in
    // `afterEach` is the runtime backstop; this is the static proof).
    const env = tempEnv("home-safety-check")
    expect(env.HOME).toBeTruthy()
    expect(env.HOME).not.toBe(os.homedir())
    const dp = discoveryPath(env)
    expect(dp.startsWith(os.homedir())).toBe(false)
    expect(dp.startsWith(env.HOME!)).toBe(true)
  })
})
