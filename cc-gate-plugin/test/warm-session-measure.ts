// Task 4 Step 4 measurement script — token-free (ANTHROPIC_BASE_URL pins
// both lanes at a local SSE stub; no real endpoint is ever reachable).
// Committed per CLAUDE.md's "reusable scripts / recipes / procedures →
// the repo" rule (finding 5, task-4 review, 2026-08-04): this was
// originally written as a scratch script under /mnt/d/tmp/, which is
// explicitly host-local and does NOT travel — the spec's §6d/§6e
// /clear-residue figures are derived from this script's output, so a
// second host (or a later Task 6/9 re-run) must be able to reproduce them
// without re-deriving the script from prose. NOT matched by bun's test
// glob (no `describe`/`test` calls) — same convention as sdk-stub.ts and
// agent-cli-stub.ts. Run with:
//   cd cc-gate-plugin && bun test/warm-session-measure.ts
import { WarmSession } from "../src/acp/warm-session.ts"
import { agentSdkCall } from "../src/gauge/agent-transport.ts"
import { sseText } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"
import { modelProvenBy } from "../src/acp/acp-wire.ts"

const HAIKU = "claude-haiku-4-5"
const PROMPT = "measure this record's request bytes"

// ---- (a) first-record vs steady-state latency, warm lane ----
{
  const CAPTURED: Array<Record<string, unknown>> = []
  const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU) })
  const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
  const t0 = performance.now()
  const r1 = await ws.oneShot(PROMPT, HAIKU, { recycle: true })
  const t1 = performance.now()
  const r2 = await ws.oneShot(PROMPT, HAIKU, { recycle: true })
  const t2 = performance.now()
  const r3 = await ws.oneShot(PROMPT, HAIKU, { recycle: true })
  const t3 = performance.now()
  console.log("=== (a) latency ===")
  console.log("record 1 (cold spawn):", (t1 - t0).toFixed(1), "ms, kind:", r1.kind)
  console.log("record 2 (warm+/clear):", (t2 - t1).toFixed(1), "ms, kind:", r2.kind)
  console.log("record 3 (warm+/clear):", (t3 - t2).toFixed(1), "ms, kind:", r3.kind)
  ws.close(); cap.stop()
}

// ---- (b) request bytes: post-/clear warm turn vs fresh one-shot agentSdkCall ----
{
  const CAPTURED_WARM: Array<Record<string, unknown>> = []
  const capWarm = stubServer((c) => { CAPTURED_WARM.push(c.body); return sseText("ANSWER", HAIKU) })
  const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: capWarm.url })
  await ws.oneShot("first turn to warm the session", HAIKU, { recycle: true })
  await ws.oneShot(PROMPT, HAIKU, { recycle: true })   // this is the post-/clear turn
  ws.close(); capWarm.stop()
  const warmReq = CAPTURED_WARM[1] as { messages: unknown[] }
  const warmBytes = JSON.stringify(warmReq).length

  const CAPTURED_ONESHOT: Array<Record<string, unknown>> = []
  const capOneShot = stubServer((c) => { CAPTURED_ONESHOT.push(c.body); return sseText("ANSWER", HAIKU) })
  await agentSdkCall(PROMPT, HAIKU, { ...process.env, ANTHROPIC_BASE_URL: capOneShot.url })
  capOneShot.stop()
  const oneShotReq = CAPTURED_ONESHOT[0] as { messages: unknown[] }
  const oneShotBytes = JSON.stringify(oneShotReq).length

  console.log("=== (b) /clear residue discrepancy ===")
  console.log("warm post-/clear turn: messages.length =", warmReq.messages.length, "bytes =", warmBytes)
  console.log("fresh one-shot turn:   messages.length =", oneShotReq.messages.length, "bytes =", oneShotBytes)
  console.log("byte delta (warm - oneshot):", warmBytes - oneShotBytes)
  console.log("warm messages (verbatim):", JSON.stringify(warmReq.messages))
  console.log("oneshot messages (verbatim):", JSON.stringify(oneShotReq.messages))
}

// ---- (c) modelUsage shape of one warm turn ----
{
  const CAPTURED: Array<Record<string, unknown>> = []
  const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU) })
  const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
  const r = await ws.oneShot(PROMPT, HAIKU, { recycle: true })
  console.log("=== (c) modelUsage shape ===")
  console.log("TurnOutcome:", JSON.stringify(r))
  if (r.kind === "ok") {
    console.log("key form:", r.model, "== undated alias?", r.model === HAIKU)
    console.log("canonicalModel populated?", r.canonicalModel !== "", "value:", r.canonicalModel)
    console.log("modelProvenBy(key, requested, canonicalModel):", modelProvenBy(r.model, HAIKU, r.canonicalModel))
  }
  ws.close(); cap.stop()
}

process.exit(0)
