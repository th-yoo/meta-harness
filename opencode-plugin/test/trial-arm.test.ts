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
//
// PRE-DATA AMENDMENT (2026-07-29, build TM2; spec §3 amendment block,
// commit fc252c2): the originally-registered formula (`% 2`, bit 0) was
// proven parity-linear — for any FIXED trialId, agreement with the
// reinject axis (`hash(sid) % 2`) was exactly 0% or 100% across ALL
// sessionIDs, never ~50%. `pickTrialArm` now uses bit 16
// (`(fnv1a(...) >>> 16) & 1`), a carry-mixed bit. The tests below exercise
// the REAL condition the spec cares about: one real trial has ONE fixed
// trialId for its whole life, so decorrelation must hold *within* that
// fixed trialId across the sessionID population — not just across the
// a-priori trialId space. Coordinator-verified empirically: fixed-trialId
// agreement with reinject ~50% (254/500, 258/500, 248/500, 261/500 across
// 4 trialIds), arm splits balanced (234/500, 266/500).

test("salt decorrelation: for a FIXED trialId, pickTrialArm agrees with reinject's hash(sid)%2 near 50% across >=500 sessionIDs (>=3 fixed trialIds)", () => {
  const trialIds = ["v7", "v8", "trial-A"]
  const N = 500
  for (const trialId of trialIds) {
    let agree = 0
    for (let i = 0; i < N; i++) {
      const sid = `session-${i}-${Math.random().toString(36).slice(2)}`
      const { arm } = pickTrialArm(trialId, sid, {})
      const trialAxis = arm === "baseline" ? 0 : 1
      if (trialAxis === reinjectArm(sid)) agree++
    }
    const rate = agree / N
    expect(rate).toBeGreaterThanOrEqual(0.4)
    expect(rate).toBeLessThanOrEqual(0.6)
  }
})

test("salt decorrelation: for a FIXED trialId, the trial/baseline arm split itself is balanced near 50/50 across >=500 sessionIDs (>=3 fixed trialIds)", () => {
  const trialIds = ["v7", "v8", "trial-A"]
  const N = 500
  for (const trialId of trialIds) {
    let trialCount = 0
    for (let i = 0; i < N; i++) {
      const sid = `session-${i}-${Math.random().toString(36).slice(2)}`
      const { arm } = pickTrialArm(trialId, sid, {})
      if (arm === "trial") trialCount++
    }
    const rate = trialCount / N
    expect(rate).toBeGreaterThanOrEqual(0.4)
    expect(rate).toBeLessThanOrEqual(0.6)
  }
})

test("parity-proof pin: fnv1a's bit 0 is a CONSTANT (trialId-only) parity across sessionIDs for a fixed trialId — the witness proving bit 0 unusable (spec §3 amendment, commit fc252c2)", () => {
  // This does NOT exercise pickTrialArm (which uses bit 16 now). It pins the
  // algebraic property that made the ORIGINAL bit-0 formula unusable and
  // triggered the pre-data spec amendment: Math.imul(h, ODD_PRIME) preserves
  // h's parity mod 2^32, so fnv1a(s)%2 reduces to a linear XOR-parity
  // function of s's charCode LSBs. Consequence: for any FIXED trialId t,
  // `fnv1a(`${t}:${sid}`) % 2 XOR fnv1a(sid) % 2` is CONSTANT across sid
  // (":" has an even char code, contributing 0) — i.e. bit 0 gives perfect
  // (anti-)collinearity with the reinject axis within any one real trial,
  // never the intended per-session ~50% split. Kept as regression/evidence
  // documenting WHY bit 16 was substituted, per the amended docs/superpowers/
  // specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md §3.
  const trialIds = ["v7", "v8", "trial-A", "trial-B", "2026-07-29-golden"]
  for (const trialId of trialIds) {
    const parities = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const sid = `session-${i}-${Math.random().toString(36).slice(2)}`
      const combined = fnv1a(`${trialId}:${sid}`) % 2
      const sidOnly = fnv1a(sid) % 2
      parities.add(combined ^ sidOnly)
    }
    // constant across ALL sids for this fixed trialId — the proof witness
    expect(parities.size).toBe(1)
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
