import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  computeLiveClassCTally,
  computeCorpusClassCTally,
  computePooledVerdict,
  renderPooledLine,
  renderFloorVerdict,
  computeLiveClassCounts,
  computeCorpusClassCounts,
  renderClassTable,
  computeReport,
  runReport,
  REPORT_BANNER,
  REPORT_FOOTNOTES,
  POOLED_FLOOR_MIN,
  POOLED_M1V2_BAR,
  type LiveClassCTally,
  type CorpusClassCTally,
} from "../src/gauge/replay-cli.ts"
import { CORPUS_FILE_REL, writeCorpus, recordKey, type CorpusRecord } from "../src/gauge/corpus-store.ts"
import { shadowRoot, PV_MANIFEST_NAME, PV_COUNTS_NAME, type PvManifest } from "../src/gauge/paired-validation.ts"
import { DEFAULT_SENSOR_REL_PATH } from "../src/sensor-append.ts"
import type { GaugeSensorField, SensorLine } from "../src/types.ts"

// --- fixture builders — REAL shapes, copied field-for-field from
// shadow.ts's emission code (fabricateLine / passthroughOnly / evaluateGauge
// base) and cross-checked against test/gauge-shadow.test.ts's own assertions
// on those exact shapes (first-strike / second-strike / gauge-only). ---

function sline(over: Partial<SensorLine> = {}): SensorLine {
  return {
    ts: 2000,
    sessionID: "sid-1",
    check: "floor-check",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 10,
    host: "h",
    app: "claude-code",
    ...over,
  }
}

/** evaluate.ts's `base` shape for a class-C multi-turn derivation, executed
 * (executable:true) — shadow.ts:82-100 / evaluate.ts:24-45. */
function classCField(over: Partial<GaugeSensorField> = {}): GaugeSensorField {
  return {
    present: true,
    executable: true,
    derivationMs: 800,
    confidence: 0.6,
    model: "haiku",
    n: 1,
    class: "C",
    horizon: "multi-turn",
    ...over,
  }
}

/** shadow.ts:82-100 `passthroughOnly` — a multi-turn-C pending left
 * untouched at a Stop with no floor cycle: no `pass`, no `wouldBlock`,
 * executable:false, fabricated `rounds:[]` envelope (fabricateLine,
 * shadow.ts:102-122). Field-for-field match to
 * gauge-shadow.test.ts:224-229's own assertions on this exact shape. */
function passthroughLine(over: Partial<SensorLine> = {}): SensorLine {
  return sline({
    rounds: [],
    gauge: {
      present: true,
      executable: false,
      derivationMs: 800,
      confidence: 0.6,
      model: "haiku",
      n: 1,
      class: "C",
      horizon: "multi-turn",
    },
    ...over,
  })
}

// --- corpus fixtures ---

function corpusRec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "resolved",
    repo: "/repo/example",
    sessionId: "csess-1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "",
    floorCheckMinedAt: 1000,
    ...over,
  }
}

describe("computeLiveClassCTally — dedup + passthrough exclusion", () => {
  test("two-strike double line: deduped to ONE derivation via the terminal (later-ts) line", () => {
    // shadow.ts:64-69 / gauge-shadow.test.ts:153-177 — first fail (strike:1,
    // wouldBlock damped to false, pending kept) then second fail (strike:2,
    // wouldBlock true, pending consumed). Same sessionID + gauge.n=1.
    const firstStrike = sline({
      ts: 2000,
      gauge: classCField({ pass: false, wouldBlock: false, strike: 1 }),
    })
    const secondStrike = sline({
      ts: 3000,
      gauge: classCField({ pass: false, wouldBlock: true, strike: 2 }),
    })
    const { a, b } = computeLiveClassCTally([firstStrike, secondStrike])
    expect(b).toBe(1) // ONE derivation, not two lines
    expect(a).toBe(1) // terminal line's executable:true
  })

  test("terminal selection is order-independent (max ts wins regardless of array order)", () => {
    const firstStrike = sline({ ts: 2000, gauge: classCField({ pass: false, wouldBlock: false, strike: 1 }) })
    const secondStrike = sline({ ts: 3000, gauge: classCField({ pass: false, wouldBlock: true, strike: 2 }) })
    const { a, b } = computeLiveClassCTally([secondStrike, firstStrike])
    expect(b).toBe(1)
    expect(a).toBe(1)
  })

  test("passthrough-only line excluded from the denominator (isolated group)", () => {
    const pt = passthroughLine({ sessionID: "sid-2", ts: 1000 })
    const { a, b } = computeLiveClassCTally([pt])
    expect(b).toBe(0)
    expect(a).toBe(0)
  })

  test("passthrough-only lines interleaved before the terminal real line are excluded, terminal still counted", () => {
    const pt1 = passthroughLine({ sessionID: "sid-1", ts: 1000 })
    const firstStrike = sline({ ts: 2000, gauge: classCField({ pass: false, wouldBlock: false, strike: 1 }) })
    const pt2 = passthroughLine({ sessionID: "sid-1", ts: 2500 })
    const secondStrike = sline({ ts: 3000, gauge: classCField({ pass: false, wouldBlock: true, strike: 2 }) })
    const { a, b } = computeLiveClassCTally([pt1, firstStrike, pt2, secondStrike])
    expect(b).toBe(1) // one derivation
    expect(a).toBe(1)
  })

  test("still-open multi-turn-C pending (terminal line itself is passthrough) excluded entirely", () => {
    const firstStrike = sline({ sessionID: "sid-3", ts: 2000, gauge: classCField({ pass: false, wouldBlock: false, strike: 1 }) })
    const stillPending = passthroughLine({ sessionID: "sid-3", ts: 2500, gauge: { present: true, executable: false, derivationMs: 800, confidence: 0.6, model: "haiku", n: 1, class: "C", horizon: "multi-turn", strike: 1 } })
    const { a, b } = computeLiveClassCTally([firstStrike, stillPending])
    expect(b).toBe(0) // terminal (max ts) is passthrough -> whole group excluded
    expect(a).toBe(0)
  })

  test("refused class-C line (executable:false, real evaluation, floor ran): counts in denominator, not numerator", () => {
    const refused = sline({
      sessionID: "sid-4",
      ts: 1200,
      gauge: {
        present: true,
        executable: false,
        derivationMs: 800,
        confidence: 0.6,
        model: "haiku",
        n: 1,
        class: "C",
        horizon: "multi-turn",
        refused: "destructive-command",
      },
    })
    const { a, b } = computeLiveClassCTally([refused])
    expect(b).toBe(1)
    expect(a).toBe(0)
  })

  test("single-turn C: immediate evaluation counts as one derivation, no strike field, no passthrough shape", () => {
    const line = sline({
      sessionID: "sid-5",
      ts: 1500,
      gauge: classCField({ horizon: "single-turn", pass: true, wouldBlock: false, strike: undefined }),
    })
    const { a, b } = computeLiveClassCTally([line])
    expect(b).toBe(1)
    expect(a).toBe(1)
  })

  test("non-class-C lines never contribute", () => {
    const a1 = sline({ sessionID: "sid-6", ts: 1000, gauge: { present: true, executable: false, derivationMs: 100, confidence: 0.9, model: "haiku", n: 1, class: "A1" } })
    const { a, b } = computeLiveClassCTally([a1])
    expect(a).toBe(0)
    expect(b).toBe(0)
  })

  test("lines with no gauge field / gauge.present:false never contribute", () => {
    const bare = sline({ sessionID: "sid-7", ts: 1000 })
    const notPresent = sline({ sessionID: "sid-8", ts: 1000, gauge: { present: false } })
    const { a, b } = computeLiveClassCTally([bare, notPresent])
    expect(a).toBe(0)
    expect(b).toBe(0)
  })
})

describe("computeCorpusClassCTally", () => {
  test("counts only poolEligible class-C records", () => {
    const records: CorpusRecord[] = [
      corpusRec({ promptSha256: "1", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" }, exec: { executable: true, timeoutMs: 30000 }, poolEligible: true }),
      corpusRec({ promptSha256: "2", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" }, exec: { executable: false, timeoutMs: 30000 }, poolEligible: true }),
      // non-poolEligible class-C: excluded
      corpusRec({ promptSha256: "3", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" }, exec: { executable: true, timeoutMs: 30000 }, poolEligible: false }),
      // poolEligible but not class C: excluded
      corpusRec({ promptSha256: "4", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: null, confidence: 0.5, class: "A1" }, exec: { executable: false, timeoutMs: 30000 }, poolEligible: true }),
      // mined stage, no derivation at all: excluded
      corpusRec({ promptSha256: "5", stage: "mined" }),
    ]
    const { c, d } = computeCorpusClassCTally(records)
    expect(d).toBe(2)
    expect(c).toBe(1)
  })

  test("empty corpus -> 0/0", () => {
    expect(computeCorpusClassCTally([])).toEqual({ c: 0, d: 0 })
  })

  test("amendment point 3: corpus-bench class-C records excluded from pooling; only corpus-transcript pools", () => {
    // corpus-bench record: poolEligible, class C, executable true — should NOT enter c/d
    const benchRecord = corpusRec({
      promptSha256: "bench-1",
      provenance: "corpus-bench",
      derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" },
      exec: { executable: true, timeoutMs: 30000 },
      poolEligible: true,
    })
    // corpus-transcript record: same properties — SHOULD enter c/d
    const transcriptRecord = corpusRec({
      promptSha256: "transcript-1",
      provenance: "corpus-transcript",
      derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "haiku", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" },
      exec: { executable: true, timeoutMs: 30000 },
      poolEligible: true,
    })

    // bench alone: should not pool
    const { c: benchC, d: benchD } = computeCorpusClassCTally([benchRecord])
    expect(benchD).toBe(0)
    expect(benchC).toBe(0)

    // transcript alone: should pool
    const { c: transcriptC, d: transcriptD } = computeCorpusClassCTally([transcriptRecord])
    expect(transcriptD).toBe(1)
    expect(transcriptC).toBe(1)

    // both together: only transcript counts
    const { c: bothC, d: bothD } = computeCorpusClassCTally([benchRecord, transcriptRecord])
    expect(bothD).toBe(1)
    expect(bothC).toBe(1)
  })
})

describe("computePooledVerdict — floor rules", () => {
  test("pooled n < 5 -> floor not-met", () => {
    const live: LiveClassCTally = { a: 1, b: 1 }
    const corpus: CorpusClassCTally = { c: 1, d: 2 }
    const v = computePooledVerdict(live, corpus)
    expect(v.n).toBe(3)
    expect(v.floor).toBe("not-met")
  })

  test("pooled n >= 5, live b === 0 -> all-corpus (cannot satisfy §3 M1v2 leg)", () => {
    const live: LiveClassCTally = { a: 0, b: 0 }
    const corpus: CorpusClassCTally = { c: 5, d: 6 }
    const v = computePooledVerdict(live, corpus)
    expect(v.n).toBe(6)
    expect(v.floor).toBe("all-corpus")
  })

  test("pooled n >= 5, live b >= 1 -> met", () => {
    const live: LiveClassCTally = { a: 1, b: 3 }
    const corpus: CorpusClassCTally = { c: 4, d: 5 }
    const v = computePooledVerdict(live, corpus)
    expect(v.n).toBe(8)
    expect(v.floor).toBe("met")
  })

  test("meetsBar true at exactly the 90% bar", () => {
    const live: LiveClassCTally = { a: 9, b: 9 }
    const corpus: CorpusClassCTally = { c: 0, d: 1 } // 9/10 = 90%
    const v = computePooledVerdict(live, corpus)
    expect(v.meetsBar).toBe(true)
  })

  test("meetsBar false just under the 90% bar", () => {
    const live: LiveClassCTally = { a: 8, b: 9 }
    const corpus: CorpusClassCTally = { c: 0, d: 1 } // 8/10 = 80%
    const v = computePooledVerdict(live, corpus)
    expect(v.meetsBar).toBe(false)
  })

  test("pinned constants", () => {
    expect(POOLED_FLOOR_MIN).toBe(5)
    expect(POOLED_M1V2_BAR).toBe(0.9)
  })
})

describe("renderPooledLine — EXACT amendment point-4 form", () => {
  // Amendment (d869660, spec point 4): "pooled M1v2 must be reported as
  // `live a/b · corpus c/d · pooled ≥90%?`, never as one number."
  test("exact string, bar not met", () => {
    const live: LiveClassCTally = { a: 1, b: 2 }
    const corpus: CorpusClassCTally = { c: 3, d: 5 }
    const v = computePooledVerdict(live, corpus)
    expect(renderPooledLine(live, corpus, v)).toBe("live 1/2 · corpus 3/5 · pooled ≥90%? no")
  })

  test("exact string, bar met", () => {
    const live: LiveClassCTally = { a: 9, b: 9 }
    const corpus: CorpusClassCTally = { c: 0, d: 1 }
    const v = computePooledVerdict(live, corpus)
    expect(renderPooledLine(live, corpus, v)).toBe("live 9/9 · corpus 0/1 · pooled ≥90%? yes")
  })

  test("exact string, zero denominator -> n/a", () => {
    const live: LiveClassCTally = { a: 0, b: 0 }
    const corpus: CorpusClassCTally = { c: 0, d: 0 }
    const v = computePooledVerdict(live, corpus)
    expect(renderPooledLine(live, corpus, v)).toBe("live 0/0 · corpus 0/0 · pooled ≥90%? n/a")
  })
})

describe("renderFloorVerdict — floor wording", () => {
  test("not-met wording carries n and the 5 floor", () => {
    const live: LiveClassCTally = { a: 1, b: 1 }
    const corpus: CorpusClassCTally = { c: 1, d: 2 }
    const v = computePooledVerdict(live, corpus)
    const text = renderFloorVerdict(live, corpus, v)
    expect(text).toContain("NOT MET")
    expect(text).toContain("n=3")
  })

  test("all-corpus wording is the amendment's literal phrase", () => {
    const live: LiveClassCTally = { a: 0, b: 0 }
    const corpus: CorpusClassCTally = { c: 5, d: 6 }
    const v = computePooledVerdict(live, corpus)
    const text = renderFloorVerdict(live, corpus, v)
    expect(text).toContain("reportable, cannot satisfy §3 M1v2 leg")
  })

  test("met wording", () => {
    const live: LiveClassCTally = { a: 1, b: 3 }
    const corpus: CorpusClassCTally = { c: 4, d: 5 }
    const v = computePooledVerdict(live, corpus)
    const text = renderFloorVerdict(live, corpus, v)
    expect(text).toContain("MET")
    expect(text).not.toContain("NOT MET")
  })
})

describe("class-rate table — descriptive, by provenance", () => {
  test("computeLiveClassCounts dedupes across all classes (not just C), excludes passthrough", () => {
    const a1 = sline({ sessionID: "s-a1", ts: 1000, gauge: { present: true, executable: false, derivationMs: 1, confidence: 1, model: "h", n: 1, class: "A1" } })
    const b1 = sline({ sessionID: "s-b1", ts: 1000, gauge: { present: true, executable: false, derivationMs: 1, confidence: 1, model: "h", n: 1, class: "B" } })
    const cFirst = sline({ sessionID: "s-c1", ts: 1000, gauge: classCField({ pass: false, wouldBlock: false, strike: 1 }) })
    const cSecond = sline({ sessionID: "s-c1", ts: 2000, gauge: classCField({ pass: true, wouldBlock: false, strike: 1 }) })
    const ptOnly = passthroughLine({ sessionID: "s-c2", ts: 1000 })
    const { counts, total } = computeLiveClassCounts([a1, b1, cFirst, cSecond, ptOnly])
    expect(counts).toEqual({ A1: 1, A2: 0, B: 1, C: 1, D: 0 })
    expect(total).toBe(3)
  })

  test("computeCorpusClassCounts filters by provenance and counts derivation.class", () => {
    const records: CorpusRecord[] = [
      corpusRec({ promptSha256: "1", provenance: "corpus-transcript", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "h", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" } }),
      corpusRec({ promptSha256: "2", provenance: "corpus-transcript", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "h", derivationMs: 1, goalSummary: "", criteria: [], check: null, confidence: 0.5, class: "D" } }),
      corpusRec({ promptSha256: "3", provenance: "corpus-bench", derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "h", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" } }),
      corpusRec({ promptSha256: "4", provenance: "corpus-transcript", stage: "mined" }), // no derivation: excluded
    ]
    const transcript = computeCorpusClassCounts(records, "corpus-transcript")
    expect(transcript.counts).toEqual({ A1: 0, A2: 0, B: 0, C: 1, D: 1 })
    expect(transcript.total).toBe(2)

    const bench = computeCorpusClassCounts(records, "corpus-bench")
    expect(bench.counts).toEqual({ A1: 0, A2: 0, B: 0, C: 1, D: 0 })
    expect(bench.total).toBe(1)
  })

  test("renderClassTable includes live + corpus-transcript rows, omits zero corpus-bench", () => {
    const live = { counts: { A1: 1, A2: 0, B: 0, C: 1, D: 0 }, total: 2 }
    const ct = { counts: { A1: 0, A2: 0, B: 0, C: 1, D: 1 }, total: 2 }
    const cb = { counts: { A1: 0, A2: 0, B: 0, C: 0, D: 0 }, total: 0 }
    const text = renderClassTable(live, ct, cb)
    expect(text).toContain("live")
    expect(text).toContain("corpus-transcript")
    expect(text).not.toContain("corpus-bench")
  })

  test("renderClassTable includes corpus-bench row when non-zero", () => {
    const empty = { counts: { A1: 0, A2: 0, B: 0, C: 0, D: 0 }, total: 0 }
    const cb = { counts: { A1: 0, A2: 0, B: 0, C: 1, D: 0 }, total: 1 }
    const text = renderClassTable(empty, empty, cb)
    expect(text).toContain("corpus-bench")
  })
})

describe("REPORT_BANNER — restates amendment points 5 + 7", () => {
  test("never consumes §3 / WRITTEN-only pilot design (point 5a)", () => {
    expect(REPORT_BANNER).toContain("never consumes")
    expect(REPORT_BANNER).toContain("WRITTEN")
  })

  test("cannot unshadow / substitute / lower bar / count toward window (point 7)", () => {
    expect(REPORT_BANNER).toContain("cannot unshadow")
    expect(REPORT_BANNER).toContain("cannot substitute for M2/M3")
    expect(REPORT_BANNER).toContain("cannot lower")
  })
})

describe("computeReport / runReport — read-only end to end", () => {
  function mkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-report-"))
  }

  function writeSensor(cwd: string, lines: SensorLine[]): void {
    const p = path.join(cwd, DEFAULT_SENSOR_REL_PATH)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""))
  }

  test("assembles pooled line, floor verdict, class table, banner, and footnotes into one text", () => {
    const cwd = mkdir()
    writeSensor(cwd, [
      sline({ sessionID: "sid-1", ts: 1000, gauge: classCField({ pass: true, wouldBlock: false, strike: undefined, horizon: "single-turn" }) }),
    ])
    writeCorpus(
      cwd,
      [
        corpusRec({
          promptSha256: "1",
          derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "h", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" },
          exec: { executable: true, timeoutMs: 30000 },
          poolEligible: true,
        }),
      ],
      () => {},
    )

    const result = computeReport(cwd)
    expect(result.live).toEqual({ a: 1, b: 1 })
    expect(result.corpus).toEqual({ c: 1, d: 1 })
    expect(result.text).toContain("live 1/1 · corpus 1/1 · pooled ≥90%? yes")
    expect(result.text).toContain("class-rate")
    expect(result.text).toContain(REPORT_BANNER)
    expect(result.text).toContain(REPORT_FOOTNOTES)
  })

  test("missing sensor stream and missing corpus store -> zero tallies, no throw", () => {
    const cwd = mkdir()
    const result = computeReport(cwd)
    expect(result.live).toEqual({ a: 0, b: 0 })
    expect(result.corpus).toEqual({ c: 0, d: 0 })
  })

  test("runReport logs computeReport's text via the injected log fn", () => {
    const cwd = mkdir()
    const logged: string[] = []
    runReport(cwd, (m) => logged.push(m))
    expect(logged.length).toBe(1)
    expect(logged[0]).toBe(computeReport(cwd).text)
  })

  test("report includes drift footnotes with exact key phrases", () => {
    const cwd = mkdir()
    writeSensor(cwd, [
      sline({ sessionID: "sid-1", ts: 1000, gauge: classCField({ pass: true, wouldBlock: false, strike: undefined, horizon: "single-turn" }) }),
    ])
    writeCorpus(cwd, [], () => {})

    const result = computeReport(cwd)
    expect(result.text).toContain("floorCheck is captured at mine time")
    expect(result.text).toContain("synthetic commit")
    expect(result.text).toContain("THIS repo's sensor stream only")
  })
})

describe("report CLI — real subprocess, zero writes", () => {
  function mkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-report-cli-"))
  }

  test("bun replay-cli.ts report <cwd> prints the pooled line, footnotes, and leaves the corpus store + sensor stream byte-identical", async () => {
    const cwd = mkdir()

    const sensorPath = path.join(cwd, DEFAULT_SENSOR_REL_PATH)
    fs.mkdirSync(path.dirname(sensorPath), { recursive: true })
    const sensorLines: SensorLine[] = [
      sline({ sessionID: "sid-1", ts: 1000, gauge: classCField({ pass: true, wouldBlock: false, strike: undefined, horizon: "single-turn" }) }),
    ]
    fs.writeFileSync(sensorPath, sensorLines.map((l) => JSON.stringify(l)).join("\n") + "\n")

    writeCorpus(
      cwd,
      [
        corpusRec({
          promptSha256: "1",
          derivation: { v: 2, sessionID: "x", n: 1, ts: 1, model: "h", derivationMs: 1, goalSummary: "", criteria: [], check: "c", confidence: 0.5, class: "C" },
          exec: { executable: false, timeoutMs: 30000 },
          poolEligible: true,
        }),
      ],
      () => {},
    )

    const corpusPath = path.join(cwd, CORPUS_FILE_REL)
    const beforeSensor = fs.readFileSync(sensorPath, "utf-8")
    const beforeCorpus = fs.readFileSync(corpusPath, "utf-8")
    const beforeEntries = fs.readdirSync(path.join(cwd, ".km", "gauge-corpus")).sort()

    const cliPath = path.join(import.meta.dir, "../src/gauge/replay-cli.ts")
    const proc = Bun.spawn(["bun", cliPath, "report", cwd], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(stdout).toContain("live 1/1 · corpus 0/1 · pooled ≥90%? no")
    expect(stdout).toContain("floorCheck is captured at mine time")
    expect(stdout).toContain("synthetic commit")
    expect(stdout).toContain("THIS repo's sensor stream only")

    const afterSensor = fs.readFileSync(sensorPath, "utf-8")
    const afterCorpus = fs.readFileSync(corpusPath, "utf-8")
    const afterEntries = fs.readdirSync(path.join(cwd, ".km", "gauge-corpus")).sort()
    expect(afterSensor).toBe(beforeSensor)
    expect(afterCorpus).toBe(beforeCorpus)
    expect(afterEntries).toEqual(beforeEntries) // no .lock file left behind either
  }, 20_000)
})

// ── Task 7 fix round 1: subprocess coverage for the `--pair` CLI wiring ──
//
// The library-level tests in paired-validation.test.ts exercise
// parsePairFlag/parsePvCountsFile/runPvCompare directly; nothing proved the
// CLI BOUNDARY in replay-cli.ts (resolvePairFlag/stripPairFlag/the
// pv-sample/pv-compare branches in main()) actually wires those functions
// together correctly through a real `bun replay-cli.ts ...` invocation —
// same subprocess-spawn precedent as the "report CLI" describe block above.
describe("pv-compare CLI — --pair wiring (Task 7 fix round 1)", () => {
  function mkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-pv-pair-cli-"))
  }

  const cliPath = path.join(import.meta.dir, "../src/gauge/replay-cli.ts")

  test("pv-compare --pair sdk:bogus refuses at the CLI boundary: non-zero exit, REFUSING on output, zero store reads/writes", async () => {
    const cwd = mkdir() // deliberately empty — no corpus store, no shadow store, no manifest anywhere under it

    const proc = Bun.spawn(["bun", cliPath, "pv-compare", cwd, "--pair", "sdk:bogus"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited

    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain("REFUSING")
    expect(stdout + stderr).toContain("sdk:bogus")

    // No store read: refusal happens before parsePvCompareArgs/runPvCompare
    // are ever called, so pv-compare's own "no readable pv-manifest.json"
    // message must NOT appear, and nothing gets created under cwd at all
    // (no .km, no shadow root, no pv-counts.json).
    expect(stdout + stderr).not.toContain("pv-manifest.json")
    expect(fs.existsSync(path.join(cwd, ".km"))).toBe(false)
  }, 20_000)

  test("pv-compare --pair sdk:agent-sdk (flag BEFORE the positional cwd) resolves the real cwd via stripPairFlag, not the literal \"--pair\" token, and writes matching arms into pv-counts.json", async () => {
    const cwd = mkdir()

    // Real store: one sdk-derived class-C record. Shadow store: the SAME
    // key, agent-sdk-derived, also class C — a healthy sdk:agent-sdk pair.
    const real: CorpusRecord[] = [
      corpusRec({
        promptSha256: "pair-cli-1",
        derivation: {
          v: 2,
          sessionID: "x",
          n: 1,
          ts: 1,
          model: "h",
          derivationMs: 1,
          goalSummary: "",
          criteria: [],
          check: "c",
          confidence: 0.9,
          class: "C",
          transport: "sdk",
        },
      }),
    ]
    const shadow: CorpusRecord[] = [
      corpusRec({
        promptSha256: "pair-cli-1",
        derivation: {
          v: 2,
          sessionID: "x",
          n: 1,
          ts: 1,
          model: "h",
          derivationMs: 1,
          goalSummary: "",
          criteria: [],
          check: "c",
          confidence: 0.9,
          class: "C",
          transport: "agent-sdk",
        },
      }),
    ]
    writeCorpus(cwd, real, () => {})
    const root = shadowRoot(cwd)
    writeCorpus(root, shadow, () => {})
    const manifest: PvManifest = {
      sampledAt: new Date().toISOString(),
      hostname: os.hostname(),
      cCount: 1,
      notCCount: 0,
      keys: { c: [recordKey(real[0]!)], notC: [] },
    }
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, PV_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")

    // `--pair` and its value placed BEFORE the positional cwd — the ordering
    // most likely to break if stripPairFlag mis-slices the args array (e.g.
    // if cwd's positional parser saw "--pair" or "sdk:agent-sdk" as the cwd
    // instead of the real path, pv-compare would look for a manifest under
    // the WRONG root and refuse with "no readable pv-manifest.json").
    const proc = Bun.spawn(["bun", cliPath, "pv-compare", "--pair", "sdk:agent-sdk", cwd], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited

    expect(code).toBe(0)
    expect(stdout).not.toContain("REFUSING")
    expect(stderr).toBe("")
    expect(stdout).toContain("sdk-vs-agent-sdk transport comparison")

    const countsRaw = fs.readFileSync(path.join(root, PV_COUNTS_NAME), "utf-8")
    const counts = JSON.parse(countsRaw) as { arms?: { baseline: string; shadow: string } }
    expect(counts.arms).toEqual({ baseline: "sdk", shadow: "agent-sdk" })
  }, 20_000)
})
