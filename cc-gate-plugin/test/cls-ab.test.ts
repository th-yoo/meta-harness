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
  CLS_AB_LOCK_REL,
  CLS_LABELS_NAME,
  CLS_ALL_ARM_NAMES,
  clsArmFileName,
  acquireClsAbLock,
  releaseClsAbLock,
  refreshClsAbLock,
  hasLiveClsAbLock,
  type ClsManifest,
  type ClsSampleRecord,
  type ClsArmRow,
  type ClsLabelRow,
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

  // fix-wave F14: a duplicated store line (same recordKey — repo +
  // promptSha256) must never be double-counted into either stratum.
  test("dedupes by recordKey before stratifying — a duplicated line counts once", () => {
    const one = cRecs(1)[0]!
    const s = stratify([one, { ...one }, ...notCRecs(2)])
    expect(s.c.length).toBe(1)
    expect(s.notC.length).toBe(2)
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

  // fix-wave F10: per-stratum cli-vs-sdk transport tally, carried into the
  // manifest (absent transport counts as cli, mirroring pv-sample's
  // isCliDerived reading).
  test("manifest carries per-stratum transport tally (absent counts as cli)", () => {
    const cwd = mkRepo()
    const cCli = cRecs(2, "cli").map((r, i) => ({ ...r, promptSha256: `sha-c-cli-${i}` }))
    const cSdk = cRecs(1, "sdk").map((r) => ({ ...r, promptSha256: "sha-c-sdk-1" }))
    const cAbsent = cRecs(1).map((r) => ({ ...r, promptSha256: "sha-c-absent-1" }))
    const notCCli = notCRecs(4, "cli").map((r, i) => ({ ...r, promptSha256: `sha-notc-cli-${i}` }))
    writeCorpus(cwd, [...cCli, ...cSdk, ...cAbsent, ...notCCli], () => {})

    expect(runClsSample(cwd, {}, () => {})).toEqual({ cCount: 4, notCCount: 4, total: 8 })
    const manifest = readManifest(cwd)
    // c stratum: 2 explicit-cli + 1 absent (counts as cli) = 3 cli, 1 sdk.
    expect(manifest.transportCounts.c).toEqual({ cli: 3, sdk: 1 })
    // notC stratum: whole pool is cli-derived and equals the drawn size (4).
    expect(manifest.transportCounts.notC).toEqual({ cli: 4, sdk: 0 })
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

describe("runClsSample — write order: manifest.json before records.ndjson (fix-wave F5)", () => {
  test("manifest.json is renamed into place before records.ndjson", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})

    const order: string[] = []
    const origRename = fs.renameSync
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      order.push(String(args[1]))
      return origRename(...args)
    }) as typeof fs.renameSync
    try {
      expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    } finally {
      fs.renameSync = origRename
    }

    const manifestIdx = order.findIndex((p) => p.endsWith(CLS_MANIFEST_NAME))
    const recordsIdx = order.findIndex((p) => p.endsWith(CLS_RECORDS_NAME))
    expect(manifestIdx).toBeGreaterThanOrEqual(0)
    expect(recordsIdx).toBeGreaterThanOrEqual(0)
    expect(manifestIdx).toBeLessThan(recordsIdx)
  })

  test("cls-label still succeeds without manifest.json (labels gate on records.ndjson only)", async () => {
    // Pinned semantics unchanged by the write-order swap — records.ndjson is
    // the only file cls-label's own refusal gates on.
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    fs.unlinkSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME))
    expect(fs.existsSync(path.join(clsAbRoot(cwd), CLS_RECORDS_NAME))).toBe(true)
  })
})

describe("runClsSample — --reset spend guard (fix-wave F6)", () => {
  function seedSpendFiles(cwd: string): void {
    const root = clsAbRoot(cwd)
    const labels: ClsLabelRow[] = [
      { key: "k1", label: "C", class: "C", model: "claude-opus-5", promptSha256: "h1", ts: "t" },
      { key: "k2", label: "not-C", class: "D", model: "claude-opus-5", promptSha256: "h2", ts: "t" },
    ]
    fs.writeFileSync(path.join(root, CLS_LABELS_NAME), labels.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const armRows: ClsArmRow[] = [
      { key: "k1", class: "C", model: "claude-haiku-4-5", promptVariant: "base", transport: "sdk", promptSha256: "h1", ts: "t" },
      { key: "k2", class: "D", model: "claude-haiku-4-5", promptVariant: "base", transport: "sdk", promptSha256: "h2", ts: "t" },
      { key: "k3", class: "C", model: "claude-haiku-4-5", promptVariant: "base", transport: "sdk", promptSha256: "h3", ts: "t" },
    ]
    fs.writeFileSync(
      path.join(root, clsArmFileName("haiku-base")),
      armRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    )
  }

  test("refuses --reset when spend files exist, printing exact row counts, zero effect", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    seedSpendFiles(cwd)
    const manifestBefore = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")

    const logs: string[] = []
    const summary = runClsSample(cwd, { reset: true }, (m) => logs.push(m))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("--discard-spend"))).toBe(true)
    expect(logs.some((l) => l.includes(`${CLS_LABELS_NAME}: 2 row(s)`))).toBe(true)
    expect(logs.some((l) => l.includes(`${clsArmFileName("haiku-base")}: 3 row(s)`))).toBe(true)
    // zero effect: manifest + spend files all untouched.
    expect(fs.readFileSync(path.join(clsAbRoot(cwd), CLS_MANIFEST_NAME), "utf-8")).toBe(manifestBefore)
    expect(fs.existsSync(path.join(clsAbRoot(cwd), CLS_LABELS_NAME))).toBe(true)
    expect(fs.existsSync(path.join(clsAbRoot(cwd), clsArmFileName("haiku-base")))).toBe(true)
  })

  test("--reset --discard-spend proceeds, printing exact row counts before destroying them", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    seedSpendFiles(cwd)

    const logs: string[] = []
    const summary = runClsSample(cwd, { reset: true, discardSpend: true }, (m) => logs.push(m))

    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    expect(logs.some((l) => l.includes(`${CLS_LABELS_NAME}: 2 row(s)`))).toBe(true)
    expect(logs.some((l) => l.includes(`${clsArmFileName("haiku-base")}: 3 row(s)`))).toBe(true)
    // the old spend is gone — rebuilt from scratch.
    expect(fs.existsSync(path.join(clsAbRoot(cwd), CLS_LABELS_NAME))).toBe(false)
    expect(fs.existsSync(path.join(clsAbRoot(cwd), clsArmFileName("haiku-base")))).toBe(false)
  })

  test("--reset with no spend files present proceeds without needing --discard-spend (unchanged)", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()
    const summary = runClsSample(cwd, { reset: true }, () => {})
    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
  })
})

describe("cls-ab lock — refresh + ownership-checked release (fix-wave F4)", () => {
  test("refreshClsAbLock bumps ts in place, pid unchanged", () => {
    const cwd = mkRepo()
    const lockPath = path.join(cwd, CLS_AB_LOCK_REL)
    expect(acquireClsAbLock(cwd, 1_000)).toBe(true)
    const before = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number; ts: number }

    refreshClsAbLock(cwd, 6_000)

    const after = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid: number; ts: number }
    expect(after.ts).toBe(6_000)
    expect(after.pid).toBe(before.pid)
    releaseClsAbLock(cwd)
  })

  test("releaseClsAbLock refuses to unlink a lock it does not own", () => {
    const cwd = mkRepo()
    const lockPath = path.join(cwd, CLS_AB_LOCK_REL)
    expect(acquireClsAbLock(cwd, 1_000)).toBe(true)

    // Simulate the lock now being owned by someone else (e.g. a takeover
    // after this process's own copy went stale) by overwriting the on-disk
    // content directly, WITHOUT going through this module's acquire/refresh
    // — releaseClsAbLock's in-process ownership record no longer matches.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, ts: 2_000 }))

    releaseClsAbLock(cwd)

    expect(fs.existsSync(lockPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toEqual({ pid: 424242, ts: 2_000 })
  })

  test("releaseClsAbLock is a no-op when this process never acquired the lock at all", () => {
    const cwd = mkRepo()
    const lockPath = path.join(cwd, CLS_AB_LOCK_REL)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, ts: Date.now() }))

    releaseClsAbLock(cwd)

    expect(fs.existsSync(lockPath)).toBe(true)
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

describe("runClsSample — concurrency: cls-sample-vs-itself cannot interleave (fix-wave)", () => {
  test("a live lock (simulating a concurrent invocation in flight) causes clean refusal — no interleave, nothing mutated", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const realBefore = fs.readFileSync(realFile)

    // Simulate a concurrent competitor (another cls-sample invocation, or —
    // per the module doc — a Task 2 arm/label writer) holding the shared
    // lock mid-operation.
    expect(acquireClsAbLock(cwd)).toBe(true)
    try {
      const logs: string[] = []
      const summary = runClsSample(cwd, {}, (m) => logs.push(m))

      expect(summary).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      // the second invocation never built (or touched) the experiment dir —
      // no interleaved/partial records.ndjson or manifest.json.
      expect(fs.existsSync(clsAbRoot(cwd))).toBe(false)
      expect(fs.readFileSync(realFile).equals(realBefore)).toBe(true)
    } finally {
      releaseClsAbLock(cwd)
    }
  })

  test("the lock is released after a successful run (no leftover lockfile)", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})

    expect(runClsSample(cwd, {}, () => {})).toBeDefined()

    expect(hasLiveClsAbLock(cwd)).toBe(false)
    expect(fs.existsSync(path.join(cwd, CLS_AB_LOCK_REL))).toBe(false)
  })

  test("the lock is released after a refuse-if-exists refusal too", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    expect(runClsSample(cwd, {}, () => {})).toBeDefined()

    expect(runClsSample(cwd, {}, () => {})).toBeUndefined()

    expect(hasLiveClsAbLock(cwd)).toBe(false)
  })

  test("a STALE lock (>10min old) is taken over rather than blocking forever", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
    fs.mkdirSync(path.dirname(path.join(cwd, CLS_AB_LOCK_REL)), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, CLS_AB_LOCK_REL),
      JSON.stringify({ pid: 99999, ts: Date.now() - 11 * 60 * 1000 }),
    )

    const summary = runClsSample(cwd, {}, () => {})

    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    expect(hasLiveClsAbLock(cwd)).toBe(false)
  })
})

describe("parseClsSampleArgs", () => {
  test("positional cwd + --reset flag; defaults to process.cwd() and reset:false", () => {
    expect(parseClsSampleArgs(["/some/dir", "--reset"])).toEqual({
      cwd: "/some/dir",
      reset: true,
      discardSpend: false,
      unknownFlag: undefined,
    })
    expect(parseClsSampleArgs(["--reset"])).toEqual({
      cwd: process.cwd(),
      reset: true,
      discardSpend: false,
      unknownFlag: undefined,
    })
    expect(parseClsSampleArgs([])).toEqual({
      cwd: process.cwd(),
      reset: false,
      discardSpend: false,
      unknownFlag: undefined,
    })
  })

  // fix-wave F6: --discard-spend only matters alongside --reset; extracted
  // like any other flag regardless of order.
  test("--discard-spend extracted alongside --reset", () => {
    expect(parseClsSampleArgs(["/some/dir", "--reset", "--discard-spend"])).toEqual({
      cwd: "/some/dir",
      reset: true,
      discardSpend: true,
      unknownFlag: undefined,
    })
  })

  // fix-wave F17: an unrecognized --flag is captured, never swallowed into
  // the cwd positional.
  test("unknown flag captured, never becomes the cwd positional", () => {
    expect(parseClsSampleArgs(["--typo", "/some/dir"])).toEqual({
      cwd: "/some/dir",
      reset: false,
      discardSpend: false,
      unknownFlag: "--typo",
    })
  })
})

describe("CLS_AB_DIR_REL", () => {
  test("is .km/gauge-cls-ab (gitignored via .km/)", () => {
    expect(CLS_AB_DIR_REL).toBe(".km/gauge-cls-ab")
  })
})
