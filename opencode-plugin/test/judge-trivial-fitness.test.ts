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

// Task 7 / Option A: sessions the judge rated `trivial:true` are still
// recorded (traces/score.json keep them), but must be excluded from
// resolveTrial's trial-side AND baseline-side rate computations — a run of
// judge-rated greetings/one-liners must never move a trial confirm/revert
// decision in either direction. Follows agent-config.test.ts's tmpStore/
// session() harness-store test layout.

function tmpStore(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-judge-trivial-"))
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

/** A judge-rated-trivial session record — same shape recordSession persists
 * when index.ts folds a trivial verdict into `record.judge`. */
function trivialSession(overrides: Partial<SessionRecord>): SessionRecord {
  return session({
    judge: { passed: overrides.passed ?? true, mode: "shadow", agreed: true, trivial: true },
    ...overrides,
  })
}

test("resolveTrial: trivial PASS sessions on the TRIAL side cannot mask a real regression", () => {
  // Without the exclusion, 3 trivial passes would drown out 1 real fail and
  // inflate the trial's rate above the baseline, wrongly CONFIRMING a change
  // that actually regressed on real work.
  const root = tmpStore()

  createCandidate(root, "v0", "baseline system")
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-pass", passed: true }))
  recordSession(root, "v0", session({ sessionID: "base-fail", passed: false }))
  // baseline: 1/2 real sessions passed -> rate 0.5

  createCandidate(root, "v1", "trial system")
  startTrial(root, "v1", "trial system", "", 1)
  recordSession(root, "v1", session({ sessionID: "trial-real-fail", passed: false }))
  recordSession(root, "v1", trivialSession({ sessionID: "trial-trivial-1", passed: true }))
  recordSession(root, "v1", trivialSession({ sessionID: "trial-trivial-2", passed: true }))
  recordSession(root, "v1", trivialSession({ sessionID: "trial-trivial-3", passed: true }))
  // Buggy (unfiltered) trial rate would be 3/4 = 0.75 >= baseline 0.5 -> CONFIRMED (wrong).
  // Correct (trivial excluded) trial rate is 0/1 = 0 < baseline 0.5 -> REVERTED.

  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("reverted")
  if (resolution.action === "reverted") {
    expect(resolution.trialRate).toBe(0)
    expect(resolution.baselineRate).toBe(0.5)
  }
})

test("resolveTrial: trivial FAIL sessions on the BASELINE side cannot mask real baseline strength", () => {
  // Without the exclusion, 3 trivial fails would drag the baseline's rate
  // down from its true 1.0, letting a genuinely-worse trial get wrongly
  // CONFIRMED against the deflated baseline.
  const root = tmpStore()

  createCandidate(root, "v0", "baseline system")
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-pass", passed: true }))
  recordSession(root, "v0", trivialSession({ sessionID: "base-trivial-1", passed: false }))
  recordSession(root, "v0", trivialSession({ sessionID: "base-trivial-2", passed: false }))
  recordSession(root, "v0", trivialSession({ sessionID: "base-trivial-3", passed: false }))
  // Buggy (unfiltered) baseline rate would be 1/4 = 0.25.
  // Correct (trivial excluded) baseline rate is 1/1 = 1.0.

  createCandidate(root, "v1", "trial system")
  startTrial(root, "v1", "trial system", "", 2)
  recordSession(root, "v1", session({ sessionID: "trial-pass", passed: true }))
  recordSession(root, "v1", session({ sessionID: "trial-fail", passed: false }))
  // trial rate: 1/2 = 0.5.
  // Buggy: 0.5 >= 0.25 -> CONFIRMED (wrong: baseline's true rate was 1.0).
  // Correct: 0.5 < 1.0 -> REVERTED.

  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("reverted")
  if (resolution.action === "reverted") {
    expect(resolution.trialRate).toBe(0.5)
    expect(resolution.baselineRate).toBe(1)
  }
})

test("resolveTrial: an all-trivial baseline is treated as no-baseline-to-compare (trial judged on its own rate)", () => {
  const root = tmpStore()

  createCandidate(root, "v0", "baseline system")
  activateCandidate(root, "v0")
  recordSession(root, "v0", trivialSession({ sessionID: "base-trivial-1", passed: true }))
  recordSession(root, "v0", trivialSession({ sessionID: "base-trivial-2", passed: false }))
  // baseline has sessions, but ALL are trivial -> filtered baseline is empty.

  createCandidate(root, "v1", "trial system")
  startTrial(root, "v1", "trial system", "", 1)
  recordSession(root, "v1", session({ sessionID: "trial-real-pass", passed: true }))

  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("confirmed")
  if (resolution.action === "confirmed") {
    expect(resolution.trialRate).toBe(1)
    expect(resolution.baselineRate).toBeNull()
  }
})

test("resolveTrial: a session with no judge verdict (judge disabled/null) counts as before — full back-compat", () => {
  const root = tmpStore()

  createCandidate(root, "v0", "baseline system")
  activateCandidate(root, "v0")
  recordSession(root, "v0", session({ sessionID: "base-pass", passed: true }))
  // no `judge` field at all on this record — pre-Task-7 shape.

  createCandidate(root, "v1", "trial system")
  startTrial(root, "v1", "trial system", "", 1)
  recordSession(root, "v1", session({ sessionID: "trial-pass", passed: true }))

  const resolution = resolveTrial(root)
  expect(resolution.action).toBe("confirmed")
  if (resolution.action === "confirmed") {
    expect(resolution.trialRate).toBe(1)
    expect(resolution.baselineRate).toBe(1)
  }
})
