import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

/** Compare from the RULES policy array to EOF — the policy content IS the
 * thing that must not drift (review round-1 F4: anchoring at the function
 * would exclude RULES, making the guard a no-op for the likely drift). */
function implBlock(src: string): string {
  const i = src.indexOf("const RULES")
  if (i < 0) throw new Error("RULES not found")
  return src.slice(i)
}

test("minimal/guard.ts unsafeReason is byte-identical to cc-gate-plugin's (interim drift guard until Plan B vendors it)", () => {
  const kernel = readFileSync(join(root, "minimal", "guard.ts"), "utf-8")
  const ccg = readFileSync(join(root, "cc-gate-plugin", "src", "gauge", "guard.ts"), "utf-8")
  expect(implBlock(kernel)).toBe(implBlock(ccg))
})

test("unsafeReason from minimal/ flags a destructive workspace-scoped command and passes a read-only one", async () => {
  const { unsafeReason } = await import("../../minimal/guard.ts")
  expect(unsafeReason("rm notes.txt")).toBeDefined()
  expect(unsafeReason("grep -q done README.md")).toBeUndefined()
})
