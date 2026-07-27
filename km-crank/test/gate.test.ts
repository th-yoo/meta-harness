import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  decideGate,
  crankLockPath,
  readCrankLock,
  isCrankLockStale,
  acquireCrankLock,
  releaseCrankLock,
  type GateInput,
} from "../src/gate.ts"

const DAY_MS = 24 * 60 * 60 * 1000

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    force: false,
    newCount: 20,
    threshold: 10,
    lastRunTs: 1_000,
    maxAgeMs: 7 * DAY_MS,
    now: 2_000,
    trialInProgress: false,
    inFlight: false,
    ...overrides,
  }
}

// ── decideGate ───────────────────────────────────────────────────────────

test("decideGate: enough new lines, no trial, no in-flight -> run", () => {
  expect(decideGate(input())).toBe("run")
})

test("decideGate: below threshold + recent last run -> skip-threshold", () => {
  const now = 1_000 + 1 * DAY_MS
  expect(decideGate(input({ newCount: 3, threshold: 10, lastRunTs: 1_000, maxAgeMs: 7 * DAY_MS, now }))).toBe(
    "skip-threshold",
  )
})

test("decideGate: below threshold but last run is stale (past maxAgeMs) -> run", () => {
  const now = 1_000 + 8 * DAY_MS
  expect(decideGate(input({ newCount: 3, threshold: 10, lastRunTs: 1_000, maxAgeMs: 7 * DAY_MS, now }))).toBe("run")
})

test("decideGate: lastRunTs=0 (never run) -> not 'recent enough' even with few new lines -> run", () => {
  expect(decideGate(input({ newCount: 0, threshold: 10, lastRunTs: 0, now: 1_000 }))).toBe("run")
})

test("decideGate: force=true bypasses the threshold/age gate even with 0 new lines", () => {
  const now = 1_000 + 1 * DAY_MS
  expect(
    decideGate(input({ force: true, newCount: 0, threshold: 10, lastRunTs: 1_000, maxAgeMs: 7 * DAY_MS, now })),
  ).toBe("run")
})

test("decideGate: trial in progress -> skip-trial (even with plenty of new lines)", () => {
  expect(decideGate(input({ trialInProgress: true }))).toBe("skip-trial")
})

test("decideGate: proposer in flight -> skip-inflight", () => {
  expect(decideGate(input({ inFlight: true }))).toBe("skip-inflight")
})

test("decideGate: priority — threshold gate wins over trial/inflight when all three would fire", () => {
  const now = 1_000 + 1 * DAY_MS
  expect(
    decideGate(
      input({ newCount: 3, threshold: 10, lastRunTs: 1_000, maxAgeMs: 7 * DAY_MS, now, trialInProgress: true, inFlight: true }),
    ),
  ).toBe("skip-threshold")
})

test("decideGate: priority — trial guard wins over inflight when threshold gate doesn't fire", () => {
  expect(decideGate(input({ trialInProgress: true, inFlight: true }))).toBe("skip-trial")
})

// ── crank-private round lock ────────────────────────────────────────────────

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-crank-gate-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test("crankLockPath: nests under <root>/km-crank/crank.lock", () => {
  expect(crankLockPath(dir)).toBe(path.join(dir, "km-crank", "crank.lock"))
})

test("readCrankLock: missing file -> null, does not throw", () => {
  expect(() => readCrankLock(dir)).not.toThrow()
  expect(readCrankLock(dir)).toBeNull()
})

test("readCrankLock: corrupt JSON -> null, does not throw", () => {
  fs.mkdirSync(path.join(dir, "km-crank"), { recursive: true })
  fs.writeFileSync(crankLockPath(dir), "{not valid json")
  expect(readCrankLock(dir)).toBeNull()
})

test("readCrankLock: wrong-shape JSON -> null", () => {
  fs.mkdirSync(path.join(dir, "km-crank"), { recursive: true })
  fs.writeFileSync(crankLockPath(dir), JSON.stringify({ nonsense: true }))
  expect(readCrankLock(dir)).toBeNull()
})

test("isCrankLockStale: false within the horizon, true past it", () => {
  const lock = { pid: 1, startedAt: 1_000 }
  expect(isCrankLockStale(lock, 1_000 + 500, 1_000)).toBe(false)
  expect(isCrankLockStale(lock, 1_000 + 1_500, 1_000)).toBe(true)
})

test("acquireCrankLock: succeeds when no lock exists, and the lock is readable afterward", () => {
  expect(acquireCrankLock(dir, 1_000, 60_000)).toBe(true)
  const lock = readCrankLock(dir)
  expect(lock).not.toBeNull()
  expect(lock!.pid).toBe(process.pid)
  expect(lock!.startedAt).toBe(1_000)
})

test("acquireCrankLock: fails (returns false) while a live lock is held", () => {
  expect(acquireCrankLock(dir, 1_000, 60_000)).toBe(true)
  expect(acquireCrankLock(dir, 1_010, 60_000)).toBe(false)
})

test("acquireCrankLock: reclaims a stale lock and succeeds", () => {
  expect(acquireCrankLock(dir, 1_000, 60_000)).toBe(true)
  // Far past the staleAfterMs horizon.
  expect(acquireCrankLock(dir, 1_000 + 120_000, 60_000)).toBe(true)
})

test("releaseCrankLock: removes the lock file so a subsequent acquire succeeds immediately", () => {
  expect(acquireCrankLock(dir, 1_000, 60_000)).toBe(true)
  releaseCrankLock(dir)
  expect(readCrankLock(dir)).toBeNull()
  expect(acquireCrankLock(dir, 1_010, 60_000)).toBe(true)
})

test("releaseCrankLock: safe to call when no lock was ever acquired", () => {
  expect(() => releaseCrankLock(dir)).not.toThrow()
})
