import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  runClsSample,
  clsAbRoot,
  CLS_RECORDS_NAME,
  CLS_LABELS_NAME,
  CLS_AB_LOCK_REL,
  acquireClsAbLock,
  releaseClsAbLock,
  parseClsArmName,
  clsArmFileName,
  parseClsRunArgs,
  parseClsLabelArgs,
  runClsRun,
  runClsLabel,
  CLS_ARM_MODEL_LITERALS,
  CLS_LABEL_MODEL_LITERAL,
  type ClsArmRow,
  type ClsLabelRow,
} from "../src/gauge/cls-ab.ts"
import { writeCorpus, type CorpusRecord } from "../src/gauge/corpus-store.ts"
import type { GaugeFile } from "../src/gauge/files.ts"
import { buildRefinerPrompt } from "../src/gauge/refiner.ts"
import { stubServer, stubServerFor, okResponse, type SdkStub } from "./sdk-stub.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-cls-ab-run-"))
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

function cRecs(n: number): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({ promptSha256: `sha-c-${i}`, derivation: gauge({ class: "C" }) }),
  )
}

function notCRecs(n: number): CorpusRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({ promptSha256: `sha-notc-${i}`, derivation: gauge({ class: "B", check: null }) }),
  )
}

/** Build a repo with an already-completed cls-sample (2 C + 2 not-C = 4
 * sampled records) — the fixture cls-run/cls-label tests build on top of. */
function sampledRepo(): string {
  const cwd = mkRepo()
  writeCorpus(cwd, [...cRecs(2), ...notCRecs(2)], () => {})
  expect(runClsSample(cwd, {}, () => {})).toEqual({ cCount: 2, notCCount: 2, total: 4 })
  return cwd
}

/** corpus-replay.test.ts / paired-validation.test.ts's `withSdkStub`
 * precedent — points KKAMAK_GAUGE_SDK_BASE_URL/KKAMAK_GAUGE_AUTH_TOKEN at
 * the stub, restores afterward, zero real model calls ever. */
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

function readArmFile(cwd: string, arm: string): ClsArmRow[] {
  const p = path.join(clsAbRoot(cwd), clsArmFileName(arm))
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClsArmRow)
}

function readLabelsFile(cwd: string): ClsLabelRow[] {
  const p = path.join(clsAbRoot(cwd), CLS_LABELS_NAME)
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClsLabelRow)
}

// ── parseClsArmName / clsArmFileName ──────────────────────────────────────

describe("parseClsArmName", () => {
  test("all four valid arm names parse", () => {
    expect(parseClsArmName("haiku-base")).toEqual({ model: "haiku", variant: "base" })
    expect(parseClsArmName("haiku-patched")).toEqual({ model: "haiku", variant: "patched" })
    expect(parseClsArmName("sonnet-base")).toEqual({ model: "sonnet", variant: "base" })
    expect(parseClsArmName("sonnet-patched")).toEqual({ model: "sonnet", variant: "patched" })
  })

  test("anything else is undefined (typo, wrong case, extra segment, opus)", () => {
    expect(parseClsArmName("haiku")).toBeUndefined()
    expect(parseClsArmName("Haiku-base")).toBeUndefined()
    expect(parseClsArmName("opus-base")).toBeUndefined()
    expect(parseClsArmName("haiku-base-extra")).toBeUndefined()
    expect(parseClsArmName("")).toBeUndefined()
  })
})

test("clsArmFileName", () => {
  expect(clsArmFileName("haiku-base")).toBe("arm-haiku-base.ndjson")
})

// ── parseClsRunArgs / parseClsLabelArgs ───────────────────────────────────

describe("parseClsRunArgs", () => {
  test("--arm and --go extracted; cwd positional; defaults", () => {
    expect(parseClsRunArgs(["/some/dir", "--arm", "haiku-base", "--go", "3"])).toEqual({
      cwd: "/some/dir",
      arm: "haiku-base",
      go: 3,
    })
    expect(parseClsRunArgs([])).toEqual({ cwd: process.cwd(), arm: undefined, go: undefined })
  })
})

describe("parseClsLabelArgs", () => {
  test("--go extracted; cwd positional; defaults", () => {
    expect(parseClsLabelArgs(["/some/dir", "--go", "5"])).toEqual({ cwd: "/some/dir", go: 5 })
    expect(parseClsLabelArgs([])).toEqual({ cwd: process.cwd(), go: undefined })
  })
})

// ── runClsRun ──────────────────────────────────────────────────────────

describe("runClsRun — refuses before any spend", () => {
  test("no sample exists -> refuses, no experiment dir mutation", async () => {
    const cwd = mkRepo()
    const logs: string[] = []
    const summary = await runClsRun(cwd, "haiku-base", 0, (m) => logs.push(m))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("no sample exists"))).toBe(true)
  })

  test("unknown arm -> refuses with zero calls to the transport", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => okResponse(JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, confidence: 0.5 })))
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "opus-base", 4, () => {}))
    expect(summary).toBeUndefined()
    expect(srv.captured.length).toBe(0)
  })

  test("no --go given -> refuses, reports pending count, zero calls", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => okResponse("{}"))
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", undefined, (m) => logs.push(m)))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("4 pending"))).toBe(true)
    expect(srv.captured.length).toBe(0)
  })

  test("--go mismatched with pending count -> refuses, zero calls, zero writes", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => okResponse("{}"))
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 3, (m) => logs.push(m)))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING"))).toBe(true)
    expect(srv.captured.length).toBe(0)
    expect(fs.existsSync(path.join(clsAbRoot(cwd), clsArmFileName("haiku-base")))).toBe(false)
  })
})

describe("runClsRun — success: model literal + prompt variant per arm", () => {
  test("haiku-base: exact model literal, base prompt (no trap text), transport 'sdk'", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))

    expect(summary).toEqual({ arm: "haiku-base", pending: 4, classified: 4, failed: 0 })
    expect(srv.captured.length).toBe(4)
    for (const c of srv.captured) {
      expect(c.body.model).toBe(CLS_ARM_MODEL_LITERALS.haiku)
      const messages = c.body.messages as Array<{ content: string }>
      expect(messages[0]!.content).not.toContain("NOT class C")
    }

    const rows = readArmFile(cwd, "haiku-base")
    expect(rows.length).toBe(4)
    for (const r of rows) {
      expect(r.class).toBe("C")
      expect(r.model).toBe("claude-haiku-4-5")
      expect(r.promptVariant).toBe("base")
      expect(r.transport).toBe("sdk")
      expect(typeof r.key).toBe("string")
      expect(typeof r.ts).toBe("string")
    }
  })

  test("sonnet-patched: exact model literal, patched prompt embeds the trap text", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "D", criteria: ["c1"], check: null, confidence: 0.9 })
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "sonnet-patched", 4, () => {}))

    expect(summary).toEqual({ arm: "sonnet-patched", pending: 4, classified: 4, failed: 0 })
    for (const c of srv.captured) {
      expect(c.body.model).toBe(CLS_ARM_MODEL_LITERALS.sonnet)
      const messages = c.body.messages as Array<{ content: string }>
      expect(messages[0]!.content).toContain("NOT class C")
    }
    const rows = readArmFile(cwd, "sonnet-patched")
    expect(rows.every((r) => r.promptVariant === "patched" && r.model === "claude-sonnet-5")).toBe(true)
  })

  test("no prompt text (F2) in arm-*.ndjson — keys, class, model, promptVariant, transport, ts only", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))

    const raw = fs.readFileSync(path.join(clsAbRoot(cwd), clsArmFileName("haiku-base")), "utf-8")
    expect(raw.includes("fix the thing")).toBe(false)
  })
})

describe("runClsRun — fail-open per record", () => {
  test("transport failure (non-2xx) -> record counted as failed, no row, batch continues", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => new Response("boom", { status: 500 }))
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))

    expect(summary).toEqual({ arm: "haiku-base", pending: 4, classified: 0, failed: 4 })
    expect(readArmFile(cwd, "haiku-base").length).toBe(0)
  })

  test("malformed model text -> undefined derivation -> failed, not a fabricated class", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => okResponse("not json at all"))
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))
    expect(summary).toEqual({ arm: "haiku-base", pending: 4, classified: 0, failed: 4 })
  })
})

describe("runClsRun — idempotent top-up (per arm)", () => {
  test("a partial success leaves the rest pending; a second --go only re-derives the missing ones", async () => {
    const cwd = sampledRepo()
    let n = 0
    const srv = stubServer(() => {
      n++
      // first 2 calls succeed, rest fail — simulate a partial batch.
      if (n <= 2) return okResponse(JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 }))
      return new Response("boom", { status: 500 })
    })
    const first = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))
    expect(first).toEqual({ arm: "haiku-base", pending: 4, classified: 2, failed: 2 })
    expect(readArmFile(cwd, "haiku-base").length).toBe(2)

    // Top-up: exactly the 2 still-pending records.
    const srv2 = stubServerFor({ goalSummary: "g", class: "D", criteria: ["c1"], check: null, confidence: 0.9 })
    const second = await withSdkStub(srv2, () => runClsRun(cwd, "haiku-base", 2, () => {}))
    expect(second).toEqual({ arm: "haiku-base", pending: 2, classified: 2, failed: 0 })
    expect(srv2.captured.length).toBe(2)

    const rows = readArmFile(cwd, "haiku-base")
    expect(rows.length).toBe(4)
    // idempotent: no duplicate keys.
    expect(new Set(rows.map((r) => r.key)).size).toBe(4)
  })

  test("different arms are independent — completing one leaves the others fully pending", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))

    expect(readArmFile(cwd, "haiku-patched").length).toBe(0)
    const srv2 = stubServer(() => okResponse("{}"))
    const logs: string[] = []
    const summary = await withSdkStub(srv2, () => runClsRun(cwd, "haiku-patched", undefined, (m) => logs.push(m)))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("4 pending"))).toBe(true)
  })
})

describe("runClsRun — lock discipline", () => {
  test("a live lock (concurrent cls-run/cls-label/cls-sample) refuses with zero writes", async () => {
    const cwd = sampledRepo()
    expect(acquireClsAbLock(cwd)).toBe(true)
    try {
      const srv = stubServer(() => okResponse("{}"))
      const logs: string[] = []
      const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, (m) => logs.push(m)))
      expect(summary).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      expect(srv.captured.length).toBe(0)
    } finally {
      releaseClsAbLock(cwd)
    }
  })

  test("the lock is released after a successful run", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))
    expect(fs.existsSync(path.join(cwd, CLS_AB_LOCK_REL))).toBe(false)
  })
})

// ── runClsLabel ────────────────────────────────────────────────────────

describe("runClsLabel — refuses before any spend", () => {
  test("no sample exists -> refuses", async () => {
    const cwd = mkRepo()
    const logs: string[] = []
    const summary = await runClsLabel(cwd, 0, (m) => logs.push(m))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("no sample exists"))).toBe(true)
  })

  test("no --go / mismatched --go -> refuses, zero calls", async () => {
    const cwd = sampledRepo()
    const srv = stubServer(() => okResponse("{}"))
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runClsLabel(cwd, undefined, (m) => logs.push(m)))
    expect(summary).toBeUndefined()
    expect(logs.some((l) => l.includes("4 pending"))).toBe(true)
    expect(srv.captured.length).toBe(0)

    const srv2 = stubServer(() => okResponse("{}"))
    const summary2 = await withSdkStub(srv2, () => runClsLabel(cwd, 1, () => {}))
    expect(summary2).toBeUndefined()
    expect(srv2.captured.length).toBe(0)
  })
})

describe("runClsLabel — success: claude-opus-5, label rubric, labels.ndjson shape", () => {
  test("writes {key,label,class,model,ts} rows, model always claude-opus-5", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ label: "C", class: "C" })
    const summary = await withSdkStub(srv, () => runClsLabel(cwd, 4, () => {}))

    expect(summary).toEqual({ pending: 4, labeled: 4, failed: 0 })
    for (const c of srv.captured) expect(c.body.model).toBe(CLS_LABEL_MODEL_LITERAL)

    const rows = readLabelsFile(cwd)
    expect(rows.length).toBe(4)
    for (const r of rows) {
      expect(r.label).toBe("C")
      expect(r.class).toBe("C")
      expect(r.model).toBe("claude-opus-5")
      expect(typeof r.key).toBe("string")
      expect(typeof r.ts).toBe("string")
    }
  })

  test("no prompt text (F2) in labels.ndjson", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ label: "not-C", class: "D" })
    await withSdkStub(srv, () => runClsLabel(cwd, 4, () => {}))
    const raw = fs.readFileSync(path.join(clsAbRoot(cwd), CLS_LABELS_NAME), "utf-8")
    expect(raw.includes("fix the thing")).toBe(false)
  })
})

describe("runClsLabel — fail-open + idempotent top-up", () => {
  test("a partial success leaves the rest pending; retryable on the next --go", async () => {
    const cwd = sampledRepo()
    let n = 0
    const srv = stubServer(() => {
      n++
      if (n <= 1) return okResponse(JSON.stringify({ label: "C", class: "C" }))
      return new Response("boom", { status: 500 })
    })
    const first = await withSdkStub(srv, () => runClsLabel(cwd, 4, () => {}))
    expect(first).toEqual({ pending: 4, labeled: 1, failed: 3 })

    const srv2 = stubServerFor({ label: "not-C", class: "B" })
    const second = await withSdkStub(srv2, () => runClsLabel(cwd, 3, () => {}))
    expect(second).toEqual({ pending: 3, labeled: 3, failed: 0 })

    const rows = readLabelsFile(cwd)
    expect(rows.length).toBe(4)
    expect(new Set(rows.map((r) => r.key)).size).toBe(4)
  })
})

describe("runClsLabel — BLIND ISOLATION (hard requirement, pre-reg §5)", () => {
  test("poisoned arm files + poisoned manifest classes: labels.ndjson is computed WITHOUT touching them", async () => {
    const cwd = sampledRepo()
    const root = clsAbRoot(cwd)

    // Plant poisoned arm outputs — if cls-label ever opened these, the label
    // could leak or drift toward them. It must not even try.
    const poisonedArm = 'THIS IS NOT VALID NDJSON AND MUST NEVER BE PARSED\x00\x01garbage'
    fs.writeFileSync(path.join(root, clsArmFileName("haiku-base")), poisonedArm)
    fs.writeFileSync(path.join(root, clsArmFileName("haiku-patched")), poisonedArm)
    fs.writeFileSync(path.join(root, clsArmFileName("sonnet-base")), poisonedArm)
    fs.writeFileSync(path.join(root, clsArmFileName("sonnet-patched")), poisonedArm)

    // Corrupt the manifest's stored classes too (flip every key's stratum
    // membership) — cls-label must produce the SAME labels regardless,
    // because it never reads manifest.json at all.
    const manifestPath = path.join(root, "manifest.json")
    fs.writeFileSync(manifestPath, "THIS IS ALSO NOT VALID JSON \x00\x01")

    const srv = stubServerFor({ label: "C", class: "C" })
    const logs: string[] = []
    const summary = await withSdkStub(srv, () => runClsLabel(cwd, 4, (m) => logs.push(m)))

    expect(summary).toEqual({ pending: 4, labeled: 4, failed: 0 })

    // The four poisoned arm files are BYTE-IDENTICAL — never opened, never written.
    for (const arm of ["haiku-base", "haiku-patched", "sonnet-base", "sonnet-patched"]) {
      expect(fs.readFileSync(path.join(root, clsArmFileName(arm)), "utf-8")).toBe(poisonedArm)
    }
    // The corrupted manifest is untouched too (cls-label never rewrites it).
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe("THIS IS ALSO NOT VALID JSON \x00\x01")

    // Every label landed successfully — corrupting manifest.json (which
    // cls-label never reads) had zero effect on the outcome.
    const rows = readLabelsFile(cwd)
    expect(rows.length).toBe(4)
    expect(rows.every((r) => r.label === "C")).toBe(true)
  })

  test("cls-label succeeds even when manifest.json does not exist at all (structural non-dependency)", async () => {
    const cwd = sampledRepo()
    const manifestPath = path.join(clsAbRoot(cwd), "manifest.json")
    fs.unlinkSync(manifestPath)

    const srv = stubServerFor({ label: "not-C", class: "D" })
    const summary = await withSdkStub(srv, () => runClsLabel(cwd, 4, () => {}))
    expect(summary).toEqual({ pending: 4, labeled: 4, failed: 0 })
  })
})

describe("runClsRun — structurally never reads labels.ndjson", () => {
  test("a poisoned labels.ndjson has zero effect on cls-run's output", async () => {
    const cwd = sampledRepo()
    fs.writeFileSync(path.join(clsAbRoot(cwd), CLS_LABELS_NAME), "NOT VALID NDJSON \x00\x01")

    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    const summary = await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))
    expect(summary).toEqual({ arm: "haiku-base", pending: 4, classified: 4, failed: 0 })

    expect(fs.readFileSync(path.join(clsAbRoot(cwd), CLS_LABELS_NAME), "utf-8")).toBe(
      "NOT VALID NDJSON \x00\x01",
    )
  })
})

// ── the real, unmodified buildRefinerPrompt is what cls-run actually sends ──

describe("runClsRun — sends the exact buildRefinerPrompt text (no re-implementation)", () => {
  test("base variant content matches buildRefinerPrompt(prompt, floorCheck, 'base') for each record", async () => {
    const cwd = sampledRepo()
    const srv = stubServerFor({ goalSummary: "g", class: "C", criteria: ["c1"], check: null, confidence: 0.9 })
    await withSdkStub(srv, () => runClsRun(cwd, "haiku-base", 4, () => {}))

    for (const c of srv.captured) {
      const messages = c.body.messages as Array<{ content: string }>
      // records all share the same prompt/floorCheck fixture (rec()'s defaults).
      expect(messages[0]!.content).toBe(buildRefinerPrompt("fix the thing", "test -f floor.ts", "base"))
    }
  })
})
