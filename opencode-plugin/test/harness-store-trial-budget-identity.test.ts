import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  createCandidate,
  activateCandidate,
  startTrial,
  resolveTrial,
  recordSession,
  type SessionRecord,
} from "../src/harness-store.ts"

// Loop-3 T7 producer-wiring gap fix: resolveTrial's emitted "trial" (confirmed/
// reverted) meta-metric events never carried the {maxAgentTimeout,
// timeoutRecording, resourceEnforcement} tuple T7's report-loop segmentation
// (bench-report-loop.test.ts) reads — so on a live meta-metrics.jsonl every
// trial event looked "legacy" and segmentation never fired. These tests prove
// the fields are now sourced from the trial's own just-measured sessions'
// env block (same scan as readActiveBudget) + the current MhConfig.recordTimeouts.

function tmpStore(): { metaRoot: string; storeRoot: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-t7-trial-"))
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

/** Hermetic MhConfig seam (mirrors bench-cmd-ab.test.ts's withMetaHome):
 * redirect META_HARNESS_HOME to a throwaway dir so readMhConfig()'s
 * recordTimeouts read never touches the developer's real
 * ~/.config/meta-harness/config.json. */
function withMetaHome<T>(recordTimeouts: boolean, fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-t7-config-"))
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ recordTimeouts }))
  const saved = process.env["META_HARNESS_HOME"]
  process.env["META_HARNESS_HOME"] = dir
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env["META_HARNESS_HOME"]
    else process.env["META_HARNESS_HOME"] = saved
  }
}

function lastMetaMetric(metaRoot: string): Record<string, unknown> {
  const sink = path.join(metaRoot, ".kkamak", "meta-metrics.jsonl")
  const lines = fs.readFileSync(sink, "utf-8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

test("resolveTrial: emitted 'confirmed' trial event (no baseline to compare) carries budget-identity sourced from the trial's own sessions + MhConfig.recordTimeouts", () => {
  const { metaRoot, storeRoot } = tmpStore()
  createCandidate(storeRoot, "v0", "baseline system")
  activateCandidate(storeRoot, "v0")
  // no baseline sessions recorded -> resolveTrial's "no baseline to compare" path

  createCandidate(storeRoot, "v1", "trial system")
  startTrial(storeRoot, "v1", "trial system", "", 1)
  recordSession(
    storeRoot,
    "v1",
    session({ sessionID: "trial-1", passed: true, env: { maxAgentTimeout: 600, resourceEnforcement: true } }),
  )

  withMetaHome(true, () => {
    const resolution = resolveTrial(storeRoot)
    expect(resolution.action).toBe("confirmed")
  })

  const e = lastMetaMetric(metaRoot)
  expect(e["event"]).toBe("trial")
  expect(e["action"]).toBe("confirmed")
  expect(e["maxAgentTimeout"]).toBe(600)
  expect(e["timeoutRecording"]).toBe(true)
  expect((e["env"] as Record<string, unknown>)["resourceEnforcement"]).toBe(true)
})

test("resolveTrial: emitted 'confirmed' trial event (with baseline) carries budget-identity from the same-model trial sessions used for the rate", () => {
  const { metaRoot, storeRoot } = tmpStore()
  createCandidate(storeRoot, "v0", "baseline system")
  activateCandidate(storeRoot, "v0")
  recordSession(storeRoot, "v0", session({ sessionID: "base-1", passed: true }))

  createCandidate(storeRoot, "v1", "trial system")
  startTrial(storeRoot, "v1", "trial system", "", 1)
  recordSession(
    storeRoot,
    "v1",
    session({ sessionID: "trial-1", passed: true, env: { maxAgentTimeout: 300, resourceEnforcement: false } }),
  )

  withMetaHome(false, () => {
    const resolution = resolveTrial(storeRoot)
    expect(resolution.action).toBe("confirmed")
  })

  const e = lastMetaMetric(metaRoot)
  expect(e["action"]).toBe("confirmed")
  expect(e["maxAgentTimeout"]).toBe(300)
  expect(e["timeoutRecording"]).toBe(false)
  expect((e["env"] as Record<string, unknown>)["resourceEnforcement"]).toBe(false)
})

test("resolveTrial: emitted 'reverted' trial event carries budget-identity from the same-model trial sessions", () => {
  const { metaRoot, storeRoot } = tmpStore()
  createCandidate(storeRoot, "v0", "baseline system")
  activateCandidate(storeRoot, "v0")
  recordSession(storeRoot, "v0", session({ sessionID: "base-1", passed: true }))
  recordSession(storeRoot, "v0", session({ sessionID: "base-2", passed: true }))

  createCandidate(storeRoot, "v1", "trial system")
  startTrial(storeRoot, "v1", "trial system", "", 1)
  recordSession(
    storeRoot,
    "v1",
    session({ sessionID: "trial-1", passed: false, env: { maxAgentTimeout: 450, resourceEnforcement: true } }),
  )

  withMetaHome(true, () => {
    const resolution = resolveTrial(storeRoot)
    expect(resolution.action).toBe("reverted")
  })

  const e = lastMetaMetric(metaRoot)
  expect(e["action"]).toBe("reverted")
  expect(e["maxAgentTimeout"]).toBe(450)
  expect(e["timeoutRecording"]).toBe(true)
  expect((e["env"] as Record<string, unknown>)["resourceEnforcement"]).toBe(true)
})
