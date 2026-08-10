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
  renderClsScoreReport,
  runClsScore,
  parseClsScoreArgs,
  listPresentArmNames,
  manifestKeysHash,
  parseClsScoreCombineFile,
  roundTo3,
  acquireClsAbLock,
  releaseClsAbLock,
  CLS_DECISION_CONSTANTS,
  CLS_SCORE_NAME,
  CLS_COMBINED_NAME,
  CLS_MANIFEST_NAME,
  CLS_LABELS_NAME,
  CLS_AB_LOCK_REL,
  CLS_ARM_MODEL_LITERALS,
  CLS_ALL_ARM_NAMES,
  parseClsArmName,
  clsAbRoot,
  clsArmFileName,
  type ClsArmMetrics,
  type ClsArmRow,
  type ClsLabelRow,
  type ClsManifest,
  type ClsMetricValue,
  type ClsScoreFile,
  CLS_RECORDS_NAME,
} from "../src/gauge/cls-ab.ts"
import { buildRefinerPrompt, buildLabelPrompt } from "../src/gauge/refiner.ts"
import { sha256Hex } from "../src/gauge/corpus-mine.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-cls-ab-score-"))
}

function armRow(key: string, cls: ClsArmRow["class"], over: Partial<ClsArmRow> = {}): ClsArmRow {
  return {
    key,
    class: cls,
    model: "claude-haiku-4-5",
    promptVariant: "base",
    transport: "sdk",
    promptSha256: "hash-default",
    ts: "t",
    ...over,
  }
}

function labelRow(key: string, label: ClsLabelRow["label"], over: Partial<ClsLabelRow> = {}): ClsLabelRow {
  return { key, label, class: null, model: "claude-opus-5", promptSha256: "hash-default", ts: "t", ...over }
}

/** `armRow` with model/promptVariant auto-filled to the GIVEN arm's own
 * expected literals (fix-wave F9's own precondition) — every fixture that
 * represents a believable arm output should use this, not bare `armRow`,
 * so F9's model/promptVariant-mismatch check never spuriously fires on
 * fixtures that were never meant to test that mismatch in the first place. */
function armRowFor(arm: string, key: string, cls: ClsArmRow["class"], over: Partial<ClsArmRow> = {}): ClsArmRow {
  const parsed = parseClsArmName(arm)!
  return armRow(key, cls, {
    model: CLS_ARM_MODEL_LITERALS[parsed.model],
    promptVariant: parsed.variant,
    ...over,
  })
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

  // fix-wave F2 (pre-data fix 2026-08-03): the OLD rule read F1 as "n/a"
  // whenever precision OR recall was "n/a" (or both were defined-zero) —
  // which wrongly reported an evaluable arm as NOT-EVALUABLE. The CORRECTED
  // rule is `f1 = (tp+fp+fn === 0) ? "n/a" : 2*tp/(2*tp+fp+fn)`, computed
  // directly from the counts, independent of precision/recall's own "n/a"
  // status. P/R "n/a" semantics themselves are UNCHANGED.
  test("F2 fix: tp+fp===0 (no C predicted) -> precision n/a, but F1 still DEFINED (fn>0)", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "B"), armRow("k2", "D")]
    const labels = new Map([
      ["k1", true],
      ["k2", false],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(1)
    expect(m.precision).toBe("n/a")
    // tp+fp+fn = 0+0+1 = 1 !== 0 -> f1 = 2*0/(0+0+1) = 0, DEFINED.
    expect(m.f1).toBe(0)
  })

  test("F2 fix: tp+fn===0 (no C in labels) -> recall n/a, but F1 still DEFINED (fp>0)", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "C"), armRow("k2", "B")]
    const labels = new Map([
      ["k1", false],
      ["k2", false],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(0)
    expect(m.recall).toBe("n/a")
    // tp+fp+fn = 0+1+0 = 1 !== 0 -> f1 = 2*0/(0+1+0) = 0, DEFINED.
    expect(m.f1).toBe(0)
  })

  test("F2 fix: tp=0,fp>0,fn>0 -> precision 0, recall 0, F1 0 (DEFINED, never n/a, never NaN)", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "C"), armRow("k2", "B")]
    const labels = new Map([
      ["k1", false], // predC & !actualC -> FP
      ["k2", true], // !predC & actualC -> FN
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.f1).toBe(0)
    expect(Number.isNaN(m.f1)).toBe(false)
  })

  test("F2: F1 is n/a ONLY when tp+fp+fn === 0 (nothing predicted C, nothing labeled C)", () => {
    const keys = ["k1", "k2"]
    const rows = [armRow("k1", "B"), armRow("k2", "D")]
    const labels = new Map([
      ["k1", false],
      ["k2", false],
    ])
    const m = computeArmMetrics("arm-x", keys, rows, labels)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(0)
    expect(m.precision).toBe("n/a")
    expect(m.recall).toBe("n/a")
    expect(m.f1).toBe("n/a")
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

// ── roundTo3 (pure, fix-wave F1) ──────────────────────────────────────────

describe("roundTo3", () => {
  test("corrects the classic 0.9 - 0.8 IEEE double artifact to an exact 0.1", () => {
    expect(0.9 - 0.8).not.toBe(0.1) // the raw artifact this helper exists to fix
    expect(roundTo3(0.9 - 0.8)).toBe(0.1)
  })

  test("rounds to 3 decimal places generally", () => {
    expect(roundTo3(0.123456)).toBe(0.123)
    expect(roundTo3(0.1235)).toBe(0.124) // half-up at the 3rd decimal (Math.round)
    expect(roundTo3(0)).toBe(0)
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

  // fix-wave F1 (pre-data fix 2026-08-03): 0.9 - 0.8 is 0.09999999999999998
  // in raw IEEE doubles, which fails a naive `>= 0.1` comparison even though
  // the pre-registered margin is meant to read as exactly met. The exactly-
  // at-bar pair from the review table.
  test("F1 fix: 0.9 vs 0.8 rounds to an exact 0.1 margin -> ADOPT-eligible, not a raw-float miss", () => {
    expect(0.9 - 0.8 >= 0.1).toBe(false) // the raw bug, pinned so this test fails loudly if ever un-fixed
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.8, fn: 3 }),
      metric("sonnet-patched", { f1: 0.9, fn: 3 }),
    ]
    const d = evaluateClsDecision(arms)
    expect(d.verdict).toBe("ADOPT")
    expect(d.marginAchieved).toBe(0.1)
  })

  // fix-wave F2 (pre-data fix 2026-08-03): an incumbent whose F1 is a
  // DEFINED zero (not "n/a") must still be evaluable — the pre-fix
  // computeArmMetrics bug (see cls-ab-score.test.ts's F2 tests) could
  // produce exactly this incumbent shape.
  test("F2 fix: incumbent with F1 0 (defined) is evaluable, not NOT-EVALUABLE", () => {
    // metric() fixture already sets complete:true by default; f1:0 (not
    // "n/a") is the case under test — the shape a real tp=0,fp>0,fn>0 arm
    // now produces after the F2 fix (previously "n/a" -> NOT-EVALUABLE).
    const d = evaluateClsDecision([metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0, fn: 5 })])
    expect(d.verdict).not.toBe("NOT-EVALUABLE")
    expect(d.f1Incumbent).toBe(0)
  })
})

// ── renderClsScoreReport tie-break prose (fix-wave F16) ──────────────────

describe("renderClsScoreReport — tie-break prose derived from CLS_DECISION_CONSTANTS", () => {
  test("the winner line's tie-break prose is built from tieBreak.modelOrder/variantOrder, never a hardcoded restatement", () => {
    const arms = [
      metric(CLS_DECISION_CONSTANTS.incumbentArm, { f1: 0.5, fn: 3 }),
      metric("sonnet-patched", { f1: 0.7, fn: 2 }),
    ]
    const decision = evaluateClsDecision(arms)
    const report = renderClsScoreReport({ cCount: 4, notCCount: 4 }, arms, decision, {
      expectedArms: [...CLS_ALL_ARM_NAMES],
      absentArms: [],
      provisional: false,
    })
    const { modelOrder, variantOrder } = CLS_DECISION_CONSTANTS.tieBreak
    const expectedProse =
      `cheaper model first (${modelOrder.join(" < ")}), then earlier prompt variant (${variantOrder.join(" < ")})`
    expect(report).toContain(expectedProse)
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
    // fix-wave F10 — fixture tally, doesn't need to reflect a real store.
    transportCounts: { c: { cli: cKeys.length, sdk: 0 }, notC: { cli: notCKeys.length, sdk: 0 } },
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

    // F8 repaired: this test writes records.ndjson below, so every row must
    // carry its variant's CORRECT expected sha or the drift flag fires.
    // prompt/floorCheck are constant across keys here, so one sha per variant.
    const shaBase = sha256Hex(buildRefinerPrompt("x", "y", "base"))
    const shaPatched = sha256Hex(buildRefinerPrompt("x", "y", "patched"))
    // incumbent haiku-base: predicts C for c1,c2,n2 (correct) + c3 (extra FP)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRow("c1", "C", { promptSha256: shaBase }),
      armRow("c2", "C", { promptSha256: shaBase }),
      armRow("c3", "C", { promptSha256: shaBase }),
      armRow("c4", "B", { promptSha256: shaBase }),
      armRow("n1", "B", { promptSha256: shaBase }),
      armRow("n2", "C", { promptSha256: shaBase }),
      armRow("n3", "B", { promptSha256: shaBase }),
      armRow("n4", "B", { promptSha256: shaBase }),
    ])
    // sonnet-patched: perfect prediction of the actual-C set {c1,c2,n2}
    writeNdjson(path.join(root, clsArmFileName("sonnet-patched")), [
      armRowFor("sonnet-patched", "c1", "C", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "c2", "C", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "c3", "B", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "c4", "B", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "n1", "B", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "n2", "C", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "n3", "B", { promptSha256: shaPatched }),
      armRowFor("sonnet-patched", "n4", "B", { promptSha256: shaPatched }),
    ])
    // sonnet-base: INCOMPLETE — missing n4
    writeNdjson(path.join(root, clsArmFileName("sonnet-base")), [
      armRowFor("sonnet-base", "c1", "C", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "c2", "B", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "c3", "B", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "c4", "B", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "n1", "B", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "n2", "C", { promptSha256: shaBase }),
      armRowFor("sonnet-base", "n3", "B", { promptSha256: shaBase }),
    ])
    // haiku-patched: never run — file absent entirely

    // records.ndjson (T1 output; F8-repaired scorer READS it for drift) — in a
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

    // F2 pin: only the expected top-level keys, no prompt/floorCheck TEXT
    // anywhere — `promptSha256` (a hash) and `mixedPrompt` (a boolean flag
    // name) both legitimately contain the substring "prompt" without
    // leaking any text, so the pin checks for actual text-bearing FIELDS
    // (prompt / promptVariant / floorCheck as JSON keys), not the bare word.
    expect(Object.keys(parsed).sort()).toEqual(
      ["absentArms", "arms", "decision", "expectedArms", "hostname", "provisional", "scoredAt", "sample"].sort(),
    )
    expect(scoreFileContent).not.toContain('"prompt":')
    expect(scoreFileContent).not.toContain('"promptVariant":')
    expect(scoreFileContent).not.toContain('"floorCheck":')
    for (const arm of parsed.arms) {
      expect(Object.keys(arm).sort()).toEqual(
        [
          "arm",
          "complete",
          "counts",
          "metrics",
          "missingKeys",
          "presentKeys",
          "totalKeys",
          "mixedPrompt",
          "mismatchedRows",
        ].sort(),
      )
      // rows carry their variant's CORRECT expected sha (F8 repaired) and
      // match their own arm's expected model/promptVariant literal ->
      // neither flag fires.
      expect(arm.mixedPrompt).toBe(false)
      expect(arm.mismatchedRows).toBe(0)
    }

    // fix-wave F10/F11: sample identity fields carried through.
    expect(parsed.sample.transportCounts).toEqual({ c: { cli: 4, sdk: 0 }, notC: { cli: 4, sdk: 0 } })
    expect(parsed.sample.manifestSampledAt).toBe("2026-08-03T00:00:00.000Z")
    expect(parsed.sample.manifestKeysHash).toBe(manifestKeysHash(keys))

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
    const classesByKey: [string, ClsArmRow["class"]][] = [
      ["c1", "C"],
      ["c2", "C"],
      ["c3", "B"],
      ["c4", "B"],
      ["n1", "B"],
      ["n2", "C"],
      ["n3", "B"],
      ["n4", "B"],
    ]
    for (const arm of ["haiku-base", "haiku-patched", "sonnet-base", "sonnet-patched"]) {
      writeNdjson(
        path.join(root, clsArmFileName(arm)),
        classesByKey.map(([k, c]) => armRowFor(arm, k, c)),
      )
    }
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.absentArms).toEqual([])
    expect(result!.arms.every((a) => a.complete)).toBe(true)
    expect(result!.arms.every((a) => !a.mixedPrompt && a.mismatchedRows === 0)).toBe(true)
    expect(result!.provisional).toBe(false)
    expect(logs.some((l) => /PROVISIONAL/.test(l))).toBe(false)
    expect(logs.some((l) => /arms present 4\/4/.test(l))).toBe(true)
  })

  test("provisional: true when all 4 arms are present but one is incomplete", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const classesByKey: [string, ClsArmRow["class"]][] = [
      ["c1", "C"],
      ["c2", "C"],
      ["c3", "B"],
      ["c4", "B"],
      ["n1", "B"],
      ["n2", "C"],
      ["n3", "B"],
      ["n4", "B"],
    ]
    for (const arm of ["haiku-base", "haiku-patched", "sonnet-patched"]) {
      writeNdjson(
        path.join(root, clsArmFileName(arm)),
        classesByKey.map(([k, c]) => armRowFor(arm, k, c)),
      )
    }
    // sonnet-base present but missing one key
    writeNdjson(
      path.join(root, clsArmFileName("sonnet-base")),
      classesByKey.slice(0, 7).map(([k, c]) => armRowFor("sonnet-base", k, c)),
    )

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

// ── runClsScore --combine (fix-wave F3) ──────────────────────────────────

/** Raw JSON string standing in for another host's `cls-score.json`/
 * `--emit-doc` file, shaped exactly like `ClsScoreFileParsed` (the ONLY
 * shape `--combine` accepts — including the REQUIRED `provisional` flag,
 * combine hard-gate). */
function otherHostFile(
  hostname: string,
  arms: { arm: string; totalKeys: number; presentKeys: number; missingKeys: number; complete: boolean; counts: { tp: number; fp: number; fn: number; tn: number } }[],
  provisional = false,
): string {
  return JSON.stringify({
    hostname,
    scoredAt: "2026-08-03T01:00:00.000Z",
    sample: { cCount: 2, notCCount: 2, total: 4 },
    provisional,
    arms,
  })
}

/** One believable other-host per-arm entry (complete, consistent counts). */
function otherArmEntry(arm: string) {
  return { arm, totalKeys: 2, presentKeys: 2, missingKeys: 0, complete: true, counts: { tp: 1, fp: 0, fn: 1, tn: 0 } }
}

/** Clean full-local fixture: all 4 registered arms, every sampled key
 * classified, no provenance red flags -> local `provisional: false`. Same
 * prediction table as the "provisional: false once all 4 registered arms
 * are present and complete" test above. */
const CLS_CLEAN_PREDS: [string, ClsArmRow["class"]][] = [
  ["c1", "C"],
  ["c2", "C"],
  ["c3", "B"],
  ["c4", "B"],
  ["n1", "B"],
  ["n2", "C"],
  ["n3", "B"],
  ["n4", "B"],
]
function writeAllFourCleanArms(cwd: string): void {
  const root = clsAbRoot(cwd)
  for (const arm of CLS_ALL_ARM_NAMES) {
    writeNdjson(
      path.join(root, clsArmFileName(arm)),
      CLS_CLEAN_PREDS.map(([k, c]) => armRowFor(arm, k, c)),
    )
  }
}

describe("runClsScore --combine", () => {
  test("combine arithmetic: combined counts are the field-wise sum across hosts", () => {
    const cwd = mkRepo()
    // local: single complete arm (haiku-base), 8-key sample.
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "C"), // FP
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])

    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(
      otherPath,
      otherHostFile("other-host", [
        { arm: "haiku-base", totalKeys: 2, presentKeys: 2, missingKeys: 0, complete: true, counts: { tp: 1, fp: 0, fn: 1, tn: 0 } },
      ]),
    )

    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.combined).toBeDefined()

    const combinedHaikuBase = result!.combined!.combined.arms.find((a) => a.arm === "haiku-base")!
    // local haiku-base: predicted C {c1,c2,c3,n2}, actual C {c1,c2,n2} ->
    // tp=3 fp=1 fn=0 tn=4. other: tp=1 fp=0 fn=1 tn=0. summed:
    expect(combinedHaikuBase.totalKeys).toBe(10)
    expect(combinedHaikuBase.complete).toBe(true)
    expect(combinedHaikuBase.counts).toEqual({ tp: 4, fp: 1, fn: 1, tn: 4 })

    // the other 3 registered arms are absent from the LOCAL side entirely
    // -> excluded from the combined arms, reported as combinedAbsentArms.
    expect(result!.combined!.combined.absentArms.sort()).toEqual(
      ["haiku-patched", "sonnet-base", "sonnet-patched"].sort(),
    )
    expect(result!.combined!.combined.decision.scope).toBe("combined")

    // durable artifact written.
    const combinedDest = path.join(root, CLS_COMBINED_NAME)
    expect(fs.existsSync(combinedDest)).toBe(true)
    const parsedCombined = JSON.parse(fs.readFileSync(combinedDest, "utf-8"))
    expect(parsedCombined.other.hostname).toBe("other-host")
    expect(logs.some((l) => l.includes(`wrote ${CLS_COMBINED_NAME}`))).toBe(true)
  })

  test("self-combine refuses cleanly (zero writes, including the per-host score)", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "B"),
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])

    const otherPath = path.join(cwd, "self-cls-score.json")
    fs.writeFileSync(
      otherPath,
      otherHostFile(os.hostname(), [
        { arm: "haiku-base", totalKeys: 2, presentKeys: 2, missingKeys: 0, complete: true, counts: { tp: 1, fp: 0, fn: 1, tn: 0 } },
      ]),
    )

    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && /combine/i.test(l) && /host/i.test(l))).toBe(true)
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
    expect(fs.existsSync(path.join(root, CLS_COMBINED_NAME))).toBe(false)
  })

  test("malformed --combine file refuses cleanly (zero writes)", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "B"),
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])

    const otherPath = path.join(cwd, "garbage-cls-score.json")
    fs.writeFileSync(otherPath, JSON.stringify({ hostname: "other-host", counts: { tp: -1 } }))

    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeUndefined()
    expect(logs.some((l) => l.includes("REFUSING") && /combine/i.test(l))).toBe(true)
    expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
  })

  test("combined-vs-per-host verdict flip: local INCUMBENT-STAYS, combined ADOPT", () => {
    const cwd = mkRepo()
    const root = clsAbRoot(cwd)
    fs.mkdirSync(root, { recursive: true })
    const manifest: ClsManifest = {
      sampledAt: "2026-08-03T00:00:00.000Z",
      hostname: "local-host",
      cCount: 2,
      notCCount: 2,
      keys: { c: ["k1", "k2"], notC: ["k3", "k4"] },
      transportCounts: { c: { cli: 2, sdk: 0 }, notC: { cli: 2, sdk: 0 } },
    }
    fs.writeFileSync(path.join(root, CLS_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")
    // ground truth: k1,k2 = C; k3,k4 = not-C.
    writeNdjson(path.join(root, CLS_LABELS_NAME), [
      labelRow("k1", "C"),
      labelRow("k2", "C"),
      labelRow("k3", "not-C"),
      labelRow("k4", "not-C"),
    ])
    // both local arms predict C at {k1,k3} identically -> tp=1 fp=1 fn=1 tn=1
    // for BOTH incumbent and candidate -> tied F1 -> incumbent wins the tie.
    const localPreds: [string, ClsArmRow["class"]][] = [
      ["k1", "C"],
      ["k2", "B"],
      ["k3", "C"],
      ["k4", "B"],
    ]
    for (const arm of ["haiku-base", "sonnet-patched"]) {
      writeNdjson(
        path.join(root, clsArmFileName(arm)),
        localPreds.map(([k, c]) => armRowFor(arm, k, c)),
      )
    }

    const localOnly = runClsScore(cwd, {}, () => {})
    expect(localOnly).toBeDefined()
    expect(localOnly!.decision.verdict).toBe("INCUMBENT-STAYS")
    expect(localOnly!.decision.winnerArm).toBe("haiku-base")

    // other host: incumbent performs badly (tp=0 fp=2 fn=2 tn=0), candidate
    // performs perfectly (tp=4 fp=0 fn=0 tn=0) -> summed with local, the
    // candidate clears the 0.10 margin AND is missed-C not-worse.
    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(
      otherPath,
      otherHostFile("other-host", [
        { arm: "haiku-base", totalKeys: 4, presentKeys: 4, missingKeys: 0, complete: true, counts: { tp: 0, fp: 2, fn: 2, tn: 0 } },
        { arm: "sonnet-patched", totalKeys: 4, presentKeys: 4, missingKeys: 0, complete: true, counts: { tp: 4, fp: 0, fn: 0, tn: 0 } },
      ]),
    )

    const combinedResult = runClsScore(cwd, { combine: otherPath }, () => {})
    expect(combinedResult).toBeDefined()
    expect(combinedResult!.combined!.combined.decision.verdict).toBe("ADOPT")
    expect(combinedResult!.combined!.combined.decision.winnerArm).toBe("sonnet-patched")
    expect(combinedResult!.combined!.combined.decision.scope).toBe("combined")
  })

  test("--emit-doc targets the COMBINED content once --combine succeeds; per-host decision.scope is per-host", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "B"),
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])

    // per-host --emit-doc run (no combine) — decision.scope is "per-host".
    const perHostDoc = path.join(cwd, "docs-out", "local-cls-score.json")
    const perHostResult = runClsScore(cwd, { emitDoc: perHostDoc }, () => {})
    expect(perHostResult).toBeDefined()
    expect(perHostResult!.decision.scope).toBe("per-host")
    const perHostEmitted = JSON.parse(fs.readFileSync(perHostDoc, "utf-8"))
    expect(perHostEmitted.decision.scope).toBe("per-host")

    // combine run with --emit-doc — the emitted doc is now the COMBINED body.
    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(
      otherPath,
      otherHostFile("other-host", [
        { arm: "haiku-base", totalKeys: 2, presentKeys: 2, missingKeys: 0, complete: true, counts: { tp: 1, fp: 0, fn: 1, tn: 0 } },
      ]),
    )
    const combinedDoc = path.join(cwd, "docs-out", "combined-cls-score.json")
    const combinedResult = runClsScore(cwd, { combine: otherPath, emitDoc: combinedDoc }, () => {})
    expect(combinedResult).toBeDefined()
    const emittedCombined = JSON.parse(fs.readFileSync(combinedDoc, "utf-8"))
    expect(emittedCombined.combined.decision.scope).toBe("combined")
    expect(emittedCombined).not.toHaveProperty("decision") // it's the ClsCombinedFile shape, not ClsScoreFile
  })
})

// ── combine provisional hard-gate ────────────────────────────────────────
// The combined verdict is THE registered verdict (spec §6 / runbook §6) —
// so it must carry its own `provisional` flag, and the other host's file
// must declare one (fail-closed parse: every emitted doc carries the field;
// a file without it is not a cls-score doc).

describe("parseClsScoreCombineFile — provisional hard-gate", () => {
  const validArms = [otherArmEntry("haiku-base")]

  test("missing provisional -> undefined (fail-closed refusal)", () => {
    const raw = JSON.parse(otherHostFile("other-host", validArms)) as Record<string, unknown>
    delete raw.provisional
    expect(parseClsScoreCombineFile(JSON.stringify(raw))).toBeUndefined()
  })

  test("non-boolean provisional -> undefined", () => {
    const raw = JSON.parse(otherHostFile("other-host", validArms)) as Record<string, unknown>
    raw.provisional = "false"
    expect(parseClsScoreCombineFile(JSON.stringify(raw))).toBeUndefined()
  })

  test("provisional: false parses and is carried", () => {
    const parsed = parseClsScoreCombineFile(otherHostFile("other-host", validArms))
    expect(parsed).toBeDefined()
    expect(parsed!.provisional).toBe(false)
  })

  test("provisional: true parses and is carried", () => {
    const parsed = parseClsScoreCombineFile(otherHostFile("other-host", validArms, true))
    expect(parsed).toBeDefined()
    expect(parsed!.provisional).toBe(true)
  })
})

describe("runClsScore --combine — combined provisional hard-gate", () => {
  function allFourOtherArms() {
    return CLS_ALL_ARM_NAMES.map((a) => otherArmEntry(a))
  }

  test("clean case: both hosts non-provisional + all 4 arms combined -> combined provisional false, no warning", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    writeAllFourCleanArms(cwd)
    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(otherPath, otherHostFile("other-host", allFourOtherArms()))
    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.provisional).toBe(false)
    expect(result!.combined!.combined.absentArms).toEqual([])
    // registered-decision object carries provisional: false ONLY here.
    expect(result!.combined!.combined.provisional).toBe(false)
    const parsedCombined = JSON.parse(
      fs.readFileSync(path.join(clsAbRoot(cwd), CLS_COMBINED_NAME), "utf-8"),
    ) as { combined: { provisional: boolean } }
    expect(parsedCombined.combined.provisional).toBe(false)
    expect(logs.some((l) => /PROVISIONAL/.test(l))).toBe(false)
  })

  test("other host provisional -> combined provisional true + WARNING naming the other host", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    writeAllFourCleanArms(cwd)
    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(otherPath, otherHostFile("other-host", allFourOtherArms(), true))
    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.provisional).toBe(false) // local itself is clean
    expect(result!.combined!.combined.provisional).toBe(true)
    expect(logs.some((l) => /WARNING: PROVISIONAL/.test(l) && /other host/i.test(l))).toBe(true)
  })

  test("local run provisional (drifted prompt hash) -> combined provisional true + WARNING naming local", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    writeAllFourCleanArms(cwd)
    const root = clsAbRoot(cwd)
    // F8 repaired: the drift check needs sampled records to rebuild expected
    // prompts — write them, stamp every arm's rows with its variant's
    // correct expected sha, then make ONE haiku-base row stale.
    writeNdjson(
      path.join(root, CLS_RECORDS_NAME),
      CLS_CLEAN_PREDS.map(([k]) => ({ key: k, prompt: "x", floorCheck: "y" })),
    )
    const shaOf = (variant: "base" | "patched") => sha256Hex(buildRefinerPrompt("x", "y", variant))
    for (const arm of CLS_ALL_ARM_NAMES) {
      const variant = parseClsArmName(arm)!.variant
      writeNdjson(
        path.join(root, clsArmFileName(arm)),
        CLS_CLEAN_PREDS.map(([k, c]) => armRowFor(arm, k, c, { promptSha256: shaOf(variant) })),
      )
    }
    // re-write haiku-base with ONE drifted promptSha256 -> local provisional (F8).
    writeNdjson(
      path.join(root, clsArmFileName("haiku-base")),
      CLS_CLEAN_PREDS.map(([k, c], i) =>
        armRowFor("haiku-base", k, c, { promptSha256: i === 0 ? "stale-hash" : shaOf("base") }),
      ),
    )
    const otherPath = path.join(cwd, "other-cls-score.json")
    fs.writeFileSync(otherPath, otherHostFile("other-host", allFourOtherArms()))
    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.provisional).toBe(true)
    expect(result!.combined!.combined.provisional).toBe(true)
    expect(logs.some((l) => /WARNING: PROVISIONAL/.test(l) && /local/.test(l))).toBe(true)
  })

  test("registered arm absent from the combined set -> combined provisional true + WARNING naming the absent arm", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    writeAllFourCleanArms(cwd)
    const otherPath = path.join(cwd, "other-cls-score.json")
    // other host claims provisional: false but lists only 3 of the 4
    // registered arms -> the absent-arm clause must still flag the combine.
    fs.writeFileSync(
      otherPath,
      otherHostFile("other-host", ["haiku-base", "haiku-patched", "sonnet-base"].map((a) => otherArmEntry(a))),
    )
    const logs: string[] = []
    const result = runClsScore(cwd, { combine: otherPath }, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.provisional).toBe(false) // local itself is clean
    expect(result!.combined!.combined.absentArms).toEqual(["sonnet-patched"])
    expect(result!.combined!.combined.provisional).toBe(true)
    expect(logs.some((l) => /WARNING: PROVISIONAL/.test(l) && /absent/i.test(l) && /sonnet-patched/.test(l))).toBe(true)
  })
})

// ── runClsScore provenance warnings (fix-wave F8/F9) ──────────────────────

describe("runClsScore — provenance warnings (mixed prompt hash / model-variant mismatch)", () => {
  /** F8 repaired (2026-08-10): drift semantics. Fixture writes REAL sampled
   * records and stamps each row with the sha the CURRENT builder produces
   * for that record — except one row, which carries a stale hash (as if the
   * record text or the rubric changed after the run). Only that row drifts. */
  test("F8 repaired: one row's promptSha256 differing from the current record's expected build -> mixedPrompt true + warning + provisional", () => {
    const cwd = mkRepo()
    const { keys } = setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const records = keys.map((k) => ({ key: k, prompt: `prompt for ${k}`, floorCheck: `check-${k}` }))
    writeNdjson(path.join(root, CLS_RECORDS_NAME), records)
    const shaFor = (k: string) =>
      sha256Hex(buildRefinerPrompt(`prompt for ${k}`, `check-${k}`, "base"))
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C", { promptSha256: shaFor("c1") }),
      armRowFor("haiku-base", "c2", "C", { promptSha256: "stale-hash-from-old-rubric" }), // drifted
      armRowFor("haiku-base", "c3", "B", { promptSha256: shaFor("c3") }),
      armRowFor("haiku-base", "c4", "B", { promptSha256: shaFor("c4") }),
      armRowFor("haiku-base", "n1", "B", { promptSha256: shaFor("n1") }),
      armRowFor("haiku-base", "n2", "C", { promptSha256: shaFor("n2") }),
      armRowFor("haiku-base", "n3", "B", { promptSha256: shaFor("n3") }),
      armRowFor("haiku-base", "n4", "B", { promptSha256: shaFor("n4") }),
    ])
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    const haikuBase = result!.arms.find((a) => a.arm === "haiku-base")!
    expect(haikuBase.mixedPrompt).toBe(true)
    expect(result!.provisional).toBe(true)
    expect(logs.some((l) => /WARNING/.test(l) && /drift/i.test(l) && /haiku-base/.test(l))).toBe(true)
  })

  /** THE ANTI-VACUITY PIN (the repaired check's reason to exist): a complete
   * arm whose rows all carry their own record's CORRECT expected sha — 8
   * DISTINCT hash values, which the pre-repair check flagged as mixed on
   * every real run — must NOT fire the flag. */
  test("F8 repaired: distinct-but-correct per-record hashes -> mixedPrompt false (vacuity regression pin)", () => {
    const cwd = mkRepo()
    const { keys } = setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    const records = keys.map((k) => ({ key: k, prompt: `prompt for ${k}`, floorCheck: `check-${k}` }))
    writeNdjson(path.join(root, CLS_RECORDS_NAME), records)
    const shaFor = (k: string) =>
      sha256Hex(buildRefinerPrompt(`prompt for ${k}`, `check-${k}`, "base"))
    const rows = keys.map((k) => armRowFor("haiku-base", k, "B", { promptSha256: shaFor(k) }))
    expect(new Set(rows.map((r) => r.promptSha256)).size).toBe(8) // genuinely distinct
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), rows)
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    expect(result!.arms.find((a) => a.arm === "haiku-base")!.mixedPrompt).toBe(false)
    expect(logs.some((l) => /drift/i.test(l) && /haiku-base/.test(l))).toBe(false)
  })

  test("F8 repaired: labels row drifting from the current record's expected build -> stdout warning (no dedicated field)", () => {
    const cwd = mkRepo()
    const root = clsAbRoot(cwd)
    fs.mkdirSync(root, { recursive: true })
    const manifest: ClsManifest = {
      sampledAt: "2026-08-03T00:00:00.000Z",
      hostname: "h",
      cCount: 1,
      notCCount: 1,
      keys: { c: ["c1"], notC: ["n1"] },
      transportCounts: { c: { cli: 1, sdk: 0 }, notC: { cli: 1, sdk: 0 } },
    }
    fs.writeFileSync(path.join(root, CLS_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")
    writeNdjson(path.join(root, CLS_RECORDS_NAME), [
      { key: "c1", prompt: "p-c1", floorCheck: "f-c1" },
      { key: "n1", prompt: "p-n1", floorCheck: "f-n1" },
    ])
    writeNdjson(path.join(root, CLS_LABELS_NAME), [
      labelRow("c1", "C", { promptSha256: sha256Hex(buildLabelPrompt("p-c1", "f-c1")) }), // correct
      labelRow("n1", "not-C", { promptSha256: "stale-hash" }), // drifted
    ])
    const logs: string[] = []
    runClsScore(cwd, {}, (m) => logs.push(m))
    expect(logs.some((l) => /WARNING/.test(l) && /drift/i.test(l) && /labels/i.test(l))).toBe(true)
  })

  test("F9: rows whose model/promptVariant does not match the arm filename's expected literal -> mismatchedRows counted + reported + provisional", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("sonnet-patched")), [
      armRowFor("sonnet-patched", "c1", "C"),
      armRowFor("sonnet-patched", "c2", "C", { model: CLS_ARM_MODEL_LITERALS.haiku }), // wrong model
      armRowFor("sonnet-patched", "c3", "B", { promptVariant: "base" }), // wrong variant
      armRowFor("sonnet-patched", "c4", "B"),
      armRowFor("sonnet-patched", "n1", "B"),
      armRowFor("sonnet-patched", "n2", "C"),
      armRowFor("sonnet-patched", "n3", "B"),
      armRowFor("sonnet-patched", "n4", "B"),
    ])
    const logs: string[] = []
    const result = runClsScore(cwd, {}, (m) => logs.push(m))
    expect(result).toBeDefined()
    const sonnetPatched = result!.arms.find((a) => a.arm === "sonnet-patched")!
    expect(sonnetPatched.mismatchedRows).toBe(2)
    expect(result!.provisional).toBe(true)
    expect(logs.some((l) => /WARNING/.test(l) && /sonnet-patched/.test(l) && /2 row/.test(l))).toBe(true)
  })
})

// ── runClsScore lock discipline over the write phase (fix-wave F12) ──────

describe("runClsScore — write phase is lock-guarded (reads stay lock-free)", () => {
  test("a live lock (concurrent cls-run/cls-label/cls-sample) refuses cleanly, zero writes", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "B"),
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])

    expect(acquireClsAbLock(cwd)).toBe(true)
    try {
      const logs: string[] = []
      const result = runClsScore(cwd, {}, (m) => logs.push(m))
      expect(result).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      expect(fs.existsSync(path.join(root, CLS_SCORE_NAME))).toBe(false)
    } finally {
      releaseClsAbLock(cwd)
    }
  })

  test("the lock is released after a successful score (no leftover lockfile)", () => {
    const cwd = mkRepo()
    setupBasicExperiment(cwd)
    const root = clsAbRoot(cwd)
    writeNdjson(path.join(root, clsArmFileName("haiku-base")), [
      armRowFor("haiku-base", "c1", "C"),
      armRowFor("haiku-base", "c2", "C"),
      armRowFor("haiku-base", "c3", "B"),
      armRowFor("haiku-base", "c4", "B"),
      armRowFor("haiku-base", "n1", "B"),
      armRowFor("haiku-base", "n2", "C"),
      armRowFor("haiku-base", "n3", "B"),
      armRowFor("haiku-base", "n4", "B"),
    ])
    expect(runClsScore(cwd, {}, () => {})).toBeDefined()
    expect(fs.existsSync(path.join(cwd, CLS_AB_LOCK_REL))).toBe(false)
  })
})

describe("parseClsScoreArgs", () => {
  test("defaults: no --emit-doc/--combine, cwd from positional", () => {
    expect(parseClsScoreArgs(["/some/repo"])).toEqual({
      cwd: "/some/repo",
      emitDoc: undefined,
      combine: undefined,
      unknownFlag: undefined,
    })
  })

  test("--emit-doc extracted", () => {
    expect(parseClsScoreArgs(["/some/repo", "--emit-doc", "/out/x.json"])).toEqual({
      cwd: "/some/repo",
      emitDoc: "/out/x.json",
      combine: undefined,
      unknownFlag: undefined,
    })
  })

  // fix-wave F3.
  test("--combine extracted", () => {
    expect(parseClsScoreArgs(["/some/repo", "--combine", "/other/host-cls-score.json"])).toEqual({
      cwd: "/some/repo",
      emitDoc: undefined,
      combine: "/other/host-cls-score.json",
      unknownFlag: undefined,
    })
  })

  // fix-wave F17: unrecognized flag captured, never swallowed into cwd.
  test("unknown flag captured, never becomes the cwd positional", () => {
    expect(parseClsScoreArgs(["--typo", "/some/repo"])).toEqual({
      cwd: "/some/repo",
      emitDoc: undefined,
      combine: undefined,
      unknownFlag: "--typo",
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
