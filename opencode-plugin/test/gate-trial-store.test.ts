import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  createCandidate,
  activateCandidate,
  startTrial,
  resolveTrial,
  resolveGateTrial,
  recordSession,
  readTrial,
  activeVersion,
  readActiveSystem,
  readActiveTools,
  readPlaybook,
  readAgentConfig,
  readEnvPolicy,
  writeActive,
  type SessionRecord,
  type GateTrialVerdict,
  type Playbook,
  type AgentConfig,
  type EnvPolicy,
} from "../src/harness-store.ts"

// §4.3 gate-outcomes trial authority (TM4): the OLD resolveTrial's stand-down
// guard for rewardMode:"gate-outcomes" trials, and the NEW resolveGateTrial
// enactment authority that owns their entire lifecycle. Verdict MATH lives in
// km-crank's trial-verdict.ts (later build item) — resolveGateTrial only
// ENACTS a verdict it is handed.

function tmpStore(): { metaRoot: string; storeRoot: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-gate-trial-"))
  const storeRoot = path.join(tmp, ".kkamak", "roles", "mh-build")
  fs.mkdirSync(storeRoot, { recursive: true })
  return { metaRoot: tmp, storeRoot }
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

function lastMetaMetric(metaRoot: string): Record<string, unknown> {
  const sink = path.join(metaRoot, ".kkamak", "meta-metrics.jsonl")
  const lines = fs.readFileSync(sink, "utf-8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

// ── Contract 1: resolveTrial stand-down guard makes ZERO score reads ───────

test("resolveTrial: gate-outcomes trial stands down with ZERO score reads (call-order spy)", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })

  // Instrument the real fs.readFileSync (call-through spy) so we can prove,
  // by call order/content, that resolveTrial never reaches readScore for a
  // gate-outcomes trial. If the stand-down guard is ever moved BELOW the
  // score read, this assertion genuinely fails: readScore's candidatePath
  // always includes "score.json" in the path it hands to fs.readFileSync.
  const spy = spyOn(fs, "readFileSync")
  let resolution: ReturnType<typeof resolveTrial>
  let scoreReadPaths: string[]
  try {
    resolution = resolveTrial(root)
    // Read the spy's recorded calls BEFORE mockRestore() — mockRestore()
    // clears mock.calls, which would make this assertion vacuously pass.
    scoreReadPaths = spy.mock.calls
      .map((args) => String(args[0]))
      .filter((p) => p.includes("score.json"))
  } finally {
    spy.mockRestore()
  }

  expect(resolution).toEqual({ action: "none" })
  expect(scoreReadPaths).toEqual([])
})

test("resolveTrial: legacy (no rewardMode) trial is unaffected by the guard — still resolves normally", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-1", passed: true }))
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1)
  recordSession(root, "v1", session({ sessionID: "trial-1", passed: true }))

  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("confirmed")
})

// ── Contract 3 + 4: resolveGateTrial keep/rollback/deferred/abandoned ──────

test("resolveGateTrial: no gate-outcomes trial → action none", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  const result = resolveGateTrial(root, { verdict: "keep" })
  expect(result).toEqual({ action: "none" })
})

test("resolveGateTrial: legacy (non-gate-outcomes) trial → action none, untouched", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1) // no opts — legacy trial
  const result = resolveGateTrial(root, { verdict: "keep" })
  expect(result).toEqual({ action: "none" })
  expect(readTrial(root)).not.toBeNull() // untouched — old resolveTrial still owns it
})

test("resolveGateTrial: keep → clearTrial, active stays on trial, ledger action=keep", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const result = resolveGateTrial(root, { verdict: "keep" })

  expect(result).toEqual({ action: "kept" })
  expect(readTrial(root)).toBeNull()
  expect(activeVersion(root)).toBe("v1")
  const metric = lastMetaMetric(metaRoot)
  expect(metric["event"]).toBe("trial")
  expect(metric["action"]).toBe("keep")
})

test("resolveGateTrial: rollback → restores baseline, clearTrial, ledger action=rollback", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "baseline tools")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "trial tools")
  startTrial(root, "v1", "trial system", "trial tools", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const result = resolveGateTrial(root, { verdict: "rollback", reason: "three-clause-fail" })

  expect(result).toEqual({ action: "rolled-back" })
  expect(readTrial(root)).toBeNull()
  expect(activeVersion(root)).toBe("v0")
  expect(readActiveSystem(root)).toBe("baseline system")
  expect(readActiveTools(root)).toBe("baseline tools")
  const metric = lastMetaMetric(metaRoot)
  expect(metric["event"]).toBe("trial")
  expect(metric["action"]).toBe("rollback")
  expect(metric["reason"]).toBe("three-clause-fail")
})

test("resolveGateTrial: rollback with reason=insufficient-events (T_MAX) → distinct ledger action", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const result = resolveGateTrial(root, { verdict: "rollback", reason: "insufficient-events" })

  // The returned action still mirrors an ordinary rollback (state-wise it IS
  // one — baseline restored); only the LEDGER action distinguishes the
  // T_MAX/insufficient-events case from an ordinary three-clause rollback.
  expect(result).toEqual({ action: "rolled-back" })
  expect(activeVersion(root)).toBe("v0")
  const metric = lastMetaMetric(metaRoot)
  expect(metric["action"]).toBe("insufficient-events")
})

test("resolveGateTrial: deferred → NO state change, ledger action=deferred", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const before = readTrial(root)
  const result = resolveGateTrial(root, { verdict: "deferred", reason: "metric null" })

  expect(result).toEqual({ action: "deferred" })
  expect(activeVersion(root)).toBe("v1") // unchanged
  expect(readTrial(root)).toEqual(before) // unchanged — no enactment
  const metric = lastMetaMetric(metaRoot)
  expect(metric["event"]).toBe("trial")
  expect(metric["action"]).toBe("deferred")
  expect(metric["reason"]).toBe("metric null")
})

test("resolveGateTrial: abandoned (explicit verdict, trial candidate still active) → restores baseline, clearTrial, ledger action=abandoned + baseline", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "baseline tools")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "trial tools")
  startTrial(root, "v1", "trial system", "trial tools", 1, null, null, null, { rewardMode: "gate-outcomes" })
  expect(activeVersion(root)).toBe("v1") // trial candidate is live before abandon

  const result = resolveGateTrial(root, { verdict: "abandoned", reason: "calibration-stale" })

  expect(result).toEqual({ action: "abandoned" })
  expect(readTrial(root)).toBeNull()
  // §5 abandon amendment clause 2 (pre-data, TM6 review, 54238eb): the
  // active-changed guard did NOT fire here (active === trial.trial), so this
  // is the explicit-abandon path — it must restore the baseline, same as
  // rollback, never leave the unvalidated trial candidate active.
  expect(activeVersion(root)).toBe("v0")
  expect(readActiveSystem(root)).toBe("baseline system")
  expect(readActiveTools(root)).toBe("baseline tools")
  const metric = lastMetaMetric(metaRoot)
  expect(metric["event"]).toBe("trial")
  expect(metric["action"]).toBe("abandoned")
  expect(metric["reason"]).toBe("calibration-stale")
  expect(metric["baseline"]).toBe("v0")
})

test("resolveGateTrial: abandoned (explicit verdict, exposure-divergence) → restores baseline", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "baseline tools")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "trial tools")
  startTrial(root, "v1", "trial system", "trial tools", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const result = resolveGateTrial(root, { verdict: "abandoned", reason: "exposure-divergence" })

  expect(result).toEqual({ action: "abandoned" })
  expect(activeVersion(root)).toBe("v0")
  expect(readActiveSystem(root)).toBe("baseline system")
})

// ── Contract 4: rollback restores ALL five snapshot fields ─────────────────

test("resolveGateTrial: rollback restores ALL five baseline snapshot fields", () => {
  const { storeRoot: root } = tmpStore()
  const basePlaybook: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] }
  const baseAgentConfig: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 1000 }
  const baseEnvPolicy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 20 }
  createCandidate(root, "v0", "baseline system", "baseline tools", basePlaybook, baseAgentConfig, baseEnvPolicy)
  activateCandidate(root, "v0")

  const trialPlaybook: Playbook = { schemaVersion: 1, nextId: 2, bullets: [] }
  const trialAgentConfig: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 5000 }
  const trialEnvPolicy: EnvPolicy = { schemaVersion: 1, maxLsEntries: 80 }
  createCandidate(root, "v1", "trial system", "trial tools", trialPlaybook, trialAgentConfig, trialEnvPolicy)
  startTrial(
    root, "v1", "trial system", "trial tools", 1,
    trialPlaybook, trialAgentConfig, trialEnvPolicy,
    { rewardMode: "gate-outcomes" },
  )
  // Sanity: the trial's values are actually live before rollback.
  expect(readActiveSystem(root)).toBe("trial system")
  expect(readAgentConfig(root)).toEqual(trialAgentConfig)

  const result = resolveGateTrial(root, { verdict: "rollback", reason: "guard breach" })

  expect(result).toEqual({ action: "rolled-back" })
  expect(readActiveSystem(root)).toBe("baseline system")
  expect(readActiveTools(root)).toBe("baseline tools")
  expect(readPlaybook(root)).toEqual(basePlaybook)
  expect(readAgentConfig(root)).toEqual(baseAgentConfig)
  expect(readEnvPolicy(root)).toEqual(baseEnvPolicy)
})

// ── Contract 5: abandoned-on-active-changed fires BEFORE any enactment ─────

test("resolveGateTrial: active version changed under the trial → abandoned, regardless of verdict handed in", () => {
  const { metaRoot, storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })
  expect(activeVersion(root)).toBe("v1")

  // Simulate a hand-edit / out-of-band activation that changes active WITHOUT
  // going through activateCandidate (which would itself clearTrial) — the
  // same "active version changed under trial" race the old resolveTrial
  // guards against (harness-store.ts:1336-1339).
  writeActive(root, "v0", "baseline system", "")
  expect(activeVersion(root)).toBe("v0")

  // Even though the caller hands in a "keep" verdict, the internal abandon
  // check must win — it fires before any enactment of the handed-in verdict.
  const result = resolveGateTrial(root, { verdict: "keep" })

  expect(result).toEqual({ action: "abandoned" })
  expect(readTrial(root)).toBeNull()
  expect(activeVersion(root)).toBe("v0") // untouched by resolveGateTrial itself
  const metric = lastMetaMetric(metaRoot)
  expect(metric["event"]).toBe("trial")
  expect(metric["action"]).toBe("abandoned")
  expect(metric["reason"]).toBe("active version changed under trial")
})

// ── Contract 6: awaitingGo trial is inert everywhere; clobber net intact ───

test("resolveGateTrial: awaitingGo trial → none; readTrial stays non-null (clobber net intact)", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "queued golden/candidate system", "")
  startTrial(root, "v1", "queued golden/candidate system", "", 1, null, null, null, {
    rewardMode: "gate-outcomes",
    awaitingGo: true,
  })

  // Queued, not started: active is untouched.
  expect(activeVersion(root)).toBe("v0")
  const queued = readTrial(root)
  expect(queued).not.toBeNull()
  expect(queued?.awaitingGo).toBe(true)
  expect(queued?.rewardMode).toBe("gate-outcomes")

  const result = resolveGateTrial(root, { verdict: "keep" })

  expect(result).toEqual({ action: "none" })
  // Clobber net intact: readTrial's guard against a second trial starting on
  // this layer still sees a live (albeit queued) trial.
  expect(readTrial(root)).not.toBeNull()
  expect(activeVersion(root)).toBe("v0")
})

test("startTrial: rewardMode set → trialId is always generated (required-when-rewardMode invariant)", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1, null, null, null, { rewardMode: "gate-outcomes" })

  const trial = readTrial(root)
  expect(trial?.rewardMode).toBe("gate-outcomes")
  expect(typeof trial?.trialId).toBe("string")
  expect(trial?.trialId).toContain("v1")
  expect(trial?.trialId?.length ?? 0).toBeGreaterThan("v1".length)
})

test("startTrial: no rewardMode → no trialId (legacy trial unaffected)", () => {
  const { storeRoot: root } = tmpStore()
  createCandidate(root, "v0", "baseline system", "")
  activateCandidate(root, "v0")
  createCandidate(root, "v1", "trial system", "")
  startTrial(root, "v1", "trial system", "", 1)

  const trial = readTrial(root)
  expect(trial?.rewardMode).toBeUndefined()
  expect(trial?.trialId).toBeUndefined()
})

test("GateTrialVerdict shape sanity — used only for compile-time contract", () => {
  const verdicts: GateTrialVerdict[] = [
    { verdict: "keep" },
    { verdict: "rollback", reason: "insufficient-events" },
    { verdict: "deferred", reason: "metric null" },
    { verdict: "abandoned", reason: "calibration registry stale" },
  ]
  expect(verdicts.length).toBe(4)
})
