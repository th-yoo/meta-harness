import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOOK_RULES_DENY_MAX, HOOK_RULES_EXPORT_REL, HOOK_RULES_MAX, exportHookRules } from "../src/hook-rules-export"
import type { Playbook, PlaybookBullet } from "../src/harness-store"

let repoRoot: string
let storeRoot: string

function bullet(n: number, mode: "shadow" | "warn" | "deny" = "shadow", pattern = "^docker "): PlaybookBullet {
  return {
    id: `b${n}`,
    text: `rule ${n}`,
    helpful: 0,
    harmful: 0,
    addedBy: "test",
    status: "active",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash", inputPattern: pattern, feedback: `f${n}`, mode },
  }
}

function writeActivePlaybook(pb: Playbook): void {
  const active = join(storeRoot, "active")
  mkdirSync(active, { recursive: true })
  writeFileSync(join(active, "playbook.json"), JSON.stringify(pb))
}

function readExport(): { version: number; writtenTs: number; killSwitch: boolean; rules: { id: string; mode: string }[] } {
  return JSON.parse(readFileSync(join(repoRoot, HOOK_RULES_EXPORT_REL), "utf-8"))
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "hr-export-repo-"))
  storeRoot = mkdtempSync(join(tmpdir(), "hr-export-store-"))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

describe("exportHookRules", () => {
  test("shape: version, writtenTs, killSwitch:false, flattened active hookRule bullets only", () => {
    const pruned = { ...bullet(3), status: "pruned" as const }
    const noRule = { ...bullet(4), hookRule: undefined }
    writeActivePlaybook({ schemaVersion: 1, nextId: 5, bullets: [bullet(1), pruned, noRule] })
    exportHookRules(repoRoot, storeRoot)
    const out = readExport()
    expect(out.version).toBe(1)
    expect(out.killSwitch).toBe(false)
    expect(out.rules.map((r) => r.id)).toEqual(["b1"])
  })

  test("stable numeric-id ordering", () => {
    writeActivePlaybook({ schemaVersion: 1, nextId: 13, bullets: [bullet(3), bullet(12), bullet(2)] })
    exportHookRules(repoRoot, storeRoot)
    expect(readExport().rules.map((r) => r.id)).toEqual(["b2", "b3", "b12"])
  })

  test("caps: 18 rules -> 16 exported by id order", () => {
    const bullets = Array.from({ length: 18 }, (_, i) => bullet(i + 1))
    writeActivePlaybook({ schemaVersion: 1, nextId: 19, bullets })
    exportHookRules(repoRoot, storeRoot)
    const ids = readExport().rules.map((r) => r.id)
    expect(ids.length).toBe(HOOK_RULES_MAX)
    expect(ids[0]).toBe("b1")
    expect(ids).not.toContain("b17")
    expect(ids).not.toContain("b18")
  })

  test("deny cap: 6 deny -> 4 kept by id order, excess deny DROPPED entirely (not demoted)", () => {
    const bullets = Array.from({ length: 6 }, (_, i) => bullet(i + 1, "deny"))
    writeActivePlaybook({ schemaVersion: 1, nextId: 7, bullets })
    exportHookRules(repoRoot, storeRoot)
    const rules = readExport().rules
    expect(rules.filter((r) => r.mode === "deny").length).toBe(HOOK_RULES_DENY_MAX)
    expect(rules.map((r) => r.id)).toEqual(["b1", "b2", "b3", "b4"])
  })

  test("non-portable pattern in store is skipped defensively", () => {
    writeActivePlaybook({
      schemaVersion: 1,
      nextId: 3,
      bullets: [bullet(1), bullet(2, "shadow", "^npm\\s+install")],
    })
    exportHookRules(repoRoot, storeRoot)
    expect(readExport().rules.map((r) => r.id)).toEqual(["b1"])
  })

  test("fail-open: missing playbook writes empty table, never throws", () => {
    exportHookRules(repoRoot, storeRoot)
    expect(readExport().rules).toEqual([])
  })
})
