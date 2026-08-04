import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  runPvSample,
  parsePvSampleArgs,
  isCliDerived,
  derivedOn,
  stratify,
  shadowRoot,
  SHADOW_DIR_REL,
  PV_MANIFEST_NAME,
  runPvCompare,
  parsePvCompareArgs,
  comparePvRecords,
  evaluatePvBar,
  missedCCap,
  combinePvCounts,
  parsePvCountsFile,
  parsePairFlag,
  PV_COUNTS_NAME,
  PV_COMBINED_NAME,
  PV_AGREEMENT_MIN,
  type PvManifest,
  type PvCounts,
  type PvCountsFile,
  type PvCombinedFile,
  type PvSetKeys,
  type PvPairing,
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
import type { GaugeTransport } from "../src/types.ts"
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

  // Fix-wave finding 8: manifest.arms is OPTIONAL provenance stamped from
  // the active pairing — on a non-default (sdk baseline, agent-sdk shadow)
  // run it must carry that pairing, not the absent-means-cli:sdk default.
  test("a non-default pairing (sdk baseline, agent-sdk shadow) stamps manifest.arms accordingly", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "sdk"), ...notCRecs(2, "sdk")], () => {})

    const summary = runPvSample(cwd, {}, () => {}, undefined, derivedOn("sdk"), "sdk", "agent-sdk")
    expect(summary).toBeDefined()

    const manifest = readManifest(cwd)
    expect(manifest.arms).toEqual({ baseline: "sdk", shadow: "agent-sdk" })
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

// ── T2: pv-compare ───────────────────────────────────────────────────────

/** Fabricated PvCounts — zero everywhere, override per test. Pure-function
 * tests only; store-level tests derive counts from real fixtures below. */
function counts(over: Partial<PvCounts> = {}): PvCounts {
  return {
    cCli: 0,
    cSdk: 0,
    intersection: 0,
    union: 0,
    missedC: 0,
    sdkOnlyC: 0,
    decided: 0,
    undecided: 0,
    missing: 0,
    wrongTransport: 0,
    ...over,
  }
}

/** One manifest key's fixture spec for buildPvFixture. */
interface PvCase {
  sha: string
  /** manifest stratum this key is registered under */
  stratum: "c" | "notC"
  /** real-store CLI arm class; undefined = key ABSENT from the real store */
  cli?: "C" | "B"
  /** shadow arm: a class = SDK-derived; "mined" = shadow derive failed/not
   * run (still stage "mined"); undefined = key ABSENT from the shadow store */
  sdk?: "C" | "B" | "mined"
  /** real arm's transport (default "cli") — "sdk" fails isCliDerived.
   * Widened to the full `GaugeTransport` (§6d) so fixtures can build a
   * non-default-pairing baseline (e.g. "sdk") — existing callers only ever
   * pass "cli"/"sdk"/undefined, so this is purely additive. */
  cliTransport?: GaugeTransport
  /** shadow arm's transport (default "sdk") — "cli"/"absent" = wrong
   * transport under the §6c default pairing; widened to `GaugeTransport`
   * (§6d) so fixtures can build a non-default shadow transport (e.g.
   * "agent-sdk") — purely additive over the existing "cli"/"sdk"/"absent"
   * callers. */
  shadowTransport?: GaugeTransport | "absent"
}

function keyOf(sha: string): string {
  return recordKey(rec({ promptSha256: sha }))
}

/** Fabricate real store + shadow store + manifest directly (no pv-sample) so
 * every per-key arm outcome is controlled. `extra` records land in a store
 * WITHOUT a manifest entry — the manifest-driven join must ignore them. */
function buildPvFixture(
  cwd: string,
  cases: PvCase[],
  extra: { real?: CorpusRecord[]; shadow?: CorpusRecord[] } = {},
): void {
  const real: CorpusRecord[] = [...(extra.real ?? [])]
  const shadow: CorpusRecord[] = [...(extra.shadow ?? [])]
  for (const cs of cases) {
    if (cs.cli !== undefined) {
      real.push(
        rec({
          promptSha256: cs.sha,
          derivation: gauge({ class: cs.cli, transport: cs.cliTransport ?? "cli" }),
        }),
      )
    }
    if (cs.sdk === "mined") {
      shadow.push(rec({ promptSha256: cs.sha, stage: "mined", derivation: undefined }))
    } else if (cs.sdk !== undefined) {
      const t = cs.shadowTransport ?? "sdk"
      shadow.push(
        rec({
          promptSha256: cs.sha,
          derivation: gauge({ class: cs.sdk, ...(t !== "absent" ? { transport: t } : {}) }),
        }),
      )
    }
  }
  const root = shadowRoot(cwd)
  writeCorpus(cwd, real, () => {})
  writeCorpus(root, shadow, () => {})
  const inStratum = (s: PvCase["stratum"]) => cases.filter((c) => c.stratum === s)
  const manifest: PvManifest = {
    sampledAt: new Date().toISOString(),
    hostname: os.hostname(),
    cCount: inStratum("c").length,
    notCCount: inStratum("notC").length,
    keys: { c: inStratum("c").map((c) => keyOf(c.sha)), notC: inStratum("notC").map((c) => keyOf(c.sha)) },
  }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, PV_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")
}

function readPvCounts(cwd: string): PvCountsFile {
  const raw = fs.readFileSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME), "utf-8")
  return JSON.parse(raw) as PvCountsFile
}

/** A well-formed other-host pv-counts.json body for --combine tests. */
function otherHostFile(c: PvCounts, keysOver: Partial<PvSetKeys> = {}): PvCountsFile {
  return {
    comparedAt: "2026-08-03T00:00:00.000Z",
    hostname: "other-host",
    counts: c,
    keys: {
      cCli: [],
      cSdk: [],
      intersection: [],
      missedC: [],
      sdkOnlyC: [],
      undecided: [],
      missing: [],
      wrongTransport: [],
      ...keysOver,
    },
    bar: evaluatePvBar(c),
  }
}

describe("missedCCap — spec ceil arithmetic incl. float edges", () => {
  test("|C_cli|=13 -> cap 2; |C_cli|=10 -> cap 1 (never 2 via float noise)", () => {
    expect(missedCCap(13)).toBe(2)
    expect(missedCCap(10)).toBe(1)
  })

  test("more edges: 0 -> 0, 1 -> 1, 20 -> 2, 30 -> 3", () => {
    expect(missedCCap(0)).toBe(0)
    expect(missedCCap(1)).toBe(1)
    expect(missedCCap(20)).toBe(2)
    expect(missedCCap(30)).toBe(3)
  })
})

describe("evaluatePvBar — verdict paths (pure)", () => {
  test("both clauses pass -> POOLING-PERMITTED (incl. exact >=0.80 and ==cap boundaries)", () => {
    // agreement exactly 4/5 = 0.80 (>= passes) and missedC exactly == cap.
    const c = counts({ cCli: 5, cSdk: 4, intersection: 4, union: 5, missedC: 1, decided: 10 })
    const bar = evaluatePvBar(c)
    expect(bar.verdict).toBe("POOLING-PERMITTED")
    expect(bar.agreement).toBeCloseTo(0.8)
    expect(bar.agreementOk).toBe(true)
    expect(bar.missedCap).toBe(1)
    expect(bar.missedOk).toBe(true)
  })

  test("agreement fails, missed-C holds -> SPLIT", () => {
    // 10/15 = 0.667 < 0.80; missedC 0 <= ceil(1.0) = 1.
    const c = counts({ cCli: 10, cSdk: 15, intersection: 10, union: 15, missedC: 0, sdkOnlyC: 5, decided: 20 })
    const bar = evaluatePvBar(c)
    expect(bar.verdict).toBe("SPLIT")
    expect(bar.agreementOk).toBe(false)
    expect(bar.missedOk).toBe(true)
  })

  test("agreement holds, missed-C fails -> SPLIT", () => {
    // 17/20 = 0.85 >= 0.80; missedC 3 > ceil(2.0) = 2.
    const c = counts({ cCli: 20, cSdk: 17, intersection: 17, union: 20, missedC: 3, decided: 40 })
    const bar = evaluatePvBar(c)
    expect(bar.verdict).toBe("SPLIT")
    expect(bar.agreementOk).toBe(true)
    expect(bar.missedCap).toBe(2)
    expect(bar.missedOk).toBe(false)
  })

  test("both fail -> SPLIT (the spec's own 13-slice expectation: 7/13 ~ 54%)", () => {
    const c = counts({ cCli: 13, cSdk: 7, intersection: 7, union: 13, missedC: 6, decided: 26 })
    const bar = evaluatePvBar(c)
    expect(bar.verdict).toBe("SPLIT")
    expect(bar.agreement).toBeCloseTo(7 / 13)
    expect(bar.agreementOk).toBe(false)
    expect(bar.missedOk).toBe(false)
  })

  test("undecided > 0 -> NOT-EVALUATED (no clause is computed)", () => {
    const c = counts({ cCli: 13, cSdk: 13, intersection: 13, union: 13, decided: 25, undecided: 1 })
    const bar = evaluatePvBar(c)
    expect(bar.verdict).toBe("NOT-EVALUATED")
    expect(bar.agreement).toBeNull()
    expect(bar.reason).toContain("fully derived")
  })

  test("missing > 0 -> NOT-EVALUATED too", () => {
    const c = counts({ cCli: 13, cSdk: 13, intersection: 13, union: 13, decided: 25, missing: 2 })
    expect(evaluatePvBar(c).verdict).toBe("NOT-EVALUATED")
  })

  test("empty-C vacuous: union == 0 -> NOT-EVALUATED, explicit 'no C in either arm' (never divide-by-zero, never auto-pass)", () => {
    const bar = evaluatePvBar(counts({ decided: 6 }))
    expect(bar.verdict).toBe("NOT-EVALUATED")
    expect(bar.agreement).toBeNull()
    expect(bar.reason).toContain("no C in either arm")
  })
})

describe("comparePvRecords / runPvCompare — manifest-driven join", () => {
  test("full join: per-arm classes from the right store, all six C-set counts", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" }, // intersection
      { sha: "s2", stratum: "c", cli: "C", sdk: "B" }, // missed-C
      { sha: "s3", stratum: "notC", cli: "B", sdk: "C" }, // sdk-only-C
      { sha: "s4", stratum: "notC", cli: "B", sdk: "B" }, // C in neither
    ])

    const summary = runPvCompare(cwd, {}, () => {})

    expect(summary?.counts).toEqual({
      cCli: 2,
      cSdk: 2,
      intersection: 1,
      union: 3,
      missedC: 1,
      sdkOnlyC: 1,
      decided: 4,
      undecided: 0,
      missing: 0,
      wrongTransport: 0,
    })
    // 1/3 < 0.80 -> agreement fails; missedC 1 <= ceil(0.2) = 1 holds.
    expect(summary?.bar.verdict).toBe("SPLIT")
    const file = readPvCounts(cwd)
    expect(file.keys.intersection).toEqual([keyOf("s1")])
    expect(file.keys.missedC).toEqual([keyOf("s2")])
    expect(file.keys.sdkOnlyC).toEqual([keyOf("s3")])
  })

  test("undecided vs missing are distinguished, counted, and never silently dropped", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" }, // decided
      { sha: "s2", stratum: "c", cli: "C", sdk: "mined" }, // undecided (shadow derive failed)
      { sha: "s3", stratum: "notC", cli: "B" }, // missing (absent from shadow store)
      { sha: "s4", stratum: "notC", sdk: "B" }, // missing (absent from real store)
    ])

    const logs: string[] = []
    const summary = runPvCompare(cwd, {}, (m) => logs.push(m))

    expect(summary?.counts.decided).toBe(1)
    expect(summary?.counts.undecided).toBe(1)
    expect(summary?.counts.missing).toBe(2)
    // undecided/missing exclude the record from BOTH strata...
    expect(summary?.counts.cCli).toBe(1)
    // ...and block the bar until the sample is fully derived.
    expect(summary?.bar.verdict).toBe("NOT-EVALUATED")
    expect(logs.join("\n")).toContain("fully derived")
    const file = readPvCounts(cwd)
    expect(file.keys.undecided).toEqual([keyOf("s2")])
    expect(file.keys.missing.sort()).toEqual([keyOf("s3"), keyOf("s4")].sort())
  })

  test("records NOT in the manifest are ignored in both stores (R3: the join is manifest-driven)", () => {
    const cwd = mkRepo()
    buildPvFixture(
      cwd,
      [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }],
      {
        // class-C records in each store with NO manifest entry — would flip
        // every count if the join drifted off the manifest.
        real: [rec({ promptSha256: "stray-real", derivation: gauge({ class: "C", transport: "cli" }) })],
        shadow: [rec({ promptSha256: "stray-shadow", derivation: gauge({ class: "C", transport: "sdk" }) })],
      },
    )

    const summary = runPvCompare(cwd, {}, () => {})

    expect(summary?.counts).toEqual(
      counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 1 }),
    )
    expect(summary?.bar.verdict).toBe("POOLING-PERMITTED")
    const raw = fs.readFileSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME), "utf-8")
    expect(raw.includes("stray-real")).toBe(false)
    expect(raw.includes("stray-shadow")).toBe(false)
  })

  test("empty-C vacuous case through the full command: reported, never a divide-by-zero pass", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "notC", cli: "B", sdk: "B" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "B" },
    ])

    const logs: string[] = []
    const summary = runPvCompare(cwd, {}, (m) => logs.push(m))

    expect(summary?.bar.verdict).toBe("NOT-EVALUATED")
    expect(logs.join("\n")).toContain("no C in either arm")
  })

  test("no manifest -> refuses (run pv-sample first), nothing written", () => {
    const cwd = mkRepo()
    writeCorpus(cwd, [...cRecs(2, "cli")], () => {})

    const logs: string[] = []
    expect(runPvCompare(cwd, {}, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("pv-sample"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })
})

describe("runPvCompare — read-only on both stores; pv-counts.json is keys-only (R5/F2)", () => {
  test("both records.ndjson byte-identical after pv-compare; no locks left; counts file has keys but no prompt text", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "B" },
    ])
    const realFile = path.join(cwd, CORPUS_FILE_REL)
    const shadowFile = path.join(shadowRoot(cwd), CORPUS_FILE_REL)
    const realBefore = fs.readFileSync(realFile)
    const shadowBefore = fs.readFileSync(shadowFile)

    expect(runPvCompare(cwd, {}, () => {})).toBeDefined()

    expect(fs.readFileSync(realFile).equals(realBefore)).toBe(true)
    expect(fs.readFileSync(shadowFile).equals(shadowBefore)).toBe(true)
    // pure read path: no lock artifact may remain in EITHER store dir.
    expect(fs.existsSync(path.join(cwd, CORPUS_DIR_REL, ".lock"))).toBe(false)
    expect(fs.existsSync(path.join(shadowRoot(cwd), CORPUS_DIR_REL, ".lock"))).toBe(false)

    const file = readPvCounts(cwd)
    expect(file.hostname).toBe(os.hostname())
    expect(Number.isNaN(Date.parse(file.comparedAt))).toBe(false)
    expect(file.keys.cCli).toEqual([keyOf("s1")])
    expect(file.bar.verdict).toBe("POOLING-PERMITTED")
    const raw = fs.readFileSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME), "utf-8")
    expect(raw.includes("fix the thing")).toBe(false)
  })
})

describe("runPvCompare --combine", () => {
  test("sums the two hosts' counts and evaluates the bar on the combined sample", () => {
    const cwd = mkRepo()
    // Local: 2 C, both agreed -> local POOLING-PERMITTED on its own.
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s3", stratum: "notC", cli: "B", sdk: "B" },
      { sha: "s4", stratum: "notC", cli: "B", sdk: "B" },
    ])
    // Other host: 8 C_cli, 1 missed -> combined 9/10 agreement, cap ceil(1.0)=1.
    const other = otherHostFile(
      counts({ cCli: 8, cSdk: 7, intersection: 7, union: 8, missedC: 1, decided: 16 }),
    )
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(other, null, 2))

    const logs: string[] = []
    const summary = runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))

    expect(summary?.bar.verdict).toBe("POOLING-PERMITTED")
    expect(summary?.combined?.counts).toEqual(
      counts({ cCli: 10, cSdk: 9, intersection: 9, union: 10, missedC: 1, decided: 20 }),
    )
    // combined: 9/10 = 0.90 >= 0.80; missedC 1 <= ceil(0.10 x 10) = 1.
    expect(summary?.combined?.bar.verdict).toBe("POOLING-PERMITTED")
    expect(summary?.combined?.bar.missedCap).toBe(1)
    const text = logs.join("\n")
    expect(text).toContain("other-host")
    expect(text).toContain("combined")

    // FIX 5: the cross-host decision is persisted, not stdout-only.
    const combinedFile = JSON.parse(
      fs.readFileSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME), "utf-8"),
    ) as PvCombinedFile
    expect(combinedFile.local.hostname).toBe(os.hostname())
    expect(combinedFile.other.hostname).toBe("other-host")
    expect(combinedFile.other.counts).toEqual(other.counts)
    expect(combinedFile.combined.counts).toEqual(summary!.combined!.counts)
    expect(combinedFile.combined.bar.verdict).toBe("POOLING-PERMITTED")
    expect(Number.isNaN(Date.parse(combinedFile.comparedAt))).toBe(false)
  })

  test("plain run (no --combine) never writes pv-combined.json", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])

    expect(runPvCompare(cwd, {}, () => {})).toBeDefined()
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME))).toBe(false)
  })

  test("combined counts can fail the bar even when a host passes alone", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "B" },
    ])
    // Other host at the spec's 13-slice: 7/13 agreement, 6 missed.
    const other = otherHostFile(
      counts({ cCli: 13, cSdk: 7, intersection: 7, union: 13, missedC: 6, decided: 26 }),
    )
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const summary = runPvCompare(cwd, { combine: otherPath }, () => {})

    expect(summary?.bar.verdict).toBe("POOLING-PERMITTED")
    // combined 8/14 = 0.571 < 0.80; missedC 6 > ceil(1.4) = 2 -> SPLIT.
    expect(summary?.combined?.counts.union).toBe(14)
    expect(summary?.combined?.bar.verdict).toBe("SPLIT")
  })

  test("combined undecided/missing > 0 -> combined bar NOT-EVALUATED", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "B" },
    ])
    const other = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 9, undecided: 1 }),
    )
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const summary = runPvCompare(cwd, { combine: otherPath }, () => {})
    expect(summary?.combined?.bar.verdict).toBe("NOT-EVALUATED")
  })

  test("malformed other file (missing count field) -> refused, and NOTHING is written (validate-first)", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])
    const bad = otherHostFile(counts({ cCli: 5 })) as unknown as Record<string, unknown>
    delete (bad.counts as Record<string, unknown>).union
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(bad))

    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })

  test("unreadable --combine path -> refused with zero writes", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])

    expect(runPvCompare(cwd, { combine: path.join(cwd, "nope.json") }, () => {})).toBeUndefined()
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })

  test("--combine with no value parses as \"\" and hits the cannot-read refusal", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])

    expect(parsePvCompareArgs(["--combine"])).toEqual({ cwd: process.cwd(), combine: "" })
    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: "" }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("cannot read"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })

  test("REGRESSION (reviewer repro 1): a negative undecided in the other file cannot cancel a local undecided into POOLING-PERMITTED", () => {
    const cwd = mkRepo()
    // Local sample has ONE undecided record -> local bar NOT-EVALUATED.
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "mined" },
    ])
    const other = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 }),
    ) as unknown as { counts: Record<string, unknown> }
    other.counts.undecided = -1 // would sum local's 1 undecided down to 0
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME))).toBe(false)
  })

  test("REGRESSION (reviewer repro 2): --combine with a file from THIS host (self-combine) refuses", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])
    const selfFile = {
      ...otherHostFile(counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 })),
      hostname: os.hostname(),
    }
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(selfFile))

    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("THIS host"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })

  test("key overlap between the other file's sets and the local sample refuses (disjointness verified, not assumed)", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])
    // Other host reports OUR s1 key as one of its C_cli members.
    const other = otherHostFile(
      counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 }),
      { cCli: [keyOf("s1")] },
    )
    const otherPath = path.join(cwd, "other-pv-counts.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("disjoint"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME))).toBe(false)
  })
})

describe("comparePvRecords — wrong-transport arms (reviewer repro 3)", () => {
  test("a shadow derivation not on SDK, or a real record no longer CLI-derived, lands in wrongTransport and blocks the bar", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" }, // healthy pair
      // Stale pre-boundary checkout derived the shadow on CLI: agreement
      // would be trivially CLI-vs-CLI — must NOT count as decided.
      { sha: "s2", stratum: "c", cli: "C", sdk: "C", shadowTransport: "cli" },
      // Shadow derivation with transport ABSENT is pre-boundary CLI too.
      { sha: "s3", stratum: "notC", cli: "B", sdk: "B", shadowTransport: "absent" },
      // Real record re-derived on SDK: its CLI arm no longer exists.
      { sha: "s4", stratum: "notC", cli: "B", sdk: "B", cliTransport: "sdk" },
    ])

    const logs: string[] = []
    const summary = runPvCompare(cwd, {}, (m) => logs.push(m))

    expect(summary?.counts.decided).toBe(1)
    expect(summary?.counts.wrongTransport).toBe(3)
    // wrong-transport pairs are excluded from every C set...
    expect(summary?.counts.cCli).toBe(1)
    expect(summary?.counts.cSdk).toBe(1)
    // ...and block the bar exactly like undecided/missing.
    expect(summary?.bar.verdict).toBe("NOT-EVALUATED")
    expect(summary?.bar.reason).toContain("wrong-transport")
    const text = logs.join("\n")
    expect(text).toContain("wrong-transport 3")
    const file = readPvCounts(cwd)
    expect(file.counts.wrongTransport).toBe(3)
    expect(file.keys.wrongTransport.sort()).toEqual([keyOf("s2"), keyOf("s3"), keyOf("s4")].sort())
  })
})

// ── §6d fix round 1: non-default-pairing coverage ───────────────────────
//
// Every test above drives `runPvCompare`/`comparePvRecords` with `{}`/no
// `pairing` argument — exercising only `PV_DEFAULT_PAIRING` (cli-vs-sdk).
// This is exactly the path two prior reviews already got wrong for: an
// `agent-sdk` shadow run under the §6c default pairing lands EVERY record in
// `wrongTransport` (the shadow's transport is never "sdk"), so the tests
// below pin that a NON-default pairing (sdk baseline, agent-sdk shadow)
// actually decides matching arms instead.
const sdkAgentSdkPairing: PvPairing = {
  baseline: derivedOn("sdk"),
  baselineLabel: "sdk",
  shadowTransport: "agent-sdk",
}

describe("comparePvRecords — non-default pairing (sdk baseline, agent-sdk shadow)", () => {
  test("sdk-derived real + agent-sdk-derived shadow -> decided, not wrongTransport", () => {
    const real = [rec({ promptSha256: "nd1", derivation: gauge({ class: "C", transport: "sdk" }) })]
    const shadow = [rec({ promptSha256: "nd1", derivation: gauge({ class: "C", transport: "agent-sdk" }) })]
    const manifest: PvManifest = {
      sampledAt: "2026-08-04T00:00:00.000Z",
      hostname: "h",
      cCount: 1,
      notCCount: 0,
      keys: { c: [keyOf("nd1")], notC: [] },
    }
    const result = comparePvRecords(manifest, real, shadow, sdkAgentSdkPairing)
    expect(result.counts.decided).toBe(1)
    expect(result.counts.wrongTransport).toBe(0)
    expect(result.counts.cCli).toBe(1)
    expect(result.counts.cSdk).toBe(1)
    expect(result.counts.intersection).toBe(1)
  })

  test("shadow derived on the wrong transport (plain sdk, not agent-sdk) -> wrongTransport under the custom pairing", () => {
    const real = [rec({ promptSha256: "nd2", derivation: gauge({ class: "C", transport: "sdk" }) })]
    const shadow = [rec({ promptSha256: "nd2", derivation: gauge({ class: "C", transport: "sdk" }) })]
    const manifest: PvManifest = {
      sampledAt: "2026-08-04T00:00:00.000Z",
      hostname: "h",
      cCount: 1,
      notCCount: 0,
      keys: { c: [keyOf("nd2")], notC: [] },
    }
    const result = comparePvRecords(manifest, real, shadow, sdkAgentSdkPairing)
    expect(result.counts.wrongTransport).toBe(1)
    expect(result.counts.decided).toBe(0)
  })

  test("real record from the wrong baseline (cli, not sdk) -> wrongTransport under the custom pairing", () => {
    const real = [rec({ promptSha256: "nd3", derivation: gauge({ class: "C", transport: "cli" }) })]
    const shadow = [rec({ promptSha256: "nd3", derivation: gauge({ class: "C", transport: "agent-sdk" }) })]
    const manifest: PvManifest = {
      sampledAt: "2026-08-04T00:00:00.000Z",
      hostname: "h",
      cCount: 1,
      notCCount: 0,
      keys: { c: [keyOf("nd3")], notC: [] },
    }
    const result = comparePvRecords(manifest, real, shadow, sdkAgentSdkPairing)
    expect(result.counts.wrongTransport).toBe(1)
    expect(result.counts.decided).toBe(0)
  })
})

describe("runPvCompare — non-default pairing end-to-end (sdk baseline, agent-sdk shadow)", () => {
  test("opts.pairing decides matching sdk/agent-sdk arms, blocks on a stale-transport arm, and writes arms into pv-counts.json", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "e1", stratum: "c", cli: "C", cliTransport: "sdk", sdk: "C", shadowTransport: "agent-sdk" },
      { sha: "e2", stratum: "notC", cli: "B", cliTransport: "sdk", sdk: "B", shadowTransport: "agent-sdk" },
      // Stale shadow derived on plain "sdk" (not "agent-sdk") — must NOT be
      // silently decided under this pairing: the guaranteed-NOT-EVALUATED
      // failure this task exists to prevent, in the opposite direction (a
      // real sdk:agent-sdk shadow run that accidentally used the wrong
      // transport must still be caught, not waved through).
      { sha: "e3", stratum: "notC", cli: "B", cliTransport: "sdk", sdk: "B", shadowTransport: "sdk" },
    ])

    const logs: string[] = []
    const summary = runPvCompare(cwd, { pairing: sdkAgentSdkPairing }, (m) => logs.push(m))

    expect(summary?.counts.decided).toBe(2)
    expect(summary?.counts.wrongTransport).toBe(1)
    expect(summary?.counts.cCli).toBe(1)
    expect(summary?.counts.cSdk).toBe(1)
    // e3's wrong-transport arm still blocks the bar, exactly like the §6c default pairing.
    expect(summary?.bar.verdict).toBe("NOT-EVALUATED")

    const file = readPvCounts(cwd)
    expect(file.arms).toEqual({ baseline: "sdk", shadow: "agent-sdk" })
    const text = logs.join("\n")
    expect(text).toContain("sdk-vs-agent-sdk transport comparison")
  })
})

describe("runPvCompare — duplicate keys refuse (never silent last-wins)", () => {
  test("duplicate key in the manifest (across strata) refuses with zero writes", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "s1", stratum: "c", cli: "C", sdk: "C" },
      { sha: "s2", stratum: "notC", cli: "B", sdk: "B" },
    ])
    // Corrupt the manifest: s1 appears in BOTH strata.
    const manifestPath = path.join(shadowRoot(cwd), PV_MANIFEST_NAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PvManifest
    manifest.keys.notC.push(keyOf("s1"))
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const logs: string[] = []
    expect(runPvCompare(cwd, {}, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("duplicate"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COUNTS_NAME))).toBe(false)
  })

  test("duplicate record key WITHIN a store (real or shadow) refuses", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])
    // Append a second record with the SAME key to the real store's ndjson —
    // the Map join would silently pick one of the two.
    const dupLine =
      JSON.stringify(rec({ promptSha256: "s1", derivation: gauge({ class: "B", transport: "cli" }) })) + "\n"
    fs.appendFileSync(path.join(cwd, CORPUS_FILE_REL), dupLine)

    const logs: string[] = []
    expect(runPvCompare(cwd, {}, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("REAL store"))).toBe(true)

    // Same for the shadow store, on a fresh fixture.
    const cwd2 = mkRepo()
    buildPvFixture(cwd2, [{ sha: "s1", stratum: "c", cli: "C", sdk: "C" }])
    const dupShadow =
      JSON.stringify(rec({ promptSha256: "s1", derivation: gauge({ class: "B", transport: "sdk" }) })) + "\n"
    fs.appendFileSync(path.join(shadowRoot(cwd2), CORPUS_FILE_REL), dupShadow)

    const logs2: string[] = []
    expect(runPvCompare(cwd2, {}, (m) => logs2.push(m))).toBeUndefined()
    expect(logs2.some((l) => l.includes("REFUSING") && l.includes("shadow store"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd2), PV_COUNTS_NAME))).toBe(false)
  })
})

describe("parsePvCountsFile — shape validation for --combine", () => {
  test("accepts our own written shape; refuses missing/non-numeric counts, missing hostname, non-JSON", () => {
    const good = otherHostFile(counts({ cCli: 3, cSdk: 3, intersection: 3, union: 3, decided: 6 }))
    expect(parsePvCountsFile(JSON.stringify(good))?.counts.cCli).toBe(3)

    const noHost = { ...good } as Record<string, unknown>
    delete noHost.hostname
    expect(parsePvCountsFile(JSON.stringify(noHost))).toBeUndefined()

    const badCount = otherHostFile(counts()) as unknown as { counts: Record<string, unknown> }
    badCount.counts.missedC = "2"
    expect(parsePvCountsFile(JSON.stringify(badCount))).toBeUndefined()

    expect(parsePvCountsFile("not json")).toBeUndefined()
    expect(parsePvCountsFile("null")).toBeUndefined()
  })

  test("negative and non-integer counts refused", () => {
    const negative = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 }),
    ) as unknown as { counts: Record<string, unknown> }
    negative.counts.undecided = -1
    expect(parsePvCountsFile(JSON.stringify(negative))).toBeUndefined()

    const nonInteger = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 }),
    ) as unknown as { counts: Record<string, unknown> }
    nonInteger.counts.missedC = 1.5
    expect(parsePvCountsFile(JSON.stringify(nonInteger))).toBeUndefined()
  })

  test("internally inconsistent counts refused (set identities checked, not just types)", () => {
    // union !== cCli + sdkOnlyC
    expect(
      parsePvCountsFile(
        JSON.stringify(otherHostFile(counts({ cCli: 5, cSdk: 5, intersection: 5, union: 6, decided: 10 }))),
      ),
    ).toBeUndefined()
    // missedC !== cCli - intersection
    expect(
      parsePvCountsFile(
        JSON.stringify(
          otherHostFile(counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, missedC: 1, decided: 10 })),
        ),
      ),
    ).toBeUndefined()
    // intersection > cSdk
    expect(
      parsePvCountsFile(
        JSON.stringify(
          otherHostFile(counts({ cCli: 5, cSdk: 4, intersection: 5, union: 5, decided: 10 })),
        ),
      ),
    ).toBeUndefined()
  })

  test("missing keys sets refused (the overlap check needs them)", () => {
    const noKeys = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 }),
    ) as unknown as Record<string, unknown>
    delete noKeys.keys
    expect(parsePvCountsFile(JSON.stringify(noKeys))).toBeUndefined()

    const badKeySet = otherHostFile(
      counts({ cCli: 5, cSdk: 5, intersection: 5, union: 5, decided: 10 }),
    ) as unknown as { keys: Record<string, unknown> }
    badKeySet.keys.missedC = [42]
    expect(parsePvCountsFile(JSON.stringify(badKeySet))).toBeUndefined()
  })
})

describe("combinePvCounts", () => {
  test("field-wise sum over all nine counts", () => {
    const a = counts({ cCli: 2, cSdk: 3, intersection: 1, union: 4, missedC: 1, sdkOnlyC: 2, decided: 5, undecided: 1, missing: 1 })
    const b = counts({ cCli: 13, cSdk: 7, intersection: 7, union: 13, missedC: 6, sdkOnlyC: 0, decided: 26, undecided: 0, missing: 2 })
    expect(combinePvCounts(a, b)).toEqual(
      counts({ cCli: 15, cSdk: 10, intersection: 8, union: 17, missedC: 7, sdkOnlyC: 2, decided: 31, undecided: 1, missing: 3 }),
    )
  })
})

describe("pv-sample -> derive (stubbed) -> pv-compare — end-to-end", () => {
  test("full pipeline yields a coherent comparison", async () => {
    const cwd = mkRepo()
    // Prompt must name the stub check's path token (src/auth.ts) or
    // validateDerivation downgrades the SDK arm's C to D (path-not-in-prompt)
    // — the e2e wants the always-C stub to actually LAND class C.
    const prompt = "please fix src/auth.ts now"
    const store = [
      ...cRecs(2, "cli").map((r) => ({ ...r, prompt })),
      ...notCRecs(3).map((r) => ({ ...r, prompt })),
    ]
    writeCorpus(cwd, store, () => {})

    const sample = runPvSample(cwd, {}, () => {})
    expect(sample).toEqual({ cCount: 2, notCCount: 2, total: 4 })
    const root = shadowRoot(cwd)

    const srv = stubServerFor({
      goalSummary: "g",
      class: "C",
      criteria: ["c1"],
      check: "test -f src/auth.ts",
      confidence: 0.9,
    })
    const deriveSummary = await withSdkStub(srv, () => runDerive(root, sample!.total, () => {}))
    expect(deriveSummary).toEqual({ pending: 4, derived: 4, staysMined: 0 })

    const logs: string[] = []
    const summary = runPvCompare(cwd, {}, (m) => logs.push(m))

    // SDK stub calls EVERYTHING C: C_sdk = whole sample, so intersection =
    // C_cli (2), union = 4, missed 0, sdk-only = the 2 not-C draws.
    expect(summary?.counts).toEqual(
      counts({ cCli: 2, cSdk: 4, intersection: 2, union: 4, sdkOnlyC: 2, decided: 4 }),
    )
    // agreement 2/4 = 0.5 < 0.80 -> SPLIT (missed-C clause holds: 0 <= 1).
    expect(summary?.bar.verdict).toBe("SPLIT")
    expect(summary?.bar.agreementOk).toBe(false)
    expect(summary?.bar.missedOk).toBe(true)
    const text = logs.join("\n")
    expect(text).toContain(`${PV_AGREEMENT_MIN}`)
    expect(text).toContain("SPLIT")
    expect(readPvCounts(cwd).counts.union).toBe(4)
  })
})

describe("parsePvCompareArgs", () => {
  test("positional cwd + --combine <path>; defaults to process.cwd() and no combine", () => {
    expect(parsePvCompareArgs(["/some/dir", "--combine", "/x/pv-counts.json"])).toEqual({
      cwd: "/some/dir",
      combine: "/x/pv-counts.json",
    })
    expect(parsePvCompareArgs([])).toEqual({ cwd: process.cwd(), combine: undefined })
    expect(parsePvCompareArgs(["--combine", "/x/c.json"])).toEqual({ cwd: process.cwd(), combine: "/x/c.json" })
  })
})

// ── §6d: pv pairing parameterization (Task 6) ───────────────────────────
//
// `pairRec` is a minimal record literal distinct from the file-level `rec`
// above (which needs a full derivation shape via `gauge()`) — these tests
// only care about transport/class/prompt, so a smaller shape (cast `as
// never`, this file's established pattern for test-only shortcuts) keeps
// them terse. Named `pairRec` rather than `rec` to avoid shadowing the
// existing top-level `rec` helper used throughout this file.
const pairRec = (transport: string | undefined, cls: string, prompt: string) =>
  ({ prompt, stage: "derived", derivation: { class: cls, ...(transport ? { transport } : {}) } }) as never

describe("derivedOn (§6d pairing predicate)", () => {
  test("reads derivation.transport, not a top-level field", () => {
    expect(derivedOn("sdk")(pairRec("sdk", "C", "p1"))).toBe(true)
    expect(derivedOn("sdk")(pairRec("agent-sdk", "C", "p2"))).toBe(false)
    expect(derivedOn("sdk")(pairRec(undefined, "C", "p3"))).toBe(false)
    expect(derivedOn("agent-sdk")(pairRec("agent-sdk", "C", "p4"))).toBe(true)
  })
})

describe("stratify with an injected baseline predicate", () => {
  test("defaults to the §6c CLI baseline (unchanged behaviour)", () => {
    const s = stratify([pairRec("cli", "C", "a"), pairRec("sdk", "C", "b")])
    expect(s.c.length).toBe(1)
  })
  test("can stratify the SDK arm instead", () => {
    const s = stratify([pairRec("cli", "C", "a"), pairRec("sdk", "C", "b")], derivedOn("sdk"))
    expect(s.c.length).toBe(1)
    expect(s.c[0]!.prompt).toBe("b")
  })
})

describe("isCliDerived — three-transport world (§6d Step 3a)", () => {
  test("an agent-sdk record is NOT CLI-derived", () => {
    expect(isCliDerived(rec({ derivation: gauge({ transport: "agent-sdk" }) }))).toBe(false)
  })
  test("an agent-sdk-daemon record is NOT CLI-derived", () => {
    expect(isCliDerived(rec({ derivation: gauge({ transport: "agent-sdk-daemon" }) }))).toBe(false)
  })
})

// ── Task 7: `--pair <baseline>:<shadow>` CLI wiring ─────────────────────

describe("parsePairFlag", () => {
  test("parses a valid pair", () => {
    const p = parsePairFlag(["--pair", "sdk:agent-sdk"])!
    expect(p.shadowTransport).toBe("agent-sdk")
    expect(p.baseline({ derivation: { transport: "sdk", class: "C" } } as never)).toBe(true)
  })
  test("absent flag yields undefined (caller applies the §6c default)", () => {
    expect(parsePairFlag([])).toBeUndefined()
  })
  test("unknown transports and malformed input yield undefined, never a default", () => {
    expect(parsePairFlag(["--pair", "sdk:nonsense"])).toBeUndefined()
    expect(parsePairFlag(["--pair", "sdk"])).toBeUndefined()
    expect(parsePairFlag(["--pair", ""])).toBeUndefined()
  })
  test("'cli' baseline maps to isCliDerived, not a strict-equality predicate (absent-transport records still count)", () => {
    const p = parsePairFlag(["--pair", "cli:sdk"])!
    expect(p.baselineLabel).toBe("cli")
    // pre-boundary record: no transport field at all.
    expect(p.baseline({ derivation: { class: "C" } } as never)).toBe(true)
    expect(p.baseline({ derivation: { transport: "sdk", class: "C" } } as never)).toBe(false)
  })
  test("parsePairFlag accepts the §6e literal structurally", () => {
    const p = parsePairFlag(["--pair", "sdk:agent-sdk-daemon"])!
    expect(p.shadowTransport).toBe("agent-sdk-daemon")
    expect(p.baselineLabel).toBe("sdk")
  })
})

describe("parsePvCountsFile — arms (§7)", () => {
  test("absent arms defaults to {baseline:'cli', shadow:'sdk'} — never refused", () => {
    const file = otherHostFile(counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 }))
    const parsed = parsePvCountsFile(JSON.stringify(file))
    expect(parsed?.arms).toEqual({ baseline: "cli", shadow: "sdk" })
  })
  test("parses arms when present", () => {
    const file = {
      ...otherHostFile(counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 })),
      arms: { baseline: "sdk", shadow: "agent-sdk" },
    }
    const parsed = parsePvCountsFile(JSON.stringify(file))
    expect(parsed?.arms).toEqual({ baseline: "sdk", shadow: "agent-sdk" })
  })
  test("arms with an unknown transport value refuses", () => {
    const file = {
      ...otherHostFile(counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 })),
      arms: { baseline: "sdk", shadow: "bogus" },
    }
    expect(parsePvCountsFile(JSON.stringify(file))).toBeUndefined()
  })
  test("arms present but not an object refuses", () => {
    const file = {
      ...otherHostFile(counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 })),
      arms: "cli:sdk",
    }
    expect(parsePvCountsFile(JSON.stringify(file))).toBeUndefined()
  })
})

describe("runPvCompare --combine — effective-arms mismatch refuses (fail-closed, cls-combine hard-gate precedent)", () => {
  test("local default (cli:sdk) vs other host's explicit sdk:agent-sdk arms refuses, zero writes", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "arm1", stratum: "c", cli: "C", sdk: "C" }])
    const other = {
      ...otherHostFile(counts({ cCli: 1, cSdk: 1, intersection: 1, union: 1, decided: 2 })),
      hostname: "other-host",
      arms: { baseline: "sdk", shadow: "agent-sdk" },
    }
    const otherPath = path.join(cwd, "other.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const logs: string[] = []
    expect(runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && l.includes("arms"))).toBe(true)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME))).toBe(false)
  })

  test("matching effective arms (both sdk:agent-sdk) combine succeeds", () => {
    const cwd = mkRepo()
    buildPvFixture(cwd, [
      { sha: "arm2", stratum: "c", cli: "C", cliTransport: "sdk", sdk: "C", shadowTransport: "agent-sdk" },
    ])
    const other = {
      ...otherHostFile(counts({ cCli: 3, cSdk: 3, intersection: 3, union: 3, decided: 6 })),
      hostname: "other-host",
      arms: { baseline: "sdk", shadow: "agent-sdk" },
    }
    const otherPath = path.join(cwd, "other.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const logs: string[] = []
    const summary = runPvCompare(
      cwd,
      { combine: otherPath, pairing: sdkAgentSdkPairing },
      (m) => logs.push(m),
    )
    expect(summary?.combined?.counts.cCli).toBe(4)
    expect(fs.existsSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME))).toBe(true)

    // Fix-wave finding 8: pv-combined.json carries the active (non-default)
    // pairing as `arms`, not the absent-means-cli:sdk default.
    const combined = JSON.parse(
      fs.readFileSync(path.join(shadowRoot(cwd), PV_COMBINED_NAME), "utf-8"),
    ) as PvCombinedFile
    expect(combined.arms).toEqual({ baseline: "sdk", shadow: "agent-sdk" })
  })

  test("both sides at the (unstated) §6c default still combine — pre-existing behaviour unaffected", () => {
    // This is the pre-existing "sums the two hosts' counts" test's shape,
    // repeated here to pin that the new arms check does not regress the
    // default-vs-default (no `arms` field on either side) path.
    const cwd = mkRepo()
    buildPvFixture(cwd, [{ sha: "arm3", stratum: "c", cli: "C", sdk: "C" }])
    const other = otherHostFile(counts({ cCli: 2, cSdk: 2, intersection: 2, union: 2, decided: 4 }))
    other.hostname = "other-host"
    const otherPath = path.join(cwd, "other.json")
    fs.writeFileSync(otherPath, JSON.stringify(other))

    const logs: string[] = []
    const summary = runPvCompare(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(summary?.combined?.counts.cCli).toBe(3)
  })
})
