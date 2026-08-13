// Store-level integration: drive the REAL transition functions the way the
// engine/propose callers do, then assert the export appears/updates.
// (engine.ts itself is not importable in isolation — these tests pin the
// helper-at-transition semantics; the call-site placement in engine.ts /
// propose.ts is exercised indirectly by the existing propose-apply e2e
// tests once wired, per the task-2 brief.)
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCandidate,
  activateCandidate,
  startTrial,
  resolveTrial,
  recordSession,
  type Playbook,
  type SessionRecord,
} from "../src/harness-store.ts"
import { exportRuleChecks, RULE_CHECKS_EXPORT_REL } from "../src/rule-checks-export.ts"

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    sessionID: "s1",
    passed: true,
    note: "",
    turnCount: 1,
    timestamp: new Date().toISOString(),
    summary: "",
    model: "anthropic/claude-x",
    variant: "",
    toolUsage: {},
    ...overrides,
  }
}

/** Minimal Playbook with one bullet, optionally carrying a check. */
function mkPlaybook(check?: { cmd: string; timeoutMs: number; state: "shadow" | "blocking"; liveEligible?: boolean }): Playbook {
  return {
    schemaVersion: 1,
    nextId: 2,
    bullets: [
      {
        id: "b1",
        text: "some rule",
        helpful: 0,
        harmful: 0,
        addedBy: "test",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(check ? { check } : {}),
      },
    ],
  }
}

describe("export-at-transition semantics", () => {
  let repoRoot: string
  let storeRoot: string
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "rcw-repo-"))
    storeRoot = mkdtempSync(join(tmpdir(), "rcw-store-"))
  })
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(storeRoot, { recursive: true, force: true })
  })

  function readExport() {
    return JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
  }

  test("activateCandidate then export reflects the newly active playbook's eligible checks", () => {
    const playbook = mkPlaybook({ cmd: "bun test", timeoutMs: 5000, state: "shadow", liveEligible: true })
    createCandidate(storeRoot, "v1", "system text", "", playbook)
    const ok = activateCandidate(storeRoot, "v1")
    expect(ok).toBe(true)

    exportRuleChecks(repoRoot, storeRoot) // what engine.ts:829 will do

    const out = readExport()
    expect(out.rules).toEqual([{ id: "b1", cmd: "bun test", timeoutMs: 5000, state: "shadow" }])
  })

  test("startTrial makes the trial playbook's checks live immediately; revert restores baseline export", () => {
    // Baseline WITHOUT checks.
    const baselinePlaybook = mkPlaybook()
    createCandidate(storeRoot, "v0", "baseline system", "", baselinePlaybook)
    activateCandidate(storeRoot, "v0")
    recordSession(storeRoot, "v0", session({ sessionID: "base-1", passed: true }))

    // Trial WITH a liveEligible check.
    const trialPlaybook = mkPlaybook({ cmd: "bun test", timeoutMs: 5000, state: "shadow", liveEligible: true })
    createCandidate(storeRoot, "v1", "trial system", "", trialPlaybook)
    startTrial(storeRoot, "v1", "trial system", "", 1, trialPlaybook)
    exportRuleChecks(repoRoot, storeRoot) // what propose.ts's startTrial call sites will do
    expect(readExport().rules.length).toBe(1)

    // Losing trial -> revert.
    recordSession(storeRoot, "v1", session({ sessionID: "trial-1", passed: false }))
    const resolution = resolveTrial(storeRoot)
    expect(resolution.action).toBe("reverted")

    exportRuleChecks(repoRoot, storeRoot) // what engine.ts's resolveTrial loop will do on revert
    expect(readExport().rules).toEqual([]) // baseline had no checks
  })

  test("resolveTrial CONFIRM branch: export re-derived, not skipped (file rewritten)", async () => {
    const baselinePlaybook = mkPlaybook({ cmd: "bun test", timeoutMs: 5000, state: "shadow", liveEligible: true })
    createCandidate(storeRoot, "v0", "baseline system", "", baselinePlaybook)
    activateCandidate(storeRoot, "v0")
    recordSession(storeRoot, "v0", session({ sessionID: "base-1", passed: true }))

    const trialPlaybook = mkPlaybook({ cmd: "bun test", timeoutMs: 5000, state: "shadow", liveEligible: true })
    createCandidate(storeRoot, "v1", "trial system", "", trialPlaybook)
    startTrial(storeRoot, "v1", "trial system", "", 1, trialPlaybook)
    exportRuleChecks(repoRoot, storeRoot)
    const first = readExport()

    // The sleep alone resolves Date.now() same-ms flakiness: monotonic
    // non-decreasing + a >=2ms gap guarantees the second write lands
    // strictly later.
    await new Promise((r) => setTimeout(r, 2))

    // Winning trial -> confirm.
    recordSession(storeRoot, "v1", session({ sessionID: "trial-1", passed: true }))
    const resolution = resolveTrial(storeRoot)
    expect(resolution.action).toBe("confirmed")

    exportRuleChecks(repoRoot, storeRoot) // what engine.ts's resolveTrial loop will do on confirm
    const second = readExport()

    // Strict > is load-bearing: an accidentally-SKIPPED reaffirm export
    // leaves writtenTs exactly equal (and rules trivially equal) — a >=
    // assertion would pass on the very bug this test exists to catch.
    expect(second.writtenTs).toBeGreaterThan(first.writtenTs)
    expect(second.rules).toEqual(first.rules) // content unchanged, reaffirmed
  })
})
