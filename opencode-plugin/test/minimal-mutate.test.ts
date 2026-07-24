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
