// Store-level integration for the hook-rules table: drive the REAL
// transition functions the way engine/propose callers do, then assert the
// compiled table appears/updates (rule-checks-export-wiring precedent —
// call-site placement in engine.ts/propose.ts is the same five lines as
// exportRuleChecks, exercised indirectly by the propose-apply e2e tests).
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCandidate, activateCandidate, type Playbook } from "../src/harness-store.ts"
import { exportHookRules, HOOK_RULES_EXPORT_REL } from "../src/hook-rules-export.ts"

function mkPlaybook(withRule: boolean): Playbook {
  return {
    schemaVersion: 1,
    nextId: 2,
    bullets: [
      {
        id: "b1",
        text: "when containerizing use podman",
        helpful: 0,
        harmful: 0,
        addedBy: "test",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(withRule
          ? { hookRule: { event: "PreToolUse" as const, toolMatcher: "Bash" as const, inputPattern: "^docker ", feedback: "use podman", mode: "shadow" as const } }
          : {}),
      },
    ],
  }
}

describe("hook-rules export-at-transition semantics", () => {
  let repoRoot: string
  let storeRoot: string
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "hrw-repo-"))
    storeRoot = mkdtempSync(join(tmpdir(), "hrw-store-"))
  })
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(storeRoot, { recursive: true, force: true })
  })

  test("activateCandidate then export reflects the newly active playbook's hookRules", () => {
    createCandidate(storeRoot, "v1", "system text", "", mkPlaybook(true))
    expect(activateCandidate(storeRoot, "v1")).toBe(true)
    exportHookRules(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, HOOK_RULES_EXPORT_REL), "utf8"))
    expect(out.rules.length).toBe(1)
    expect(out.rules[0].id).toBe("b1")
    expect(out.rules[0].mode).toBe("shadow")
  })

  test("activating a rule-less candidate empties the table (stale rules never linger)", () => {
    createCandidate(storeRoot, "v1", "system text", "", mkPlaybook(true))
    activateCandidate(storeRoot, "v1")
    exportHookRules(repoRoot, storeRoot)
    createCandidate(storeRoot, "v2", "system text", "", mkPlaybook(false))
    activateCandidate(storeRoot, "v2")
    exportHookRules(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, HOOK_RULES_EXPORT_REL), "utf8"))
    expect(out.rules).toEqual([])
  })
})
