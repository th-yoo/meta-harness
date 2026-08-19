import { test, expect } from "bun:test"
import { join, dirname } from "node:path"
import { auditPrompt, AUDIT_PROMPT_VERSION, buildSample, parseVerdict, cardFrom, runAuditUncached } from "../src/bench/convention-audit.ts"

test("auditPrompt loads the frozen prompt with all four clauses + verdict line", () => {
  const p = auditPrompt()
  expect(p).toContain("numerically")           // compute clause
  expect(p).toContain("success criteria")      // instruction-criteria clause
  expect(p).toContain("MANDATORY")             // imperative clause
  expect(p).toContain("CONTENT VERDICT:")      // machine line
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v1")
})

const P = (root: string) => ({ tbRoot: root } as any)  // only .tbRoot is read
const FIX = join(dirname(new URL(import.meta.url).pathname), "fixtures/conv-audit")

test("buildSample emits instruction + input, never tests/ bytes", () => {
  const s = buildSample(P(FIX), "clean")
  expect(s.text).toContain("data.txt")
  expect(s.text).not.toContain("LEAK_CANARY")
})
test("buildSample rejects ..-traversal COPY source", () => {
  expect(() => buildSample(P(FIX), "traversal")).toThrow(/outside|containment|leak/i)
})
test("buildSample rejects symlink-out COPY source", () => {
  expect(() => buildSample(P(FIX), "symlink")).toThrow(/outside|containment|leak/i)
})
test("buildSample truncates an oversized dir COPY and flags it", () => {
  const s = buildSample(P(FIX), "bigdir", 100_000)
  expect(s.truncated).toBe(true)
  expect(s.text.length).toBeLessThan(120_000)
})
test("buildSample is deterministic", () => {
  expect(buildSample(P(FIX), "clean").text).toBe(buildSample(P(FIX), "clean").text)
})

test("parseVerdict reads the machine line", () => {
  expect(parseVerdict("...\nCONTENT VERDICT: MISMATCH\n...")).toBe("MISMATCH")
  expect(parseVerdict("CONTENT VERDICT: NO MISMATCH")).toBe("NO_MISMATCH")
})
test("parseVerdict defaults to NO_MISMATCH when the line is absent", () => {
  expect(parseVerdict("no verdict here")).toBe("NO_MISMATCH")
})
test("cardFrom returns the audit body verbatim", () => {
  const raw = "SURFACE ... CONTENT ... MISREADINGS ..."
  expect(cardFrom(raw)).toBe(raw.trim())
})

const okReply = (text: string) => ({
  kind: "ok",
  text,
  model: "anthropic/claude-sonnet-5",
  canonicalModel: "anthropic/claude-sonnet-5",
  sessionId: "s1",
  stopReason: "end_turn",
})
// Fixture return types MUST match the real deps signatures (tsc --noEmit checks this;
// bun test does not): ensureDaemon → Promise<boolean>, closeSession → Promise<{closed}>.
const deps = (reply: any) => ({
  ensure: async () => true,
  call: async () => reply,
  close: async () => ({ closed: true }),
})

test("runAuditUncached returns a card on MISMATCH", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("AUDIT BODY\nCONTENT VERDICT: MISMATCH")))
  expect(r.card).toContain("AUDIT BODY")
  expect(r.verdict).toBe("MISMATCH")
})
test("runAuditUncached returns null card on NO MISMATCH", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("clean\nCONTENT VERDICT: NO MISMATCH")))
  expect(r.card).toBeNull()
  expect(r.verdict).toBe("NO_MISMATCH")
})
test("runAuditUncached fails safe (card null) on daemon error", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps({ kind: "error" }))
  expect(r.card).toBeNull()
  expect(r.verdict).toBe("ERROR")
})
test("runAuditUncached fails safe on max_tokens truncation", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps({ ...okReply(""), stopReason: "max_tokens" }))
  expect(r.card).toBeNull()
  expect(r.verdict).toBe("ERROR")
})
