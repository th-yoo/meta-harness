import { test, expect } from "bun:test"
import { join, dirname } from "node:path"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { auditPrompt, AUDIT_PROMPT_VERSION, buildSample, parseFirstColNum, parseVerdict, cardFrom, applyTransform, runAuditUncached, auditCard, _resetAuditCache, writeAuditTrail, revalidate, type RevalClaim } from "../src/bench/convention-audit.ts"
import { runAgent } from "../src/bench/agent-run.ts"

test("auditPrompt loads the frozen prompt with all four clauses + verdict line", () => {
  const p = auditPrompt()
  expect(p).toContain("numerically")           // compute clause
  expect(p).toContain("success criteria")      // instruction-criteria clause
  expect(p).toContain("MANDATORY")             // imperative clause
  expect(p).toContain("CONTENT VERDICT:")      // machine line
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v2")
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
test("buildSample strips COPY flag tokens (--chown=) and still samples the real source", () => {
  const s = buildSample(P(FIX), "flags-and-glob")
  expect(() => buildSample(P(FIX), "flags-and-glob")).not.toThrow()
  expect(s.text).toContain("data.txt")
  expect(s.text).toContain("alpha 1")
})
test("buildSample skips a glob COPY source (*.py) without throwing", () => {
  expect(() => buildSample(P(FIX), "flags-and-glob")).not.toThrow()
})

test("parseFirstColNum reads EU comma-decimals", () => {
  expect(parseFirstColNum("47183,554644")).toBeCloseTo(47183.554644, 5)
  expect(parseFirstColNum("1580.3")).toBeCloseTo(1580.3, 5)
  expect(parseFirstColNum("-12,5")).toBeCloseTo(-12.5, 5)
  expect(Number.isNaN(parseFirstColNum("abc"))).toBe(true)
  expect(Number.isNaN(parseFirstColNum("1,2,3"))).toBe(true)   // not a lone decimal comma
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

test("applyTransform covers the closed whitelist (offset is C - in)", () => {
  expect(applyTransform("reciprocal", 1e7, 19139.4)).toBeCloseTo(522.5, 1)
  expect(applyTransform("scale", 0.1, 1913.9)).toBeCloseTo(191.39, 2)
  expect(applyTransform("offset", 20721.4, 19139.4)).toBeCloseTo(1582.0, 1)  // C - in
  expect(applyTransform("identity", 0, 42)).toBe(42)
})

// ── Task 3: revalidate — one-fixed-constant + anti-fabrication ──
//
// Hand-transcribed from docs/loop-probes/rep-audit-20260819/generator/out-gen4-r{1,2}.json.
// These test the ALGORITHM (measured), NOT live prompt-adherence (that is the deferred probe).
const SAMPLE = "lines=1500 top-tokens: x:1 first-col-range=[150, 21000]\n--head--\n150 ...\n--tail--\n20950 ..."

const r2: RevalClaim = { transform: "reciprocal", constant: 1e7, delta: 30,
  landings: [ { input: 19139.4, computed: 522.5, canonical: 520.7, discriminates: "E:units" },
              { input: 3745.3, computed: 2670.0, canonical: 2700, discriminates: "E:units" } ] }
// gen4-r1's best single constant (3.028e7) lands only x1; the other misses badly.
const r1: RevalClaim = { transform: "reciprocal", constant: 3.028e7, delta: 30,
  landings: [ { input: 19139.4, computed: 1582.1, canonical: 1582, discriminates: "E:units" },
              { input: 3745.3, computed: 8084.8, canonical: 2680, discriminates: "E:units" } ] }

test("revalidate PASSES gen4-r2 (one constant lands >=2)", () => {
  expect(revalidate(r2, SAMPLE).ok).toBe(true)
})
test("revalidate REJECTS gen4-r1 (single constant lands <2)", () => {
  const o = revalidate(r1, SAMPLE)
  expect(o.ok).toBe(false)
  if (!o.ok) expect(o.reason).toBe("only-1-landed-under-one-constant")
})
test("revalidate REJECTS an out-of-range fabricated input", () => {
  const bad: RevalClaim = { ...r2, landings: [ { input: 99999, computed: 100, canonical: 100, discriminates: "E:x" },
                                               { input: 88888, computed: 112, canonical: 112, discriminates: "E:x" } ] }
  expect(revalidate(bad, SAMPLE).ok).toBe(false)
})
test("revalidate REJECTS a landing with no discriminates (misreading tie)", () => {
  const bad: RevalClaim = { ...r2, landings: r2.landings.map(l => ({ ...l, discriminates: "" })) }
  expect(revalidate(bad, SAMPLE).ok).toBe(false)
})
test("revalidate FAILS closed when range is unavailable", () => {
  const o = revalidate(r2, "lines=10 top-tokens: a:1\n--head--\nfoo\n--tail--\nbar")
  expect(o.ok).toBe(false)
  if (!o.ok) expect(o.reason).toBe("range-unavailable")
})
test("revalidate FAILS closed when the range bounds are malformed (NaN, not just missing)", () => {
  const o = revalidate(r2, "lines=10 top-tokens: a:1 first-col-range=[1..2, 3]\n--head--\nfoo\n--tail--\nbar")
  expect(o.ok).toBe(false)
  if (!o.ok) expect(o.reason).toBe("range-unavailable")
})
test("revalidate REJECTS a degenerate identity/0 card whose canonical equals the raw input", () => {
  const degenerate: RevalClaim = { transform: "identity", constant: 0, delta: 30,
    landings: [ { input: 1580, computed: 1580, canonical: 1580, discriminates: "E:units" },
                { input: 2670, computed: 2670, canonical: 2670, discriminates: "E:units" } ] }
  const o = revalidate(degenerate, SAMPLE)
  expect(o.ok).toBe(false)
  if (!o.ok) expect(o.reason).toBe("degenerate-transform")
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

test("auditCard single-flights concurrent same-task misses into one call", async () => {
  _resetAuditCache()
  let calls = 0
  const d = { ensure: async () => true, close: async () => ({ closed: true }), call: async () => { calls++; return okReply("X\nCONTENT VERDICT: MISMATCH") } }
  const [a, b] = await Promise.all([auditCard(P(FIX), "clean", {}, d), auditCard(P(FIX), "clean", {}, d)])
  expect(calls).toBe(1)
  expect(a.card).toBe(b.card)   // byte-identical across "arms"
})

test("writeAuditTrail appends one ndjson line with the card + verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-trail-"))
  writeAuditTrail({ resultsDir: dir } as any, "clean",
    { card: "C", rawAudit: "R", verdict: "MISMATCH", sample: "S", truncated: false })
  const line = JSON.parse(readFileSync(join(dir, "convention-audit-trail.ndjson"), "utf-8").trim())
  expect(line.task).toBe("clean"); expect(line.verdict).toBe("MISMATCH"); expect(line.card).toBe("C")
  expect(line.promptVersion).toBe("lane-a-v2")
})

// ── Task 7: injection wiring (agent-run.ts's trailing conventionAudit param) ──

const FIXROOT = FIX  // Task-2 fixture's parent — "clean" has a known instruction.md

test("runAgent appends the convention card after the budget line, byte-identical when off", async () => {
  let captured = ""
  // runAgent unconditionally calls driver.classifyAttempt (agent-run.ts:206) and
  // driver.parseOutput (:233) — the fake MUST supply both or it throws before any assertion.
  const drv: any = {
    id: "fake", modelArg: (m: string) => m,
    harness: { kind: "workspace-file", filename: "AGENTS.md", buildFlags: () => [] },
    buildArgv: (o: any) => { captured = o.instruction; return ["true"] },
    classifyAttempt: () => "done",
    parseOutput: () => ({ turnCount: 1, toolUsage: {}, events: [] }),
  }
  const exec: any = async () => ({ rc: 0, stdout: "", stderr: "", timedOut: false })
  const sleep: any = async () => {}
  const base = { tbRoot: FIXROOT } as any        // fixture task dir with a known instruction.md
  await runAgent(drv, base, "c", "clean", "m", "", 900, "", exec, sleep)          // OFF
  const off = captured
  await runAgent(drv, base, "c", "clean", "m", "", 900, "", exec, sleep, "CARD-XYZ")  // ON
  expect(off).not.toContain("CARD-XYZ")
  expect(captured.indexOf("CARD-XYZ")).toBeGreaterThan(captured.indexOf("wall-clock"))  // card AFTER budget line
  expect(captured.startsWith(off.replace(/\n+$/, ""))).toBe(true)                  // off-text is a prefix → byte-identical base
})
