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
  const storeRoot = path.join(tmp, ".meta-harness", "roles", "mh-build")
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
