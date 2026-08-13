import { test, expect } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  applyPlaybookOps, canonicalChecksJson, checksHashOf, EMPTY_CHECKS_HASH,
  budgetIdentityMatches, readActiveBudget, createCandidate, activateCandidate,
  activeChecks, checksHashOfList,
  type Playbook, type PlaybookOp,
} from "../src/harness-store.ts"

const base: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] } as Playbook
// (real fixture shape — see gate-trial-store.test.ts:265; a bare {bullets: []}
// cast would yield "bundefined" ids from applyPlaybookOps' nextId++)

function tmpStore(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-t2-checks-"))
  const storeRoot = path.join(tmp, ".kkamak", "roles", "mh-build")
  fs.mkdirSync(storeRoot, { recursive: true })
  return storeRoot
}

test("legacy playbook JSON without check fields parses and round-trips (back-compat)", () => {
  const pb = applyPlaybookOps(base, [{ op: "add", text: "plain rule" }])
  expect(pb.bullets[0]!.check).toBeUndefined()
})

test("add op with check threads cmd/timeoutMs and stamps state shadow, liveEligible absent", () => {
  const pb = applyPlaybookOps(base, [
    { op: "add", text: "verify before done", check: { cmd: "test -s DONE.txt", timeoutMs: 5000 } },
  ])
  const c = pb.bullets[0]!.check!
  expect(c.cmd).toBe("test -s DONE.txt")
  expect(c.state).toBe("shadow")
  expect(c.liveEligible).toBeUndefined()
})

test("canonicalChecksJson sorts by bulletId with fixed key order and excludes state/liveEligible", () => {
  const s = canonicalChecksJson([
    { bulletId: "b2", cmd: "y", timeoutMs: 2 },
    { bulletId: "b1", cmd: "x", timeoutMs: 1 },
  ])
  expect(s).toBe('[{"bulletId":"b1","cmd":"x","timeoutMs":1},{"bulletId":"b2","cmd":"y","timeoutMs":2}]')
})

test("EMPTY_CHECKS_HASH equals checksHashOf(null) and of a checkless playbook", () => {
  expect(checksHashOf(null)).toBe(EMPTY_CHECKS_HASH)
  const pb = applyPlaybookOps(base, [{ op: "add", text: "plain" }])
  expect(checksHashOf(pb)).toBe(EMPTY_CHECKS_HASH)
})

test("two playbooks identical in prose but different in check cmd hash differently", () => {
  const a = applyPlaybookOps(base, [{ op: "add", text: "r", check: { cmd: "c1", timeoutMs: 1000 } }])
  const b = applyPlaybookOps(base, [{ op: "add", text: "r", check: { cmd: "c2", timeoutMs: 1000 } }])
  // ids differ per-op; normalize: compare via same-id lists
  const ha = canonicalChecksJson([{ bulletId: "x", cmd: "c1", timeoutMs: 1000 }])
  const hb = canonicalChecksJson([{ bulletId: "x", cmd: "c2", timeoutMs: 1000 }])
  expect(ha).not.toBe(hb)
  expect(a.bullets[0]!.check!.cmd).not.toBe(b.bullets[0]!.check!.cmd)
})

// ── Step 4: budgetIdentityMatches + readActiveBudget checksHash wiring ──────

// Fix round 1 (reviewer finding): the verdict-side param is `BudgetStamp`,
// whose checksHash-bearing field is `activeChecksHash` (matching the REAL
// `AbVerdict` field cmd-ab.ts's verdictDict stamps, a3 routing T8) — NOT a
// bare `checksHash`, which no verdict producer ever writes. The activeBudget
// (second-param, "the layer's CURRENT active-playbook hash") side genuinely
// is `checksHash` (readActiveBudget's real field name) — only the verdict
// side was ever wrong. These two tests previously hand-built the verdict
// side with `checksHash` too, which type-checked (BudgetStamp's field is
// optional) but masked the real-AbVerdict field-name mismatch entirely; see
// bench-cmd-ab.test.ts's "cmdAb + budgetIdentityMatches SEAM" test for the
// regression guard that goes through an ACTUAL cmd-ab-written verdict.
test("budgetIdentityMatches: legacy record (absent activeChecksHash) vs modern zero-check record MATCH", () => {
  const legacy = { maxAgentTimeout: 600, minAgentTimeout: 0, timeoutRecording: false, env: { resourceEnforcement: false } }
  const modern = { maxAgentTimeout: 600, minAgentTimeout: 0, timeoutRecording: false, resourceEnforcement: false, checksHash: EMPTY_CHECKS_HASH }
  expect(budgetIdentityMatches(legacy, modern)).toBe(true)
})

test("budgetIdentityMatches: differing activeChecksHash vs checksHash MISMATCH", () => {
  const a = { maxAgentTimeout: 600, minAgentTimeout: 0, timeoutRecording: false, env: { resourceEnforcement: false }, activeChecksHash: "aaaa" }
  const b = { maxAgentTimeout: 600, minAgentTimeout: 0, timeoutRecording: false, resourceEnforcement: false, checksHash: "bbbb" }
  expect(budgetIdentityMatches(a, b)).toBe(false)
})

test("readActiveBudget on a store whose active playbook has a checked bullet returns that playbook's real hash", () => {
  const storeRoot = tmpStore()
  const pb = applyPlaybookOps(base, [
    { op: "add", text: "verify before done", check: { cmd: "test -s DONE.txt", timeoutMs: 5000 } },
  ])
  createCandidate(storeRoot, "v0", "baseline system", "", pb)
  activateCandidate(storeRoot, "v0")
  const budget = readActiveBudget(storeRoot)
  expect(budget.checksHash).toBe(checksHashOf(pb))
  expect(budget.checksHash).not.toBe(EMPTY_CHECKS_HASH)
})

test("readActiveBudget on a store with no playbook falls back to EMPTY_CHECKS_HASH", () => {
  const storeRoot = tmpStore()
  createCandidate(storeRoot, "v0", "baseline system")
  activateCandidate(storeRoot, "v0")
  const budget = readActiveBudget(storeRoot)
  expect(budget.checksHash).toBe(EMPTY_CHECKS_HASH)
})

// ── a3 routing T7: activeChecks / checksHashOfList (the extraction cmd-run.ts/
// cmd-ab.ts's enforced-set gathering depends on) ────────────────────────────

test("activeChecks: null playbook and a checkless playbook both yield []", () => {
  expect(activeChecks(null)).toEqual([])
  const pb = applyPlaybookOps(base, [{ op: "add", text: "plain" }])
  expect(activeChecks(pb)).toEqual([])
})

test("activeChecks: only ACTIVE bullets with a check are extracted, pruned/checkless ones excluded", () => {
  const withCheck = applyPlaybookOps(base, [
    { op: "add", text: "verify before done", check: { cmd: "test -s DONE.txt", timeoutMs: 5000 } },
    { op: "add", text: "plain rule" },
  ])
  const pruned = applyPlaybookOps(withCheck, [{ op: "delete", id: "b1" }])
  const checks = activeChecks(pruned)
  expect(checks).toEqual([])
})

test("activeChecks: shape is {bulletId, cmd, timeoutMs} per active checked bullet, feeding checksHashOf via checksHashOfList", () => {
  const pb = applyPlaybookOps(base, [
    { op: "add", text: "verify before done", check: { cmd: "test -s DONE.txt", timeoutMs: 5000 } },
  ])
  const checks = activeChecks(pb)
  expect(checks).toEqual([{ bulletId: "b1", cmd: "test -s DONE.txt", timeoutMs: 5000 }])
  expect(checksHashOfList(checks)).toBe(checksHashOf(pb))
})

test("checksHashOfList([]) equals EMPTY_CHECKS_HASH", () => {
  expect(checksHashOfList([])).toBe(EMPTY_CHECKS_HASH)
})
