import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRolesImport } from "../src/fleet/import.ts"
import { accountRoleRoot, readActiveSystem } from "../src/harness-store.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mh-import-")); process.env.META_HARNESS_HOME = home })
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }) })

describe("roles-import", () => {
  test("architect maps to analyzer+designer; frontmatter stripped; v1 active", () => {
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] }, roles: ["analyzer", "designer", "implementer", "evaluator"] })
    const analyzer = readActiveSystem(accountRoleRoot("mh-analyzer"))
    expect(analyzer).toContain("## Use Cases")
    expect(analyzer).not.toContain("description: analyst-designer") // frontmatter gone
    expect(readActiveSystem(accountRoleRoot("mh-designer"))).toContain("## Alternatives")
    expect(readActiveSystem(accountRoleRoot("mh-evaluator"))).toContain("VERDICT:")
  })

  test("refuses second import without --force, succeeds with it", () => {
    const args = { from: FIXTURES, map: { architect: ["analyzer", "designer"] } }
    cmdRolesImport(args)
    expect(() => cmdRolesImport(args)).toThrow(/--force/)
    expect(() => cmdRolesImport({ ...args, force: true })).not.toThrow()
  })

  test("missing source file dies naming the path", () => {
    expect(() => cmdRolesImport({ from: "/nonexistent" })).toThrow(/nonexistent/)
  })
})
