// PRE-SPEND DRY-RUN for the revalidation wire-format adherence probe
// (docs/loop-probes/reval-adherence-20260819/pre-registration.md): the parser
// must be green OFFLINE, on real prior model output, before any call is spent.
//
// The sibling suite (bench-convention-audit.test.ts) tests the ALGORITHM on
// hand-transcribed claims. This file tests the PARSER against the actual bytes
// of docs/loop-probes/rep-audit-20260819/generator/out-gen4-r{1,2}.json, plus a
// round-trip of the imposed block shape, so the probe's measurement instrument
// is validated on real output rather than on a guessed grammar.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRevalBlock, revalidate, stripRevalBlock } from "../src/bench/convention-audit.ts"

const GEN4 = join(import.meta.dir, "..", "..", "docs", "loop-probes", "rep-audit-20260819", "generator")
const fixture = (n: string): string => JSON.parse(readFileSync(join(GEN4, n), "utf8")).result as string

// The gen4 fixtures predate the imposed block: they are free-form prose + a
// pipe table with no REVALIDATION marker. The parser must read them as absent
// (fail-closed → no inject), never mine a claim out of unstructured prose.
test("parser is fail-closed on real pre-schema output (gen4-r1)", () => {
  expect(parseRevalBlock(fixture("out-gen4-r1.json")).kind).toBe("absent")
})
test("parser is fail-closed on real pre-schema output (gen4-r2)", () => {
  expect(parseRevalBlock(fixture("out-gen4-r2.json")).kind).toBe("absent")
})

// The real first-column range of the raman trap the gen4 calls audited.
const SAMPLE = "lines=3564 top-tokens: x:1 first-col-range=[1648.7, 47183.6]\n--head--\n47183,554644\t19261,547207\n--tail--\n1648,712345\t980,1\n"

/** The imposed shape from convention-audit-prompt.txt, appended to a card. */
const block = (transform: string, constant: string, delta: string, rows: string[]): string =>
  `## 3. MISREADINGS\n- **Misreading D** — dominant peak mistaken for 2D.\n- **Misreading E** — raw col1 read as cm-1.\n\nREVALIDATION:\nTRANSFORM: ${transform}\nCONSTANT: ${constant}\nDELTA: ${delta}\n| input | computed | canonical | discriminates |\n|---|---|---|---|\n${rows.join("\n")}\n`

// gen4-r2's winning claim, transcribed into the imposed shape with its own
// numbers: reciprocal 1e7 lands P1 on Si 520.7 (d 1.78) and P2 on 2D 2700 (d 30.01).
const R2_BLOCK = block("reciprocal", "1e7", "35", [
  "| 19139.420 | 522.479 | 520.7 | D |",
  "| 3745.339 | 2669.987 | 2700 | E |",
])

// gen4-r1's confident-wrong class: a constant fitted to ONE peak (3.028e7 from
// x1 -> G=1582). It lands that peak exactly and misses the other by thousands.
const R1_BLOCK = block("reciprocal", "3.028e7", "35", [
  "| 19139.420 | 1582.03 | 1582 | D |",
  "| 3745.339 | 8084.7 | 2680 | E |",
])

test("imposed block round-trips: gen4-r2's real numbers parse then PASS", () => {
  const p = parseRevalBlock(R2_BLOCK)
  expect(p.kind).toBe("claim")
  if (p.kind !== "claim") return
  expect(p.claim.transform).toBe("reciprocal")
  expect(p.claim.constant).toBe(1e7)
  expect(p.claim.landings.length).toBe(2)
  expect(revalidate(p.claim, SAMPLE).ok).toBe(true)
})

test("imposed block round-trips: gen4-r1's per-peak constant parses then REJECTS", () => {
  const p = parseRevalBlock(R1_BLOCK)
  expect(p.kind).toBe("claim")
  if (p.kind !== "claim") return
  const o = revalidate(p.claim, SAMPLE)
  expect(o.ok).toBe(false)
  if (!o.ok) expect(o.reason).toBe("only-1-landed-under-one-constant")
})

test("the block never survives into the injected card", () => {
  const stripped = stripRevalBlock(R2_BLOCK)
  expect(stripped).not.toContain("REVALIDATION")
  expect(stripped).not.toContain("3745.339")
  expect(stripped).toContain("Misreading D")
})
