# Lane A Revalidator (increment-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic propose-verify revalidator that rejects a numeric convention card whose claimed transform does not reproduce, before injection.

**Architecture:** Extend `convention-audit.ts` with pure functions (transforms, `parseRevalTable`, `stripRevalTable`, `revalidate`), widen `AuditResult` so a MISMATCH may carry `card:null`, and splice parse+revalidate into `runAuditUncached` after the existing `cardFrom` call. Injection gate becomes `CONTENT MISMATCH ∧ revalidation ∈ {PASS, N/A}`. The auditor prompt emits a machine-checkable `REVALIDATION:` block (kept OUT of the injected card); a criteria-class card with no numeric claim declares `TRANSFORM: none` and is unaffected.

**Tech Stack:** TypeScript (Bun), `bun test`, `tsc --noEmit`. All new logic is pure functions unit-tested over fixtures — zero live model calls.

**Spec:** `docs/superpowers/specs/2026-08-19-lane-a-revalidator-design.md`

## Global Constraints

- All new code lives in `opencode-plugin/src/bench/convention-audit.ts`, its prompt file `convention-audit-prompt.txt`, and its test `opencode-plugin/test/bench-convention-audit.test.ts`. No other source files change (verified: `cmd-run.ts:470` `card = r.card ?? ""` already handles `card:null`).
- Fail-CLOSED: only an explicit `TRANSFORM: none` reaches the criteria-class inject-on-content-gate-alone path. A missing block (`absent`) or an unparseable block (`malformed`) on a MISMATCH verdict ⇒ NO injection.
- Transform whitelist is CLOSED, single-constant, NO eval: `reciprocal` `C/in`, `scale` `C*in`, `offset` `C − in` (pinned; not signed), `identity`.
- The one-fixed-constant test (≥2 landings within Δ under ONE constant) is the primary guard. Anti-fabrication (range-membership) is defense-in-depth.
- The `REVALIDATION:` block is PARSED but NEVER injected. `cardFrom` strips it. Bias toward over-stripping.
- Bump `AUDIT_PROMPT_VERSION` to `"lane-a-v3"` in the SAME change as the prompt file.
- Run `bun test test/bench-convention-audit.test.ts` and `bunx tsc --noEmit` before every commit. Fixture return types must match real deps signatures (tsc checks; bun test does not).
- Wire format schema (imposed by the prompt), block is LAST in the response, nothing after it:
  ```
  REVALIDATION:
  TRANSFORM: reciprocal
  CONSTANT: 1.0e7
  DELTA: 30
  | input | computed | canonical | discriminates |
  |---|---|---|---|
  | 19139.4 | 522.5 | 520.7 | E:units-nm-vs-cm |
  | 3745.3 | 2670.0 | 2700 | E:units-nm-vs-cm |
  ```

---

### Task 1: Sampler comma-decimal fix (prerequisite)

`summarizeFile`'s `first-col-range` silently vanishes on EU comma-decimals (`Number("47183,554644")` → `NaN`), the raman locale — disabling the range check `revalidate` depends on.

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts:105-111` (the `nums`/`rangeStr` block in `summarizeFile`)
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseFirstColNum(tok: string): number` (exported pure helper) — comma-decimal aware numeric parse; `NaN` when not numeric.

- [ ] **Step 1: Write the failing test**

```ts
import { parseFirstColNum } from "../src/bench/convention-audit.ts"

test("parseFirstColNum reads EU comma-decimals", () => {
  expect(parseFirstColNum("47183,554644")).toBeCloseTo(47183.554644, 5)
  expect(parseFirstColNum("1580.3")).toBeCloseTo(1580.3, 5)
  expect(parseFirstColNum("-12,5")).toBeCloseTo(-12.5, 5)
  expect(Number.isNaN(parseFirstColNum("abc"))).toBe(true)
  expect(Number.isNaN(parseFirstColNum("1,2,3"))).toBe(true)   // not a lone decimal comma
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "parseFirstColNum"`
Expected: FAIL — `parseFirstColNum` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add near the top of `convention-audit.ts` (module scope):
```ts
/** Numeric parse of a first-column token, tolerant of a single decimal comma
 * (EU locale, e.g. "47183,554644"). A token with a lone comma and no dot has the
 * comma read as a decimal point; anything else falls through to Number(). */
export function parseFirstColNum(tok: string): number {
  if (/^-?\d+,\d+$/.test(tok)) return Number(tok.replace(",", "."))
  return Number(tok)
}
```
Then in `summarizeFile`, replace `const nums = firstCols.map(Number)` with `const nums = firstCols.map(parseFirstColNum)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bench-convention-audit.test.ts -t "parseFirstColNum"` → PASS. Then `bun test test/bench-convention-audit.test.ts` (full file, no regressions) and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "fix(lane-a): comma-decimal aware first-col-range in summarizeFile"
```

---

### Task 2: Transform primitives

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts` (add near the other pure helpers)
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Produces:
  - `type RevalTransform = "reciprocal" | "scale" | "offset" | "identity"`
  - `applyTransform(t: RevalTransform, c: number, x: number): number`

- [ ] **Step 1: Write the failing test**

```ts
import { applyTransform } from "../src/bench/convention-audit.ts"

test("applyTransform covers the closed whitelist (offset is C - in)", () => {
  expect(applyTransform("reciprocal", 1e7, 19139.4)).toBeCloseTo(522.5, 1)
  expect(applyTransform("scale", 0.1, 1913.9)).toBeCloseTo(191.39, 2)
  expect(applyTransform("offset", 20721.4, 19139.4)).toBeCloseTo(1582.0, 1)  // C - in
  expect(applyTransform("identity", 0, 42)).toBe(42)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "applyTransform"` → FAIL (not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
export type RevalTransform = "reciprocal" | "scale" | "offset" | "identity"

/** Evaluate a whitelisted single-constant transform. Pinned: offset = C - in
 * (laser-line subtraction; both gen4 fixtures use this sign). No eval, no
 * arbitrary formulae. */
export function applyTransform(t: RevalTransform, c: number, x: number): number {
  switch (t) {
    case "reciprocal": return c / x
    case "scale": return c * x
    case "offset": return c - x
    case "identity": return x
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bench-convention-audit.test.ts -t "applyTransform"` → PASS. Then full file + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): whitelisted single-constant transform primitives"
```

---

### Task 3: `revalidate` — one-fixed-constant + anti-fabrication

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: `applyTransform`, `RevalTransform` (Task 2).
- Produces:
  - `interface RevalLanding { input: number; computed: number; canonical: number; discriminates: string }`
  - `interface RevalClaim { transform: RevalTransform; constant: number; delta: number; landings: RevalLanding[] }`
  - `type RevalOutcome = { ok: true } | { ok: false; reason: string }`
  - `revalidate(claim: RevalClaim, sample: string): RevalOutcome`

- [ ] **Step 1: Write the failing test** (gen4-derived claims; label as hand-transcribed)

```ts
import { revalidate, type RevalClaim } from "../src/bench/convention-audit.ts"

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
  expect(revalidate(r2, "lines=10 top-tokens: a:1\n--head--\nfoo\n--tail--\nbar").ok).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "revalidate"` → FAIL (not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
export interface RevalLanding { input: number; computed: number; canonical: number; discriminates: string }
export interface RevalClaim { transform: RevalTransform; constant: number; delta: number; landings: RevalLanding[] }
export type RevalOutcome = { ok: true } | { ok: false; reason: string }

/** Recompute the card's winning row deterministically. PASS iff, under the ONE
 * declared constant, >=2 landings land within delta of their canonical, every
 * landing's input is inside the sample's first-col-range, and every landing
 * names the misreading it discriminates. Fail-closed if range is unavailable. */
export function revalidate(claim: RevalClaim, sample: string): RevalOutcome {
  const m = sample.match(/first-col-range=\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/)
  if (!m) return { ok: false, reason: "range-unavailable" }
  const lo = Number(m[1]), hi = Number(m[2])
  if (claim.landings.length < 2) return { ok: false, reason: "under-2-landings" }
  let landed = 0
  for (const L of claim.landings) {
    if (!L.discriminates.trim()) return { ok: false, reason: "landing-missing-discriminates" }
    if (L.input < lo || L.input > hi) return { ok: false, reason: `input-out-of-range:${L.input}` }
    const out = applyTransform(claim.transform, claim.constant, L.input)
    if (Math.abs(out - L.canonical) <= claim.delta) landed++
  }
  return landed >= 2 ? { ok: true } : { ok: false, reason: `only-${landed}-landed-under-one-constant` }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bench-convention-audit.test.ts -t "revalidate"` → PASS. Then full file + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): revalidate() one-fixed-constant + range/misreading anti-fabrication"
```

---

### Task 4: `parseRevalBlock` — four-way, fail-closed

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: `RevalClaim`, `RevalTransform` (Tasks 2/3).
- Produces:
  - `type ParsedReval = { kind: "none" } | { kind: "absent" } | { kind: "malformed"; raw: string } | { kind: "claim"; claim: RevalClaim }`
  - `parseRevalBlock(raw: string): ParsedReval`

- [ ] **Step 1: Write the failing test**

```ts
import { parseRevalBlock } from "../src/bench/convention-audit.ts"

const BLOCK = `SURFACE ...
REVALIDATION:
TRANSFORM: reciprocal
CONSTANT: 1.0e7
DELTA: 30
| input | computed | canonical | discriminates |
|---|---|---|---|
| 19139.4 | 522.5 | 520.7 | E:units |
| 3745.3 | 2670.0 | 2700 | E:units |`

test("parseRevalBlock: well-formed → claim", () => {
  const p = parseRevalBlock(BLOCK)
  expect(p.kind).toBe("claim")
  if (p.kind === "claim") {
    expect(p.claim.transform).toBe("reciprocal")
    expect(p.claim.constant).toBeCloseTo(1e7, 0)
    expect(p.claim.landings.length).toBe(2)
    expect(p.claim.landings[0]!.discriminates).toBe("E:units")
  }
})
test("parseRevalBlock: no marker → absent", () => {
  expect(parseRevalBlock("SURFACE ... CONTENT ...").kind).toBe("absent")
})
test("parseRevalBlock: explicit TRANSFORM: none → none", () => {
  expect(parseRevalBlock("REVALIDATION:\nTRANSFORM: none").kind).toBe("none")
})
test("parseRevalBlock: unknown transform → malformed", () => {
  expect(parseRevalBlock("REVALIDATION:\nTRANSFORM: wibble\nCONSTANT: 1\nDELTA: 1\n| input | computed | canonical | discriminates |\n|-|-|-|-|\n| 1 | 1 | 1 | x |\n| 2 | 2 | 2 | y |").kind).toBe("malformed")
})
test("parseRevalBlock: <2 landing rows → malformed", () => {
  expect(parseRevalBlock("REVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: 1\nDELTA: 1\n| input | computed | canonical | discriminates |\n|-|-|-|-|\n| 1 | 1 | 1 | x |").kind).toBe("malformed")
})
test("parseRevalBlock: unparseable constant → malformed", () => {
  expect(parseRevalBlock("REVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: abc\nDELTA: 1\n| input | computed | canonical | discriminates |\n|-|-|-|-|\n| 1 | 1 | 1 | x |\n| 2 | 2 | 2 | y |").kind).toBe("malformed")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "parseRevalBlock"` → FAIL (not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
export type ParsedReval =
  | { kind: "none" }
  | { kind: "absent" }
  | { kind: "malformed"; raw: string }
  | { kind: "claim"; claim: RevalClaim }

const REVAL_TRANSFORMS = new Set<RevalTransform>(["reciprocal", "scale", "offset", "identity"])

/** Parse the imposed REVALIDATION block. Four-way, fail-closed: no marker →
 * absent; explicit `TRANSFORM: none` → none (criteria-class); a present-but-
 * broken block → malformed; a complete block → claim. */
export function parseRevalBlock(raw: string): ParsedReval {
  const marker = raw.match(/^REVALIDATION:\s*$/m)
  if (!marker) return { kind: "absent" }
  const body = raw.slice(marker.index!)
  const tRaw = body.match(/^TRANSFORM:\s*(\S+)/m)?.[1]?.toLowerCase()
  if (tRaw === "none") return { kind: "none" }
  if (!tRaw || !REVAL_TRANSFORMS.has(tRaw as RevalTransform)) return { kind: "malformed", raw }
  const constant = Number(body.match(/^CONSTANT:\s*(\S+)/m)?.[1])
  const delta = Number(body.match(/^DELTA:\s*(\S+)/m)?.[1])
  if (Number.isNaN(constant) || Number.isNaN(delta)) return { kind: "malformed", raw }
  const landings: RevalLanding[] = []
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""))
    if (cells.length !== 4) continue
    const [inS, compS, canS, disc] = cells
    if (inS === "input" || /^-+$/.test(inS!)) continue   // header / separator row
    const input = Number(inS), computed = Number(compS), canonical = Number(canS)
    if ([input, computed, canonical].some(Number.isNaN) || !disc) continue
    landings.push({ input, computed, canonical, discriminates: disc! })
  }
  if (landings.length < 2) return { kind: "malformed", raw }
  return { kind: "claim", claim: { transform: tRaw as RevalTransform, constant, delta, landings } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bench-convention-audit.test.ts -t "parseRevalBlock"` → PASS. Then full file + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): parseRevalBlock four-way fail-closed parser"
```

---

### Task 5: `stripRevalBlock` — remove the block from the injected card

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Produces: `stripRevalBlock(raw: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { stripRevalBlock } from "../src/bench/convention-audit.ts"

test("stripRevalBlock removes the block to EOF and trims", () => {
  const raw = "SURFACE stuff\nCONTENT VERDICT: MISMATCH\nREVALIDATION:\nTRANSFORM: reciprocal\n| input |...\n| 1 | 2 | 3 | x |"
  const out = stripRevalBlock(raw)
  expect(out).toContain("SURFACE stuff")
  expect(out).not.toContain("REVALIDATION:")
  expect(out).not.toContain("TRANSFORM:")
})
test("stripRevalBlock is a no-op when no block present", () => {
  expect(stripRevalBlock("SURFACE only")).toBe("SURFACE only")
})
test("stripRevalBlock over-strips a mid-answer block (bias: block last)", () => {
  const raw = "human\nREVALIDATION:\nTRANSFORM: none\ntrailing human prose"
  expect(stripRevalBlock(raw)).toBe("human")   // trailing prose lost — acceptable; a leak is worse
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "stripRevalBlock"` → FAIL (not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
/** Remove the REVALIDATION block (first whole-line marker → end of string) so it
 * is never injected into the task instruction. Biases toward over-stripping: a
 * block leaking into the SUT is worse than losing trailing prose. */
export function stripRevalBlock(raw: string): string {
  const m = raw.match(/^REVALIDATION:\s*$/m)
  if (!m) return raw.trim()
  return raw.slice(0, m.index).trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bench-convention-audit.test.ts -t "stripRevalBlock"` → PASS. Then full file + `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): stripRevalBlock keeps the machine block out of the injected card"
```

---

### Task 6: Widen `AuditResult` + wire the gate into `runAuditUncached` + audit trail

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts:200-202` (AuditResult), `:284-286` (splice), `:305-317` (writeAuditTrail)
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: `parseRevalBlock`, `revalidate`, `stripRevalBlock` (Tasks 3/4/5).
- Produces: `AuditResult` gains `reval?: "PASS" | "N/A" | "FAIL"` and `revalReason?: string`; MISMATCH may carry `card:null`.

- [ ] **Step 1: Write the failing test**

```ts
const withBlock = (t: string) => `${t}\nCONTENT VERDICT: MISMATCH\nREVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: 1e7\nDELTA: 30\n| input | computed | canonical | discriminates |\n|-|-|-|-|\n| 19139.4 | 522.5 | 520.7 | E:units |\n| 3745.3 | 2670.0 | 2700 | E:units |`

test("runAuditUncached: MISMATCH + valid block → card present, reval PASS, block stripped", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply(withBlock("AUDIT BODY"))))
  expect(r.card).toContain("AUDIT BODY")
  expect(r.card).not.toContain("REVALIDATION:")
  expect((r as any).reval).toBe("PASS")
})
test("runAuditUncached: MISMATCH + failing block → card null, reval FAIL + reason", async () => {
  const bad = "BODY\nCONTENT VERDICT: MISMATCH\nREVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: 3.028e7\nDELTA: 30\n| input | computed | canonical | discriminates |\n|-|-|-|-|\n| 19139.4 | 1582.1 | 1582 | E:x |\n| 3745.3 | 8084.8 | 2680 | E:x |"
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply(bad)))
  expect(r.card).toBeNull()
  expect((r as any).reval).toBe("FAIL")
  expect((r as any).revalReason).toBeTruthy()
})
test("runAuditUncached: MISMATCH + absent block → card null (fail-closed)", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("BODY\nCONTENT VERDICT: MISMATCH")))
  expect(r.card).toBeNull()
  expect((r as any).reval).toBe("FAIL")
})
test("runAuditUncached: MISMATCH + explicit none → criteria-class card present, reval N/A", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("ELF BODY\nCONTENT VERDICT: MISMATCH\nREVALIDATION:\nTRANSFORM: none")))
  expect(r.card).toContain("ELF BODY")
  expect(r.card).not.toContain("REVALIDATION:")
  expect((r as any).reval).toBe("N/A")
})
```

Note: the `SAMPLE` the fixture task `"clean"` produces must expose a `first-col-range` covering `[?, 21000]` for the PASS/FAIL cases, or the test must point at a numeric fixture. If `FIX/clean` has no numeric first column, add a numeric fixture task (e.g. `raman`) under `test/fixtures/conv-audit/` with an `instruction.md` + a numeric `data.txt` whose first-col-range spans the test inputs, and use it in these four tests. Fold that fixture creation into this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "runAuditUncached: MISMATCH + valid block"` → FAIL.

- [ ] **Step 3: Write minimal implementation**

Widen the type at `:200-202`:
```ts
export type AuditResult =
  | { card: string; rawAudit: string; verdict: "MISMATCH"; reval: "PASS" | "N/A"; sample: string; truncated: boolean }
  | { card: null; rawAudit: string; verdict: "NO_MISMATCH" | "ERROR" | "MISMATCH"; reval?: "FAIL"; revalReason?: string; sample: string; truncated: boolean }
```
Replace the two trailing returns at `:284-286`:
```ts
    const verdict = parseVerdict(outcome.text)
    if (verdict === "NO_MISMATCH") return { card: null, rawAudit: outcome.text, verdict, sample, truncated }

    const parsed = parseRevalBlock(outcome.text)
    if (parsed.kind === "none") {
      return { card: cardFrom(outcome.text), rawAudit: outcome.text, verdict: "MISMATCH", reval: "N/A", sample, truncated }
    }
    if (parsed.kind !== "claim") {
      return { card: null, rawAudit: outcome.text, verdict: "MISMATCH", reval: "FAIL", revalReason: `block-${parsed.kind}`, sample, truncated }
    }
    const outcomeReval = revalidate(parsed.claim, sample)
    if (!outcomeReval.ok) {
      return { card: null, rawAudit: outcome.text, verdict: "MISMATCH", reval: "FAIL", revalReason: outcomeReval.reason, sample, truncated }
    }
    return { card: cardFrom(outcome.text), rawAudit: outcome.text, verdict: "MISMATCH", reval: "PASS", sample, truncated }
```
Note: `cardFrom` still returns whole-verbatim here; Task 7 makes it strip. Also add `reval`/`revalReason` to every other `AuditResult` literal in the function (the ERROR and NO_MISMATCH returns need no `reval` — it is optional on the null branch). Extend `writeAuditTrail`'s `line` object (`:305-317`) with `reval: (r as any).reval ?? null, revalReason: (r as any).revalReason ?? null`.

- [ ] **Step 4: Run test to verify it passes**

Run the four new tests, then the full file, then `bunx tsc --noEmit`. Confirm the pre-existing "returns a card on MISMATCH" test still passes (its reply has no block → now `absent` → card null): UPDATE that legacy test to include a valid block or assert the new `absent`→null behaviour explicitly (it is a real behaviour change: a MISMATCH with no block no longer injects). Make that update in this task and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): gate injection on revalidation (MISMATCH + reval PASS/N-A)"
```

---

### Task 7: Prompt emits the block + `cardFrom` strips it + version bump

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit-prompt.txt`, `opencode-plugin/src/bench/convention-audit.ts:8` (`AUDIT_PROMPT_VERSION`), `:179-181` (`cardFrom`)
- Test: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: `stripRevalBlock` (Task 5).
- Produces: `cardFrom` now returns the stripped body; `AUDIT_PROMPT_VERSION === "lane-a-v3"`.

- [ ] **Step 1: Write the failing test**

```ts
test("AUDIT_PROMPT_VERSION bumped to lane-a-v3 and prompt demands the block", () => {
  const p = auditPrompt()
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v3")
  expect(p).toContain("REVALIDATION:")
  expect(p).toContain("TRANSFORM:")
  expect(p).toContain("discriminates")     // the misreading-tie column
})
test("cardFrom strips the REVALIDATION block", () => {
  const raw = "SURFACE body\nREVALIDATION:\nTRANSFORM: reciprocal\n| 1 | 2 | 3 | x |"
  expect(cardFrom(raw)).toBe("SURFACE body")
})
```
Also UPDATE the existing `test("auditPrompt loads the frozen prompt...")` assertion `expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v2")` → `"lane-a-v3"`, and the existing `test("cardFrom returns the audit body verbatim")` to reflect stripping (a body with no block is unchanged; add a block case asserting removal).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bench-convention-audit.test.ts -t "lane-a-v3"` → FAIL.

- [ ] **Step 3: Write minimal implementation**

`convention-audit.ts:8` bump: `export const AUDIT_PROMPT_VERSION = "lane-a-v3"`.
`cardFrom` (`:179-181`):
```ts
export function cardFrom(raw: string): string {
  return stripRevalBlock(raw)
}
```
Append to `convention-audit-prompt.txt` (after the imperative-rule paragraph):
```
NUMERIC REVALIDATION BLOCK. If, and only if, the data's convention is a NUMERIC transform (a units/axis conversion your MISREADINGS section identified), end your ENTIRE answer with a machine-checkable block — the LAST thing in your response, with nothing after it. Declare the SINGLE winning transform, its ONE fixed constant, a tolerance, and at least two landings; each landing names the misreading (from your MISREADINGS list) it discriminates. Keep the same numbers in your prose MISREADINGS section too — the block is a check, not a substitute for stating the disambiguation as an instruction. Use exactly this shape:
REVALIDATION:
TRANSFORM: <reciprocal|scale|offset|identity>
CONSTANT: <one number; offset means constant - value>
DELTA: <one number>
| input | computed | canonical | discriminates |
|---|---|---|---|
| <peak from the data> | <transform applied> | <known reference> | <misreading id> |
| <peak from the data> | <transform applied> | <known reference> | <misreading id> |
If the convention is NOT a numeric transform (e.g. a criteria/scope/script reading), emit exactly:
REVALIDATION:
TRANSFORM: none
```

- [ ] **Step 4: Run test to verify it passes**

Run the new tests, the updated legacy assertions, the full file, and `bunx tsc --noEmit`. Confirm the Task-6 `runAuditUncached` tests still pass now that `cardFrom` strips (the `expect(r.card).not.toContain("REVALIDATION:")` assertions become load-bearing here).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit-prompt.txt opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "feat(lane-a): prompt emits REVALIDATION block, cardFrom strips it, bump lane-a-v3"
```

---

## Notes for the executor
- The adherence probe (`docs/loop-probes/reval-adherence-20260819/pre-registration.md`) is OUT of this plan — it is a pre-arm gate, its own spend go. This plan ships the deterministic core with zero model calls.
- After Task 7, the whole feature is dark until `--convention-audit` is used AND a first arm is measured — both separate gos. Nothing here arms anything.
- `bunx tsc --noEmit` is as load-bearing as `bun test`: the deps-fixture return types are only checked by tsc.
