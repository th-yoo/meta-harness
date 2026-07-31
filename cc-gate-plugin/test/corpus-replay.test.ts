import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { deriveRecord, runDerive } from "../src/gauge/corpus-replay.ts"
import { readCorpus, writeCorpus, CORPUS_FILE_REL, type CorpusRecord } from "../src/gauge/corpus-store.ts"

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
