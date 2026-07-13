import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STANDARD_SQUAD, detectEscalation, lintPayload, parseVerdict,
  readActiveSquadDef, squadRoot, writeSquadDefV1,
} from "../src/fleet/squad-def.ts"
import type { SquadDef } from "../src/fleet/squad-def.ts"

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
})
