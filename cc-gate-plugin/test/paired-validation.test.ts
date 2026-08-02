import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  runPvSample,
  parsePvSampleArgs,
  isCliDerived,
  shadowRoot,
  SHADOW_DIR_REL,
  PV_MANIFEST_NAME,
  type PvManifest,
} from "../src/gauge/paired-validation.ts"
import {
  readCorpus,
  writeCorpus,
  recordKey,
  acquireCorpusLock,
  releaseCorpusLock,
  CORPUS_DIR_REL,
  CORPUS_FILE_REL,
  type CorpusRecord,
} from "../src/gauge/corpus-store.ts"
import { runDerive } from "../src/gauge/corpus-replay.ts"
import type { GaugeFile } from "../src/gauge/files.ts"
import { stubServerFor, type SdkStub } from "./sdk-stub.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-pv-sample-"))
}

/** Derived-stage GaugeFile blob — corpus-replay.test.ts's DERIVATION shape,
 * persisted-form (v2, n:1). `transport` left ABSENT by default (= CLI, per
 * the §6c provenance rule / plan R2); override to "cli" or "sdk" per test. */
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

/** Derived-stage record (the pv-sample population is derived records only —
 * a mined record has no derivation and no classification to pair). */
function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "derived",
    repo: "/repo/a",
    sessionId: "sess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "",
    floorCheckMinedAt: 1000,
    derivation: gauge(),
    ...over,
  }
}

/** n class-C CLI-derived records with distinct keys. */
function cRecs(n: number, transport?: "cli" | "sdk"): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({
      promptSha256: `sha-c-${i}`,
      derivation: gauge({ class: "C", ...(transport !== undefined ? { transport } : {}) }),
    }),
  )
}

/** n not-C (class B) CLI-derived records with distinct keys. */
function notCRecs(n: number, transport?: "cli" | "sdk"): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({
      promptSha256: `sha-notc-${i}`,
      derivation: gauge({ class: "B", check: null, ...(transport !== undefined ? { transport } : {}) }),
    }),
  )
}

/** Run `fn` with the SDK transport pointed at `srv` — corpus-replay.test.ts's
 * withSdkStub verbatim (base-URL + token env seams, restored afterward);
 * zero real model calls. */
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

function shadowKeys(cwd: string): string[] {
  return readCorpus(shadowRoot(cwd)).map(recordKey)
}

function readManifest(cwd: string): PvManifest {
  const raw = fs.readFileSync(path.join(shadowRoot(cwd), PV_MANIFEST_NAME), "utf-8")
  return JSON.parse(raw) as PvManifest
}

describe("isCliDerived — R2 transport predicate", () => {
  test("derivation with transport 'cli' -> true", () => {
    expect(isCliDerived(rec({ derivation: gauge({ transport: "cli" }) }))).toBe(true)
  })

  test("derivation with transport ABSENT -> true (pre-boundary CLI)", () => {
    expect(isCliDerived(rec({ derivation: gauge() }))).toBe(true)
  })

  test("derivation with transport 'sdk' -> false (no CLI arm to pair with)", () => {
    expect(isCliDerived(rec({ derivation: gauge({ transport: "sdk" }) }))).toBe(false)
  })

  test("no derivation at all (mined-stage record) -> false", () => {
    expect(isCliDerived(rec({ stage: "mined", derivation: undefined }))).toBe(false)
  })
})

describe("runPvSample — stratification", () => {
  test("all class-C + equal-size not-C draw; sdk-transport records never sampled", () => {
    const cwd = mkRepo()
    const store = [
      ...cRecs(3, "cli"),
      ...notCRecs(5), // transport absent = CLI (R2)
      rec({ promptSha256: "sha-sdk-c", derivation: gauge({ class: "C", transport: "sdk" }) }),
      rec({ promptSha256: "sha-sdk-b", derivation: gauge({ class: "B", transport: "sdk" }) }),
    ]
    writeCorpus(cwd, store, () => {})

    const summary = runPvSample(cwd, {}, () => {})

    expect(summary).toEqual({ cCount: 3, notCCount: 3, total: 6 })
    const keys = shadowKeys(cwd)
    expect(keys.length).toBe(6)
    // every class-C CLI record is in — no exceptions.
    for (const r of cRecs(3, "cli")) expect(keys).toContain(recordKey(r))
    // sdk-transport records are excluded from sampling entirely, C or not.
    expect(keys).not.toContain(recordKey(rec({ promptSha256: "sha-sdk-c" })))
    expect(keys).not.toContain(recordKey(rec({ promptSha256: "sha-sdk-b" })))
    // the remaining 3 are a subset of the not-C CLI stratum.
    const notCKeys = notCRecs(5).map(recordKey)
    const drawn = keys.filter((k) => notCKeys.includes(k))
    expect(drawn.length).toBe(3)
  })

  test("absent-transport class-C records count as CLI-derived (R2)", () => {
    const cwd = mkRepo()
    // 2 C with NO transport field + 2 not-C with NO transport field.
    writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})

    const summary = runPvSample(cwd, {}, () => {})

    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    const keys = shadowKeys(cwd)
    for (const r of cRecs(2)) expect(keys).toContain(recordKey(r))
  })
})

describe("runPvSample — real store is never touched", () => {
  test("real records.ndjson byte-identical after pv-sample; no lock left behind", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli"), ...notCRecs(3)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const before = fs.readFileSync(realFile)

    const summary = runPvSample(cwd, {}, () => {})

    expect(summary).toBeDefined()
    expect(fs.readFileSync(realFile).equals(before)).toBe(true)
    // pv-sample reads the real store via the lock-free read path only —
    // no lock artifact may remain in the REAL store dir.
    expect(fs.existsSync(path.join(cwd, CORPUS_DIR_REL, ".lock"))).toBe(false)
  })
})

describe("runPvSample — shadow store shape", () => {
  test("shadow pending count == sample size; every record reset to stage 'mined' with derive/resolve fields removed", () => {
    const cwd = mkRepo()
    // Give the sampled records resolve-stage baggage to prove it's stripped.
    const resolved = cRecs(2, "cli").map((r) => ({
      ...r,
      stage: "resolved" as const,
      state: { kind: "commit" as const, sha: "abc" },
      exec: { executable: true, pass: true, timeoutMs: 1 },
      poolEligible: true,
    }))
    writeCorpus(cwd, [...resolved, ...notCRecs(2)], () => {})

    const summary = runPvSample(cwd, {}, () => {})

    expect(summary?.total).toBe(4)
    // The shadow store is a nested `.km/gauge-corpus/records.ndjson` under
    // the shadow root, so the UNMODIFIED deriver (readCorpus on the shadow
    // root as cwd) sees the sample as its ordinary pending set (R1/R4).
    const shadow = readCorpus(shadowRoot(cwd))
    expect(shadow.length).toBe(4)
    for (const r of shadow) {
      expect(r.stage).toBe("mined")
      expect(r.derivation).toBeUndefined()
      expect(r.state).toBeUndefined()
      expect(r.exec).toBeUndefined()
      expect(r.poolEligible).toBeUndefined()
      // mined-identity fields survive untouched (corpus-mine.ts shape).
      expect(r.provenance).toBe("corpus-transcript")
      expect(typeof r.prompt).toBe("string")
      expect(typeof r.promptSha256).toBe("string")
      expect(typeof r.floorCheckMinedAt).toBe("number")
    }
  })
})

describe("runPvSample — refuse-if-exists (R3)", () => {
  test("second run without --reset refuses; --reset discards and rebuilds", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli"), ...notCRecs(2)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)

    expect(runPvSample(cwd, {}, () => {})).toBeDefined()
    const firstManifest = fs.readFileSync(path.join(shadowRoot(cwd), PV_MANIFEST_NAME), "utf-8")
    const realBefore = fs.readFileSync(realFile)

    // Without --reset: refuses, shadow untouched, real store byte-identical.
    const logs: string[] = []
    expect(runPvSample(cwd, {}, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("--reset"))).toBe(true)
    expect(fs.readFileSync(path.join(shadowRoot(cwd), PV_MANIFEST_NAME), "utf-8")).toBe(firstManifest)
    expect(fs.readFileSync(realFile).equals(realBefore)).toBe(true)

    // With --reset: discards and rebuilds.
    const summary = runPvSample(cwd, { reset: true }, () => {})
    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    expect(readCorpus(shadowRoot(cwd)).length).toBe(4)
  })

  test("--reset with a LIVE shadow lock (shadow derive in flight) refuses; both stores untouched", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli"), ...notCRecs(2)], () => {})
    const realFile = path.join(cwd, CORPUS_FILE_REL)

    expect(runPvSample(cwd, {}, () => {})).toBeDefined()
    const root = shadowRoot(cwd)
    const firstManifest = fs.readFileSync(path.join(root, PV_MANIFEST_NAME), "utf-8")
    const shadowBefore = fs.readFileSync(path.join(root, CORPUS_FILE_REL))
    const realBefore = fs.readFileSync(realFile)

    // Simulate a shadow derive batch mid-spend: it holds the SHADOW store's
    // own lock (fresh -> non-stale).
    expect(acquireCorpusLock(root, () => {})).toBe(true)
    try {
      const logs: string[] = []
      expect(runPvSample(cwd, { reset: true }, (m) => logs.push(m))).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      // shadow sample survives intact — records AND manifest.
      expect(fs.readFileSync(path.join(root, CORPUS_FILE_REL)).equals(shadowBefore)).toBe(true)
      expect(fs.readFileSync(path.join(root, PV_MANIFEST_NAME), "utf-8")).toBe(firstManifest)
      // real store byte-identical on this refusal path too.
      expect(fs.readFileSync(realFile).equals(realBefore)).toBe(true)
    } finally {
      releaseCorpusLock(root)
    }
  })

  test("--reset with a STALE shadow lock proceeds (corpus-store's own staleness rule, not a new one)", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli"), ...notCRecs(2)], () => {})

    expect(runPvSample(cwd, {}, () => {})).toBeDefined()
    const root = shadowRoot(cwd)
    // A lock from a killed shadow deriver, older than corpus-store.ts's
    // STALE_MS (10 min) — stale-equivalent, must not block a --reset.
    fs.writeFileSync(
      path.join(root, CORPUS_DIR_REL, ".lock"),
      JSON.stringify({ pid: 99999, ts: Date.now() - 11 * 60 * 1000 }),
    )

    const summary = runPvSample(cwd, { reset: true }, () => {})
    expect(summary).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    expect(readCorpus(root).length).toBe(4)
  })
})

describe("runPvSample — zero class-C edge", () => {
  test("no CLI-derived class-C records -> 'nothing to validate' error, no shadow dir created", () => {
    const cwd = mkRepo()
    // not-C CLI records + a class-C record that is SDK-only: still nothing
    // to validate (sdk records are outside the sampling population, R2).
    writeCorpus(
      cwd,
      [...notCRecs(3), rec({ promptSha256: "sha-sdk-c", derivation: gauge({ class: "C", transport: "sdk" }) })],
      () => {},
    )

    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const before = fs.readFileSync(realFile)
    const logs: string[] = []
    const summary = runPvSample(cwd, {}, (m) => logs.push(m))

    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("nothing to validate"))).toBe(true)
    expect(fs.existsSync(shadowRoot(cwd))).toBe(false)
    // real store byte-identical on this refusal path too.
    expect(fs.readFileSync(realFile).equals(before)).toBe(true)
  })
})

describe("runPvSample — manifest (R3/R5)", () => {
  test("manifest keys match the shadow store contents exactly; counts + provenance fields present; no prompt text", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(3, "cli"), ...notCRecs(4)], () => {})

    const summary = runPvSample(cwd, {}, () => {})
    expect(summary).toBeDefined()

    const manifest = readManifest(cwd)
    expect(typeof manifest.sampledAt).toBe("string")
    expect(Number.isNaN(Date.parse(manifest.sampledAt))).toBe(false)
    expect(manifest.hostname).toBe(os.hostname())
    expect(manifest.cCount).toBe(3)
    expect(manifest.notCCount).toBe(3)
    expect(manifest.keys.c.length).toBe(3)
    expect(manifest.keys.notC.length).toBe(3)

    // keys.c ∪ keys.notC == the shadow store's record keys, exactly.
    const manifestKeys = [...manifest.keys.c, ...manifest.keys.notC].sort()
    expect(manifestKeys).toEqual(shadowKeys(cwd).sort())
    // strata are honest: every keys.c member really is a class-C record.
    for (const k of manifest.keys.c) expect(cRecs(3, "cli").map(recordKey)).toContain(k)

    // R5/F2: keys only, never prompt text.
    const raw = fs.readFileSync(path.join(shadowRoot(cwd), PV_MANIFEST_NAME), "utf-8")
    expect(raw.includes("fix the thing")).toBe(false)
  })
})

describe("runPvSample -> runDerive integration — the tool's central claim", () => {
  test("the UNMODIFIED deriver, pointed at the shadow root as cwd: fence accepts go == sample size, every record derives, manifest untouched", async () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli"), ...notCRecs(3)], () => {})

    const summary = runPvSample(cwd, {}, () => {})
    expect(summary?.total).toBe(4)
    const root = shadowRoot(cwd)
    const manifestBefore = fs.readFileSync(path.join(root, PV_MANIFEST_NAME), "utf-8")

    // Same DERIVATION blob + stub transport as corpus-replay.test.ts — zero
    // real model calls; runDerive is the real, unmodified §6c deriver.
    const srv = stubServerFor({
      goalSummary: "g",
      class: "C",
      criteria: ["c1"],
      check: "test -f src/auth.ts",
      confidence: 0.9,
    })
    const deriveSummary = await withSdkStub(srv, () =>
      runDerive(root, summary!.total, (m) => void m),
    )

    // The cost fence accepted go === sample size (R1: the shadow's pending
    // set IS the sample) and every reset record derived.
    expect(deriveSummary).toEqual({ pending: 4, derived: 4, staysMined: 0 })
    const after = readCorpus(root)
    expect(after.length).toBe(4)
    expect(after.every((r) => r.stage === "derived")).toBe(true)
    expect(after.every((r) => r.derivation?.transport === "sdk")).toBe(true)
    // the manifest is not the deriver's to touch — byte-identical.
    expect(fs.readFileSync(path.join(root, PV_MANIFEST_NAME), "utf-8")).toBe(manifestBefore)
  })
})

describe("parsePvSampleArgs", () => {
  test("positional cwd + --reset flag; defaults to process.cwd() and reset:false", () => {
    expect(parsePvSampleArgs(["/some/dir", "--reset"])).toEqual({ cwd: "/some/dir", reset: true })
    expect(parsePvSampleArgs(["--reset"])).toEqual({ cwd: process.cwd(), reset: true })
    expect(parsePvSampleArgs([])).toEqual({ cwd: process.cwd(), reset: false })
  })
})
