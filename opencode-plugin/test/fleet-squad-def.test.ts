import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STANDARD_SQUAD, activeSquadVersion, detectEscalation, lintPayload, parseVerdict,
  readActiveSquadDef, readSquadDefVersion, recordSquadOutcome, squadRoot, syncWireContracts, writeSquadDefV1,
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

  // #2 (verdict→score): the Evaluator may append `score=<passed>/<total>` so a
  // future best-of-k can RANK candidates when several pass or all fail. Optional
  // + backward-compatible: no score → the field is simply absent.
  test("parseVerdict extracts optional score=N/M (normalized passed/total)", () => {
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: PASS score=32/32"))
      .toEqual({ verdict: "PASS", score: 1 })
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL cause=impl score=28/32"))
      .toEqual({ verdict: "FAIL", cause: "impl", score: 0.875 })
  })

  test("parseVerdict score is absent when not emitted (back-compat) and on total=0", () => {
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: PASS")).toEqual({ verdict: "PASS" })
    // total=0 is degenerate — no score field rather than a div-by-zero.
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL cause=impl score=0/0"))
      .toEqual({ verdict: "FAIL", cause: "impl" })
  })

  test("evaluator wire contract instructs the optional score suffix", () => {
    const home = mkdtempSync(join(tmpdir(), "mh-wire-"))
    process.env.META_HARNESS_HOME = home
    try {
      writeSquadDefV1(STANDARD_SQUAD)
      const contract = readFileSync(join(accountRoleRoot("mh-evaluator"), "contract.md"), "utf-8")
      expect(contract).toContain("score=")
    } finally {
      delete process.env.META_HARNESS_HOME
      rmSync(home, { recursive: true, force: true })
    }
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

describe("channel 2 — squad-level fitness (spec §6, D5)", () => {
  test("activeSquadVersion reads the active def's __version", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    expect(activeSquadVersion("standard")).toBe("v1")
  })

  test("activeSquadVersion defaults to v1 when no active def exists", () => {
    expect(activeSquadVersion("nope")).toBe("v1")
  })

  test("recordSquadOutcome creates score.json under the active version, same shape as a role score", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    recordSquadOutcome("standard", {
      sliceId: "s1", passed: true, steps: 12, nodePath: "root/s1", ts: "2026-07-14T00:00:00.000Z",
    })
    const p = join(squadRoot("standard"), "candidates", "v1", "score.json")
    const score = JSON.parse(readFileSync(p, "utf-8"))
    expect(score.version).toBe("v1")
    expect(score.nPass).toBe(1)
    expect(score.nFail).toBe(0)
    expect(score.sessions).toEqual([
      { sliceId: "s1", passed: true, steps: 12, nodePath: "root/s1", ts: "2026-07-14T00:00:00.000Z" },
    ])
  })

  test("recordSquadOutcome appends across calls and bumps nPass/nFail independently", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    recordSquadOutcome("standard", { sliceId: "s1", passed: true, steps: 5, ts: "t1" })
    recordSquadOutcome("standard", {
      sliceId: "s2", passed: false, steps: 40, escalationType: "Exhausted", ts: "t2",
    })
    const p = join(squadRoot("standard"), "candidates", "v1", "score.json")
    const score = JSON.parse(readFileSync(p, "utf-8"))
    expect(score.nPass).toBe(1)
    expect(score.nFail).toBe(1)
    expect(score.sessions.length).toBe(2)
    expect(score.sessions[1].escalationType).toBe("Exhausted")
  })

  test("recordSquadOutcome never throws when no active squad def exists (recording must never break a run)", () => {
    expect(() =>
      recordSquadOutcome("nonexistent", { sliceId: "s1", passed: true, steps: 1, ts: "t" }),
    ).not.toThrow()
    expect(existsSync(join(squadRoot("nonexistent"), "candidates"))).toBe(false)
  })
})

describe("readSquadDefVersion (def-version pin, spec §6 ch2)", () => {
  test("happy: reads an INACTIVE candidate version's squad.json", () => {
    writeSquadDefV1(STANDARD_SQUAD) // active = v1
    const v2: SquadDef = {
      ...STANDARD_SQUAD,
      flow: { ...STANDARD_SQUAD.flow, bounds: { ...STANDARD_SQUAD.flow.bounds, R1: 5 } },
    }
    mkdirSync(join(squadRoot("standard"), "candidates", "v2"), { recursive: true })
    writeFileSync(join(squadRoot("standard"), "candidates", "v2", "squad.json"), JSON.stringify(v2))

    const read = readSquadDefVersion("standard", "v2")
    expect(read.flow.bounds.R1).toBe(5)
    // Active def untouched/unaffected by reading a candidate directly.
    expect(readActiveSquadDef("standard").flow.bounds.R1).toBe(2)
  })

  test("missing version: dies actionably, naming the version and squad type", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    expect(() => readSquadDefVersion("standard", "v9")).toThrow(/v9/)
    expect(() => readSquadDefVersion("standard", "v9")).toThrow(/standard/)
  })

  test("missing squad type entirely: dies actionably", () => {
    expect(() => readSquadDefVersion("nope", "v1")).toThrow(/nope/)
  })

  test("validates slots like readActiveSquadDef: dies on a hand-written claude-code leaf", () => {
    const def: SquadDef = {
      ...STANDARD_SQUAD,
      type: "cc-cand-test",
      slots: {
        ...STANDARD_SQUAD.slots,
        evaluator: { kind: "agent", role: "evaluator", platform: "claude-code", model: "anthropic/claude-haiku-4-5" },
      },
    }
    const dir = join(squadRoot("cc-cand-test"), "candidates", "v1")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "squad.json"), JSON.stringify(def))
    expect(() => readSquadDefVersion("cc-cand-test", "v1")).toThrow(/claude-code leaf/)
  })
})

describe("recordSquadOutcome version override (spec §6 ch2 def-version pin / trial machinery)", () => {
  test("explicit version routes the outcome to THAT candidate's score.json, not the active one", () => {
    writeSquadDefV1(STANDARD_SQUAD) // active = v1
    mkdirSync(join(squadRoot("standard"), "candidates", "v2"), { recursive: true })
    writeFileSync(join(squadRoot("standard"), "candidates", "v2", "squad.json"), JSON.stringify(STANDARD_SQUAD))

    recordSquadOutcome("standard", { sliceId: "s1", passed: true, steps: 4, ts: "t1" }, "v2")

    const v2Score = JSON.parse(readFileSync(join(squadRoot("standard"), "candidates", "v2", "score.json"), "utf-8"))
    expect(v2Score.nPass).toBe(1)
    expect(v2Score.sessions[0]).toMatchObject({ sliceId: "s1", passed: true })
    // v1 (active) never touched by a v2-routed record.
    expect(existsSync(join(squadRoot("standard"), "candidates", "v1", "score.json"))).toBe(false)
  })

  test("omitted version still falls back to activeSquadVersion (unchanged existing behavior)", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    recordSquadOutcome("standard", { sliceId: "s1", passed: true, steps: 4, ts: "t1" })
    const v1Score = JSON.parse(readFileSync(join(squadRoot("standard"), "candidates", "v1", "score.json"), "utf-8"))
    expect(v1Score.nPass).toBe(1)
  })
})
