// opencode-plugin/test/rule-checks-export.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportRuleChecks, RULE_CHECKS_EXPORT_REL } from "../src/rule-checks-export.ts"
import type { Playbook } from "../src/harness-store.ts"

let repoRoot: string
let storeRoot: string

function writeActivePlaybook(pb: Playbook): void {
  mkdirSync(join(storeRoot, "active"), { recursive: true })
  writeFileSync(join(storeRoot, "active", "playbook.json"), JSON.stringify(pb, null, 2))
}

const basePb = (bullets: Playbook["bullets"]): Playbook => ({ schemaVersion: 1, nextId: bullets.length + 1, bullets })

const bullet = (id: string, over: Partial<Playbook["bullets"][number]> = {}): Playbook["bullets"][number] => ({
  id, text: `rule ${id}`, helpful: 0, harmful: 0, addedBy: "test", status: "active",
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z", ...over,
})

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "rce-repo-"))
  storeRoot = mkdtempSync(join(tmpdir(), "rce-store-"))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

describe("exportRuleChecks", () => {
  test("writes only liveEligible checks from active bullets, spec file shape", () => {
    writeActivePlaybook(basePb([
      bullet("pb-1", { check: { cmd: "bun test --silent", timeoutMs: 30000, state: "shadow", liveEligible: true } }),
      bullet("pb-2", { check: { cmd: "curl example.com", timeoutMs: 5000, state: "shadow", liveEligible: false } }),
      bullet("pb-3"), // no check
      bullet("pb-4", { status: "pruned", check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } }),
    ]))
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.version).toBe(1)
    expect(typeof out.writtenTs).toBe("number")
    expect(out.rules).toEqual([{ id: "pb-1", cmd: "bun test --silent", timeoutMs: 30000, state: "shadow" }])
  })

  test("empty rules array when no eligible checks; creates .km/ if missing", () => {
    writeActivePlaybook(basePb([bullet("pb-1")]))
    expect(existsSync(join(repoRoot, ".km"))).toBe(false)
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules).toEqual([])
  })

  test("no active playbook at storeRoot: writes empty rules (post-null-writeActive state)", () => {
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules).toEqual([])
  })

  test("overwrites a previous export wholesale (no merge)", () => {
    writeActivePlaybook(basePb([bullet("pb-1", { check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } })]))
    exportRuleChecks(repoRoot, storeRoot)
    writeActivePlaybook(basePb([bullet("pb-9", { check: { cmd: "false", timeoutMs: 2000, state: "shadow", liveEligible: true } })]))
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules.map((r: { id: string }) => r.id)).toEqual(["pb-9"])
  })

  test("never throws: unwritable repoRoot is swallowed (fail-open producer)", () => {
    writeActivePlaybook(basePb([]))
    expect(() => exportRuleChecks(join(repoRoot, "no-such-parent", "x", "y"), storeRoot)).not.toThrow()
  })
})
