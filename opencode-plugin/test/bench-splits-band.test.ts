import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { makeBenchPaths } from "../src/bench/paths.ts"
import {
  taskPassRates,
  bandPartition,
  loadActiveSplit,
  splitHash,
  resumeIdentCheck,
  filterTaskResults,
  sentinelRegressionReject,
  abDecision,
  cmdSplit,
  type PhaseTaggedTaskResults,
} from "../src/bench/splits.ts"
import {
  DEFAULT_DECISION_CONFIG,
  DEFAULT_SPEED_TIEBREAK_CONFIG,
  decide,
  pairedRunStats,
  mcnemarExactOneSided,
  type DecisionConfig,
  type PairStats,
} from "../src/bench/ab-stats.ts"
import { BenchError } from "../src/bench/util.ts"

// Ported from term-bench2/test_splits_band.py — see that file for the
// original vectors and comments.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-splits-"))
}

function fakeBenchPaths(termBenchDir: string): BenchPaths {
  return {
    metaRoot: path.dirname(termBenchDir),
    termBenchDir,
    tbRoot: path.join(termBenchDir, "tb-root-unused"),
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

function agentResults(dir: string, name: string, tasks: Record<string, number[]>): string {
  const p = path.join(dir, name)
  const t: Record<string, { rewards: number[] }> = {}
  for (const [k, v] of Object.entries(tasks)) t[k] = { rewards: v }
  fs.writeFileSync(p, JSON.stringify({ label: name, model: "m", tasks: t }))
  return p
}

function oracleResults(dir: string, name: string, tasks: Record<string, number>): string {
  const p = path.join(dir, name)
  const t: Record<string, { reward: number }> = {}
  for (const [k, v] of Object.entries(tasks)) t[k] = { reward: v }
  fs.writeFileSync(p, JSON.stringify({ tasks: t }))
  return p
}

// ── taskPassRates ────────────────────────────────────────────────────────

test("taskPassRates merges both shapes (rewards[] pooled with scalar reward)", () => {
  const dir = tmpDir()
  const a = agentResults(dir, "a.json", { t1: [1, 0], t2: [1, 1] })
  const o = oracleResults(dir, "o.json", { t1: 1, t3: 0 })
  const rates = taskPassRates([a, o])
  expect(rates.t1).toBeCloseTo(2 / 3, 9) // pooled: [1,0] + [1]
  expect(rates.t2).toBe(1.0)
  expect(rates.t3).toBe(0.0)
})

// ── bandPartition ────────────────────────────────────────────────────────

test("bandPartition: pool/sentinels/excluded, unknown stays in pool, deterministic under seed", () => {
  const tasks = ["easy1", "easy2", "easy3", "easy4", "mid1", "mid2", "hard0", "unknown"]
  const rates = {
    easy1: 1.0, easy2: 0.95, easy3: 0.9, easy4: 1.0,
    mid1: 0.5, mid2: 0.3, hard0: 0.0,
  }
  const [pool, sentinels, excluded] = bandPartition(tasks, rates, 0.2, 0.8, 0.9, 2, 42)
  expect(new Set(pool)).toEqual(new Set(["mid1", "mid2", "unknown"]))
  expect(sentinels.length).toBe(2)
  for (const s of sentinels) expect(["easy1", "easy2", "easy3", "easy4"]).toContain(s)
  expect(excluded).toContain("hard0")
  const union = new Set([...excluded, ...sentinels, ...pool])
  expect(union).toEqual(new Set(tasks))
  // deterministic under the same seed
  const [, sentinels2] = bandPartition(tasks, rates, 0.2, 0.8, 0.9, 2, 42)
  expect(sentinels2).toEqual(sentinels)
})

// ── cmd_split make (with/without --results band filtering) ──────────────

test("split make --results writes schemaVersion 2 with band/sentinels/excluded", () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, "tasks.txt"), "mid1\nmid2\nmid3\nmid4\neasy1\neasy2\nhard0\n")
  const res = agentResults(dir, "base.json", {
    mid1: [1, 0], mid2: [0, 1], mid3: [1, 0], mid4: [0, 1],
    easy1: [1, 1], easy2: [1, 1], hard0: [0, 0],
  })
  const out = path.join(dir, "splits.json")
  const paths = fakeBenchPaths(dir)
  cmdSplit(paths, {
    splitCmd: "make", source: "tasks.txt", folds: 2, seed: 1, splitFile: out,
    results: [res], band: "0.2,0.8", sentinels: 2, sentinelHi: 0.9,
  })
  const d = JSON.parse(fs.readFileSync(out, "utf-8"))
  expect(d.schemaVersion).toBe(2)
  expect(new Set(d.sentinels)).toEqual(new Set(["easy1", "easy2"]))
  expect(d.excluded).toContain("hard0")
  const foldTasks = d.folds.flat()
  expect(new Set(foldTasks)).toEqual(new Set(["mid1", "mid2", "mid3", "mid4"])) // pool only
  expect(d.band).toEqual([0.2, 0.8])
})

test("split make without --results stays schemaVersion 1, no sentinels/band", () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, "tasks.txt"), "a\nb\nc\nd\n")
  const out = path.join(dir, "splits.json")
  const paths = fakeBenchPaths(dir)
  cmdSplit(paths, { splitCmd: "make", source: "tasks.txt", folds: 2, splitFile: out })
  const d = JSON.parse(fs.readFileSync(out, "utf-8"))
  expect(d.schemaVersion).toBe(1)
  expect(d.sentinels).toBeUndefined()
  expect(d.band).toBeUndefined()
})

test("split make malformed --band dies for all three bad forms", () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, "tasks.txt"), "a\nb\n")
  const res = oracleResults(dir, "r.json", { a: 1, b: 0 })
  const paths = fakeBenchPaths(dir)
  for (const bad of ["foo", "0.8,0.2", "1,2,3"]) {
    expect(() =>
      cmdSplit(paths, {
        splitCmd: "make", source: "tasks.txt", splitFile: path.join(dir, "s.json"),
        results: [res], band: bad,
      }),
    ).toThrow(BenchError)
  }
})

// ── load_active_split sentinels ──────────────────────────────────────────

test("loadActiveSplit appends sentinels after fold, fold-first", () => {
  const dir = tmpDir()
  const p = path.join(dir, "splits.json")
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 2, seed: 1, source: "x",
    folds: [["a", "b"], ["c", "d"]], activeFold: 0, rotatedAt: null,
    band: [0.2, 0.8], sentinels: ["easy1", "easy2"], excluded: [],
  }))
  const { heldIn, heldOut, meta } = loadActiveSplit(p)
  expect(heldIn).toEqual(["c", "d"])
  expect(heldOut).toEqual(["a", "b", "easy1", "easy2"])
  expect(meta.sentinels).toEqual(["easy1", "easy2"])
})

test("loadActiveSplit v1 has no sentinels", () => {
  const dir = tmpDir()
  const p = path.join(dir, "splits.json")
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1, seed: 1, source: "x",
    folds: [["a"], ["b"]], activeFold: 1, rotatedAt: null,
  }))
  const { heldIn, heldOut, meta } = loadActiveSplit(p)
  expect(heldOut).toEqual(["b"])
  expect(meta.sentinels).toEqual([])
  expect(heldIn).toEqual(["a"])
})

test("loadActiveSplit dedupes a sentinel already in the active fold", () => {
  const dir = tmpDir()
  const p = path.join(dir, "splits.json")
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 2, seed: 1, source: "x",
    folds: [["a", "b"], ["c", "sent1"]], activeFold: 1, rotatedAt: null,
    band: [0.2, 0.8], sentinels: ["sent1", "other"], excluded: [],
  }))
  const { heldIn, heldOut } = loadActiveSplit(p)
  expect(heldOut).toEqual(["c", "sent1", "other"])
  expect(heldOut.filter((t) => t === "sent1").length).toBe(1)
  expect(heldIn).not.toContain("sent1")
})

test("split show prints sentinel line", () => {
  const dir = tmpDir()
  const p = path.join(dir, "splits.json")
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 2, seed: 1, source: "x",
    folds: [["a", "b"], ["c", "d"]], activeFold: 0, rotatedAt: null,
    band: [0.2, 0.8], sentinels: ["easy1", "easy2"], excluded: [],
  }))
  const paths = fakeBenchPaths(dir)
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(" "))
  try {
    cmdSplit(paths, { splitCmd: "show", splitFile: p })
  } finally {
    console.log = origLog
  }
  expect(logs.join("\n")).toContain("sentinels (2): easy1, easy2")
})

test("split show omits sentinel line when there are none", () => {
  const dir = tmpDir()
  const p = path.join(dir, "splits.json")
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1, seed: 1, source: "x",
    folds: [["a"], ["b"]], activeFold: 0, rotatedAt: null,
  }))
  const paths = fakeBenchPaths(dir)
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(" "))
  try {
    cmdSplit(paths, { splitCmd: "show", splitFile: p })
  } finally {
    console.log = origLog
  }
  expect(logs.join("\n")).not.toContain("sentinels")
})

// ── stratified held-out gate (dilution fix) ─────────────────────────────

test("sentinel dilution: pooled would accept but fold-only rejects (crux vector)", () => {
  const heldInResults: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInResults[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [1], active: [0] }
  }
  // 3 fold tasks, 18 run-pairs total, one net discordant pair favouring
  // active -> delta = -1/18 ~= -0.0556, just past the default 0.05 margin.
  const foldResults: PhaseTaggedTaskResults = {
    fold_a: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_b: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_c: { phase: "held-out", sentinel: false, candidate: [1, 1, 1, 1, 1, 0], active: Array(6).fill(1) },
  }
  // 3 concordant-pass sentinels: inflate n_pairs without moving b/c.
  const sentinelResults: PhaseTaggedTaskResults = {}
  for (const x of ["a", "b", "c"]) {
    sentinelResults[`sent_${x}`] = { phase: "held-out", sentinel: true, candidate: [1], active: [1] }
  }
  const taskResults: PhaseTaggedTaskResults = { ...heldInResults, ...foldResults, ...sentinelResults }
  const cfg = DEFAULT_DECISION_CONFIG // alpha=0.05, nonregressMargin=0.05

  const hiStats = pairedRunStats(filterTaskResults(taskResults, "held-in"))

  const foldOnly = filterTaskResults(taskResults, "held-out", false)
  const hoFoldStats = pairedRunStats(foldOnly)
  expect(hoFoldStats.delta).toBeLessThan(-cfg.nonregressMargin) // marginal regression

  const pooled = filterTaskResults(taskResults, "held-out") // sentinel=undefined -> no filter
  const hoPooledStats = pairedRunStats(pooled)
  expect(hoPooledStats.delta).toBeGreaterThanOrEqual(-cfg.nonregressMargin) // dilution "fixes" it away — the bug

  const foldDecision = decide(hiStats, hoFoldStats, cfg)
  const pooledDecision = decide(hiStats, hoPooledStats, cfg)

  expect(pooledDecision.decision).toBe("accept") // what the OLD pooled gate would wrongly do
  expect(foldDecision.decision).toBe("reject") // what the stratified gate correctly does
  expect(foldDecision.reasons.some((r) => r.includes("held-out regression"))).toBe(true)
})

test("sentinel-only regression forces reject", () => {
  const hoSentinel: PairStats = {
    nTasks: 3, nPairs: 3, b: 0, c: 3, candPass: 0, actPass: 3,
    delta: -1.0, taskDeltas: { s1: -1.0, s2: -1.0, s3: -1.0 },
  }
  const [decision, reasons] = sentinelRegressionReject(
    "accept", ["accept: held-in significant win, held-out non-regress"], hoSentinel, 0.05,
  )
  expect(decision).toBe("reject")
  expect(reasons).toContain("sentinel regression")
})

test("sentinel regression guard is a no-op when there's no regression (incl. null hoSentinel)", () => {
  const hoSentinel: PairStats = {
    nTasks: 3, nPairs: 3, b: 0, c: 0, candPass: 3, actPass: 3,
    delta: 0.0, taskDeltas: { s1: 0.0, s2: 0.0, s3: 0.0 },
  }
  const [decision, reasons] = sentinelRegressionReject("accept", ["ok"], hoSentinel, 0.05)
  expect(decision).toBe("accept")
  expect(reasons).toEqual(["ok"])

  const [decision2, reasons2] = sentinelRegressionReject("accept", ["ok"], null, 0.05)
  expect(decision2).toBe("accept")
  expect(reasons2).toEqual(["ok"])
})

// ── ab_decision — pins the fold-only gate wiring ─────────────────────────

test("abDecision: fold-only wiring rejects marginal regression despite sentinel dilution", () => {
  const heldInResults: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInResults[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [1], active: [0] }
  }
  const foldResults: PhaseTaggedTaskResults = {
    fold_a: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_b: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_c: { phase: "held-out", sentinel: false, candidate: [1, 1, 1, 1, 1, 0], active: Array(6).fill(1) },
  }
  const sentinelResults: PhaseTaggedTaskResults = {}
  for (const x of ["a", "b", "c"]) {
    sentinelResults[`sent_${x}`] = { phase: "held-out", sentinel: true, candidate: [1], active: [1] }
  }
  const taskResults: PhaseTaggedTaskResults = { ...heldInResults, ...foldResults, ...sentinelResults }
  const cfg = DEFAULT_DECISION_CONFIG

  const [decision, reasons, , ho, hoSentinel] = abDecision(
    taskResults, cfg, false, Object.keys(foldResults), Object.keys(sentinelResults),
  )

  const pooled = pairedRunStats(filterTaskResults(taskResults, "held-out"))
  expect(pooled.delta).toBeGreaterThanOrEqual(-cfg.nonregressMargin) // pooled "fixes" it away — the bug
  expect(ho!.delta).toBeLessThan(-cfg.nonregressMargin) // fold-only still shows the regression

  expect(decision).toBe("reject")
  expect(reasons.some((r) => r.includes("held-out regression"))).toBe(true)
  expect(hoSentinel).not.toBeNull()
  expect(hoSentinel!.delta).toBe(0.0) // sentinels themselves concordant
})

test("abDecision: sentinel regression forces reject over would-be accept", () => {
  const heldInResults: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInResults[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [1], active: [0] }
  }
  const foldResults: PhaseTaggedTaskResults = {
    fold_a: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_b: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
  }
  const sentinelResults: PhaseTaggedTaskResults = {}
  for (const x of ["a", "b", "c"]) {
    sentinelResults[`sent_${x}`] = { phase: "held-out", sentinel: true, candidate: [0], active: [1] }
  }
  const taskResults: PhaseTaggedTaskResults = { ...heldInResults, ...foldResults, ...sentinelResults }
  const cfg = DEFAULT_DECISION_CONFIG

  const [decision, reasons] = abDecision(
    taskResults, cfg, false, Object.keys(foldResults), Object.keys(sentinelResults),
  )

  expect(reasons.some((r) => r.includes("accept: held-in significant win"))).toBe(true) // decide() itself said accept
  expect(decision).toBe("reject") // sentinel override wins
  expect(reasons).toContain("sentinel regression")
})

test("abDecision: early-stopped forces reject over would-be accept", () => {
  const heldInResults: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInResults[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [1], active: [0] }
  }
  const foldResults: PhaseTaggedTaskResults = {
    fold_a: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
    fold_b: { phase: "held-out", sentinel: false, candidate: Array(6).fill(1), active: Array(6).fill(1) },
  }
  const taskResults: PhaseTaggedTaskResults = { ...heldInResults, ...foldResults }
  const cfg = DEFAULT_DECISION_CONFIG

  const [decision, reasons, , , hoSentinel] = abDecision(
    taskResults, cfg, true, Object.keys(foldResults), [],
  )

  expect(reasons.some((r) => r.includes("accept: held-in significant win"))).toBe(true)
  expect(decision).toBe("reject") // early-stop override wins
  expect(reasons).toContain("early-stopped on futility")
  expect(hoSentinel).toBeNull()
})

// ── abDecision speed tiebreak (task-3-brief.md, Phase 3 W1c) ────────────
//
// Shared fixture shape: held-in is a set of concordant both-pass pairs
// (candidate == active reward) so decide() always lands on "inconclusive:
// held-in win not significant" (delta=0, b=c=0) — the ONLY decision the
// tiebreak is allowed to touch. `fastHeldIn` attaches elapsed data so
// pairedSpeedStats has real both-pass pairs to score; `foldResults` is a
// clean (non-regressing) held-out fold so `ho !== null` and no held-out
// regression fires first.

function fastHeldIn(n: number, candMs: number, actMs: number, prefix = "fast"): PhaseTaggedTaskResults {
  const out: PhaseTaggedTaskResults = {}
  for (let i = 0; i < n; i++) {
    out[`${prefix}${i}`] = {
      phase: "held-in",
      sentinel: false,
      candidate: [1],
      active: [1],
      candidateElapsed: [candMs],
      activeElapsed: [actMs],
    }
  }
  return out
}

const cleanFold: PhaseTaggedTaskResults = {
  fold_a: { phase: "held-out", sentinel: false, candidate: [1, 1], active: [1, 1] },
  fold_b: { phase: "held-out", sentinel: false, candidate: [1, 1], active: [1, 1] },
}

const speedCfg: DecisionConfig = { ...DEFAULT_DECISION_CONFIG, speedTiebreak: DEFAULT_SPEED_TIEBREAK_CONFIG }

test("abDecision: speed tiebreak upgrades inconclusive -> accept when all guards + thresholds hold", () => {
  // 8 held-in pairs, candidate uniformly faster (5 vs 10 -> ratio 0.5,
  // fasterB=8/slowerC=0 -> signTestP = 1/256), reward-concordant so decide()
  // alone would say "inconclusive".
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(8, 5, 10), ...cleanFold }

  const withoutTiebreak = abDecision(taskResults, DEFAULT_DECISION_CONFIG, false, Object.keys(cleanFold), [])
  expect(withoutTiebreak[0]).toBe("inconclusive") // sanity: decide() alone never accepts this fixture

  const [decision, reasons] = abDecision(taskResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(decision).toBe("accept")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(true)
})

test("abDecision: speed tiebreak never fires on a decision other than inconclusive (accept/reject untouched)", () => {
  // Held-in significant WIN (decide() itself says accept) — speed tiebreak
  // guard 1 (decision === 'inconclusive') must be a no-op here; the ordinary
  // accept path (not the tiebreak reason) is what fires.
  const heldInWin: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInWin[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [1], active: [0] }
  }
  const acceptResults: PhaseTaggedTaskResults = { ...heldInWin, ...cleanFold }
  const [acceptDecision, acceptReasons] = abDecision(acceptResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(acceptDecision).toBe("accept")
  expect(acceptReasons.some((r) => r.includes("speed tiebreak"))).toBe(false)

  // Held-in significant LOSS (decide() itself says reject) — must stay reject.
  const heldInLoss: PhaseTaggedTaskResults = {}
  for (let i = 0; i < 6; i++) {
    heldInLoss[`hi${i}`] = { phase: "held-in", sentinel: false, candidate: [0], active: [1] }
  }
  const rejectResults: PhaseTaggedTaskResults = { ...heldInLoss, ...cleanFold }
  const [rejectDecision, rejectReasons] = abDecision(rejectResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(rejectDecision).toBe("reject")
  expect(rejectReasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked when earlyStopped, even with qualifying speed", () => {
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(8, 5, 10), ...cleanFold }
  const [decision, reasons] = abDecision(taskResults, speedCfg, true, Object.keys(cleanFold), [])
  expect(decision).toBe("reject") // early-stop override wins, never "accept"
  expect(reasons).toContain("early-stopped on futility")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked in LEGACY mode (ho === null), structural, never manufactures an accept", () => {
  // No held-out tasks at all -> foldOutTasks=[] -> abDecision's own `ho` is
  // null (mirrors cmd-ab.ts's explicit-mode --tasks/--task-file/--all path).
  const taskResults: PhaseTaggedTaskResults = fastHeldIn(8, 5, 10)
  const [decision, reasons, , ho] = abDecision(taskResults, speedCfg, false, [], [])
  expect(ho).toBeNull()
  expect(decision).toBe("inconclusive") // never "accept" — decide() itself already forces this, tiebreak must agree
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked when held-in delta < 0, even with qualifying speed", () => {
  // One discordant pair favouring active (not significant: mcnemarExactOneSided(1,0)=0.5),
  // so decide() still lands on "inconclusive" but hi.delta = (2-3)/3 < 0.
  const heldIn: PhaseTaggedTaskResults = {
    lose: { phase: "held-in", sentinel: false, candidate: [0], active: [1] },
  }
  const taskResults: PhaseTaggedTaskResults = { ...heldIn, ...fastHeldIn(8, 5, 10), ...cleanFold }
  const [decision, reasons, hi] = abDecision(taskResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(hi.delta).toBeLessThan(0)
  expect(decision).toBe("inconclusive")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked when nPairs < minBothPassPairs", () => {
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(7, 5, 10), ...cleanFold } // 7 < 8
  const [decision, reasons] = abDecision(taskResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(decision).toBe("inconclusive")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked when signTestP > alpha (medianRatio would otherwise qualify)", () => {
  // 5 fast (ratio 0.5) + 3 slow (ratio 1.5) -> b=5,c=3 -> signTestP =
  // mcnemarExactOneSided(5,3) (well above 0.05); medianRatio (4th/5th of 8
  // sorted) = 0.5, which alone WOULD qualify -- isolates the p condition.
  const taskResults: PhaseTaggedTaskResults = {
    ...fastHeldIn(5, 5, 10, "fast"), // ratio 0.5, faster
    ...fastHeldIn(3, 15, 10, "slow"), // ratio 1.5, slower
    ...cleanFold,
  }
  const p = mcnemarExactOneSided(5, 3)
  expect(p).toBeGreaterThan(speedCfg.speedTiebreak!.alpha)
  const [decision, reasons] = abDecision(taskResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(decision).toBe("inconclusive")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak guard — blocked when medianRatio > maxMedianRatio (signTestP would otherwise qualify)", () => {
  // All 8 pairs faster (b=8,c=0 -> signTestP = 1/256, well under 0.05) but
  // only marginally (ratio 0.9 > 0.8 threshold) -- isolates the ratio condition.
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(8, 9, 10), ...cleanFold }
  const [decision, reasons] = abDecision(taskResults, speedCfg, false, Object.keys(cleanFold), [])
  expect(decision).toBe("inconclusive")
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(false)
})

test("abDecision: speed tiebreak — sentinel-regression reject still runs last and can override a tiebreak accept", () => {
  const sentinelResults: PhaseTaggedTaskResults = {}
  for (const x of ["a", "b", "c"]) {
    sentinelResults[`sent_${x}`] = { phase: "held-out", sentinel: true, candidate: [0], active: [1] }
  }
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(8, 5, 10), ...cleanFold, ...sentinelResults }
  const [decision, reasons] = abDecision(
    taskResults,
    speedCfg,
    false,
    Object.keys(cleanFold),
    Object.keys(sentinelResults),
  )
  expect(reasons.some((r) => r.includes("speed tiebreak"))).toBe(true) // tiebreak DID fire
  expect(decision).toBe("reject") // but sentinel regression has the last word
  expect(reasons).toContain("sentinel regression")
})

test("abDecision: --speed-tiebreak flag OFF (cfg.speedTiebreak undefined) is byte-identical to pre-feature decide()-only decisions", () => {
  const taskResults: PhaseTaggedTaskResults = { ...fastHeldIn(8, 5, 10), ...cleanFold }
  const withFlagOff = abDecision(taskResults, DEFAULT_DECISION_CONFIG, false, Object.keys(cleanFold), [])
  const decideOnly = decide(
    pairedRunStats(filterTaskResults(taskResults, "held-in")),
    pairedRunStats(filterTaskResults(taskResults, "held-out", false)),
    DEFAULT_DECISION_CONFIG,
  )
  expect(withFlagOff[0]).toBe(decideOnly.decision)
  expect(withFlagOff[1]).toEqual(decideOnly.reasons) // no speed-tiebreak reason appended
  expect(withFlagOff[0]).toBe("inconclusive") // sanity: same fixture upgrades under speedCfg above
})

// ── --resume split fingerprint (splitHash) ──────────────────────────────

test("splitHash is deterministic and order-invariant", () => {
  const h1 = splitHash(["b", "a"], ["d", "c"])
  const h2 = splitHash(["a", "b"], ["c", "d"])
  expect(h1).toBe(h2) // sorted internally -> order doesn't matter
  expect(h1.length).toBe(12)
})

test("splitHash changes with composition", () => {
  const h1 = splitHash(["a", "b"], ["c", "d"])
  const h2 = splitHash(["a", "b"], ["c", "e"]) // regenerated split, one task swapped
  expect(h1).not.toBe(h2)
})

test("resumeIdentCheck passes when matching", () => {
  const runIdent = {
    layer: "project-global", candidate: "v3", baseline: "v2",
    model: "m", k: 2, activeFold: 0, splitHash: "abc123",
  }
  const prev = { ...runIdent }
  expect(() => resumeIdentCheck(prev, runIdent)).not.toThrow()
})

test("resumeIdentCheck dies on splitHash mismatch", () => {
  const runIdent = {
    layer: "project-global", candidate: "v3", baseline: "v2",
    model: "m", k: 2, activeFold: 0, splitHash: "abc123",
  }
  const prev = { ...runIdent, splitHash: "old999" }
  expect(() => resumeIdentCheck(prev, runIdent)).toThrow(BenchError)
})

test("resumeIdentCheck dies on any other field mismatch", () => {
  const runIdent = {
    layer: "project-global", candidate: "v3", baseline: "v2",
    model: "m", k: 2, activeFold: 0, splitHash: "abc123",
  }
  const prev = { ...runIdent, model: "different-model" }
  expect(() => resumeIdentCheck(prev, runIdent)).toThrow(BenchError)
})

// ── cross-driver --resume refusal (task-B3-brief.md) ──────────────────────
// cmd-ab.ts's runIdent now carries `driver: driver.id`; resumeIdentCheck
// compares every runIdent key against the prior partial's value generically
// (no driver-specific code needed), so a partial written by one driver
// refuses to resume under a different one automatically. DRIVER_IDS only
// has "opencode" at this point in the track (claude-code lands in B5), so
// this is exercised at the resumeIdentCheck unit level with a synthetic
// ident diff, matching the pattern of the two tests above.

test("resumeIdentCheck dies on a driver mismatch (cross-driver --resume refusal)", () => {
  const runIdent = {
    layer: "project-global", candidate: "v3", baseline: "v2",
    model: "m", k: 2, activeFold: 0, splitHash: "abc123", driver: "opencode",
  }
  const prev = { ...runIdent, driver: "claude-code" }
  expect(() => resumeIdentCheck(prev, runIdent)).toThrow(BenchError)
})

test("resumeIdentCheck passes when driver matches (same-driver --resume allowed)", () => {
  const runIdent = {
    layer: "project-global", candidate: "v3", baseline: "v2",
    model: "m", k: 2, activeFold: 0, splitHash: "abc123", driver: "opencode",
  }
  const prev = { ...runIdent }
  expect(() => resumeIdentCheck(prev, runIdent)).not.toThrow()
})

// ── real committed splits.json fixture (read-only!) ─────────────────────
//
// term-bench2/splits.json is the live oracle-gate fixture: read-only in this
// task. The expected hash below was hand-verified against Python's exact
// serialization (`json.dumps(sorted(held_in) + ["|"] + sorted(held_out))`,
// default ", " separators) via a one-off `python3 -c` computation over the
// real file — see task-5-report.md for the transcript.

test("loadActiveSplit + splitHash against the real committed term-bench2/splits.json", () => {
  const paths = makeBenchPaths()
  const { heldIn, heldOut, meta } = loadActiveSplit(paths.splitsFile)
  expect(meta.activeFold).toBe(0)
  expect(heldIn.length).toBe(27)
  expect(heldOut.length).toBe(13) // 10 fold + 3 sentinels, no overlap in fold 0
  expect(heldOut).toContain("constraints-scheduling")
  expect(heldOut).toContain("circuit-fibsqrt")
  expect(heldOut).toContain("code-from-image")
  const h = splitHash(heldIn, heldOut)
  expect(h).toBe("e064bd5d6b06")
  expect(h.length).toBe(12)
})
