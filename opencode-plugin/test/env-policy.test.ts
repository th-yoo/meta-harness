import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  validateEnvPolicy,
  readEnvPolicy,
  createCandidate,
  activateCandidate,
  startTrial,
  resolveTrial,
  recordSession,
  type EnvPolicy,
  type SessionRecord,
} from "../src/harness-store.ts"

function tmpStore(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-env-policy-"))
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

test("validateEnvPolicy drops a shell-unsafe lsPath", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, lsPath: "/app; rm -rf /" })
  expect(out).toEqual({ schemaVersion: 1 })
  expect(out?.lsPath).toBeUndefined()
})

test("validateEnvPolicy drops a relative lsPath", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, lsPath: "relative/x" })
  expect(out).toEqual({ schemaVersion: 1 })
  expect(out?.lsPath).toBeUndefined()
})

test("validateEnvPolicy keeps a shell-safe absolute lsPath", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, lsPath: "/app/sub-dir_1" })
  expect(out).toEqual({ schemaVersion: 1, lsPath: "/app/sub-dir_1" })
})

test("validateEnvPolicy filters languageProbes to the fixed whitelist", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, languageProbes: ["python3", "evil"] })
  expect(out).toEqual({ schemaVersion: 1, languageProbes: ["python3"] })
})

test("validateEnvPolicy clamps maxLsEntries into [5, 100]", () => {
  expect(validateEnvPolicy({ schemaVersion: 1, maxLsEntries: 3 })).toEqual({
    schemaVersion: 1, maxLsEntries: 5,
  })
  expect(validateEnvPolicy({ schemaVersion: 1, maxLsEntries: 500 })).toEqual({
    schemaVersion: 1, maxLsEntries: 100,
  })
})

test("validateEnvPolicy drops unknown fields", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, bogus: "field", maxLsEntries: 10 })
  expect(out).toEqual({ schemaVersion: 1, maxLsEntries: 10 })
})

test("validateEnvPolicy preserves the probes object", () => {
  const out = validateEnvPolicy({ schemaVersion: 1, probes: { ls: false, pkg: true } })
  expect(out).toEqual({ schemaVersion: 1, probes: { ls: false, pkg: true } })
})

test("validateEnvPolicy returns null for non-objects and wrong schemaVersion", () => {
  expect(validateEnvPolicy({ schemaVersion: 2 })).toBeNull()
  expect(validateEnvPolicy(null)).toBeNull()
  expect(validateEnvPolicy("nope")).toBeNull()
  expect(validateEnvPolicy([1, 2, 3])).toBeNull()
  expect(validateEnvPolicy({})).toBeNull()
})

test("env policy rides createCandidate -> activateCandidate -> readEnvPolicy", () => {
  const root = tmpStore()
  const policy: EnvPolicy = {
    schemaVersion: 1,
    probes: { ls: true, lang: true, pkg: false, mem: true },
    lsPath: "/app/work",
    maxLsEntries: 40,
    languageProbes: ["python3", "node"],
  }
  createCandidate(root, "v1", "system text", "", undefined, undefined, policy)
  const ok = activateCandidate(root, "v1")
  expect(ok).toBe(true)
  expect(readEnvPolicy(root)).toEqual(policy)
})

test("Phase 4 durability fix: a trial that CONFIRMS does not wipe the active env-policy when the cycle staged none", () => {
  // Same durability bug/fix as agent-config.test.ts's analogous case: without
  // the carry-forward (`staged ?? readEnvPolicy(root)`), a playbook-only
  // trial that CONFIRMS would permanently delete an evolved env-policy,
  // because resolveTrial's CONFIRMED path only clearTrials (never restores).
  const root = tmpStore()
  const policy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 60 }

  createCandidate(root, "v0", "baseline system", "", undefined, undefined, policy)
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-1", passed: true }))

  // Simulate a playbook-only propose/curate cycle: nothing staged this round.
  const staged: EnvPolicy | null = null
  const carried = staged ?? readEnvPolicy(root)
  expect(carried).toEqual(policy)

  createCandidate(root, "v1", "trial system (playbook edit only)", "", undefined, undefined, carried ?? undefined)
  startTrial(root, "v1", "trial system (playbook edit only)", "", 1, null, undefined, carried)
  expect(readEnvPolicy(root)).toEqual(policy)

  recordSession(root, "v1", session({ sessionID: "trial-1", passed: true }))
  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("confirmed")

  expect(readEnvPolicy(root)).toEqual(policy)
})

test("trial revert restores the baseline env policy", () => {
  const root = tmpStore()
  const policy1: EnvPolicy = { schemaVersion: 1, maxLsEntries: 20 }
  const policy2: EnvPolicy = { schemaVersion: 1, maxLsEntries: 80 }

  createCandidate(root, "v0", "baseline system", "", undefined, undefined, policy1)
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-1", passed: true }))

  createCandidate(root, "v1", "trial system", "", undefined, undefined, policy2)
  startTrial(root, "v1", "trial system", "", 1, null, undefined, policy2)
  expect(readEnvPolicy(root)).toEqual(policy2)

  recordSession(root, "v1", session({ sessionID: "trial-1", passed: false }))
  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("reverted")
  expect(readEnvPolicy(root)).toEqual(policy1)
})
