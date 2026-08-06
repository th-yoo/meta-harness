import { describe, expect, test } from "bun:test"
import { WarmSession, selectEvidence } from "../src/acp/warm-session.ts"
import { modelProvenBy, CLI_SPAWN_BUDGET_MS, GAUGE_ISOLATION } from "../src/acp/acp-wire.ts"
import {
  HAS_CLAUDE_CODE_CREDENTIALS, sseText, hangFirstServer, until,
} from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

// Raised from 60s: with turnTimeoutMs floored at CLI_SPAWN_BUDGET_MS (8s),
// a hard-reset test's worst case is ~8s + hardGrace + a full respawn + a
// second turn — comfortably over 60s only if something is wrong, but the
// margin has to exist or a slow host produces a false failure.
const CLI_TEST_TIMEOUT_MS = 90_000
const HAIKU = "claude-haiku-4-5"
// What the stub DECLARES in message_start. Step 1a (2026-08-04, token-free
// gate probe, `.superpowers/sdd/2026-08-04-acp-warm-daemon/task-4-step1a-
// report.md`) measured that on the streaming-input + local-stub driving path
// these WarmSession tests use, this declared id does NOT propagate into
// modelUsage's key -- so it must never be read as a prediction of what
// TurnOutcome.model will be. Kept dated only because most tests below don't
// assert on the model at all and any string will do; this is what the real
// API and this repo's captured transcripts declare
// (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22).
const STUB_DECLARED_MODEL = "claude-haiku-4-5-20251001"
// What modelUsage IS ACTUALLY keyed by on THIS driving path (Step 1a,
// measured 2026-08-04, same report): the client-requested model id,
// verbatim -- identical to HAIKU. Tests that assert on TurnOutcome.model use
// THIS constant, never STUB_DECLARED_MODEL. The genuinely-differently-
// spelled-key case (real API keys modelUsage by a DATED snapshot for an
// undated request) is proven at the pure-function level by the
// `modelProvenBy` fixtures above and, end-to-end, by Task 6's `fakeDaemon`
// (its `model` default IS the dated form) -- neither goes through
// `sseText`'s `message_start`, so neither is affected by this finding.
const HAIKU_OBSERVED_KEY = HAIKU
// §6e/round-4 C3: the turn's timers start at the PUSH while the subprocess
// is still booting (§6d measured 1.25-1.46s). Every override below uses
// this floor; only hardGraceMs and queueWaitMs may be small, because
// neither measures generation.
const T = CLI_SPAWN_BUDGET_MS       // 8_000

// Review finding 3 (2026-08-04): `route()`'s USE of `modelProvenBy` --
// i.e. `warm-session.ts`'s `!t.observedModel ⇒ call-consumed` gate, and
// especially the multi-key branch -- was previously untested anywhere. The
// retargeted CLI test above only ever observes a SINGLE, MATCHING key
// (Step 1a: modelUsage's key tracks the client-requested model verbatim on
// this driving path, regardless of what the stub declares), so it cannot
// exercise a non-matching or multi-key result no matter what the stub is
// told to declare. `selectEvidence` is a pure function precisely so these
// shapes -- fabricated directly, no CLI spawn, no stub -- can be covered
// at all; this describe block carries NO credentials guard because it
// spawns nothing.
describe("selectEvidence (§6e model-evidence selection, pure -- no CLI, no stub)", () => {
  test("single matching key is accepted as evidence", () => {
    const usage = { "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" } }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("claude-haiku-4-5")
    expect(e.canonicalModel).toBe("claude-haiku-4-5")
  })

  test("single NON-matching key proves nothing: empty evidence, so route() reports call-consumed, never a silent ok", () => {
    const usage = { "claude-opus-5-20260101": { outputTokens: 5, canonicalModel: "claude-opus-5" } }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("")
    expect(e.canonicalModel).toBe("")
  })

  test("empty modelUsage (the /clear synthetic-result shape, and a genuinely evidence-free result) is empty evidence", () => {
    expect(selectEvidence({}, HAIKU)).toEqual({ model: "", canonicalModel: "" })
    expect(selectEvidence(undefined, HAIKU)).toEqual({ model: "", canonicalModel: "" })
  })

  test("multi-key: an auxiliary model with ZERO output tokens does not block the provable key", () => {
    // "claude-3-5-haiku-20241022" is a genuinely DIFFERENT model (an older
    // snapshot, e.g. a title-generation aux call) -- modelProvenBy must
    // reject it as evidence for a "claude-haiku-4-5" request, unlike a
    // same-family dated variant.
    const usage = {
      "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" },
      "claude-3-5-haiku-20241022": { outputTokens: 0, canonicalModel: "claude-3-5-haiku-20241022" },
    }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("claude-haiku-4-5")
    expect(e.canonicalModel).toBe("claude-haiku-4-5")
  })

  test("multi-key: an auxiliary model with NONZERO output tokens makes the turn unprovable", () => {
    const usage = {
      "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" },
      "claude-3-5-haiku-20241022": { outputTokens: 2, canonicalModel: "claude-3-5-haiku-20241022" },
    }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("")
    expect(e.canonicalModel).toBe("")
  })
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("WarmSession (spawns bundled CLI)", () => {
  test("two records reuse one subprocess; the second context is clean; exactly one call each", async () => {
    let n = 0
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText(`ANSWER-${++n}`, STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r1 = await ws.oneShot("first record prompt", HAIKU, { recycle: true })
      const r2 = await ws.oneShot("second record prompt", HAIKU, { recycle: true })
      expect(r1.kind).toBe("ok")
      expect(r2.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)                        // exactly 1 model call per record
      const m2 = CAPTURED[1] as { messages: unknown[] }
      // THE binding assertion: the first record's text is gone from the
      // second turn's context — that is what "/clear reset the context"
      // means. The exact MESSAGE COUNT is now pinned (review finding 7,
      // 2026-08-04): the streaming-input protocol sends ONE user turn per
      // request (not a growing history array), and Step 4's measurement
      // (task-4-report.md) confirmed `messages.length === 1` on both the
      // warm post-/clear turn and the fresh one-shot turn — the `/clear`
      // echo residue (~506 B, measured) lives INSIDE that single message's
      // content blocks, not as extra array entries.
      expect(JSON.stringify(m2.messages)).not.toContain("first record prompt")
      expect(JSON.stringify(m2.messages)).toContain("second record prompt")
      expect(m2.messages.length).toBe(1)                     // bulk-history regression guard
      expect(ws.isWarm()).toBe(true)                         // no respawn between records
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("ROUND-4 C1, RETARGETED (Step 1a, 2026-08-04): WarmSession forwards modelUsage's KEY verbatim, and modelProvenBy accepts it", async () => {
    // This test used to assert `r.model === HAIKU_DATED` on the theory that
    // declaring a dated snapshot id in the stub's message_start makes the
    // real CLI/SDK key modelUsage by that same dated id. Step 1a (token-free
    // gate probe, `.superpowers/sdd/2026-08-04-acp-warm-daemon/
    // task-4-step1a-report.md`) measured that this is FALSE on the
    // streaming-input + local-stub driving path these WarmSession tests use:
    // modelUsage came back keyed by the UNDATED alias
    // ("claude-haiku-4-5") regardless of what message_start declared —
    // `sseText`'s declared id and modelUsage's key are NOT the same channel
    // here. Asserting the old dated expectation would fail a CORRECT
    // implementation on every credentialed host, so this test now asserts
    // the OBSERVED shape: the key WarmSession forwards equals the request,
    // verbatim, and modelProvenBy still accepts it (the degenerate but
    // real case of its matching rule).
    //
    // The genuinely-differently-spelled-key case this test originally meant
    // to lock down (a DATED modelUsage key proving an UNDATED request) is
    // NOT re-derivable through this stub layer per the finding above; it is
    // covered instead (a) at the pure-function level by the `modelProvenBy`
    // fixture tests above (`k.startsWith(m + "-")` case), and (b)
    // end-to-end by Task 6's `fakeDaemon`, whose `model` default IS the
    // dated form and which fabricates `_meta.model` directly on the ACP
    // wire rather than through `sseText`'s `message_start` — a channel Step
    // 1a did not implicate.
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("model-evidence record", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") return
      expect(r.model).toBe(HAIKU_OBSERVED_KEY)               // the KEY, verbatim — observed undated
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("ROUND-4 C1 corollary, RETARGETED (found live in this task, same mechanism as Step 1a): a stub-declared DIFFERENT model does not make modelUsage's key differ -- WarmSession forwards it verbatim and it still proves the request", async () => {
    // This test used to assert that declaring a genuinely different model
    // ("claude-opus-5-20260101") in the stub's message_start would make
    // WarmSession either report `call-consumed` or an `ok` whose model
    // fails `modelProvenBy`. A direct token-free probe (2026-08-04, same
    // stub/streaming-input mechanism as Step 1a) found this premise FALSE
    // on this driving path: modelUsage came back keyed by
    // "claude-haiku-4-5" -- the CLIENT-REQUESTED model -- regardless of the
    // stub's declared "claude-opus-5-20260101". message_start's declared
    // model and modelUsage's key are not the same channel here; this is
    // the DIFFERENT-MODEL corollary of the "ROUND-4 C1, RETARGETED" test
    // above (that one covers a differently-SPELLED key for the SAME model,
    // this one covers a genuinely different model).
    //
    // The scenario this test originally meant to lock down -- WarmSession
    // reporting evidence that does not reconcile, never a silent `ok` stamp
    // -- is NOT reachable through this stub layer for the same structural
    // reason, and is proven instead at the pure-function level:
    // acp-wire.test.ts:114-115 locks
    // `modelProvenBy("claude-opus-5", "claude-haiku-4-5") === false` (and
    // the dated-opus variant). This test is retargeted to lock the
    // mechanism it CAN observe on this path: the stub's declared model is
    // inert to modelUsage's key, and the forwarded key still proves the
    // request.
    const cap = stubServer(() => sseText("ANSWER", "claude-opus-5-20260101"))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("wrong model record", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") return
      expect(r.model).toBe(HAIKU_OBSERVED_KEY)
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("recycle:false keeps context (ACP multi-prompt session semantics)", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      await ws.oneShot("turn one marker", HAIKU, { recycle: true })
      await ws.oneShot("turn two", HAIKU, { recycle: false })
      expect(JSON.stringify((CAPTURED[1] as { messages: unknown[] }).messages)).toContain("turn one marker")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5: a SENT turn that times out is call-consumed (never partial text); session stays warm", async () => {
    // The endpoint ACCEPTS the connection and never answers: the request is
    // in flight at the API, so the conservative side of the ambiguity is
    // "consumed" — the caller must NOT fall back.
    // Wall clock: r1 pushes at t0, the subprocess reaches the stub by
    // ~t0+1.5s and hangs; the turn timer fires at t0+8s (interrupt) and the
    // hard timer at t0+12s at the latest. r2 then runs on a warm-or-fresh
    // session with its OWN 8s budget, which covers a respawn. ~22s worst
    // case, well inside the 90s test timeout.
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r1 = await ws.oneShot("hanging record", HAIKU, { recycle: true })
      expect(r1.kind).toBe("call-consumed")                  // NOT ok, NOT no-call
      expect("text" in r1).toBe(false)                       // no truncated text escapes
      const r2 = await ws.oneShot("normal record", HAIKU, { recycle: true })
      expect(r2.kind).toBe("ok")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L6: a 500 (api_retry) is call-consumed and the retry is never consumed as a result", async () => {
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER", STUB_DECLARED_MODEL)))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("retry-provoking record", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
      expect(n).toBeLessThanOrEqual(2)   // the abort races an in-flight retry; a THIRD request means it never landed
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5 has NO connection-only exception: an unreachable endpoint AFTER the push is call-consumed", async () => {
    // Round-3 finding C1. An earlier draft classified `api_retry` with
    // `error_status === null` as no-call, on the theory that a
    // connection-level failure proves nothing reached the model.
    // sdk.d.ts:2839-2841 documents that status as covering "connection
    // errors (e.g. TIMEOUTS) that had no HTTP response" — and a read
    // timeout is exactly the billed-but-unanswered case, so that carve-out
    // could spend a SECOND model call on one record. It also bought
    // nothing: the daemon and its clients are fingerprint-matched on the
    // same endpoint, so an endpoint the daemon cannot reach the fallback
    // cannot reach either. This test is the lock on its removal.
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r = await ws.oneShot("x", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
    } finally { ws.close() }
  }, CLI_TEST_TIMEOUT_MS)

  test("FIFO: concurrent oneShots serialize; BOTH resolve; two calls total", async () => {
    // The queued caller's promise must resolve. A design that lets execute()
    // overwrite the queue-waiter's resolver deadlocks here.
    // queueWaitMs is raised explicitly so this test measures FIFO, not the
    // queue cap: turn A pays a ~1.5s spawn plus a response, and the DEFAULT
    // 6s cap would make the assertion depend on host speed. The cap itself
    // has its own dedicated test below.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { queueWaitMs: 60_000 })
    try {
      const [a, b] = await Promise.all([
        ws.oneShot("record A", HAIKU, { recycle: true }),
        ws.oneShot("record B", HAIKU, { recycle: true }),
      ])
      expect(a.kind).toBe("ok")
      expect(b.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L4: a turn still queued at its queue-wait cap resolves no-call, provably unsent", async () => {
    // queueWaitMs is the ONLY short timer here — it measures queue
    // residency, not generation, so it is not bound by CLI_SPAWN_BUDGET_MS.
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 500 })
    try {
      const first = ws.oneShot("occupies the session", HAIKU, { recycle: true })
      const queued = await ws.oneShot("never gets its turn", HAIKU, { recycle: true })
      expect(queued.kind).toBe("no-call")        // never reached execute()
      await first                                 // drain, whatever it becomes (<= ~10s)
      expect(cap.count()).toBe(1)                 // the queued turn sent NOTHING
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel(tag) drops only that caller's turn, never the other caller's in-flight turn", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "B" })
      expect(ws.cancel("B")).toBe("queued-dropped")
      expect((await queued).kind).toBe("no-call")
      expect(ws.cancel("nobody")).toBe("unknown")     // must not touch A
      const a = await inflight
      expect(a.kind).toBe("call-consumed")            // A ended on its OWN timeout, not B's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel scoping, WRONG-OWNER shape: a cancel naming the QUEUED turn's tag never reaches the IN-FLIGHT turn", async () => {
    // Round-3 finding C2's regression lock. The sibling test above puts the
    // named turn in `pending`, which `cancel()` searches FIRST — so it
    // passes even when tags collide across callers. This one names a tag
    // that ONLY the in-flight turn holds while a DIFFERENT-tagged turn is
    // queued, and then a tag that nobody holds, proving the search never
    // falls through to "whoever happens to be current". Task 5 additionally
    // mints globally-unique tags so a collision cannot arise on the wire.
    //
    // Round-4 I11: the `until(...)` gate is REQUIRED. `cancel` on a turn
    // that has not yet PUSHED is `unsent-dropped`, not `interrupted` — a
    // correct implementation, since cancelling must never be what causes a
    // model call. Waiting for the stub to see A's request is the only
    // observable proof A crossed the send boundary, and the CLI takes
    // 1.25-1.46s to get there.
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "tag-A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "tag-B" })
      expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)   // A has been SENT
      expect(ws.cancel("tag-C")).toBe("unknown")       // nobody: must be a no-op
      expect(ws.cancel("tag-A")).toBe("interrupted")   // the in-flight turn, by ITS OWN tag
      const a = await inflight
      expect(a.kind).toBe("call-consumed")             // it was SENT; never no-call
      const b = await queued
      expect(b.kind === "ok" || b.kind === "no-call").toBe(true)   // untouched by A's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancelling a turn BEFORE it pushes drops it — a cancel must never cause a model call", async () => {
    // Round-4 I11's direct lock. `this.current` is assigned BEFORE the
    // recycle leg, so for up to clearTimeoutMs a turn is current-but-unsent.
    // The old design interrupted there, left `done` false, and let execute()
    // push the prompt a moment later: the cancel CAUSED the spend it was
    // asked to prevent, and the interrupt() may have aborted the in-flight
    // /clear instead of a turn.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      // Turn 1 warms the session so turn 2 takes the /clear path (the window
      // this test needs); wait for it to finish.
      expect((await ws.oneShot("warm the session", HAIKU, { recycle: true })).kind).toBe("ok")
      const before = CAPTURED.length                     // 1
      const second = ws.oneShot("must never be sent", HAIKU, { recycle: true, tag: "C" })
      // Cancel immediately: the turn is current, the /clear is in flight,
      // nothing has been pushed for THIS turn.
      const verdict = ws.cancel("C")
      expect(verdict === "unsent-dropped" || verdict === "queued-dropped").toBe(true)
      expect((await second).kind).toBe("no-call")        // provably unsent
      await new Promise((r) => setTimeout(r, 2_000))     // let any stray push land
      expect(CAPTURED.length).toBe(before)               // ZERO extra model calls
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("a hardReset with a turn QUEUED behind it does not kill the replacement session", async () => {
    // Round-3 finding C3's regression lock. hardTimer fires ~1ms after the
    // turn timer, so hardReset() lands while interrupt() is still in
    // flight; the OLD pump's `for await` only unwinds on the subprocess
    // exit event, by which time drain() has already started turn B on a
    // NEW Query. Without the `this.q !== q` generation guard the dying pump
    // settles B and destroys B's session.
    //
    // Round-4 C3: turnTimeoutMs is 8_000, NOT 1_000. At 1_000 turn A is
    // hard-reset before its request ever reaches the stub (the subprocess
    // takes 1.25-1.46s to boot), so B becomes the stub's FIRST request and
    // hangs, and a CORRECT implementation fails this test deterministically.
    // Wall clock now: A pushes at t0, reaches the stub ~t0+1.5s and hangs;
    // timer at t0+8s, hardTimer at t0+8.001s; B runs on a fresh Query,
    // pushes at ~t0+8s, reaches the stub ~t0+9.5s as request #2 and is
    // answered — inside B's own 8s budget. ~10s total.
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 1, queueWaitMs: 60_000 })
    try {
      const a = ws.oneShot("A hangs and is hard-reset", HAIKU, { recycle: true })
      const b = ws.oneShot("B must survive the teardown", HAIKU, { recycle: true })
      expect((await a).kind).toBe("call-consumed")   // A was sent
      expect((await b).kind).toBe("ok")              // B ran on the REPLACEMENT Query
      expect(ws.isWarm()).toBe(true)                 // and that Query is still alive
      expect(cap.count()).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("close() settles every outstanding caller — no hanging promises", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 30_000, hardGraceMs: 5_000, queueWaitMs: 60_000 })
    const inflight = ws.oneShot("A", HAIKU, { recycle: true })
    const queued = ws.oneShot("B", HAIKU, { recycle: true })
    // Deterministic instead of a fixed sleep: close only once A has crossed
    // the send boundary, so `call-consumed` is an assertion rather than a
    // coin flip on spawn latency (round-4 C3/I10).
    expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)
    ws.close()
    const [a, b] = await Promise.all([inflight, queued])
    expect(a.kind).toBe("call-consumed")            // sent, therefore consumed
    expect(b.kind).toBe("no-call")                  // queued: provably unsent
    expect(ws.isWarm()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)

  test("close() during the SDK import does not spawn a subprocess or send anything", async () => {
    // Round-4 I3. `ensure()` checked `this.closed` only at entry, so a
    // close landing inside `await import(...)` was followed by a Query
    // construction, a CLI spawn and a real push: a LEAKED subprocess and a
    // spent model call on a terminated session, with isWarm() true after
    // close(). The import is the widest such window (~84ms measured) and
    // this test drives it directly.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    const p = ws.oneShot("must never reach the model", HAIKU, { recycle: true })
    ws.close()                                       // same tick as the enqueue
    expect((await p).kind).toBe("no-call")
    await new Promise((r) => setTimeout(r, 3_000))   // generous: a leaked spawn would land here
    expect(CAPTURED.length).toBe(0)
    expect(ws.isWarm()).toBe(false)
    expect(ws.turnInFlight()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)
})

// S0 (2026-08-04): WarmSession takes an `isolation` option, defaulting to
// GAUGE_ISOLATION. Neither test below spawns the CLI — WarmSession's
// constructor never calls ensure()/query(), so both run unconditionally,
// with no HAS_CLAUDE_CODE_CREDENTIALS guard.
describe("WarmSession isolation option (S0 — construction only, no CLI spawn)", () => {
  test("GAUGE_ISOLATION is the §6d set, field for field", () => {
    expect(GAUGE_ISOLATION).toEqual({
      systemPrompt: "",
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      persistSession: false,
      strictMcpConfig: true,
      tools: [],
      title: "kkamak-gauge",
      thinking: { type: "disabled" },
    })
  })

  test("the DEFAULT isolation is the gauge one — omitting the option changes nothing", () => {
    // The regression guard for §6d/§6e: every existing caller constructs
    // WarmSession without `isolation` and must keep the exact wire shape the
    // daemon plan's Task 4 tests already pin.
    const ws = new WarmSession({ ...process.env })
    expect(ws.isolation).toEqual(GAUGE_ISOLATION)
    ws.close()
  })
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("a custom isolation reaches the wire (S0)", () => {
  test("a non-empty systemPrompt is what the request carries", async () => {
    // The capability the whole pool plan rests on: a `reasoning` profile is
    // undeliverable if this literal stays hardcoded (review finding C1).
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url }, {
      isolation: { ...GAUGE_ISOLATION, systemPrompt: "MARKER-SYSTEM-PROMPT", title: "kkamak-reasoning" },
    })
    try {
      expect((await ws.oneShot("hi", HAIKU, { recycle: true })).kind).toBe("ok")
      expect(JSON.stringify(CAPTURED[0])).toContain("MARKER-SYSTEM-PROMPT")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)
})
