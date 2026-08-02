import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { deriveRecord, runDerive, checkFenceUnderLock } from "../src/gauge/corpus-replay.ts"
import {
  readCorpus,
  writeCorpus,
  acquireCorpusLock,
  releaseCorpusLock,
  CORPUS_DIR_REL,
  CORPUS_FILE_REL,
  type CorpusRecord,
} from "../src/gauge/corpus-store.ts"
import { stubServer, stubServerFor, okResponse, type SdkStub } from "./sdk-stub.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-replay-"))
}

function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "mined",
    repo: "/repo/a",
    sessionId: "sess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "",
    floorCheckMinedAt: 1000,
    ...over,
  }
}

function lockPathFor(cwd: string): string {
  return path.join(cwd, CORPUS_DIR_REL, ".lock")
}

const DERIVATION = {
  goalSummary: "g",
  class: "C",
  criteria: ["c1"],
  check: "test -f src/auth.ts",
  confidence: 0.9,
}

/** Run `fn` with the SDK transport pointed at `srv` (base-URL + token env
 * seams), restoring whatever was there before afterward — zero real model
 * calls, every test routes through the stub server (§6c transport). */
async function withSdkStub<T>(srv: SdkStub, fn: () => Promise<T>): Promise<T> {
  const prevUrl = process.env.KKAMAK_GAUGE_SDK_BASE_URL
  const prevTok = process.env.KKAMAK_GAUGE_AUTH_TOKEN
  process.env.KKAMAK_GAUGE_SDK_BASE_URL = srv.url
  process.env.KKAMAK_GAUGE_AUTH_TOKEN = "tok-test"
  try {
    return await fn()
  } finally {
    if (prevUrl === undefined) delete process.env.KKAMAK_GAUGE_SDK_BASE_URL
    else process.env.KKAMAK_GAUGE_SDK_BASE_URL = prevUrl
    if (prevTok === undefined) delete process.env.KKAMAK_GAUGE_AUTH_TOKEN
    else process.env.KKAMAK_GAUGE_AUTH_TOKEN = prevTok
    srv.stop()
  }
}

describe("deriveRecord", () => {
  test("happy path: mined -> derived, GaugeFile-shaped blob (v2, n:1, model+derivationMs+transport recorded)", async () => {
    const srv = stubServerFor(DERIVATION)
    const record = rec({ prompt: "verify src/auth.ts exists", sessionId: "sid-42" })

    const result = await withSdkStub(srv, () => deriveRecord(record))

    expect(result.stage).toBe("derived")
    expect(result.derivation).toBeDefined()
    const d = result.derivation!
    expect(d.v).toBe(2)
    expect(d.n).toBe(1)
    expect(d.sessionID).toBe("sid-42")
    expect(typeof d.ts).toBe("number")
    // model = the resolved API id actually sent, not the CLI alias.
    expect(d.model).toBe("claude-haiku-4-5")
    expect(typeof d.derivationMs).toBe("number")
    expect(d.goalSummary).toBe("g")
    // §6c provenance: SDK-derived blobs carry transport "sdk" (absent = cli).
    expect(d.transport).toBe("sdk")
    // path token verbatim in prompt + in repo scope -> stays class C, not downgraded.
    expect(d.class).toBe("C")
    expect(d.check).toBe("test -f src/auth.ts")
    // rest of the record is preserved untouched.
    expect(result.repo).toBe(record.repo)
    expect(result.promptSha256).toBe(record.promptSha256)
  })

  test("malformed model output (not JSON) -> record stays stage 'mined', no derivation persisted", async () => {
    const srv = stubServer(() => okResponse("not json at all"))
    const record = rec()

    const result = await withSdkStub(srv, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })

  test("model output missing required parse fields -> stays 'mined'", async () => {
    const srv = stubServerFor({ goalSummary: "g" }) // no class, no criteria
    const record = rec()

    const result = await withSdkStub(srv, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })

  test("model call failure (API error) -> stays 'mined'", async () => {
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    const record = rec()

    const result = await withSdkStub(srv, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })
})

describe("runDerive — cost fence", () => {
  test("missing --go: refuses, logs pending count, no store write, no model calls", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    const srv = stubServerFor(DERIVATION)
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runDerive(cwd, undefined, (m) => logs.push(m)))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("2"))).toBe(true)
    expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
    expect(srv.captured.length).toBe(0)
  })

  test("wrong --go (mismatched n): refuses, no store write, no model calls", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    const srv = stubServerFor(DERIVATION)
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runDerive(cwd, 1, (m) => logs.push(m)))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUS") || l.includes("refus"))).toBe(true)
    expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
    expect(srv.captured.length).toBe(0)
  })

  test("correct --go: derives every pending record, stage advances, store rewritten", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const srv = stubServerFor(DERIVATION)

    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runDerive(cwd, 2, (m) => logs.push(m)))

    expect(summary).toEqual({ pending: 2, derived: 2, staysMined: 0 })
    const after = readCorpus(cwd)
    expect(after.length).toBe(2)
    expect(after.every((r) => r.stage === "derived")).toBe(true)
    expect(after.every((r) => r.derivation?.n === 1)).toBe(true)
    expect(after.every((r) => r.derivation?.transport === "sdk")).toBe(true)
  })

  test("only stage:'mined' records count toward the pending fence — derived/resolved records excluded", async () => {
    const cwd = mkRepo()
    writeCorpus(
      cwd,
      [rec({ stage: "derived", promptSha256: "sha-c" }), rec({ promptSha256: "sha-d" })],
      () => {},
    )
    const srv = stubServerFor(DERIVATION)

    const summary = await withSdkStub(srv, () => runDerive(cwd, 1, () => {}))

    expect(summary?.pending).toBe(1)
    expect(summary?.derived).toBe(1)
  })

  test("partial failure: malformed model output leaves that record 'mined', others derive normally", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec({ promptSha256: "sha-e", prompt: "verify src/auth.ts exists" }), rec({ promptSha256: "sha-f" })], () => {})

    // A server that alternates: first call returns a valid derivation,
    // second malformed text (runDerive is sequential, so this is
    // deterministic — same shape as the old alternating stub bin).
    let calls = 0
    const srv = stubServer(() => {
      calls += 1
      return calls === 1 ? okResponse(JSON.stringify(DERIVATION)) : okResponse("garbage, not json")
    })

    const summary = await withSdkStub(srv, () => runDerive(cwd, 2, () => {}))
    expect(summary?.pending).toBe(2)
    expect(summary?.derived).toBe(1)
    expect(summary?.staysMined).toBe(1)

    const after = readCorpus(cwd)
    const stages = after.map((r) => r.stage).sort()
    expect(stages).toEqual(["derived", "mined"])
  })
})

// --- Task 3 review fix-wave: the corpus lock now guards the WHOLE
// read -> derive -> write lifecycle, not just writeCorpus's final write
// (findings: lost-update via a stale-snapshot rewrite clobbering a
// concurrent mine; spent-but-discarded via a post-spend write refusal that
// looks identical to the zero-effect fence refusal). ---

describe("runDerive — lock held by another writer", () => {
  test("lock already held: refuses before any model call, store untouched (zero-requests assertion)", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec()], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    // Simulate a concurrent writer (e.g. a `mine` in flight) already holding
    // the corpus lock.
    expect(acquireCorpusLock(cwd, () => {})).toBe(true)

    const srv = stubServerFor(DERIVATION)
    const logs: string[] = []
    let summary: unknown
    try {
      summary = await withSdkStub(srv, () => runDerive(cwd, 1, (m) => logs.push(m)))

      expect(summary).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      // zero model calls — the stub server was never hit.
      expect(srv.captured.length).toBe(0)
      // zero effect — the store is byte-identical to before the attempt.
      expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
      // and still stage "mined" — the fence-passing record was untouched.
      expect(readCorpus(cwd)[0]!.stage).toBe("mined")
    } finally {
      releaseCorpusLock(cwd) // release our simulated concurrent holder
    }
  })
})

describe("checkFenceUnderLock — re-check under the lock", () => {
  test("fresh pending count still matches go -> returns the fresh read", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})

    const logs: string[] = []
    const result = checkFenceUnderLock(cwd, 2, (m) => logs.push(m))

    expect(result?.pending.length).toBe(2)
    expect(result?.all.length).toBe(2)
    expect(logs.length).toBe(0)
  })

  test("a concurrent mine lands between the CLI's first read and lock acquisition -> refuses, zero effect", () => {
    const cwd = mkRepo()
    // The CLI's first (pre-lock) read saw exactly 1 pending record and the
    // operator passed --go 1, matching it.
    writeCorpus(cwd, [rec()], () => {})

    // In the window between that read and lock acquisition, a `mine` lands
    // and adds a second pending record.
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-new", sessionId: "sess-2" })], () => {})

    const logs: string[] = []
    const result = checkFenceUnderLock(cwd, 1, (m) => logs.push(m))

    expect(result).toBeUndefined()
    expect(
      logs.some((l) => l.includes("REFUSING") && l.includes("changed under lock") && l.includes("2")),
    ).toBe(true)
    // the store itself is untouched by the fence check (read-only).
    expect(readCorpus(cwd).length).toBe(2)
  })
})

describe("runDerive — lock released on throw (finally guarantee)", () => {
  test("a throw in the post-model write path still releases the lock — spend is not stranded behind a leaked lock", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec()], () => {})
    // Valid derivation — the model call SUCCEEDS (real spend happens)
    // before the injected failure.
    const srv = stubServerFor(DERIVATION)

    // Monkey-patch fs.writeFileSync (corpus-store.test.ts "takeover race"
    // precedent) to fail ONLY the corpus store's tmp+rename write, leaving
    // lock create/refresh writes (same fs call, different path) untouched —
    // simulates a real fs failure (disk full, permissions) landing exactly
    // where finding 2 warned a post-spend write could go wrong.
    const origWriteFileSync = fs.writeFileSync
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      const target = String(args[0])
      if (target.includes(".records.ndjson.tmp-")) {
        throw new Error("simulated fs failure writing the corpus store")
      }
      return origWriteFileSync(...args)
    }) as typeof fs.writeFileSync

    try {
      await withSdkStub(srv, async () => {
        await expect(runDerive(cwd, 1, () => {})).rejects.toThrow(
          "simulated fs failure writing the corpus store",
        )
      })
      // the model call really happened before the injected write failure.
      expect(srv.captured.length).toBe(1)
    } finally {
      fs.writeFileSync = origWriteFileSync
    }

    // The lock must NOT be leaked by the throw — released via runDerive's
    // outer `finally`, not stranded for the rest of the process lifetime.
    expect(fs.existsSync(lockPathFor(cwd))).toBe(false)
    // Provable, not just "file absent": a fresh acquire succeeds immediately
    // (a leaked/stale-but-present lock would still block a FRESH acquire
    // for up to STALE_MS even though this assertion alone can't distinguish
    // "released" from "never created" — the existsSync check above already
    // rules out "never created" since we know the batch reached the lock-held
    // write phase after a successful model call).
    expect(acquireCorpusLock(cwd, () => {})).toBe(true)
    releaseCorpusLock(cwd)
  })
})
