/**
 * hook-rules-kill.test.ts — TDD for src/hook-rules-kill.ts (hook-rule P3
 * plan, T4). Written FIRST, failing (module did not exist yet).
 *
 * Contract 3: setHookRulesKillSwitch persists `hookRulesKillSwitch` into the
 * store-root config (readMhConfig's file) then re-exports the table, so
 * `.km/hook-rules.json` flips immediately — "instantly" = the next hook
 * process reads the new table. exportHookRules reads the config flag
 * (default false — P1 behavior preserved).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setHookRulesKillSwitch } from "../src/hook-rules-kill"
import { HOOK_RULES_EXPORT_REL, exportHookRules } from "../src/hook-rules-export"
import type { Playbook, PlaybookBullet } from "../src/harness-store"

let repoRoot: string
let storeRoot: string

function bullet(n: number, mode: "shadow" | "warn" | "deny" = "shadow"): PlaybookBullet {
  return {
    id: `b${n}`,
    text: `rule ${n}`,
    helpful: 0,
    harmful: 0,
    addedBy: "test",
    status: "active",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^docker ", feedback: `f${n}`, mode },
  }
}

function writeActivePlaybook(pb: Playbook): void {
  const active = join(storeRoot, "active")
  mkdirSync(active, { recursive: true })
  writeFileSync(join(active, "playbook.json"), JSON.stringify(pb))
}

function readExport(): { killSwitch: boolean; rules: { id: string }[] } {
  return JSON.parse(readFileSync(join(repoRoot, HOOK_RULES_EXPORT_REL), "utf-8"))
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "hr-kill-repo-"))
  storeRoot = mkdtempSync(join(tmpdir(), "hr-kill-store-"))
  writeActivePlaybook({ schemaVersion: 1, nextId: 2, bullets: [bullet(1)] })
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

test("toggle on: table killSwitch flips to true immediately (re-export inside the setter)", () => {
  setHookRulesKillSwitch(repoRoot, storeRoot, true)
  const out = readExport()
  expect(out.killSwitch).toBe(true)
  expect(out.rules.map((r) => r.id)).toEqual(["b1"])
})

test("toggle off: table killSwitch back to false", () => {
  setHookRulesKillSwitch(repoRoot, storeRoot, true)
  setHookRulesKillSwitch(repoRoot, storeRoot, false)
  expect(readExport().killSwitch).toBe(false)
})

test("config persisted: hookRulesKillSwitch lands in the store-root config.json, other keys preserved", () => {
  writeFileSync(join(storeRoot, "config.json"), JSON.stringify({ proposerModel: "anthropic/claude-opus-5" }))
  setHookRulesKillSwitch(repoRoot, storeRoot, true)
  const cfg = JSON.parse(readFileSync(join(storeRoot, "config.json"), "utf-8"))
  expect(cfg.hookRulesKillSwitch).toBe(true)
  expect(cfg.proposerModel).toBe("anthropic/claude-opus-5")
})

test("exportHookRules without any config file: killSwitch false (P1 default preserved)", () => {
  exportHookRules(repoRoot, storeRoot)
  expect(readExport().killSwitch).toBe(false)
})

test("exportHookRules honors an already-set config flag on its own (no setter involved)", () => {
  writeFileSync(join(storeRoot, "config.json"), JSON.stringify({ hookRulesKillSwitch: true }))
  exportHookRules(repoRoot, storeRoot)
  expect(readExport().killSwitch).toBe(true)
})
