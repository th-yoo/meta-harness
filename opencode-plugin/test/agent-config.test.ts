import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  validateAgentConfig,
  readAgentConfig,
  createCandidate,
  activateCandidate,
  startTrial,
  resolveTrial,
  recordSession,
  type AgentConfig,
  type SessionRecord,
} from "../src/harness-store.ts"

function tmpStore(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-agent-config-"))
  const storeRoot = path.join(tmp, ".kkamak", "roles", "mh-build")
  fs.mkdirSync(storeRoot, { recursive: true })
  return storeRoot
}

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

test("validateAgentConfig clamps fastTimeoutMs into [500, 30000]", () => {
  expect(validateAgentConfig({ schemaVersion: 1, fastTimeoutMs: 100 })).toEqual({
    schemaVersion: 1, fastTimeoutMs: 500,
  })
  expect(validateAgentConfig({ schemaVersion: 1, fastTimeoutMs: 99999 })).toEqual({
    schemaVersion: 1, fastTimeoutMs: 30000,
  })
})

test("validateAgentConfig filters invalid command entries, keeping valid ones", () => {
  const out = validateAgentConfig({
    schemaVersion: 1,
    extraFastCommands: ["rm -rf /", "good-cmd", "also.ok_1"],
  })
  expect(out).toEqual({
    schemaVersion: 1,
    extraFastCommands: ["good-cmd", "also.ok_1"],
  })
})

test("validateAgentConfig drops unknown fields", () => {
  const out = validateAgentConfig({ schemaVersion: 1, bogus: "field", fastTimeoutMs: 1000 })
  expect(out).toEqual({ schemaVersion: 1, fastTimeoutMs: 1000 })
})

test("validateAgentConfig caps command lists at 20 entries", () => {
  const many = Array.from({ length: 25 }, (_, i) => `cmd${i}`)
  const out = validateAgentConfig({ schemaVersion: 1, extraSlowCommands: many })
  expect(out?.extraSlowCommands?.length).toBe(20)
})

test("validateAgentConfig returns null for non-objects and wrong schemaVersion", () => {
  expect(validateAgentConfig({ schemaVersion: 2 })).toBeNull()
  expect(validateAgentConfig(null)).toBeNull()
  expect(validateAgentConfig("nope")).toBeNull()
  expect(validateAgentConfig([1, 2, 3])).toBeNull()
  expect(validateAgentConfig({})).toBeNull()
})

test("agent config rides createCandidate -> activateCandidate -> readAgentConfig", () => {
  const root = tmpStore()
  const cfg: AgentConfig = {
    schemaVersion: 1,
    fastTimeoutMs: 2000,
    extraFastCommands: ["ls", "pwd"],
    extraSlowCommands: ["build"],
  }
  createCandidate(root, "v1", "system text", "", undefined, cfg)
  const ok = activateCandidate(root, "v1")
  expect(ok).toBe(true)
  expect(readAgentConfig(root)).toEqual(cfg)
})

test("Phase 4 durability fix: a trial that CONFIRMS does not wipe the active agent-config when the cycle staged none", () => {
  // Reproduces the bug from the whole-branch review: propose/curate threaded
  // agentConfig/envPolicy into createCandidate/startTrial ONLY from a staged
  // file. When nothing was staged this cycle, that local was `null`, and
  // startTrial(..., null) -> writeActive treats `null` as REMOVE, deleting
  // the active knob. Because resolveTrial's CONFIRMED path only clearTrials
  // (never restores active), a playbook-only trial that CONFIRMS would
  // delete an evolved knob PERMANENTLY. The fix: carry the active config
  // forward (`staged ?? readAgentConfig(root)`) before calling createCandidate
  // and startTrial — this test drives that exact idiom end-to-end.
  const root = tmpStore()
  const cfg: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 4000 }

  createCandidate(root, "v0", "baseline system", "", undefined, cfg)
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-1", passed: true }))

  // Simulate a playbook-only propose/curate cycle: nothing staged this round.
  const staged: AgentConfig | null = null
  const carried = staged ?? readAgentConfig(root)
  expect(carried).toEqual(cfg) // sanity: carry-forward picked up the active knob

  createCandidate(root, "v1", "trial system (playbook edit only)", "", undefined, carried ?? undefined)
  startTrial(root, "v1", "trial system (playbook edit only)", "", 1, null, carried)
  expect(readAgentConfig(root)).toEqual(cfg) // still present immediately after trial start

  // Trial matches baseline's pass rate -> CONFIRMED (not reverted).
  recordSession(root, "v1", session({ sessionID: "trial-1", passed: true }))
  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("confirmed")

  // The whole point of the fix: CONFIRM must not have wiped the knob.
  expect(readAgentConfig(root)).toEqual(cfg)
})

test("trial revert restores the baseline agent config", () => {
  const root = tmpStore()
  const cfg1: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 1000 }
  const cfg2: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 5000 }

  createCandidate(root, "v0", "baseline system", "", undefined, cfg1)
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-1", passed: true }))

  createCandidate(root, "v1", "trial system", "", undefined, cfg2)
  startTrial(root, "v1", "trial system", "", 1, null, cfg2)
  expect(readAgentConfig(root)).toEqual(cfg2)

  recordSession(root, "v1", session({ sessionID: "trial-1", passed: false }))
  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("reverted")
  expect(readAgentConfig(root)).toEqual(cfg1)
})
