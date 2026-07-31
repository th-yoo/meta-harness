import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CORPUS_DIR_REL,
  CORPUS_FILE_REL,
  readCorpus,
  writeCorpus,
  upsertRecords,
  type CorpusRecord,
} from "../src/gauge/corpus-store.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-store-"))
}

function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "transcript",
    stage: "mined",
    repo: "/repo/a",
    sessionId: "sess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "bun test",
    floorCheckMinedAt: 1000,
    ...over,
  }
}

function lockPathFor(repo: string): string {
  return path.join(repo, CORPUS_DIR_REL, ".lock")
}

describe("constants", () => {
  test("pinned relative paths", () => {
    expect(CORPUS_DIR_REL).toBe(".km/gauge-corpus")
    expect(CORPUS_FILE_REL).toBe(".km/gauge-corpus/records.ndjson")
  })
})

describe("readCorpus", () => {
  test("missing store file -> []", () => {
    const repo = mkRepo()
    expect(readCorpus(repo)).toEqual([])
  })

  test("malformed lines are skipped silently, valid lines parsed", () => {
    const repo = mkRepo()
    const dir = path.join(repo, CORPUS_DIR_REL)
    fs.mkdirSync(dir, { recursive: true })
    const good = rec()
    fs.writeFileSync(
      path.join(repo, CORPUS_FILE_REL),
      [JSON.stringify(good), "not json at all {{{", "", "42"].join("\n"),
    )
    const records = readCorpus(repo)
    expect(records.length).toBe(1)
    expect(records[0]).toMatchObject(good)
  })
})

describe("writeCorpus happy path", () => {
  test("atomic tmp+rename full rewrite, no leftover tmp file", () => {
    const repo = mkRepo()
    const logs: string[] = []
    const ok = writeCorpus(repo, [rec(), rec({ promptSha256: "sha-b" })], (m) => logs.push(m))
    expect(ok).toBe(true)
    expect(logs.length).toBe(0)
    const lines = fs
      .readFileSync(path.join(repo, CORPUS_FILE_REL), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(2)
    expect(lines[1].promptSha256).toBe("sha-b")

    const leftovers = fs
      .readdirSync(path.join(repo, CORPUS_DIR_REL))
      .filter((n) => n.includes(".tmp-"))
    expect(leftovers.length).toBe(0)
    // lock released after a successful write
    expect(fs.existsSync(lockPathFor(repo))).toBe(false)
  })

  test("empty records array writes an empty file", () => {
    const repo = mkRepo()
    const ok = writeCorpus(repo, [], () => {})
    expect(ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, CORPUS_FILE_REL), "utf-8")).toBe("")
  })
})

describe("writeCorpus lockfile contention", () => {
  test("wx-collision: fresh lock held by another writer -> refuses, logs REFUSING, no lost update", () => {
    const repo = mkRepo()
    // Seed the store with a first, already-committed write.
    expect(writeCorpus(repo, [rec()], () => {})).toBe(true)
    const before = fs.readFileSync(path.join(repo, CORPUS_FILE_REL), "utf-8")

    // Simulate a concurrent in-flight writer holding a fresh lock: a
    // pre-existing lock FILE (single atomic wx artifact, not a directory).
    const lockPath = lockPathFor(repo)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, ts: Date.now() }), { flag: "wx" })

    const logs: string[] = []
    const ok = writeCorpus(repo, [rec({ promptSha256: "sha-b" })], (m) => logs.push(m))

    expect(ok).toBe(false)
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("REFUSING")
    expect(logs[0]).toContain("gauge-corpus")
    // no lost update: store content unchanged
    expect(fs.readFileSync(path.join(repo, CORPUS_FILE_REL), "utf-8")).toBe(before)
    // the other writer's lock is untouched
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  test("stale lock (>10min old) -> takeover, write succeeds, lock cleaned up", () => {
    const repo = mkRepo()
    const lockPath = lockPathFor(repo)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const staleTs = Date.now() - (10 * 60 * 1000 + 1)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111, ts: staleTs }), { flag: "wx" })

    const logs: string[] = []
    const ok = writeCorpus(repo, [rec()], (m) => logs.push(m))

    expect(ok).toBe(true)
    expect(logs.length).toBe(0)
    const lines = fs
      .readFileSync(path.join(repo, CORPUS_FILE_REL), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(1)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  test("torn/unparseable lock content -> treated as stale, takeover succeeds", () => {
    const repo = mkRepo()
    const lockPath = lockPathFor(repo)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, "{not valid json")

    const ok = writeCorpus(repo, [rec()], () => {})
    expect(ok).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  test("after a refused write, once the other writer releases the lock, a retry succeeds", () => {
    const repo = mkRepo()
    const lockPath = lockPathFor(repo)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, ts: Date.now() }), { flag: "wx" })

    expect(writeCorpus(repo, [rec()], () => {})).toBe(false)

    // other writer releases
    fs.unlinkSync(lockPath)

    expect(writeCorpus(repo, [rec()], () => {})).toBe(true)
  })

  test("takeover race: a concurrent writer recreates the lock between our unlink and our fresh wx-create -> refuses, spawn NOT lost (no double-hold)", () => {
    const repo = mkRepo()
    const lockPath = lockPathFor(repo)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const staleTs = Date.now() - (10 * 60 * 1000 + 1)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111, ts: staleTs }), { flag: "wx" })

    // Inject the race: the instant our takeover unlinks the stale lock, a
    // concurrent writer wins the fresh wx-create first. This is exactly the
    // window the original directory+separate-write design got wrong (both
    // sides could end up believing they held the lock); the single wx-file
    // design must collapse this to a clean refusal for the loser.
    const origUnlink = fs.unlinkSync
    fs.unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) => {
      const r = origUnlink(...args)
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 222, ts: Date.now() }), { flag: "wx" })
      return r
    }) as typeof fs.unlinkSync

    try {
      const logs: string[] = []
      const ok = writeCorpus(repo, [rec()], (m) => logs.push(m))
      expect(ok).toBe(false)
      expect(logs[0]).toContain("REFUSING")
      // the concurrent winner's lock must survive untouched — we must not
      // have clobbered it or believed we also held it.
      const held = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
      expect(held.pid).toBe(222)
      // no store file was written by the loser
      expect(fs.existsSync(path.join(repo, CORPUS_FILE_REL))).toBe(false)
    } finally {
      fs.unlinkSync = origUnlink
    }
  })
})

describe("upsertRecords", () => {
  test("no match -> incoming record appended", () => {
    const existing = [rec({ promptSha256: "sha-a" })]
    const incoming = [rec({ promptSha256: "sha-b" })]
    const merged = upsertRecords(existing, incoming)
    expect(merged.length).toBe(2)
  })

  test("identity is (repo, promptSha256): same sha, different repo -> two records", () => {
    const existing = [rec({ repo: "/repo/a", promptSha256: "sha-x" })]
    const incoming = [rec({ repo: "/repo/b", promptSha256: "sha-x" })]
    expect(upsertRecords(existing, incoming).length).toBe(2)
  })

  test("match -> incoming wins field-wise", () => {
    const existing = [rec({ stage: "mined", floorCheck: "old check" })]
    const incoming = [rec({ stage: "mined", floorCheck: "new check" })]
    const merged = upsertRecords(existing, incoming)
    expect(merged.length).toBe(1)
    expect(merged[0]!.floorCheck).toBe("new check")
  })

  test("stage never regresses: derived stays derived even if incoming says mined", () => {
    const existing = [rec({ stage: "derived", derivation: { v: 1, sessionID: "s", n: 1, ts: 1, model: "m", derivationMs: 1, goalSummary: "g", criteria: ["c"], check: null, confidence: 0.5 } })]
    const incoming = [rec({ stage: "mined" })]
    const merged = upsertRecords(existing, incoming)
    expect(merged[0]!.stage).toBe("derived")
    // other fields still merge from incoming
    expect(merged[0]!.promptTs).toBe(incoming[0]!.promptTs)
  })

  test("stage advances forward normally: mined -> derived", () => {
    const existing = [rec({ stage: "mined" })]
    const incoming = [rec({ stage: "derived" })]
    const merged = upsertRecords(existing, incoming)
    expect(merged[0]!.stage).toBe("derived")
  })

  test("preserves prior optional fields the incoming patch omits", () => {
    const existing = [rec({ stage: "derived", poolEligible: true })]
    const incoming = [rec({ stage: "derived" })]
    const merged = upsertRecords(existing, incoming)
    expect(merged[0]!.poolEligible).toBe(true)
  })

  test("incoming explicit undefined does not erase a previously-set field", () => {
    const state = { kind: "commit" as const, sha: "abc123" }
    const existing = [rec({ stage: "resolved", state })]
    const incoming = [rec({ stage: "resolved", state: undefined })]
    const merged = upsertRecords(existing, incoming)
    expect(merged.length).toBe(1)
    expect(merged[0]!.state).toEqual(state)
  })

  test("pure: does not mutate inputs", () => {
    const existing = [rec({ promptSha256: "sha-a" })]
    const incoming = [rec({ promptSha256: "sha-a", floorCheck: "changed" })]
    const existingSnapshot = JSON.parse(JSON.stringify(existing))
    upsertRecords(existing, incoming)
    expect(existing).toEqual(existingSnapshot)
  })
})

describe("F2 tripwire", () => {
  test("gauge-corpus never enters km-sensors-sync FILES", () => {
    const sync = fs.readFileSync(
      path.join(import.meta.dir, "../../scripts/km-sensors-sync.sh"),
      "utf-8",
    )
    expect(sync).not.toContain("gauge-corpus")
  })
})
