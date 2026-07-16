/**
 * fleet-dag-planner.test.ts — T3 (N4) Task 3: PLANNER_SQUAD def + guarded
 * Designer DAG wire-contract. Hermetic META_HARNESS_HOME per-test, same
 * beforeEach idiom as fleet-squad-cli.test.ts / fleet-squad-def.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountRoleRoot } from "../src/harness-store.ts"
import { PLANNER_SQUAD, STANDARD_SQUAD, readActiveSquadDef, writeSquadDefV1 } from "../src/fleet/squad-def.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-planner-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("PLANNER_SQUAD def shape", () => {
  test("type is 'planner'; designer wire is [['## Task DAG']]; gatePolicy is {gate1:auto,gate2:human}; slots match STANDARD's", () => {
    expect(PLANNER_SQUAD.type).toBe("planner")
    expect(PLANNER_SQUAD.wire.headings.designer).toEqual([["## Task DAG"]])
    expect(PLANNER_SQUAD.flow.gatePolicy).toEqual({ gate1: "auto", gate2: "human" })
    expect(PLANNER_SQUAD.slots).toEqual(STANDARD_SQUAD.slots)
  })
})

describe("PLANNER_SQUAD writes + reads back", () => {
  test("writeSquadDefV1(PLANNER_SQUAD) then readActiveSquadDef('planner') round-trips the designer wire", () => {
    writeSquadDefV1(PLANNER_SQUAD)
    const def = readActiveSquadDef("planner")
    expect(def.wire.headings.designer).toEqual([["## Task DAG"]])
  })
})

describe("planner Designer contract.md teaches the DAG format", () => {
  test("mh-designer's contract.md contains the ## Task DAG heading and the block-format detail", () => {
    writeSquadDefV1(PLANNER_SQUAD)
    const contract = readFileSync(join(accountRoleRoot("mh-designer"), "contract.md"), "utf-8")
    expect(contract).toContain("## Task DAG")
    expect(contract).toContain("deps")
    expect(contract).toContain("mutatesDeps")
  })
})

describe("back-compat regression — STANDARD_SQUAD's designer contract stays byte-identical", () => {
  test("in a separate META_HARNESS_HOME, mh-designer's contract.md has no Task DAG and keeps Alternatives/Recommended", () => {
    const otherHome = mkdtempSync(join(tmpdir(), "mh-planner-std-"))
    process.env.META_HARNESS_HOME = otherHome
    try {
      writeSquadDefV1(STANDARD_SQUAD)
      const contract = readFileSync(join(accountRoleRoot("mh-designer"), "contract.md"), "utf-8")
      expect(contract).not.toContain("Task DAG")
      expect(contract).toContain("## Alternatives")
      expect(contract).toContain("## Recommended")
    } finally {
      process.env.META_HARNESS_HOME = home
      rmSync(otherHome, { recursive: true, force: true })
    }
  })
})
