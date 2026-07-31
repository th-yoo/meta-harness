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

function stubBin(dir: string, script: string): string {
  const p = path.join(dir, "stub-claude")
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`)
  fs.chmodSync(p, 0o755)
  return p
}

const DERIVATION = {
  goalSummary: "g",
  class: "C",
  criteria: ["c1"],
  check: "test -f src/auth.ts",
  confidence: 0.9,
}

function stubBinFor(dir: string, derivation: unknown): string {
  return stubBin(
    dir,
    `PROMPT=$(cat)
[ -n "$PROMPT" ] || exit 3
[ "$KM_CHILD" = "1" ] || exit 4
echo '${JSON.stringify({ type: "result", result: JSON.stringify(derivation) }).replace(/'/g, `'\\''`)}'`,
  )
}

/** Run `fn` with KKAMAK_GAUGE_CLAUDE_BIN set to `bin`, restoring whatever was
 * there before (undefined or otherwise) afterward — zero real model calls,
 * every test routes through a stub bin. */
async function withStubBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.KKAMAK_GAUGE_CLAUDE_BIN
  process.env.KKAMAK_GAUGE_CLAUDE_BIN = bin
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.KKAMAK_GAUGE_CLAUDE_BIN
    else process.env.KKAMAK_GAUGE_CLAUDE_BIN = prev
  }
}

describe("deriveRecord", () => {
  test("happy path: mined -> derived, GaugeFile-shaped blob (v2, n:1, model+derivationMs recorded)", async () => {
    const tmp = mkRepo()
    const bin = stubBinFor(tmp, DERIVATION)
    const record = rec({ prompt: "verify src/auth.ts exists", sessionId: "sid-42" })

    const result = await withStubBin(bin, () => deriveRecord(record))

    expect(result.stage).toBe("derived")
    expect(result.derivation).toBeDefined()
    const d = result.derivation!
    expect(d.v).toBe(2)
    expect(d.n).toBe(1)
    expect(d.sessionID).toBe("sid-42")
    expect(typeof d.ts).toBe("number")
    expect(typeof d.model).toBe("string")
    expect(typeof d.derivationMs).toBe("number")
    expect(d.goalSummary).toBe("g")
    // path token verbatim in prompt + in repo scope -> stays class C, not downgraded.
    expect(d.class).toBe("C")
    expect(d.check).toBe("test -f src/auth.ts")
    // rest of the record is preserved untouched.
    expect(result.repo).toBe(record.repo)
    expect(result.promptSha256).toBe(record.promptSha256)
  })

  test("malformed model output (not JSON) -> record stays stage 'mined', no derivation persisted", async () => {
    const tmp = mkRepo()
    const bin = stubBin(tmp, `cat >/dev/null; echo "not json at all"`)
    const record = rec()

    const result = await withStubBin(bin, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })

  test("model output missing required parse fields -> stays 'mined'", async () => {
    const tmp = mkRepo()
    const bin = stubBinFor(tmp, { goalSummary: "g" }) // no class, no criteria
    const record = rec()

    const result = await withStubBin(bin, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })

  test("model call failure (non-zero exit) -> stays 'mined'", async () => {
    const tmp = mkRepo()
    const bin = stubBin(tmp, `cat >/dev/null; exit 1`)
    const record = rec()

    const result = await withStubBin(bin, () => deriveRecord(record))

    expect(result.stage).toBe("mined")
    expect(result.derivation).toBeUndefined()
  })
})

describe("runDerive — cost fence", () => {
  test("missing --go: refuses, logs pending count, no store write, no model calls", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    const marker = path.join(cwd, "called.marker")
    const bin = stubBin(cwd, `touch ${marker}; cat >/dev/null; echo nope`)

    const logs: string[] = []
    const summary = await withStubBin(bin, () => runDerive(cwd, undefined, (m) => logs.push(m)))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("2"))).toBe(true)
    expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("wrong --go (mismatched n): refuses, no store write, no model calls", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    const marker = path.join(cwd, "called.marker")
    const bin = stubBin(cwd, `touch ${marker}; cat >/dev/null; echo nope`)

    const logs: string[] = []
    const summary = await withStubBin(bin, () => runDerive(cwd, 1, (m) => logs.push(m)))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUS") || l.includes("refus"))).toBe(true)
    expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("correct --go: derives every pending record, stage advances, store rewritten", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec(), rec({ promptSha256: "sha-b" })], () => {})
    const bin = stubBinFor(cwd, DERIVATION)

    const logs: string[] = []
    const summary = await withStubBin(bin, () => runDerive(cwd, 2, (m) => logs.push(m)))

    expect(summary).toEqual({ pending: 2, derived: 2, staysMined: 0 })
    const after = readCorpus(cwd)
    expect(after.length).toBe(2)
    expect(after.every((r) => r.stage === "derived")).toBe(true)
    expect(after.every((r) => r.derivation?.n === 1)).toBe(true)
  })

  test("only stage:'mined' records count toward the pending fence — derived/resolved records excluded", async () => {
    const cwd = mkRepo()
    writeCorpus(
      cwd,
      [rec({ stage: "derived", promptSha256: "sha-c" }), rec({ promptSha256: "sha-d" })],
      () => {},
    )
    const bin = stubBinFor(cwd, DERIVATION)

    const summary = await withStubBin(bin, () => runDerive(cwd, 1, () => {}))

    expect(summary?.pending).toBe(1)
    expect(summary?.derived).toBe(1)
  })

  test("partial failure: malformed model output leaves that record 'mined', others derive normally", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec({ promptSha256: "sha-e", prompt: "verify src/auth.ts exists" }), rec({ promptSha256: "sha-f" })], () => {})

    // A bin that alternates: first call returns malformed text, second a valid envelope.
    const bin = stubBin(
      cwd,
      `PROMPT=$(cat)
COUNTFILE="${cwd}/call-count"
COUNT=$(cat "$COUNTFILE" 2>/dev/null || echo 0)
echo $((COUNT+1)) > "$COUNTFILE"
if [ "$COUNT" = "0" ]; then
  echo '${JSON.stringify({ type: "result", result: JSON.stringify(DERIVATION) }).replace(/'/g, `'\\''`)}'
else
  echo "garbage, not json"
fi`,
    )

    const summary = await withStubBin(bin, () => runDerive(cwd, 2, () => {}))
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
  test("lock already held: refuses before any model call, store untouched (marker-file assertion)", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [rec()], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    // Simulate a concurrent writer (e.g. a `mine` in flight) already holding
    // the corpus lock.
    expect(acquireCorpusLock(cwd, () => {})).toBe(true)

    const marker = path.join(cwd, "called.marker")
    const bin = stubBin(cwd, `touch ${marker}; cat >/dev/null; echo nope`)

    const logs: string[] = []
    let summary: unknown
    try {
      summary = await withStubBin(bin, () => runDerive(cwd, 1, (m) => logs.push(m)))

      expect(summary).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      // zero model calls — the stub bin was never spawned.
      expect(fs.existsSync(marker)).toBe(false)
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
    const bin = stubBinFor(cwd, DERIVATION)

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
      await withStubBin(bin, async () => {
        await expect(runDerive(cwd, 1, () => {})).rejects.toThrow(
          "simulated fs failure writing the corpus store",
        )
      })
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
