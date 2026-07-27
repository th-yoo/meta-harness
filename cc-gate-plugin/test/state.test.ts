import { test, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/state.ts"
import { INITIAL_STATE, type CcGateState } from "../src/types.ts"

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
  store.save("s1", nonInitial())
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
  store.save("s1", nonInitial())
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(true)
  // ...then saving an initial-equivalent state must remove it rather than
  // writing an initial-looking file to disk.
  store.save("s1", { ...INITIAL_STATE })
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false)
  // And loading afterward still yields fresh initial state.
  expect(store.load("s1")).toEqual(INITIAL_STATE)
})

test("save: initial-equivalent state ignoring updatedAt still deletes (no file ever created)", () => {
  const store = new FileStateStore(dir)
  store.save("s1", { ...INITIAL_STATE, updatedAt: 123456 })
  expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false)
})

test("sessionId is sanitized: path-escape attempt writes inside dir only", () => {
  const store = new FileStateStore(dir)
  const evilId = "a/../b"
  store.save(evilId, nonInitial())

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

test("concurrent-write safety: interleaved load->modify->save is last-writer-wins and never corrupt", () => {
  const store = new FileStateStore(dir)
  const sessionId = "concurrent-session"

  // Simulate two "processes" both loading the same (absent) initial state,
  // then modifying independently, then saving — interleaved rather than
  // sequential, so the second save must fully overwrite the first.
  const a = store.load(sessionId)
  const b = store.load(sessionId)

  const aModified: CcGateState = { ...a, edited: true, round: 1, failStreak: 1 }
  const bModified: CcGateState = { ...b, edited: true, gating: true, round: 2, failStreak: 2 }

  store.save(sessionId, aModified)
  store.save(sessionId, bModified) // last writer

  const finalRaw = fs.readFileSync(path.join(dir, "concurrent-session.json"), "utf-8")
  // File must parse cleanly (never torn/partial from the atomic rename).
  const finalParsed = JSON.parse(finalRaw) as CcGateState
  expect(finalParsed.round).toBe(2)
  expect(finalParsed.failStreak).toBe(2)
  expect(finalParsed.gating).toBe(true)

  const loaded = store.load(sessionId)
  expect(loaded.round).toBe(2)
  expect(loaded.failStreak).toBe(2)
})
