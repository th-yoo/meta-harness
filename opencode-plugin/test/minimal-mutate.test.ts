import { test, expect } from "bun:test"
import { generateMutants, unifiedDiff } from "../../minimal/mutate.ts"

const SRC = `import asyncio

async def run_tasks(tasks, max_concurrent):
    sem = asyncio.Semaphore(max_concurrent)
    jobs = [asyncio.create_task(_one(t, sem)) for t in tasks]
    try:
        await asyncio.gather(*jobs)
    except asyncio.CancelledError:
        for j in jobs:
            j.cancel()
        raise
    finally:
        await _drain(jobs)

def check(a, b):
    if a < b and b >= 0:
        return True
    return False
`

const okSyntax = (_s: string) => true

test("generates at most k mutants, all distinct from the source", () => {
  const ms = generateMutants(SRC, 4, okSyntax)
  expect(ms.length).toBeLessThanOrEqual(4)
  expect(ms.length).toBeGreaterThan(0)
  for (const m of ms) expect(m.mutated).not.toBe(SRC)
})

test("includes an await-removal mutant that drops exactly one await", () => {
  const ms = generateMutants(SRC, 10, okSyntax)
  const aw = ms.find((m) => m.op === "remove-await")
  expect(aw).toBeDefined()
  expect((SRC.match(/\bawait /g) ?? []).length - (aw!.mutated.match(/\bawait /g) ?? []).length).toBe(1)
})

test("includes a comparison-swap mutant", () => {
  const ms = generateMutants(SRC, 10, okSyntax)
  const cmp = ms.find((m) => m.op === "swap-comparison")
  expect(cmp).toBeDefined()
  expect(cmp!.mutated).not.toBe(SRC)
})

test("includes an and/or swap mutant", () => {
  const ms = generateMutants(SRC, 10, okSyntax)
  const ao = ms.find((m) => m.op === "swap-and-or")
  expect(ao).toBeDefined()
  expect(ao!.mutated).toContain(" or ")
})

test("skips mutants the syntax checker rejects", () => {
  const rejectAll = (_s: string) => false
  expect(generateMutants(SRC, 4, rejectAll)).toEqual([])
})

test("is deterministic — same input, same mutants", () => {
  const a = generateMutants(SRC, 4, okSyntax)
  const b = generateMutants(SRC, 4, okSyntax)
  expect(a.map((m) => m.mutated)).toEqual(b.map((m) => m.mutated))
})

test("source with nothing to mutate yields no mutants", () => {
  expect(generateMutants("x = 1\n", 4, okSyntax)).toEqual([])
})

test("unifiedDiff shows the changed line with - and + markers", () => {
  const ms = generateMutants(SRC, 1, okSyntax)
  const d = unifiedDiff(SRC, ms[0]!.mutated)
  expect(d).toContain("-")
  expect(d).toContain("+")
  expect(d.split("\n").some((l) => l.startsWith("-"))).toBe(true)
})

// R9 forensics bug: swap-and-or hit a DOCSTRING ("and"->"or" in prose) —
// semantic no-op, unkillable mutant, gate unsatisfiable (all 5 office
// attempts burned both rounds on it). Operators must skip non-code lines.
const DOCSTRING_SRC = `def run(tasks, max_concurrent):
    """Run tasks with cancellation and cleanup semantics.

    Cancels children and waits for cleanup before returning.
    """
    # cancel and drain
    done = a and b
    return done
`

test("operators skip docstring lines (triple-quoted blocks)", () => {
  const ms = generateMutants(DOCSTRING_SRC, 10, () => true)
  for (const m of ms) {
    expect(m.line).not.toBe(2) // "cancellation and cleanup" docstring line
    expect(m.line).not.toBe(4) // "Cancels children and waits" docstring line
  }
})

test("operators skip comment lines", () => {
  const ms = generateMutants(DOCSTRING_SRC, 10, () => true)
  for (const m of ms) expect(m.line).not.toBe(6) // "# cancel and drain"
})

test("operators still hit real code lines with and/or", () => {
  const ms = generateMutants(DOCSTRING_SRC, 10, () => true)
  const ao = ms.find((m) => m.op === "swap-and-or")
  expect(ao).toBeDefined()
  expect(ao!.line).toBe(7) // "done = a and b"
})

// C1 headless finding (docs/2026-07-27-probe-grip-fix-design.md S2): the
// `if __name__ == '__main__':` guard + block never execute when verify.sh
// imports the module — a guaranteed dead zone; negating the guard itself
// fires main() at import time (spurious kill/hang). Both excluded statically.
const MAIN_SRC = `def check(a, b):
    return a < b

if __name__ == '__main__':
    x = 1 < 2
    if x and True:
        check(1, 2)
`

test("operators skip the __main__ guard line and its block", () => {
  const ms = generateMutants(MAIN_SRC, 10, () => true)
  for (const m of ms) {
    expect(m.line).not.toBe(4) // the guard line (negate-if would match it)
    expect(m.line).not.toBe(5) // x = 1 < 2
    expect(m.line).not.toBe(6) // if x and True:
    expect(m.line).not.toBe(7) // check(1, 2)
  }
  expect(ms.some((m) => m.line === 2)).toBe(true) // real code still mutated
})

test('double-quoted __main__ guard is excluded too', () => {
  const src = 'def f(a, b):\n    return a < b\n\nif __name__ == "__main__":\n    f(1 < 2, 3)\n'
  const ms = generateMutants(src, 10, () => true)
  for (const m of ms) expect(m.line).toBeLessThanOrEqual(2)
})

test("code after a dedented line following the __main__ block is mutable again", () => {
  // guard block ends at the first non-empty line at <= guard indent
  const src = "class C:\n    def m(self):\n        if __name__ == '__main__':\n            x = 1 < 2\n        return self.a < self.b\n"
  const ms = generateMutants(src, 10, () => true)
  expect(ms.some((m) => m.line === 5)).toBe(true) // return line mutable
  for (const m of ms) expect(m.line).not.toBe(4) // block line not
})

// S1: coverage-guided site filter — only lines the agent's verification
// actually executed are mutation-eligible.
test("allowedLines restricts mutation sites to covered lines", () => {
  const ms = generateMutants(SRC, 10, okSyntax, new Set([16]))
  expect(ms.length).toBeGreaterThan(0)
  for (const m of ms) expect(m.line).toBe(16) // "if a < b and b >= 0:"
})

test("empty allowedLines yields no mutants", () => {
  expect(generateMutants(SRC, 10, okSyntax, new Set<number>())).toEqual([])
})

test("omitted allowedLines keeps the full site set", () => {
  const a = generateMutants(SRC, 10, okSyntax)
  const b = generateMutants(SRC, 10, okSyntax, undefined)
  expect(b.map((m) => m.mutated)).toEqual(a.map((m) => m.mutated))
})
