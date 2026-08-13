import { test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileStateStore, StaleWriteError, saveResetWithRetry } from "../src/state.ts"
import { INITIAL_STATE, isInitialState, type CcGateState } from "../src/types.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-state-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function nonInitial(overrides: Partial<CcGateState> = {}): CcGateState {
  return { ...INITIAL_STATE, edited: true, gating: true, round: 1, failStreak: 1, ...overrides }
}

test("load: absent file → fresh initial state", () => {
  const store = new FileStateStore(dir)
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("save/load: roundtrip stamps updatedAt", () => {
  const store = new FileStateStore(dir)
  const before = Date.now()
  store.save("s1", nonInitial(), 0)
  const loaded = store.load("s1")
  expect(loaded.edited).toBe(true)
  expect(loaded.gating).toBe(true)
  expect(loaded.round).toBe(1)
  expect(loaded.updatedAt).toBeGreaterThanOrEqual(before)
})

test("load: corrupt JSON file → fresh initial state, does not throw", () => {
  const store = new FileStateStore(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "s1.json"), "{not valid json")
  expect(() => store.load("s1")).not.toThrow()
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("load: wrong-shape JSON (missing fields) → fresh initial state", () => {
  const store = new FileStateStore(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "s1.json"), JSON.stringify({ v: 1, edited: true }))
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("load: unknown v → fresh initial state", () => {
  const store = new FileStateStore(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "s1.json"),
    JSON.stringify({ ...nonInitial(), v: 2 }),
  )
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("save: initial-equivalent state deletes the file (absent == initial)", () => {
  const store = new FileStateStore(dir)
  // First write something real so a file exists...
  store.save("s1", nonInitial(), 0)
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(true)
  // ...then saving an initial-equivalent state must remove it rather than
  // writing an initial-looking file to disk. Chained save with no intervening
  // load: the delete is CAS-guarded, so it must present the real on-disk
  // updatedAt from the first write, not 0.
  const afterFirst = store.load("s1")
  store.save("s1", { ...INITIAL_STATE }, afterFirst.updatedAt)
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false)
  // And loading afterward still yields fresh initial state.
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("save: initial-equivalent state ignoring updatedAt still deletes (no file ever created)", () => {
  const store = new FileStateStore(dir)
  store.save("s1", { ...INITIAL_STATE, updatedAt: 123456 }, 0)
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false)
})

// ── isInitialState hardening (Task 2, fix-them-serialized-teacup plan) ────
// A state carrying only checkMs (every other field back at its initial
// value) must NOT read as initial, or FileStateStore.save() would silently
// rmSync it away — losing in-flight per-round timing.

test("isInitialState: a state with only checkMs populated is NOT initial", () => {
  expect(isInitialState({ ...INITIAL_STATE, checkMs: [123] })).toBe(false)
})

test("isInitialState: checkMs undefined or an empty array is still initial", () => {
  expect(isInitialState({ ...INITIAL_STATE })).toBe(true)
  expect(isInitialState({ ...INITIAL_STATE, checkMs: [] })).toBe(true)
})

test("save: a state carrying only checkMs is NOT deleted — it must persist to disk, not vanish as if initial", () => {
  const store = new FileStateStore(dir)
  store.save("s1", { ...INITIAL_STATE, checkMs: [456] }, 0)
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(true)
  expect(store.load("s1").checkMs).toEqual([456])
})

test("sessionId is sanitized: path-escape attempt writes inside dir only", () => {
  const store = new FileStateStore(dir)
  const evilId = "a/../b"
  store.save(evilId, nonInitial(), 0)

  // Nothing escaped upward: dir itself contains exactly one sanitized file.
  const entries = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
  expect(entries).toEqual(["a_.._b.json"])

  // The parent of dir gained no stray "b.json" file.
  const parentEntries = fs.readdirSync(path.dirname(dir))
  expect(parentEntries.includes("b.json")).toBe(false)

  // load() with the same raw id round-trips via the same sanitization.
  const loaded = store.load(evilId)
  expect(loaded.edited).toBe(true)
})

test("sweep: skip case — fresh .last-swept marker means a stale file survives", () => {
  const store = new FileStateStore(dir)
  const now = Date.now()

  // A file that is 8 days old by updatedAt (would normally be swept).
  fs.mkdirSync(dir, { recursive: true })
  const stalePath = path.join(dir, "stale.json")
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ ...nonInitial(), updatedAt: now - 8 * 24 * 60 * 60 * 1000 }),
  )

  // Marker touched "now" (fresh) → rate limit should skip the sweep entirely.
  fs.writeFileSync(path.join(dir, ".last-swept"), "")

  store.sweep(now)

  expect(fs.existsSync(stalePath)).toBe(true)
})

test("sweep: positive case — stale file removed, fresh file kept, marker itself untouched/not parsed", () => {
  const store = new FileStateStore(dir)
  const now = Date.now()

  fs.mkdirSync(dir, { recursive: true })
  const stalePath = path.join(dir, "stale.json")
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ ...nonInitial(), updatedAt: now - 8 * 24 * 60 * 60 * 1000 }),
  )
  const freshPath = path.join(dir, "fresh.json")
  fs.writeFileSync(freshPath, JSON.stringify({ ...nonInitial(), updatedAt: now - 1000 }))

  // No .last-swept marker present → sweep must run (not rate-limited).
  expect(fs.existsSync(path.join(dir, ".last-swept"))).toBe(false)

  store.sweep(now)

  expect(fs.existsSync(stalePath)).toBe(false)
  expect(fs.existsSync(freshPath)).toBe(true)
  // Marker created by the sweep itself, and survives (never deleted as if it
  // were a stale *.json, and never crashes attempting to JSON.parse it).
  expect(fs.existsSync(path.join(dir, ".last-swept"))).toBe(true)
})

test("sweep: unparseable *.json falls back to file mtime for the age check", () => {
  const store = new FileStateStore(dir)
  const now = Date.now()

  fs.mkdirSync(dir, { recursive: true })
  const corruptPath = path.join(dir, "corrupt.json")
  fs.writeFileSync(corruptPath, "{not json at all")
  // Back-date the file's mtime by 8 days so the mtime-fallback path sweeps it.
  const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000)
  fs.utimesSync(corruptPath, eightDaysAgo, eightDaysAgo)

  expect(() => store.sweep(now)).not.toThrow()
  expect(fs.existsSync(corruptPath)).toBe(false)
})

test("sweep: never throws even against a missing directory", () => {
  const store = new FileStateStore(path.join(dir, "does", "not", "exist", "yet"))
  expect(() => store.sweep(Date.now())).not.toThrow()
})

test("sweep on nonexistent dir → no dir created, no throw", () => {
  const missingDir = path.join(dir, "never-armed", "cc-gate")
  const store = new FileStateStore(missingDir)

  expect(fs.existsSync(missingDir)).toBe(false)
  expect(() => store.sweep(Date.now())).not.toThrow()
  // No mkdir, no marker file, no parent dir either — a Stop hook firing in
  // an ungated/untouched cwd must not create .km/cc-gate at all.
  expect(fs.existsSync(missingDir)).toBe(false)
  expect(fs.existsSync(path.join(dir, "never-armed"))).toBe(false)
})

test("concurrent-write safety: interleaved load->modify->save is compare-and-swap — the stale second writer is REFUSED rather than allowed to clobber", () => {
  const store = new FileStateStore(dir)
  const sessionId = "concurrent-session"

  // Two "processes" both load the same (absent) initial state (updatedAt 0),
  // modify independently, then save interleaved. Writer A lands first; writer
  // B is now stale (it holds the pre-A snapshot's updatedAt 0, but disk moved
  // on), so its save must be REFUSED rather than blindly overwriting A.
  const a = store.load(sessionId)
  const b = store.load(sessionId)

  const aModified: CcGateState = { ...a, edited: true, round: 1, failStreak: 1 }
  const bModified: CcGateState = { ...b, edited: true, gating: true, round: 2, failStreak: 2 }

  store.save(sessionId, aModified, a.updatedAt) // lands (expected 0 == absent)
  expect(() => store.save(sessionId, bModified, b.updatedAt)).toThrow(StaleWriteError)

  // A's write survives intact — B never clobbered it.
  const finalRaw = fs.readFileSync(path.join(dir, "concurrent-session.json"), "utf-8")
  const finalParsed = JSON.parse(finalRaw) as CcGateState // parses cleanly (atomic rename)
  expect(finalParsed.round).toBe(1)
  expect(finalParsed.failStreak).toBe(1)
  expect(finalParsed.gating).toBe(false)

  // A stale writer that RE-READS wins the CAS on its retry (the
  // saveResetWithRetry path, exercised directly here).
  const fresh = store.load(sessionId)
  store.save(sessionId, { ...bModified, updatedAt: fresh.updatedAt }, fresh.updatedAt)
  expect(store.load(sessionId).round).toBe(2)
})

// -- A1 cycle-tagging: isInitialState hardening (checkMs precedent) -------

import { isInitialState as isInit2, INITIAL_STATE as INIT2 } from "../src/types.ts"

test("state carrying only touchedPaths is NOT initial (save() must not rmSync it)", () => {
  expect(isInit2({ ...INIT2, touchedPaths: ["/repo/a.ts"] })).toBe(false)
})

test("state carrying only touchedTruncated is NOT initial", () => {
  expect(isInit2({ ...INIT2, touchedTruncated: true })).toBe(false)
})

test("empty touchedPaths array still reads initial", () => {
  expect(isInit2({ ...INIT2, touchedPaths: [] })).toBe(true)
})

// ── CAS port: compare-and-swap, monotonic stamp, lock, reset-retry, sweep ──
// (kkamak parity — ~/z2/kkamak/test/{runtime,gate}.test.ts)

test("save: monotonic updatedAt — two immediate saves strictly increase the stamp", () => {
  const store = new FileStateStore(dir)
  store.save("s1", nonInitial(), 0)
  const first = store.load("s1").updatedAt
  // Same session, present the real stamp; even if the wall clock has not
  // ticked a full ms, the commit must stamp max(now, current+1).
  store.save("s1", { ...nonInitial(), round: 2 }, first)
  const second = store.load("s1").updatedAt
  expect(second).toBeGreaterThan(first)
})

test("save: a stale DELETE (initial-equivalent) is refused — real progress survives", () => {
  const store = new FileStateStore(dir)
  store.save("s1", nonInitial(), 0) // A: real record
  const stale = 0 // a writer that loaded when the session was absent
  // Concurrent real progress lands (B), moving updatedAt off `stale`.
  const afterA = store.load("s1").updatedAt
  store.save("s1", { ...nonInitial(), round: 5 }, afterA)
  // The stale writer now tries to RESET (delete) against its old expectation.
  expect(() => store.save("s1", { ...INITIAL_STATE }, stale)).toThrow(StaleWriteError)
  // Progress survived the refused delete.
  expect(store.load("s1").round).toBe(5)
})

test("save: first-ever save with expected 0 succeeds (absent == initial sentinel)", () => {
  const store = new FileStateStore(dir)
  store.save("brand-new", nonInitial(), 0)
  expect(store.load("brand-new").round).toBe(1)
})

test("saveResetWithRetry: a lost race retries against fresh state and the reset lands", () => {
  const store = new FileStateStore(dir)
  store.save("s1", { ...nonInitial(), gating: true, round: 1 }, 0)
  // The caller holds a STALE expectation (0), so the first CAS fails; the
  // retry reloads fresh and the reset (delete) then lands.
  saveResetWithRetry(store, "s1", { ...INITIAL_STATE }, 0, () => {})
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false)
})

test("saveResetWithRetry: a second consecutive lost race is logged and swallowed, never throws", () => {
  // A wrapping store whose save() ALWAYS throws StaleWriteError — the retry
  // can never win. The helper must not propagate; it logs once.
  let logged = 0
  const alwaysStale: import("../src/types.ts").StateStore = {
    load: () => ({ ...INITIAL_STATE }),
    save: () => {
      throw new StaleWriteError("always")
    },
    sweep: () => {},
  }
  expect(() =>
    saveResetWithRetry(alwaysStale, "s1", { ...INITIAL_STATE }, 0, () => {
      logged++
    }),
  ).not.toThrow()
  expect(logged).toBe(1)
})

test("save: delete-path EPERM propagates (no empty-catch swallow) — store-layer contract", () => {
  const store = new FileStateStore(dir)
  store.save("s1", nonInitial(), 0)
  const expected = store.load("s1").updatedAt
  // Make the directory read+execute only: rmSync of the child fails EPERM.
  fs.chmodSync(dir, 0o500)
  try {
    // Initial-equivalent save → delete path → rmSync throws → must propagate.
    expect(() => store.save("s1", { ...INITIAL_STATE }, expected)).toThrow()
  } finally {
    fs.chmodSync(dir, 0o700) // restore so afterEach cleanup works
  }
})

test("sweep: a file whose lock is HELD by a live writer is skipped (survives even past the acquire window)", () => {
  const store = new FileStateStore(dir, 20, 2000) // tiny acquire timeout
  const now = Date.now()
  fs.mkdirSync(dir, { recursive: true })
  const stalePath = path.join(dir, "held.json")
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ ...nonInitial(), updatedAt: now - 8 * 24 * 60 * 60 * 1000 }),
  )
  // Simulate a live holder: a fresh lock file with THIS process's live pid.
  fs.writeFileSync(`${stalePath}.lock`, String(process.pid))
  // No .last-swept → sweep runs; but tryLock cannot acquire the held lock, so
  // the stale file must SURVIVE (sweep's rmSync must never run unlocked).
  store.sweep(now)
  expect(fs.existsSync(stalePath)).toBe(true)
  fs.rmSync(`${stalePath}.lock`, { force: true })
})

test("sweep: an UNheld stale file is deleted (staleness re-checked inside the lock)", () => {
  const store = new FileStateStore(dir)
  const now = Date.now()
  fs.mkdirSync(dir, { recursive: true })
  const stalePath = path.join(dir, "stale2.json")
  fs.writeFileSync(
    stalePath,
    JSON.stringify({ ...nonInitial(), updatedAt: now - 8 * 24 * 60 * 60 * 1000 }),
  )
  store.sweep(now)
  expect(fs.existsSync(stalePath)).toBe(false)
})

test("save: mkdir precedes lock — first-ever save into a nonexistent dir lands (dir + lock created)", () => {
  const fresh = path.join(dir, "nested", "deeper")
  const store = new FileStateStore(fresh)
  expect(fs.existsSync(fresh)).toBe(false)
  store.save("s1", nonInitial(), 0)
  expect(store.load("s1").round).toBe(1)
})
