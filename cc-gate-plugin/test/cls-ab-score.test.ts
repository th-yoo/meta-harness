// Task 3 — `cls-score`: metrics + pre-registered decision rule (plan
// docs/superpowers/plans/2026-08-03-gauge-classifier-ab.md, spec
// docs/superpowers/specs/2026-08-03-gauge-classifier-ab-preregistration.md
// §3). Pure-function unit tests for the metric arithmetic + decision rule,
// then fs-backed integration tests for `runClsScore` (completeness report,
// labels-incomplete refusal, F2 pin, byte-identity, --emit-doc).
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  computeArmMetrics,
  pickWinner,
  evaluateClsDecision,
  runClsScore,
  parseClsScoreArgs,
  listPresentArmNames,
  CLS_DECISION_CONSTANTS,
  CLS_SCORE_NAME,
  CLS_MANIFEST_NAME,
  CLS_LABELS_NAME,
  clsAbRoot,
  clsArmFileName,
  type ClsArmMetrics,
  type ClsArmRow,
  type ClsLabelRow,
  type ClsManifest,
  type ClsMetricValue,
} from "../src/gauge/cls-ab.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-cls-ab-score-"))
}

function armRow(key: string, cls: ClsArmRow["class"]): ClsArmRow {
  return { key, class: cls, model: "claude-haiku-4-5", promptVariant: "base", transport: "sdk", ts: "t" }
}

function labelRow(key: string, label: ClsLabelRow["label"]): ClsLabelRow {
  return { key, label, class: null, model: "claude-opus-5", ts: "t" }
}

// ── computeArmMetrics (pure) ─────────────────────────────────────────────

describe("computeArmMetrics", () => {
  test("basic TP/FP/FN/TN + precision/recall/F1 arithmetic", () => {
    const keys = ["k1", "k2", "k3", "k4"]
    const rows = [armRow("k1", "C"), armRow("k2", "C"), armRow("k3", "B"), armRow("k4", "A1")]
    const labels = new Map([
      ["k1", true], // TP
      ["k2", false], // FP (false-C)
      ["k3", true], // FN (missed-C)
      ["k4", false], // TN
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.complete).toBe(true)
    expect(m.missingKeys).toBe(0)
    expect(m.tp).toBe(1)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(1)
    expect(m.tn).toBe(1)
    expect(m.precision).toBe(0.5)
    expect(m.recall).toBe(0.5)
    expect(m.f1).toBe(0.5)
  })

  test("zero-division: no C predicted -> precision n/a, F1 n/a", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "B"), armRow("k2", "D")]
    const labels = new Map([
      ["k1", true],
      ["k2", false],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(0)
    expect(m.precision).toBe("n/a")
    expect(m.f1).toBe("n/a")
  })

  test("zero-division: no C in labels -> recall n/a, F1 n/a", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "C"), armRow("k2", "B")]
    const labels = new Map([
      ["k1", false],
      ["k2", false],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fn).toBe(0)
    expect(m.recall).toBe("n/a")
    expect(m.f1).toBe("n/a")
  })

  test("both precision and recall defined-zero -> F1 n/a, never NaN", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "C"), armRow("k2", "B")]
    const labels = new Map([
      ["k1", false], // predC & !actualC -> FP
      ["k2", true], // !predC & actualC -> FN
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.f1).toBe("n/a")
    expect(Number.isNaN(m.f1)).toBe(false)
  })

  test("incomplete arm (missing a manifest key) -> complete false, all metrics n/a, counts zero", () => {
    const keys = ["k1", "k2", "k3"]
    const rows = [armRow("k1", "C"), armRow("k2", "B")] // k3 missing
    const labels = new Map([
      ["k1", true],
      ["k2", false],
      ["k3", true],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.complete).toBe(false)
    expect(m.presentKeys).toBe(2)
    expect(m.missingKeys).toBe(1)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(0)
    expect(m.tn).toBe(0)
    expect(m.precision).toBe("n/a")
    expect(m.recall).toBe("n/a")
    expect(m.f1).toBe("n/a")
  })

  test("raw-class reduction: A1/A2/B/D all reduce to not-C (only C is positive)", () => {
    const keys = ["k1", "k2", "k3", "k4"]
    const rows = [armRow("k1", "A1"), armRow("k2", "A2"), armRow("k3", "B"), armRow("k4", "D")]
    const labels = new Map([
      ["k1", true],
      ["k2", true],
      ["k3", true],
      ["k4", true],
    ]) // all labeled C, but every arm prediction reduces to not-C
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fn).toBe(4) // every one is missed-C
    expect(m.fp).toBe(0)
    expect(m.tn).toBe(0)
  })
})

// ── pickWinner (pure) ─────────────────────────────────────────────────────

function metric(arm: string, over: Partial<ClsArmMetrics> = {}): ClsArmMetrics {
  return {
    arm,
    totalKeys: 10,
    presentKeys: 10,
    missingKeys: 0,
    complete: true,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    precision: 0.5,
    recall: 0.5,
    f1: 0.5,
    ...over,
  }
}

describe("pickWinner", () => {
  test("argmax F1, excludes incomplete arms and n/a F1 arms", () => {
    const arms = [
      metric("haiku-base", { f1: 0.5 }),
      metric("haiku-patched", { f1: 0.9, complete: false }), // excluded (incomplete)
      metric("sonnet-base", { f1: "n/a" as ClsMetricValue }), // excluded (n/a)
      metric("sonnet-patched", { f1: 0.7 }),
    ]
    expect(pickWinner(arms)).toEqual({ arm: "sonnet-patched", f1: 0.7 })
  })

  test("tie-break stage 1: equal F1 -> cheaper model (haiku) wins over sonnet", () => {
    const arms = [metric("sonnet-patched", { f1: 0.6 }), metric("haiku-patched", { f1: 0.6 })]
    expect(pickWinner(arms)?.arm).toBe("haiku-patched")
  })

  test("tie-break stage 2: equal F1, same model -> base wins over patched", () => {
    const arms = [metric("haiku-patched", { f1: 0.6 }), metric("haiku-base", { f1: 0.6 })]
    expect(pickWinner(arms)?.arm).toBe("haiku-base")
  })

  test("undefined when no complete arm has a defined F1", () => {
    const arms = [metric("haiku-base", { complete: false }), metric("sonnet-base", { f1: "n/a" as ClsMetricValue })]
    expect(pickWinner(arms)).toBeUndefined()
  })
})

// ── evaluateClsDecision (pure) ────────────────────────────────────────────

describe("evaluateClsDecision", () => {
  test("NOT-EVALUABLE: incumbent missing entirely", () => {
    const arms = [metric("sonnet-base", { f1: 0.9 })]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("NOT-EVALUABLE")
    expect(d.reason).toMatch(/incumbent/i)
  })

  test("NOT-EVALUABLE: incumbent present but incomplete", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { complete: false }),
      metric("sonnet-patched", { f1: 0.9 }),
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("NOT-EVALUABLE")
  })

  test("NOT-EVALUABLE: incumbent complete but F1 undefined", () => {
    const arms = [metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: "n/a" as ClsMetricValue })]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("NOT-EVALUABLE")
    expect(d.reason).toMatch(/undefined/i)
  })

  test("ADOPT: winner clears margin and is missed-C not-worse", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.5, fn: 3 }),
      metric("sonnet-patched", { f1: 0.65, fn: 2 }), // margin 0.15 >= 0.10, fn 2 <= 3
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("ADOPT")
    expect(d.winnerArm).toBe("sonnet-patched")
    expect(d.marginAchieved).toBeCloseTo(0.15)
  })

  test("INCUMBENT-STAYS: margin fails (< 0.10)", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.5, fn: 3 }),
      metric("sonnet-patched", { f1: 0.55, fn: 2 }), // margin 0.05 < 0.10
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("INCUMBENT-STAYS")
    expect(d.reason).toMatch(/margin/i)
  })

  test("INCUMBENT-STAYS: missed-C worse even though margin clears", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.5, fn: 2 }),
      metric("sonnet-patched", { f1: 0.65, fn: 3 }), // margin 0.15 ok, but fn 3 > 2
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("INCUMBENT-STAYS")
    expect(d.reason).toMatch(/missed-C/i)
  })

  test("INCUMBENT-STAYS: incumbent is itself the argmax", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.8, fn: 1 }),
      metric("sonnet-patched", { f1: 0.5, fn: 3 }),
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("INCUMBENT-STAYS")
    expect(d.winnerArm).toBe(CLS_DECISION_CONSTANTS.incumbentArm)
  })
})

// ── runClsScore (fs-backed integration) ───────────────────────────────────

function writeManifest(cwd: string, cKeys: string[], notCKeys: string[]): void {
  const root = clsAbRoot(cwd)
  fs.mkdirSync(root, { recursive: true })
  const manifest: ClsManifest = {
    sampledAt: "2026-08-03T00:00:00.000Z",
    hostname: "test-host",
    cCount: cKeys.length,
    notCCount: notCKeys.length,
    keys: { c: cKeys, notC: notCKeys },
  }
  fs.writeFileSync(path.join(root, CLS_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")
}

function writeNdjson(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
}

/** 4 nominal-C keys (c1..c4) + 4 nominal-not-C keys (n1..n4). Ground truth
 * (labels, all 8): actual C = {c1, c2, n2} (deliberately crosses strata —
 * ground truth is NOT the nominal stratum). */
function setupBasicExperiment(cwd: string): { keys: string[] } {
  const cKeys = ["c1", "c2", "c3", "c4"]
  const notCKeys = ["n1", "n2", "n3", "n4"]
  writeManifest(cwd, cKeys, notCKeys)
  const root = clsAbRoot(cwd)
  const labels: ClsLabelRow[] = [
    labelRow("c1", "C"),
    labelRow("c2", "C"),
    labelRow("c3", "not-C"),
    labelRow("c4", "not-C"),
    labelRow("n1", "not-C"),
    labelRow("n2", "C"),
    labelRow("n3", "not-C"),
    labelRow("n4", "not-C"),
  ]
  writeNdjson(path.join(root, CLS_LABELS_NAME), labels)
  return { keys: [...cKeys, ...notCKeys] }
}

describe("runClsScore", () => {
  test("refuses when no manifest exists", () => {
    const cwd = mkRepo()
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => /REFUSING/.test(l))).toBe(true)
    expect(fs.existsSync(path.join(clsAbRoot(cwd), CLS_SCORE_NAME))).toBe(false)
  })

  test("refuses entirely when labels are incomplete (zero writes)", () => {
    const cwd = mkRepo()
    writeManifest(cwd, ["c1", "c2"], ["n1", "n2"])
    const root = clsAbRoot(cwd)
    // only 3 of 4 sampled keys labeled
    writeNdjson(path.join(root, CLS_LABELS_NAME), [labelRow("c1", "C"), labelRow("c2", "not-C"), labelRow("n1", "not-C")])
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRow("c1", "C"),
      armRow("c2", "B"),
      armRow("n1", "B"),
      armRow("n2", "B"),
    ])
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => /REFUSING.*labels/i.test(l))).toBe(true)
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
  })

  test("full pipeline: completeness report, ADOPT decision, F2 pin, byte-identity, --emit-doc", () => {
    const cwd = mkRepo()
    const { keys } = setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)

    // incumbent haiku-base: predicts C for c1,c2,n2 (correct) + c3 (extra FP)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRow("c1", "C"),
      armRow("c2", "C"),
      armRow("c3", "C"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
      armRow("n4", "B"),
    ])
    // sonnet-patched: perfect prediction of the actual-C set {c1,c2,n2}
    writeNdjson(path.join(root, clsArmFileName("sonnet-patched")), [
      armRow("c1", "C"),
      armRow("c2", "C"),
      armRow("c3", "B"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
      armRow("n4", "B"),
    ])
    // sonnet-base: INCOMPLETE — missing n4
    writeNdjson(path.join(root, clsArmFileName("sonnet-base")), [
      armRow("c1", "C"),
      armRow("c2", "B"),
      armRow("c3", "B"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
    ])
    // haiku-patched: never run — file absent entirely

    // records.ndjson (T1 output, never read by the scorer) — present in a
    // real experiment dir; must survive byte-identical (minor fix 2).
    const recordsPath = path.join(root, "records.ndjson")
    fs.writeFileSync(recordsPath, keys.map((k) => JSON.stringify({ key: k, prompt: "x", floorCheck: "y" })).join("\n") + "\n")

    expect(listPresentArmNames(cwd).sort()).toEqual(["haiku-base", "sonnet-base", "sonnet-patched"].sort())

    // snapshot inputs before scoring
    const before = {
      manifest: fs.readFileSync(path.join(root, CLS_MANIFEST_NAME), "utf-8"),
      labels: fs.readFileSync(path.join(root, CLS_LABELS_NAME), "utf-8"),
      records: fs.readFileSync(recordsPath, "utf-8"),
      haikuBase: fs.readFileSync(path.join(root, clsArmFileName("haiku-base")), "utf-8"),
      sonnetPatched: fs.readFileSync(path.join(root, clsArmFileName("sonnet-patched")), "utf-8"),
      sonnetBase: fs.readFileSync(path.join(root, clsArmFileName("sonnet-base")), "utf-8"),
    }

    const emitDocPath = path.join(cwd, "docs", "gauge-cls-ab", "test-host-cls-score.json")
    const logs: string[] = []
    const result = runClsScore(cwd, { emitDoc: emitDocPath }, (m) => logs.push(m))

    expect(result).toBeDefined()
    expect(result!.arms.map((a) => a.arm).sort()).toEqual(["haiku-base", "sonnet-base", "sonnet-patched"].sort())

    const sonnetBaseEntry = result!.arms.find((a) => a.arm === "sonnet-base")!
    expect(sonnetBaseEntry.complete).toBe(false)
    expect(sonnetBaseEntry.missingKeys).toBe(1)
    expect(logs.some((l) => /sonnet-base.*INCOMPLETE/.test(l) || /INCOMPLETE.*sonnet-base/.test(l))).toBe(true)

    expect(result!.decision.verdict).toBe("ADOPT")
    expect(result!.decision.winnerArm).toBe("sonnet-patched")

    // fix-wave (IMPORTANT): haiku-patched never ran -> absent, and sonnet-base
    // is incomplete -> this run is PROVISIONAL even though a verdict computed.
    expect(result!.expectedArms.sort()).toEqual(
      ["haiku-base", "haiku-patched", "sonnet-base", "sonnet-patched"].sort(),
    )
    expect(result!.absentArms).toEqual(["haiku-patched"])
    expect(result!.provisional).toBe(true)
    expect(logs.some((l) => /PROVISIONAL/.test(l))).toBe(true)
    expect(logs.some((l) => /arms present 3\/4/.test(l))).toBe(true)
    expect(logs.some((l) => /never run.*haiku-patched/.test(l))).toBe(true)

    // main output written
    const scoreFileContent = fs.readFileSync(path.join(root, CLS_SCORE_NAME), "utf-8")
    const parsed = JSON.parse(scoreFileContent)
    expect(parsed.decision.verdict).toBe("ADOPT")
    expect(parsed.provisional).toBe(true)
    expect(parsed.absentArms).toEqual(["haiku-patched"])

    // F2 pin: only the expected top-level keys, no prompt/floorCheck text anywhere
    expect(Object.keys(parsed).sort()).toEqual(
      ["absentArms", "arms", "decision", "expectedArms", "hostname", "provisional", "scoredAt", "sample"].sort(),
    )
    expect(scoreFileContent).not.toMatch(/prompt/i)
    expect(scoreFileContent).not.toMatch(/floorCheck/i)
    for (const arm of parsed.arms) {
      expect(Object.keys(arm).sort()).toEqual(
        ["arm", "complete", "counts", "metrics", "missingKeys", "presentKeys", "totalKeys"].sort(),
      )
    }

    // --emit-doc: same content, committable path auto-created
    expect(fs.existsSync(emitDocPath)).toBe(true)
    expect(fs.readFileSync(emitDocPath, "utf-8")).toBe(scoreFileContent)

    // byte-identity: every input untouched (minor fix 2 adds records.ndjson)
    expect(fs.readFileSync(path.join(root, CLS_MANIFEST_NAME), "utf-8")).toBe(before.manifest)
    expect(fs.readFileSync(path.join(root, CLS_LABELS_NAME), "utf-8")).toBe(before.labels)
    expect(fs.readFileSync(recordsPath, "utf-8")).toBe(before.records)
    expect(fs.readFileSync(path.join(root, clsArmFileName("haiku-base")), "utf-8")).toBe(before.haikuBase)
    expect(fs.readFileSync(path.join(root, clsArmFileName("sonnet-patched")), "utf-8")).toBe(before.sonnetPatched)
    expect(fs.readFileSync(path.join(root, clsArmFileName("sonnet-base")), "utf-8")).toBe(before.sonnetBase)
  })

  test("provisional: false once all 4 registered arms are present and complete", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const allComplete = [
      armRow("c1", "C"),
      armRow("c2", "C"),
      armRow("c3", "B"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
      armRow("n4", "B"),
    ]
    for (const arm of ["haiku-base", "haiku-patched", "sonnet-base", "sonnet-patched"]) {
      writeNdjson(path.join(root, clsArmFileName(arm)), allComplete)
    }
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.absentArms).toEqual([])
    expect(result!.arms.every((a) => a.complete)).toBe(true)
    expect(result!.provisional).toBe(false)
    expect(logs.some((l) => /PROVISIONAL/.test(l))).toBe(false)
    expect(logs.some((l) => /arms present 4\/4/.test(l))).toBe(true)
  })

  test("provisional: true when all 4 arms are present but one is incomplete", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const allComplete = [
      armRow("c1", "C"),
      armRow("c2", "C"),
      armRow("c3", "B"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
      armRow("n4", "B"),
    ]
    for (const arm of ["haiku-base", "haiku-patched", "sonnet-patched"]) {
      writeNdjson(path.join(root, clsArmFileName(arm)), allComplete)
    }
    // sonnet-base present but missing one key
    writeNdjson(path.join(root, clsArmFileName("sonnet-base")), allComplete.slice(0, 7))

    const result = runClsScore(cwd, {}, () => {})
    expect(result).toBeDefined()
    expect(result!.absentArms).toEqual([]) // all 4 files present
    expect(result!.provisional).toBe(true) // but one is incomplete
  })

  test("zero present arms: manifest + labels only -> empty arms, NOT-EVALUABLE, provisional", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.arms).toEqual([])
    expect(result!.absentArms.sort()).toEqual(
      ["haiku-base", "haiku-patched", "sonnet-base", "sonnet-patched"].sort(),
    )
    expect(result!.decision.verdict).toBe("NOT-EVALUABLE")
    expect(result!.provisional).toBe(true)
    // still writes cls-score.json — a registered "nothing run yet" state
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(true)
    expect(logs.some((l) => /PROVISIONAL/.test(l))).toBe(true)
    expect(logs.some((l) => /arms present 0\/4/.test(l))).toBe(true)
  })

  test("refuses on malformed manifest (keys.c/keys.notC not arrays)", () => {
    const cwd = mkRepo()
    const root = clsAbRoot(cwd)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, CLS_MANIFEST_NAME),
      JSON.stringify({ sampledAt: "t", hostname: "h", cCount: 1, notCCount: 1, keys: { c: "not-an-array", notC: [] } }),
    )
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => /REFUSING.*malformed/i.test(l))).toBe(true)
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
  })
})

describe("parseClsScoreArgs", () => {
  test("defaults: no --emit-doc, cwd from positional", () => {
    expect(parseClsScoreArgs(["/some/repo"])).toEqual({ cwd: "/some/repo", emitDoc: undefined })
  })

  test("--emit-doc extracted", () => {
    expect(parseClsScoreArgs(["/some/repo", "--emit-doc", "/out/x.json"])).toEqual({
      cwd: "/some/repo",
      emitDoc: "/out/x.json",
    })
  })

  test("--emit-doc with no value refuses cleanly (zero writes)", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRow("c1", "C"),
      armRow("c2", "C"),
      armRow("c3", "B"),
      armRow("c4", "B"),
      armRow("n1", "B"),
      armRow("n2", "C"),
      armRow("n3", "B"),
      armRow("n4", "B"),
    ])
    const { emitDoc } = parseClsScoreArgs([cwd, "--emit-doc"])
    expect(emitDoc).toBe("")
    const logs: string[] = []
    const result = runClsScore(cwd, { emitDoc }, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => /REFUSING/.test(l))).toBe(true)
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
  })
})
