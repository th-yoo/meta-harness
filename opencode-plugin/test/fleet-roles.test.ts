import { describe, expect, test } from "bun:test"
import { FLEET_ROLES, roleSpec } from "../src/fleet/roles.ts"

describe("FLEET_ROLES manifest", () => {
  test("has exactly the four squad roles with mh- agents", () => {
    expect(FLEET_ROLES.map((r) => r.role).sort()).toEqual([
      "analyzer", "designer", "evaluator", "implementer",
    ])
    for (const r of FLEET_ROLES) expect(r.agent).toBe(`mh-${r.role}`)
  })

  test("permission uses bash key, never shell; design roles read-only", () => {
    for (const r of FLEET_ROLES) {
      expect(Object.keys(r.permission)).not.toContain("shell")
    }
    expect(roleSpec("analyzer").permission).toEqual({ bash: "deny", edit: "deny", write: "deny" })
    expect(roleSpec("designer").permission).toEqual({ bash: "deny", edit: "deny", write: "deny" })
    expect(roleSpec("evaluator").permission).toEqual({ bash: "allow", edit: "deny", write: "deny" })
    expect(roleSpec("implementer").permission).toEqual({ bash: "allow", edit: "allow", write: "allow" })
  })

  test("roleSpec dies on unknown role", () => {
    expect(() => roleSpec("architect")).toThrow(/unknown fleet role/)
  })
})
