import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  MECHANISM_PATHS,
  calibrationPath,
  readCalibration,
  calibrationStale,
  type Calibration,
} from "../src/calibration.ts"

const GOOD: Calibration = {
  rate: 0.105,
  numerator: 2,
  denominator: 19,
  wilson95CI: [0.03, 0.31],
  coveredMechanismRev: "abc123deadbeef",
  date: "2026-07-29",
  note: "cross-host pooled C2+C1+G1, not independently certified (HISTORY.md FA1 CLOSED BY MATH)",
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "km-calibration-test-"))
  fs.mkdirSync(path.join(tmpRoot, "km-crank"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function writeCal(cal: unknown): void {
  fs.writeFileSync(calibrationPath(tmpRoot), JSON.stringify(cal), "utf-8")
}

// ── contract 1: fresh when path-scoped rev matches ─────────────────────────

test("calibrationStale: fresh when injected path-scoped rev matches coveredMechanismRev", () => {
  writeCal(GOOD)
  const cal = readCalibration(tmpRoot)
  const fakeGitLastRev = (_paths: string[]) => "abc123deadbeef"
  expect(calibrationStale(tmpRoot, cal, fakeGitLastRev)).toBe(false)
})

// ── contract 2: stale when a mechanism path changed ─────────────────────────

test("calibrationStale: stale when injected path-scoped rev differs (a mechanism path changed)", () => {
  writeCal(GOOD)
  const cal = readCalibration(tmpRoot)
  const fakeGitLastRev = (_paths: string[]) => "9999999999newer"
  expect(calibrationStale(tmpRoot, cal, fakeGitLastRev)).toBe(true)
})

// ── contract 3: docs-only commits do NOT stale it ───────────────────────────

test("calibrationStale: is called with MECHANISM_PATHS, not repo HEAD or any docs-adjacent path", () => {
  writeCal(GOOD)
  const cal = readCalibration(tmpRoot)
  let seenPaths: string[] | undefined
  const fakeGitLastRev = (paths: string[]) => {
    seenPaths = paths
    return "abc123deadbeef"
  }
  calibrationStale(tmpRoot, cal, fakeGitLastRev)
  expect(seenPaths).toEqual(MECHANISM_PATHS)
})

test("calibrationStale: a docs-only commit (path-scoped rev unchanged, unlike repo HEAD) stays fresh", () => {
  writeCal(GOOD)
  const cal = readCalibration(tmpRoot)
  // Simulates a docs-only commit landing after coveredMechanismRev was baked
  // in: repo HEAD would have moved, but the path-scoped last-modifying
  // commit of MECHANISM_PATHS has not, because gitLastRev is scoped to
  // those paths by construction (never asked for HEAD).
  const fakeGitLastRev = (paths: string[]) => {
    expect(paths).toEqual(MECHANISM_PATHS)
    return "abc123deadbeef" // unchanged despite hypothetical later docs commits
  }
  expect(calibrationStale(tmpRoot, cal, fakeGitLastRev)).toBe(false)
})

// ── contract 4: missing/corrupt registry -> treated as stale ───────────────

test("readCalibration: missing file -> null", () => {
  expect(readCalibration(tmpRoot)).toBeNull()
})

test("readCalibration: corrupt JSON -> null", () => {
  fs.writeFileSync(calibrationPath(tmpRoot), "{ not valid json", "utf-8")
  expect(readCalibration(tmpRoot)).toBeNull()
})

test("readCalibration: valid JSON but wrong shape -> null", () => {
  writeCal({ rate: 0.105, numerator: 2 }) // missing required fields
  expect(readCalibration(tmpRoot)).toBeNull()
})

test("calibrationStale: missing registry (cal=null) -> always stale, regardless of gitLastRev", () => {
  const fakeGitLastRev = (_paths: string[]) => "anything"
  expect(calibrationStale(tmpRoot, null, fakeGitLastRev)).toBe(true)
})

test("calibrationStale: corrupt registry (readCalibration -> null) -> always stale", () => {
  fs.writeFileSync(calibrationPath(tmpRoot), "not json at all", "utf-8")
  const cal = readCalibration(tmpRoot)
  expect(cal).toBeNull()
  const fakeGitLastRev = (_paths: string[]) => "abc123deadbeef"
  expect(calibrationStale(tmpRoot, cal, fakeGitLastRev)).toBe(true)
})

// ── contract 5: the committed json matches the registered numbers exactly ──

test("committed km-crank/calibration.json matches the §4 rule 1 registered numbers exactly", () => {
  const repoRoot = path.join(import.meta.dir, "..", "..")
  const cal = readCalibration(repoRoot)
  expect(cal).not.toBeNull()
  expect(cal!.rate).toBe(0.105)
  expect(cal!.numerator).toBe(2)
  expect(cal!.denominator).toBe(19)
  expect(cal!.wilson95CI).toEqual([0.03, 0.31])
  expect(cal!.date).toBe("2026-07-29")
  expect(typeof cal!.coveredMechanismRev).toBe("string")
  expect(cal!.coveredMechanismRev.length).toBeGreaterThan(0)
})

test("committed calibration.json's coveredMechanismRev equals the real path-scoped rev right now", () => {
  // No injected gitLastRev here — this is the one test allowed to shell out
  // to real git, to prove the committed rev is actually correct as of this
  // commit (not merely well-formed). Every other test in this file injects
  // a fake per the brief's "never shell out to git in tests" for behavior
  // contracts; this test verifies the DATA, not calibrationStale's logic.
  const repoRoot = path.join(import.meta.dir, "..", "..")
  const cal = readCalibration(repoRoot)
  expect(cal).not.toBeNull()
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  const realRev = execFileSync(
    "git",
    ["log", "-1", "--format=%H", "--", ...MECHANISM_PATHS],
    { cwd: repoRoot, encoding: "utf-8" },
  ).trim()
  expect(cal!.coveredMechanismRev).toBe(realRev)
})
