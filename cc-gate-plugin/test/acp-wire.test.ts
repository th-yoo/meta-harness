import { describe, expect, test } from "bun:test"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET, CLI_SPAWN_BUDGET_MS, modelProvenBy,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, GAUGE_ISOLATION,
} from "../src/gauge/acp-wire.ts"

describe("acp-wire framing", () => {
  test("round-trips a request frame", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    expect(frames.length).toBe(1)
    expect((frames[0] as { method: string }).method).toBe("initialize")
  })
  test("reassembles frames split across chunks", () => {
    const d = new FrameDecoder()
    const wire = encodeFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x" } })
    expect(d.push(wire.slice(0, 10)).length).toBe(0)
    expect(d.push(wire.slice(10)).length).toBe(1)
  })
  test("a multi-byte character split across two BUFFER chunks survives verbatim", () => {
    // THE corruption guard. A bare chunk.toString() yields two U+FFFD here,
    // the frame still parses as JSON, and a silently corrupted prompt goes
    // to the model — a wrong derivation with no error anywhere.
    const d = new FrameDecoder()
    const text = "é你好\u{1F600} tail"        // 2-, 3- and 4-byte sequences
    const wire = Buffer.from(encodeFrame({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { text } }), "utf8")
    // Cut inside the 4-byte emoji: find its start and split one byte in.
    const cut = wire.indexOf(Buffer.from("\u{1F600}", "utf8")) + 1
    expect(d.push(wire.subarray(0, cut)).length).toBe(0)
    const frames = d.push(wire.subarray(cut))
    expect(frames.length).toBe(1)
    expect((frames[0] as { params: { text: string } }).params.text).toBe(text)
  })
  test("two frames in one chunk", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 3, method: "a" }) + encodeFrame({ jsonrpc: "2.0", id: 4, method: "b" }))
    expect(frames.length).toBe(2)
  })
  test("malformed line counts, never throws, stream survives", () => {
    const d = new FrameDecoder()
    const frames = d.push("not json\n" + encodeFrame({ jsonrpc: "2.0", id: 5, method: "ok" }))
    expect(frames.length).toBe(1)
    expect(d.malformed).toBe(1)
  })
  test("an unterminated giant line is dropped, not buffered forever", () => {
    const d = new FrameDecoder({ maxLineChars: 64 })
    expect(d.push("x".repeat(200)).length).toBe(0)
    expect(d.malformed).toBe(1)
    // buffer was reset: a well-formed frame right after still decodes
    expect(d.push(encodeFrame({ jsonrpc: "2.0", id: 6, method: "ok" })).length).toBe(1)
  })
  test("the two instrument error codes are distinct, stable, and inside the reserved server-error band", () => {
    expect(ACP_ERR_NO_CALL).toBe(-32000)
    expect(ACP_ERR_CALL_CONSUMED).toBe(-32001)
    for (const c of [ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED]) {
      expect(c).toBeLessThanOrEqual(-32000)
      expect(c).toBeGreaterThanOrEqual(-32099)
    }
  })
})

// §6e budget rule, locked as arithmetic rather than prose: if the client
// leg ever stops exceeding the daemon's worst case, an ordinary slow turn
// trips law L2 and the record costs TWO model calls.
describe("ACP_BUDGET arithmetic (§6e budget rule)", () => {
  test("the five daemon legs sum to the declared worst case", () => {
    const b = ACP_BUDGET
    expect(b.queueWaitMs + b.clearTimeoutMs + b.setModelMs + b.turnTimeoutMs + b.hardGraceMs)
      .toBe(b.daemonWorstCaseMs)
  })
  test("the client leg strictly exceeds the daemon worst case", () => {
    expect(ACP_BUDGET.daemonLegMs).toBeGreaterThan(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("the client's slack covers a connect + initialize + session/new preamble", () => {
    // Not decoration: the daemon's clock starts when it accepts the prompt,
    // the client's when it opens the socket. Anything under a second of
    // slack would make an ordinary busy daemon look like law L2.
    expect(ACP_BUDGET.daemonLegMs - ACP_BUDGET.daemonWorstCaseMs).toBeGreaterThanOrEqual(3_000)
  })
  test("daemon leg + minimum fallback still fits the per-record budget", () => {
    expect(ACP_BUDGET.daemonLegMs + ACP_BUDGET.minFallbackMs).toBeLessThanOrEqual(ACP_BUDGET.recordBudgetMs)
  })
  test("the per-record budget is unchanged from the incumbent 60s", () => {
    expect(ACP_BUDGET.recordBudgetMs).toBe(60_000)
  })
  test("the generation budget exceeds the measured CLI spawn (round-4 C3)", () => {
    // A turn's timers start at the PUSH while the subprocess is still
    // booting; §6d measured that spawn at 1.25-1.46s. A turnTimeoutMs at or
    // below it cannot distinguish "generation failed" from "not started
    // yet". CLI_SPAWN_BUDGET_MS is the floor every WarmSession
    // construction, production or test, must clear.
    expect(CLI_SPAWN_BUDGET_MS).toBe(8_000)
    expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(CLI_SPAWN_BUDGET_MS)
  })
})

// §6e "Which field proves the model" — the MATCHING rule, not equality.
// This is the round-4 C1 lock: the repo's own captured CLI transcripts key
// modelUsage by the DATED snapshot id
// (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22 =>
// "claude-haiku-4-5-20251001") while resolveModelId("haiku") produces the
// undated alias. Strict equality here discards EVERY honest derivation.
describe("modelProvenBy (§6e model-proof rule)", () => {
  test("exact match proves", () => {
    expect(modelProvenBy("claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DATED snapshot key proves its undated alias", () => {
    expect(modelProvenBy("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true)
  })
  test("canonicalModel proves even when the key is provider-specific", () => {
    expect(modelProvenBy("bedrock/anthropic.claude-haiku", "claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DIFFERENT model never proves — prefix matching must not be a substring match", () => {
    expect(modelProvenBy("claude-opus-5", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-opus-5-20260101", "claude-haiku-4-5")).toBe(false)
    // and the boundary: a longer FAMILY name is not a snapshot of a shorter one
    expect(modelProvenBy("claude-haiku-4-52", "claude-haiku-4-5")).toBe(false)
  })
  test("empty inputs never prove anything", () => {
    expect(modelProvenBy("", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-haiku-4-5", "")).toBe(false)
  })
})

// The per-session SDK-option slice. GAUGE_ISOLATION must stay byte-identical
// to the option literal inlined in agent-transport.ts's agentSdkCall
// (agent-transport.ts:119-132 is the authority) — that equality is what a
// later node's test proves against the live call site; this only locks the
// value declared here.
describe("WarmIsolation / GAUGE_ISOLATION (§6d/§6e gauge isolation set)", () => {
  test("matches the agent-transport.ts option literal field-for-field", () => {
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
  test("is as-const-safe to spread into an SDK options literal", () => {
    const options = { ...GAUGE_ISOLATION, model: "claude-haiku-4-5", cwd: "/x", env: {} }
    expect(options.title).toBe("kkamak-gauge")
    expect(options.model).toBe("claude-haiku-4-5")
    expect(options.thinking).toEqual({ type: "disabled" })
  })
})
