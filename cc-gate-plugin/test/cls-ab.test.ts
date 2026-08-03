import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  runClsSample,
  parseClsSampleArgs,
  isDerived,
  stratify,
  clsAbRoot,
  CLS_AB_DIR_REL,
  CLS_MANIFEST_NAME,
  CLS_RECORDS_NAME,
  type ClsManifest,
  type ClsSampleRecord,
} from "../src/gauge/cls-ab.ts"
import { writeCorpus, recordKey, CORPUS_FILE_REL, type CorpusRecord } from "../src/gauge/corpus-store.ts"
import type { GaugeFile } from "../src/gauge/files.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-cls-ab-"))
}

function gauge(over: Partial<GaugeFile> = {}): GaugeFile {
  return {
    v: 2,
    sessionID: "sid-1",
    n: 1,
    ts: 2000,
    model: "claude-haiku-4-5",
    derivationMs: 10,
    goalSummary: "g",
    criteria: ["c1"],
    check: "test -f src/auth.ts",
    confidence: 0.9,
    class: "C",
    ...over,
  }
}

function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "derived",
    repo: "/repo/a",
    sessionId: "sess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "test -f floor.ts",
    floorCheckMinedAt: 1000,
    derivation: gauge(),
    ...over,
  }
}

function cRecs(n: number, transport?: "cli" | "sdk"): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({
      promptSha256: `sha-c-${i}`,
      derivation: gauge({ class: "C", ...(transport !== undefined ? { transport } : {}) }),
    }),
  )
}

function notCRecs(n: number, transport?: "cli" | "sdk"): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({
      promptSha256: `sha-notc-${i}`,
      derivation: gauge({ class: "B", check: null, ...(transport !== undefined ? { transport } : {}) }),
    }),
  )
}

function readManifest(cwd: string): ClsManifest {
  const raw = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")
  return JSON.parse(raw) as ClsManifest
}

function readRecords(cwd: string): ClsSampleRecord[] {
  const raw = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_RECORDS_NAME), "utf-8")
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClsSampleRecord)
}

describe("isDerived — any-transport predicate (differs from pv-sample's isCliDerived)", () => {
  test("derivation with transport 'cli' -> true", () => {
    expect(isDerived(rec({ derivation: gauge({ transport: "cli" }) }))).toBe(true)
  })
  test("derivation with transport 'sdk' -> true (unlike pv-sample, sdk arms ARE sampled)", () => {
    expect(isDerived(rec({ derivation: gauge({ transport: "sdk" }) }))).toBe(true)
  })
  test("derivation with transport ABSENT -> true", () => {
    expect(isDerived(rec({ derivation: gauge() }))).toBe(true)
  })
  test("no derivation at all (mined-stage record) -> false", () => {
    expect(isDerived(rec({ stage: "mined", derivation: undefined }))).toBe(false)
  })
})

describe("stratify — pure", () => {
  test("splits derived records into c / notC; ignores undivided records", () => {
    const c = cRecs(2, "sdk")
    const notC = notCRecs(3, "cli")
    const undived = rec({ stage: "mined", derivation: undefined, promptSha256: "sha-mined" })
    const s = stratify([...c, ...notC, undived])
    expect(s.c.length).toBe(2)
    expect(s.notC.length).toBe(3)
  })
})

describe("runClsSample — stratification (any transport)", () => {
  test("all nominal-C (any transport) + equal-size not-C draw", () => {
    const cwd = mkRepo()
    const store = [
      ...cRecs(2, "cli"),
      ...cRecs(1, "sdk").map((r) => ({ ...r, promptSha256: "sha-c-sdk" })),
      ...notCRecs(5, "cli"),
    ]
    writeCorpus(cwd, store, () => {})

    const summary = runClsSample(cwd, {}, () => {})

    expect(summary).toEqual({ cCount: 3, notCCount: 3, total: 6 })
    const manifest = readManifest(cwd)
    expect(manifest.keys.c.length).toBe(3)
    expect(manifest.keys.notC.length).toBe(3)
    // sdk-transport class-C record IS included (unlike pv-sample).
    expect(manifest.keys.c).toContain(recordKey(rec({ promptSha256: "sha-c-sdk" })))
  })
})

describe("runClsSample — real store is never touched (pin on success AND refusal paths)", () => {
  test("byte-identical after a successful sample", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(3)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const before = fs.readFileSync(realFile)

    expect(runClsSample(cwd, {}, () => {})).toBeDefined()

    expect(fs.readFileSync(realFile).equals(before)).toBe(true)
  })

  test("byte-identical after a refuse-if-exists refusal", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(3)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const before = fs.readFileSync(realFile)

    expect(runClsSample(cwd, {}, () => {})).toBeUndefined()

    expect(fs.readFileSync(realFile).equals(before)).toBe(true)
  })

  test("byte-identical after a zero-C hard-error refusal", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...notCRecs(3)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const before = fs.readFileSync(realFile)

    expect(runClsSample(cwd, {}, () => {})).toBeUndefined()

    expect(fs.readFileSync(realFile).equals(before)).toBe(true)
  })
})

describe("runClsSample — refuse-if-exists / --reset", () => {
  test("second run without --reset refuses; --reset discards and rebuilds", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})

    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    const firstManifest = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")

    const logs: string[] = []
    expect(runClsSample(cwd, {}, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("--reset"))).toBe(true)
    expect(fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")).toBe(firstManifest)

    const summary = runClsSample(cwd, { reset: true }, () => {})
    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
  })
})

describe("runClsSample — zero-C hard error", () => {
  test("zero nominal-C derived records -> hard error, no experiment dir created, before any dir mutation", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...notCRecs(4)], () => {})

    const logs: string[] = []
    const summary = runClsSample(cwd, {}, (m) => logs.push(m))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.toLowerCase().includes("error"))).toBe(true)
    expect(fs.existsSync(clsAbRoot(cwd))).toBe(false)
  })

  test("zero-C blocks even with --reset (an existing sample must never be discarded by a bad run)", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    const manifestBefore = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")

    // Rewrite the store with zero class-C records — a subsequent --reset
    // sample must refuse rather than discard the existing in-flight sample.
    writeCorpus(cwd, [...notCRecs(3)], () => {})

    const summary = runClsSample(cwd, { reset: true }, () => {})
    expect(summary).toBeUndefined()
    expect(fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")).toBe(manifestBefore)
  })
})

describe("runClsSample — manifest <-> records key match; no prompt text in manifest.json (F2)", () => {
  test("manifest keys equal records.ndjson keys exactly; strata are honest", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(3), ...notCRecs(4)], () => {})

    const summary = runClsSample(cwd, {}, () => {})
    expect(summary).toBeDefined()

    const manifest = readManifest(cwd)
    expect(typeof manifest.sampledAt).toBe("string")
    expect(Number.isNaN(Date.parse(manifest.sampledAt))).toBe(false)
    expect(manifest.hostname).toBe(os.hostname())
    expect(manifest.cCount).toBe(3)
    expect(manifest.notCCount).toBe(3)

    const records = readRecords(cwd)
    const recordKeys = records.map((r) => r.key).sort()
    const manifestKeys = [...manifest.keys.c, ...manifest.keys.notC].sort()
    expect(recordKeys).toEqual(manifestKeys)

    for (const k of manifest.keys.c) expect(cRecs(3).map(recordKey)).toContain(k)

    // records.ndjson keeps prompt/floorCheck/key — full fidelity for later stages.
    for (const r of records) {
      expect(typeof r.prompt).toBe("string")
      expect(typeof r.floorCheck).toBe("string")
      expect(typeof r.key).toBe("string")
    }
  })

  test("no prompt text ever appears in manifest.json (F2 grep pin)", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()

    const raw = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")
    expect(raw.includes("fix the thing")).toBe(false)
    // records.ndjson DOES carry the prompt text (host-local, never committed).
    const recordsRaw = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_RECORDS_NAME), "utf-8")
    expect(recordsRaw.includes("fix the thing")).toBe(true)
  })
})

describe("parseClsSampleArgs", () => {
  test("positional cwd + --reset flag; defaults to process.cwd() and reset:false", () => {
    expect(parseClsSampleArgs(["/some/dir", "--reset"])).toEqual({ cwd: "/some/dir", reset: true })
    expect(parseClsSampleArgs(["--reset"])).toEqual({ cwd: process.cwd(), reset: true })
    expect(parseClsSampleArgs([])).toEqual({ cwd: process.cwd(), reset: false })
  })
})

describe("CLS_AB_DIR_REL", () => {
  test("is .km/gauge-cls-ab (gitignored via .km/)", () => {
    expect(CLS_AB_DIR_REL).toBe(".km/gauge-cls-ab")
  })
})
