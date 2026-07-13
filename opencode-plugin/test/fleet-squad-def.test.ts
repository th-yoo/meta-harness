import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STANDARD_SQUAD, detectEscalation, lintPayload, parseVerdict,
  readActiveSquadDef, squadRoot, syncWireContracts, writeSquadDefV1,
} from "../src/fleet/squad-def.ts"
import type { SquadDef } from "../src/fleet/squad-def.ts"
import { accountRoleRoot } from "../src/harness-store.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-squad-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("SquadDef store", () => {
  test("writeSquadDefV1 then readActiveSquadDef round-trips", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const def = readActiveSquadDef("standard")
    expect(def.type).toBe("standard")
    expect(def.flow.bounds).toEqual({ R1: 2, R2: 1, R3: 3, globalBudgetSteps: 40 })
    expect(squadRoot("standard").startsWith(home)).toBe(true)
  })

  test("writeSquadDefV1 refuses when active already exists", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    expect(() => writeSquadDefV1(STANDARD_SQUAD)).toThrow(/already/)
  })

  test("readActiveSquadDef dies with actionable hint when missing", () => {
    expect(() => readActiveSquadDef("standard")).toThrow(/squad-def-init/)
  })
})

describe("SquadDef slot guards (unsupported topologies, spec §5/§8)", () => {
  test("writeSquadDefV1 dies on a nested-squad slot", () => {
    const def: SquadDef = {
      ...STANDARD_SQUAD,
      type: "nested-test",
      slots: { ...STANDARD_SQUAD.slots, designer: { kind: "squad", type: "standard" } },
    }
    expect(() => writeSquadDefV1(def)).toThrow(/nested squads/)
  })

  test("readActiveSquadDef dies on a claude-code leaf slot", () => {
    // Hand-write the active squad.json directly (bypassing writeSquadDefV1's
    // own guard) to prove readActiveSquadDef independently validates a
    // def that reached disk some other way (e.g. hand-edited or produced by
    // an older writer).
    const def: SquadDef = {
      ...STANDARD_SQUAD,
      type: "cc-test",
      slots: {
        ...STANDARD_SQUAD.slots,
        evaluator: { kind: "agent", role: "evaluator", platform: "claude-code", model: "anthropic/claude-haiku-4-5" },
      },
    }
    const root = squadRoot("cc-test")
    mkdirSync(join(root, "active"), { recursive: true })
    writeFileSync(join(root, "active", "squad.json"), JSON.stringify({ ...def, __version: "v1" }))
    expect(() => readActiveSquadDef("cc-test")).toThrow(/claude-code leaf/)
  })
})

describe("wire lint", () => {
  test("analyzer payload with spec headings passes; empty payload lists missing OR-groups", () => {
    const good = "## Use Cases\n- x\n## Functional Spec\n- y\n"
    expect(lintPayload(STANDARD_SQUAD, "analyzer", good).ok).toBe(true)
    const bad = lintPayload(STANDARD_SQUAD, "analyzer", "hello")
    expect(bad.ok).toBe(false)
    expect(bad.missing.length).toBeGreaterThan(0)
  })

  test("analyzer Clarify alone also satisfies the OR-group contract", () => {
    expect(lintPayload(STANDARD_SQUAD, "analyzer", "## Clarify\nwhich db?").ok).toBe(true)
  })

  test("STANDARD_SQUAD carries phase-specific evaluator overrides alongside the role-level entry", () => {
    expect(STANDARD_SQUAD.wire.headings["evaluator"]).toEqual([["## Test Spec"], ["VERDICT:"]])
    expect(STANDARD_SQUAD.wire.headings["evaluator-spec"]).toEqual([["## Test Spec"]])
    expect(STANDARD_SQUAD.wire.headings["evaluator-verdict"]).toEqual([["VERDICT:"]])
  })

  test("evaluator-verdict lint key fails a spec-only payload (live-smoke finding)", () => {
    const specOnly = "## Test Spec\nran\nno verdict line here"
    const bad = lintPayload(STANDARD_SQUAD, "evaluator-verdict", specOnly)
    expect(bad.ok).toBe(false)
    // Would have passed under the old collapsed "evaluator" key, since that
    // key's OR-group is satisfied by "## Test Spec" alone.
    expect(lintPayload(STANDARD_SQUAD, "evaluator", specOnly).ok).toBe(true)
  })

  test("evaluator-verdict lint key passes a proper VERDICT payload", () => {
    expect(lintPayload(STANDARD_SQUAD, "evaluator-verdict", "VERDICT: PASS").ok).toBe(true)
  })
})

describe("escalations + verdict", () => {
  test("detectEscalation types all five; Refused wins over other headings", () => {
    expect(detectEscalation("## Clarify\nA or B?")?.type).toBe("Clarify")
    expect(detectEscalation("## Infeasible\ncontradictory")?.type).toBe("Infeasible")
    expect(detectEscalation("## Use Cases\n## Refused\nharmful")?.type).toBe("Refused")
    expect(detectEscalation("## Use Cases\nfine")).toBeNull()
  })

  test("parseVerdict: PASS, FAIL with cause, FAIL defaults to impl, garbage → null", () => {
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: PASS")).toEqual({ verdict: "PASS" })
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL cause=design"))
      .toEqual({ verdict: "FAIL", cause: "design" })
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL")).toEqual({ verdict: "FAIL", cause: "impl" })
    expect(parseVerdict(STANDARD_SQUAD, "looks good")).toBeNull()
  })

  // Live-loop finding: three proposer generations converged blindly toward an
  // invisible wire contract — verdictRe's uppercase requirement appeared
  // nowhere in the evidence shown to the proposer. Case-insensitive parsing
  // is the robustness half of the fix (Fix B below closes the visibility gap).
  test("parseVerdict is case-insensitive: lowercase 'verdict: pass' normalizes to PASS", () => {
    expect(parseVerdict(STANDARD_SQUAD, "verdict: pass")).toEqual({ verdict: "PASS" })
  })

  test("parseVerdict is case-insensitive: mixed-case cause normalizes to lowercase", () => {
    expect(parseVerdict(STANDARD_SQUAD, "verdict: FAIL cause=DESIGN"))
      .toEqual({ verdict: "FAIL", cause: "design" })
  })

  // Live-loop finding, generation 4: a haiku evaluator emitted
  // "**VERDICT: pass**" (markdown bold) and the bare ^VERDICT:...$ anchors
  // rejected it. parseVerdict now strips markdown emphasis/backticks +
  // surrounding whitespace per line before matching.
  test("parseVerdict tolerates markdown bold: '**VERDICT: pass**' normalizes to PASS", () => {
    expect(parseVerdict(STANDARD_SQUAD, "**VERDICT: pass**")).toEqual({ verdict: "PASS" })
  })

  test("parseVerdict tolerates underscores + surrounding whitespace: '  __verdict: FAIL cause=design__  '", () => {
    expect(parseVerdict(STANDARD_SQUAD, "  __verdict: FAIL cause=design__  "))
      .toEqual({ verdict: "FAIL", cause: "design" })
  })

  test("parseVerdict tolerates backticks: '`VERDICT: PASS`'", () => {
    expect(parseVerdict(STANDARD_SQUAD, "`VERDICT: PASS`")).toEqual({ verdict: "PASS" })
  })

  test("parseVerdict leaves a plain unadorned VERDICT line unchanged", () => {
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: PASS")).toEqual({ verdict: "PASS" })
  })

  test("parseVerdict still returns null for garbage even after emphasis stripping", () => {
    expect(parseVerdict(STANDARD_SQUAD, "**looks good**")).toBeNull()
  })
})

describe("syncWireContracts (Fix B — wire contract visible to the proposer)", () => {
  test("writes contract.md under each role's account-role root", () => {
    syncWireContracts(STANDARD_SQUAD)
    for (const role of ["analyzer", "designer", "implementer", "evaluator"]) {
      const p = join(accountRoleRoot(`mh-${role}`), "contract.md")
      const content = readFileSync(p, "utf-8")
      expect(content.length).toBeGreaterThan(0)
    }
  })

  test("evaluator's contract.md contains the verdictRe pattern and a VERDICT: PASS example", () => {
    syncWireContracts(STANDARD_SQUAD)
    const content = readFileSync(join(accountRoleRoot("mh-evaluator"), "contract.md"), "utf-8")
    expect(content).toContain(STANDARD_SQUAD.wire.verdictRe)
    expect(content).toContain("VERDICT: PASS")
  })

  test("non-evaluator roles' contracts omit the verdictRe pattern", () => {
    syncWireContracts(STANDARD_SQUAD)
    const content = readFileSync(join(accountRoleRoot("mh-analyzer"), "contract.md"), "utf-8")
    expect(content).not.toContain(STANDARD_SQUAD.wire.verdictRe)
  })

  test("writeSquadDefV1 calls syncWireContracts as a side effect", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const content = readFileSync(join(accountRoleRoot("mh-implementer"), "contract.md"), "utf-8")
    expect(content).toContain("## Implementation Report")
  })
})
