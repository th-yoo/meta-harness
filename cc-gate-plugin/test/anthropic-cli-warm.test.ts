// test/anthropic-cli-warm.test.ts — N3c-iv: `makeAnthropicCliWarmProvider`
// (src/gauge/providers/anthropic-cli-warm.ts) wraps the reviewed ACP client
// (acp-client.ts: `ensureDaemon`, `daemonCall`) as a `SendPromptProvider`.
// Fake daemons only (test/acp-fake-daemon.ts) — no WarmSession, no CLI, no
// credentials, no model, zero spend. Mirrors acp-client.test.ts's tempSock /
// LIVE_FAKES / afterEach discipline so a leaked socket under
// ~/.config/kkamak fails loudly rather than silently.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { makeAnthropicCliWarmProvider } from "../src/gauge/providers/anthropic-cli-warm.ts"
import { buildAgentOutgoingText } from "../src/gauge/agent-transport.ts"
import { GAUGE_ISOLATION, type WarmIsolation } from "../src/acp/acp-wire.ts"
import { resolveProvider } from "../src/gauge/send-prompt.ts"
import { envFingerprint } from "../src/acp/acp-paths.ts"
import { fakeDaemon, type FakeDaemonHandle } from "./acp-fake-daemon.ts"
import { shortSock } from "./sock-path.ts"

const HAIKU = "claude-haiku-4-5"

// Short names via sock-path.ts: darwin sun_path caps the path at 104B.
function tempSock(tag: string): string {
  return shortSock(`w-${tag}`)
}

/** The base env every fake-daemon test starts from. Every fake in this file
 * is built with `envFingerprint(ENV_with_socket)` so the fake's echo can
 * never silently disagree with what the client fingerprints. */
const ENV: Record<string, string | undefined> = { ...process.env, KKAMAK_ACP_TEST_MARKER: "anthropic-cli-warm-test" }

const LIVE_FAKES: FakeDaemonHandle[] = []

/** Sockets under ~/.config/kkamak that were ALREADY there before this file
 * ran. The leak check is a DELTA against this, not an absolute emptiness
 * assertion.
 *
 * Why: that directory is shared with the live host. Since the review-sensor
 * was armed (2026-08-06, ledger ts 1785996709580) it drives the ACP warm
 * lane, so a real `acp-<fp>.sock` is routinely listening while tests run —
 * and an absolute `toEqual([])` then fails every test in this file on any
 * armed host, wedging the gate that runs them. Observed live: 72 failures
 * from one pre-existing socket.
 *
 * The delta preserves the check exactly. What it guards is production code
 * ignoring `KKAMAK_ACP_SOCKET` and falling back to the default
 * fingerprint-derived path; such a leak is a NEW file appearing during a
 * test, which this still catches. It only stops blaming this file for
 * sockets it never created. */
const dirOf = () => path.join(process.env.HOME ?? "", ".config", "kkamak")
const acpSocksNow = (): string[] =>
  fs.existsSync(dirOf()) ? fs.readdirSync(dirOf()).filter((f) => f.startsWith("acp-")) : []
const PRE_EXISTING = new Set(acpSocksNow())

afterEach(() => {
  while (LIVE_FAKES.length) { const f = LIVE_FAKES.pop()!; try { f.stop() } catch { /* ignore */ } }
  const leaked = acpSocksNow().filter((f) => !PRE_EXISTING.has(f))
  expect(leaked).toEqual([])
})

/** The fake daemon is already listening BEFORE the provider is called, so
 * `ensureDaemon`'s step-1 probe succeeds immediately and nothing is ever
 * spawned — every test here is zero-CLI, zero-spend by construction. */
function envWithFake(tag: string, answer: Parameters<typeof fakeDaemon>[1]["answer"], fakeOpts: Partial<Parameters<typeof fakeDaemon>[1]> = {}) {
  const sock = tempSock(tag)
  const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
  const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer, ...fakeOpts })
  LIVE_FAKES.push(fake)
  return { env, fake }
}

describe("makeAnthropicCliWarmProvider (fake daemons only — no CLI, no model)", () => {
  test("1. ok path end-to-end: UNDATED evidence key for the requested undated model -> ok, model=requested, canonicalModel per rule", async () => {
    const { env } = envWithFake("ok-undated", "ok", { model: HAIKU, canonicalModel: "" })
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({
      ok: true,
      text: "ANSWER",
      model: HAIKU, // requested literal
      canonicalModel: HAIKU, // daemon's canonicalModel was "" -> falls back to the evidence key
    })
  })

  test("1b. canonicalModel primary branch: a NON-EMPTY daemon canonicalModel passes through verbatim", async () => {
    // Distinct from BOTH the evidence key and the requested string, so the
    // primary branch (`outcome.canonicalModel || outcome.model`'s left
    // side) is exercised, not merely reachable. Proven via the dated-key
    // prefix rule (modelProvenBy's second branch: key.startsWith(`${requested}-`)).
    const { env } = envWithFake("canonical-nonempty", "ok", {
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
    const { env } = envWithFake("canonical-fallback-dated", "ok", { canonicalModel: "" })
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
    const { env } = envWithFake("wrong-family", "ok", { model: "claude-opus-4-1", canonicalModel: "" })
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("hello", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("3a. daemon no-call maps through unchanged", async () => {
    const { env } = envWithFake("nocall", "no-call")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "no-call" })
  })

  test("3b. daemon call-consumed maps through unchanged", async () => {
    const { env } = envWithFake("consumed", "call-consumed")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("4. -32002 pool-exhausted from the fake -> no-call (wire-contract regression, through daemonCall's own L3 step-i)", async () => {
    const { env } = envWithFake("pool-exhausted", "pool-exhausted")
    const provider = makeAnthropicCliWarmProvider(env)
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(outcome).toEqual({ ok: false, kind: "no-call" })
  })

  test("5. schema present -> captured prompt carries buildAgentOutgoingText's trailing instruction; absent -> bare prompt", async () => {
    const { env, fake } = envWithFake("schema", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }

    await provider("bare prompt text", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm" })
    expect(fake.promptParams()?.prompt[0]?.text).toBe("bare prompt text")

    await provider("with schema", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm", schema })
    expect(fake.promptParams()?.prompt[0]?.text).toBe(buildAgentOutgoingText("with schema", schema))
    expect(fake.promptParams()?.prompt[0]?.text).toContain("Respond with ONLY a JSON object matching this schema")
  })

  test("6. isolation passed through deep-equal (fake asserts _meta.kkamak.isolation)", async () => {
    const { env, fake } = envWithFake("isolation", "ok")
    const provider = makeAnthropicCliWarmProvider(env)
    const customIsolation: WarmIsolation = {
      ...GAUGE_ISOLATION, systemPrompt: "CLI-WARM-PROVIDER-ISOLATION-MARKER", title: "kkamak-cli-warm-test",
    }
    await provider("x", { model: HAIKU, isolation: customIsolation, provider: "anthropic-cli-warm" })
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).toEqual(customIsolation)
    // discriminates on VALUE, not just presence
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).not.toEqual(GAUGE_ISOLATION)
  })

  test("7. timeoutMs mapping is observable: short timeout + hanging fake -> call-consumed within budget, not the default leg", async () => {
    const { env, fake } = envWithFake("timeout", "hang")
    const provider = makeAnthropicCliWarmProvider(env)
    const t0 = Date.now()
    const outcome = await provider("x", { model: HAIKU, isolation: GAUGE_ISOLATION, provider: "anthropic-cli-warm", timeoutMs: 500 })
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
    expect(Date.now() - t0).toBeLessThan(1_500) // well under ACP_BUDGET.daemonLegMs (36_000)
    expect(fake.sawPrompt()).toBe(true) // it really did cross the send boundary
  })

  test("8. maxTokens ignored: passing it changes NOTHING on the wire (session/new + prompt frames byte-stable)", async () => {
    const { env, fake } = envWithFake("maxtokens", "ok")
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
    makeAnthropicCliWarmProvider(ENV)
    const after = resolveProvider("anthropic-cli-warm")
    expect(after).toBe(before)
  })
})
