import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fnv1a,
  pickTrialArm,
  appendExposureRow,
  readExposureRows,
  type ExposureRow,
} from "../src/trial-arm.ts"

// Reinject's own hash, reimplemented here ONLY as an independent parity
// oracle for the "identical constants" assertion below — trial-arm.ts must
// never import this (wrong direction, per plan Global Constraints).
function reinjectHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
const reinjectArm = (sessionID: string): 0 | 1 => (reinjectHash(sessionID) % 2 === 0 ? 0 : 1)

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "trial-arm-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const row = (over: Partial<ExposureRow> = {}): ExposureRow => ({
  ts: 1234, sessionID: "sess-1", trialId: "v7", layer: "project-global",
  arm: "baseline", forced: false, ...over,
})

// --- fnv1a parity -----------------------------------------------------

test("fnv1a: identical to reinject.ts's hash on sample strings", () => {
  for (const s of ["", "a", "sess-1", "v7:sess-1", "the quick brown fox", "🦊"]) {
    expect(fnv1a(s)).toBe(reinjectHash(s))
  }
})

// --- Contract 1: salt decorrelation (§11 item 10, named test) --------

test("salt decorrelation: pickTrialArm(trialId, sid) agrees with reinject's hash(sid)%2 near 50% across the trialId space", () => {
  // CONCERN (see tm2-report.md): FNV-1a's low bit is a linear parity
  // function of input-byte LSBs — Math.imul(h, ODD_PRIME) preserves h's
  // parity mod 2^32, and h0=0x811c9dc5 is odd, so hash(s)%2 = 1 XOR (XOR of
  // charCode LSBs in s). Consequence, verified below and empirically:
  // hash(`${trialId}:${sid}`)%2 XOR hash(sid)%2 == parity(trialId) —
  // CONSTANT across sessionID for any *fixed* trialId (":" is even, so it
  // contributes 0). So within one real trial (one fixed trialId), the
  // trial arm and the reinject arm are either PERFECTLY correlated or
  // PERFECTLY anti-correlated — never an empirically-~50%, per-session-
  // random split. The ~50% only emerges when trialId ALSO varies across
  // the sample, i.e. across the a-priori space of trial IDs, not within
  // any one trial. This test exercises that (necessarily weaker) claim;
  // the stronger per-trial determinism is pinned by the next test.
  const N = 300
  let agree = 0
  for (let i = 0; i < N; i++) {
    const sid = `session-${i}-${Math.random().toString(36).slice(2)}`
    const trialId = `trial-${i}-${Math.random().toString(36).slice(2)}`
    const { arm } = pickTrialArm(trialId, sid, {})
    const trialAxis = arm === "baseline" ? 0 : 1
    if (trialAxis === reinjectArm(sid)) agree++
  }
  const rate = agree / N
  expect(rate).toBeGreaterThanOrEqual(0.35)
  expect(rate).toBeLessThanOrEqual(0.65)
})

test("CONCERN pin: for a FIXED trialId, agreement with the reinject axis is deterministic (0% or 100%), not ~50% — sessionID-independent", () => {
  // This is the mathematical consequence documented above, pinned as a
  // regression/evidence test rather than left as prose only. It does NOT
  // assert the spec's §3 decorrelation intent holds per-trial — it proves
  // it does not, for this exact hash formula.
  const trialIds = ["v7", "v8", "trial-A", "trial-B", "2026-07-29-golden"]
  for (const trialId of trialIds) {
    let agree = 0
    const N = 200
    for (let i = 0; i < N; i++) {
      const sid = `session-${i}-${Math.random().toString(36).slice(2)}`
      const { arm } = pickTrialArm(trialId, sid, {})
      const trialAxis = arm === "baseline" ? 0 : 1
      if (trialAxis === reinjectArm(sid)) agree++
    }
    // deterministic extreme, not a random-looking rate
    expect(agree === 0 || agree === N).toBe(true)
  }
})

test("salt decorrelation: fixed sessionID, different trialIds can land different arms (witness pair)", () => {
  const sid = "fixed-witness-session"
  let witness: { a: string; b: string } | null = null
  for (let i = 0; i < 500 && !witness; i++) {
    const trialA = `trial-${i}`
    const armA = pickTrialArm(trialA, sid, {}).arm
    for (let j = i + 1; j < i + 50; j++) {
      const trialB = `trial-${j}`
      const armB = pickTrialArm(trialB, sid, {}).arm
      if (armA !== armB) { witness = { a: trialA, b: trialB }; break }
    }
  }
  expect(witness).not.toBeNull()
})

// --- Contract 2: determinism -------------------------------------------

test("determinism: same (trialId, sessionID) always yields the same arm", () => {
  const first = pickTrialArm("v7", "sess-abc", {})
  for (let i = 0; i < 20; i++) {
    expect(pickTrialArm("v7", "sess-abc", {})).toEqual(first)
  }
})

// --- Contract 3: forcing -------------------------------------------------

test("forcing: KKAMAK_TRIAL_ARM=baseline forces arm+forced:true", () => {
  expect(pickTrialArm("v7", "sess-x", { KKAMAK_TRIAL_ARM: "baseline" })).toEqual({
    arm: "baseline", forced: true,
  })
})

test("forcing: KKAMAK_TRIAL_ARM=trial forces arm+forced:true", () => {
  expect(pickTrialArm("v7", "sess-x", { KKAMAK_TRIAL_ARM: "trial" })).toEqual({
    arm: "trial", forced: true,
  })
})

test("forcing: invalid KKAMAK_TRIAL_ARM value is ignored (hash path, forced:false)", () => {
  const forced = pickTrialArm("v7", "sess-x", { KKAMAK_TRIAL_ARM: "v0" })
  const unforced = pickTrialArm("v7", "sess-x", {})
  expect(forced.forced).toBe(false)
  expect(forced.arm).toBe(unforced.arm)
})

test("forcing: unset KKAMAK_TRIAL_ARM falls through to hash path", () => {
  const { forced } = pickTrialArm("v7", "sess-x", {})
  expect(forced).toBe(false)
})

// --- Contract 4: any-row dedupe (§2 resumed-session re-enrollment trap) --

test("dedupe: append under trial-A, then same sid under trial-B -> already-enrolled, file byte-unchanged", () => {
  const r1 = appendExposureRow(root, row({ sessionID: "sess-dupe", trialId: "trial-A", arm: "baseline" }))
  expect(r1).toBe("appended")
  const file = join(root, ".km", "trial-arms.ndjson")
  const before = readFileSync(file, "utf-8")

  const r2 = appendExposureRow(root, row({ sessionID: "sess-dupe", trialId: "trial-B", arm: "trial" }))
  expect(r2).toBe("already-enrolled")

  const after = readFileSync(file, "utf-8")
  expect(after).toBe(before)
  expect(readExposureRows(root).length).toBe(1)
  expect(readExposureRows(root)[0]!.trialId).toBe("trial-A")
})

test("dedupe: different sessionIDs both append normally", () => {
  expect(appendExposureRow(root, row({ sessionID: "s1" }))).toBe("appended")
  expect(appendExposureRow(root, row({ sessionID: "s2" }))).toBe("appended")
  expect(readExposureRows(root).length).toBe(2)
})

// --- Contract 5: tolerant read --------------------------------------------

test("readExposureRows: skips corrupt lines, returns typed rows", () => {
  appendExposureRow(root, row({ sessionID: "good-1" }))
  const file = join(root, ".km", "trial-arms.ndjson")
  const fs = require("node:fs")
  fs.appendFileSync(file, "{not json\n")
  fs.appendFileSync(file, JSON.stringify({ sessionID: "missing-fields" }) + "\n")
  fs.appendFileSync(file, "\n") // blank line
  fs.appendFileSync(file, JSON.stringify(row({ sessionID: "good-2" })) + "\n")

  const rows = readExposureRows(root)
  expect(rows.length).toBe(2)
  expect(rows.map((r) => r.sessionID).sort()).toEqual(["good-1", "good-2"])
})

test("readExposureRows: missing file -> []", () => {
  expect(readExposureRows(root)).toEqual([])
})

test("readExposureRows: accepts an exact file path as well as a cwd", () => {
  appendExposureRow(root, row({ sessionID: "s-path" }))
  const file = join(root, ".km", "trial-arms.ndjson")
  expect(readExposureRows(file)).toEqual(readExposureRows(root))
})

// --- Contract 6: dir creation / plain ndjson ------------------------------

test("append creates .km/ dir if missing; file is plain ndjson", () => {
  expect(existsSync(join(root, ".km"))).toBe(false)
  appendExposureRow(root, row())
  const file = join(root, ".km", "trial-arms.ndjson")
  expect(existsSync(file)).toBe(true)
  const raw = readFileSync(file, "utf-8")
  const lines = raw.trim().split("\n")
  expect(lines.length).toBe(1)
  expect(() => JSON.parse(lines[0]!)).not.toThrow()
})
