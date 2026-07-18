import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import {
  plateauVerdict,
  summarizeLoop,
  loadMetaMetrics,
  pausedFlagPath,
  cmdReportLoop,
  defaultMetaMetricsSinks,
  type MetaMetricEvent,
} from "../src/bench/report-loop.ts"

// Ported from term-bench2/test_meta_metrics.py — see that file for the
// original vectors and comments (the append_meta_metric half is already
// covered by TS meta-metrics tests in bench-store/harness-store's own
// suite, so it's skipped here per the task brief).

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-report-loop-"))
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

// ── summarizeLoop ────────────────────────────────────────────────────────

test("summarizeLoop: counts abDecisions/trialActions, held-out delta trend, judge agreement", () => {
  const events: MetaMetricEvent[] = [
    { ts: "2026-07-09T01:00:00Z", event: "ab", decision: "inconclusive", heldOutDelta: 0.5, splitFold: 0 },
    { ts: "2026-07-09T02:00:00Z", event: "ab", decision: "accept", heldOutDelta: 0.25, splitFold: 1 },
    { ts: "2026-07-09T03:00:00Z", event: "trial", action: "confirmed" },
    { ts: "2026-07-09T04:00:00Z", event: "judge", agreed: true },
    { ts: "2026-07-09T05:00:00Z", event: "judge", agreed: false },
  ]
  const s = summarizeLoop(events)
  expect(s.abDecisions).toEqual({ accept: 1, inconclusive: 1 })
  expect(s.trialActions).toEqual({ confirmed: 1 })
  expect(s.heldOutDeltas).toEqual([
    ["2026-07-09T01:00:00Z", 0, 0.5],
    ["2026-07-09T02:00:00Z", 1, 0.25],
  ])
  expect(s.judgeAgreement).toEqual({ n: 2, rate: 0.5 })
})

test("summarizeLoop([]) still has a plateau key", () => {
  const s = summarizeLoop([])
  expect(s.plateau).toBeDefined()
  expect(s.plateau.plateaued).toBe(false)
})

// ── W1a: time-to-resolve — optional fields parse into speedRatios ────────

test("summarizeLoop: tracks speedMedianRatio per ab event into speedRatios, skipping events without it", () => {
  const events: MetaMetricEvent[] = [
    { ts: "2026-07-09T01:00:00Z", event: "ab", decision: "inconclusive", speedMedianRatio: 0.8, speedP: 0.1, speedNPairs: 5 },
    { ts: "2026-07-09T02:00:00Z", event: "ab", decision: "accept", speedMedianRatio: null }, // no qualifying pairs
    { ts: "2026-07-09T03:00:00Z", event: "ab", decision: "accept" }, // pre-W1a legacy event — field absent entirely
    { ts: "2026-07-09T04:00:00Z", event: "ab", decision: "accept", speedMedianRatio: 1.2 },
  ]
  const s = summarizeLoop(events)
  expect(s.speedRatios).toEqual([
    ["2026-07-09T01:00:00Z", 0.8],
    ["2026-07-09T04:00:00Z", 1.2],
  ])
})

test("summarizeLoop([]) has an empty speedRatios array, not undefined", () => {
  const s = summarizeLoop([])
  expect(s.speedRatios).toEqual([])
})

// ── plateauVerdict ───────────────────────────────────────────────────────

const PROJECT_SINK = "/repo/.meta-harness/meta-metrics.jsonl" // passed explicitly as projectSink

function ab(decision: string, hiDelta: number, layer = "account-global"): MetaMetricEvent {
  // heldInDelta is the trend series
  return { event: "ab", layer, decision, heldInDelta: hiDelta, heldOutDelta: 0.0, splitFold: 0, ts: "2026-07-10T00:00:00Z" }
}

function trial(action: string, tr: number | null, br: number | null, sink = PROJECT_SINK): MetaMetricEvent {
  return { event: "trial", action, trialRate: tr, baselineRate: br, ts: "2026-07-10T00:00:00Z", _sink: sink }
}

// Budget-identity tuple {maxAgentTimeout, timeoutRecording, resourceEnforcement}
// (Loop-3 T7) — mirrors T6's ab-verdict.json stamp shape.
interface Budget {
  maxAgentTimeout?: number
  timeoutRecording?: boolean
  resourceEnforcement?: boolean
}

function trialB(action: string, tr: number | null, br: number | null, budget: Budget, sink = PROJECT_SINK): MetaMetricEvent {
  return {
    event: "trial",
    action,
    trialRate: tr,
    baselineRate: br,
    ts: "2026-07-10T00:00:00Z",
    _sink: sink,
    maxAgentTimeout: budget.maxAgentTimeout,
    timeoutRecording: budget.timeoutRecording,
    env: budget.resourceEnforcement !== undefined ? { resourceEnforcement: budget.resourceEnforcement } : undefined,
  }
}

function abB(decision: string, hiDelta: number, budget: Budget, layer = "account-global"): MetaMetricEvent {
  return {
    event: "ab",
    layer,
    decision,
    heldInDelta: hiDelta,
    heldOutDelta: 0.0,
    splitFold: 0,
    ts: "2026-07-10T00:00:00Z",
    maxAgentTimeout: budget.maxAgentTimeout,
    timeoutRecording: budget.timeoutRecording,
    env: budget.resourceEnforcement !== undefined ? { resourceEnforcement: budget.resourceEnforcement } : undefined,
  }
}

test("plateauVerdict: bench is per-layer, report-only, never drives the flag", () => {
  const evs = [ab("reject", 0.0), ab("inconclusive", 0.0), ab("reject", -0.1)]
  const v = plateauVerdict(evs)
  expect(v.bench["account-global"]!.plateaued).toBe(true)
  expect(v.plateaued).toBe(false) // bench NEVER drives the flag

  // an accept in the window breaks that layer's plateau
  const evs2 = [ab("reject", 0.0), ab("accept", 0.3), ab("reject", 0.0)]
  expect(plateauVerdict(evs2).bench["account-global"]!.plateaued).toBe(false)

  // rising HELD-IN trend under all-inconclusive = underpowered, NOT plateau
  const evs3 = [ab("inconclusive", 0.0), ab("inconclusive", 0.2), ab("inconclusive", 0.4)]
  expect(plateauVerdict(evs3).bench["account-global"]!.plateaued).toBe(false)

  // layers are independent: another layer's accept must not break this one
  const evs4 = [ab("reject", 0.0), ab("reject", 0.0), ab("reject", 0.0), ab("accept", 0.5, "account-role")]
  const v4 = plateauVerdict(evs4)
  expect(v4.bench["account-global"]!.plateaued).toBe(true)
  expect(v4.bench["account-role"]!.plateaued).toBe(false)
})

test("plateauVerdict: project stream (project sink only) drives the flag", () => {
  const ties = [trial("confirmed", 0.8, 0.8), trial("confirmed", 0.8, 0.8), trial("confirmed", 0.8, 0.8), trial("reverted", 0.6, 0.8)]
  const v = plateauVerdict(ties, undefined, undefined, PROJECT_SINK)
  expect(v.project.plateaued).toBe(true)
  expect(v.plateaued).toBe(true)

  const improv = [...ties.slice(0, 3), trial("confirmed", 0.9, 0.8)]
  expect(plateauVerdict(improv, undefined, undefined, PROJECT_SINK).plateaued).toBe(false)

  // started events + null-baseline confirms are neutral, not improvements
  const boot = [trial("started", null, null), ...Array(4).fill(trial("confirmed", 1.0, null))]
  expect(plateauVerdict(boot, undefined, undefined, PROJECT_SINK).project.plateaued).toBe(true)

  // trial events from a NON-project sink are ignored
  const foreign = Array(4).fill(trial("confirmed", 0.8, 0.8, "/home/u/.config/meta-harness/meta-metrics.jsonl"))
  const v2 = plateauVerdict(foreign, undefined, undefined, PROJECT_SINK)
  expect(v2.project.reason.startsWith("insufficient")).toBe(true)
})

test("plateauVerdict: insufficient data", () => {
  const v = plateauVerdict([ab("reject", 0.0)])
  expect(v.bench["account-global"]!.plateaued).toBe(false)
  expect(v.plateaued).toBe(false)
})

// ── plateauVerdict: budget-identity segmentation (Loop-3 T7) ───────────────

test("plateauVerdict: project excludes a cross-budget trialRate from counting as a strict improvement", () => {
  // 2 pre-change (600s) ties, then 1 post-change (900s) event whose trialRate
  // reads as an improvement over its OWN baselineRate figure — but that
  // baselineRate was never re-scored at 900s (no manual re-baseline has
  // happened yet). Naively `slice(-3)` would treat this as a strict
  // improvement (0.95 > 0.7) within the trailing window; segmented by
  // budget-identity, the 600s events are excluded and only 1 (900s) event
  // remains — not enough to resolve any verdict at all, let alone "improved".
  const events = [
    trialB("confirmed", 0.7, 0.7, { maxAgentTimeout: 600 }),
    trialB("confirmed", 0.7, 0.7, { maxAgentTimeout: 600 }),
    trialB("confirmed", 0.95, 0.7, { maxAgentTimeout: 900 }),
  ]
  const v = plateauVerdict(events, undefined, 3, PROJECT_SINK)
  expect(v.project.n).toBe(1) // only the 900s event counts toward the current-identity window
  expect(v.project.reason).toBe("insufficient data")
  expect(v.project.plateaued).toBe(false)
})

test("plateauVerdict: project resolves a fresh verdict from same-identity events after a budget change, ignoring pre-change history", () => {
  // A single pre-change (600s) event, followed by 3 post-change (900s) ties.
  // The pre-change event must NOT count toward `n` or the window — the
  // post-change events alone (all non-improvements) should resolve to
  // plateaued, proving segmentation resets the window rather than
  // permanently blocking a legitimate verdict once fresh same-identity data
  // accumulates.
  const events = [
    trialB("confirmed", 0.6, 0.6, { maxAgentTimeout: 600 }),
    trialB("confirmed", 0.7, 0.7, { maxAgentTimeout: 900 }),
    trialB("confirmed", 0.7, 0.7, { maxAgentTimeout: 900 }),
    trialB("confirmed", 0.7, 0.7, { maxAgentTimeout: 900 }),
  ]
  const v = plateauVerdict(events, undefined, 3, PROJECT_SINK)
  expect(v.project.n).toBe(3) // the 600s event is excluded
  expect(v.project.plateaued).toBe(true)
  expect(v.project.reason).toBe("no strict improvement in last 3 resolved trials")
})

test("plateauVerdict: project segmentation keys off the FULL tuple — timeoutRecording and resourceEnforcement flips also exclude", () => {
  // Same maxAgentTimeout, but recordTimeouts flipped ON — a distinct
  // budget-identity per design §6.2 item 2 (timeout-excluded vs
  // timeout-included pass-rates aren't comparable).
  const timeoutRecordingFlip = [
    trialB("confirmed", 0.6, 0.6, { maxAgentTimeout: 600, timeoutRecording: false }),
    trialB("confirmed", 0.6, 0.6, { maxAgentTimeout: 600, timeoutRecording: false }),
    trialB("confirmed", 0.9, 0.6, { maxAgentTimeout: 600, timeoutRecording: true }),
  ]
  const v1 = plateauVerdict(timeoutRecordingFlip, undefined, 3, PROJECT_SINK)
  expect(v1.project.n).toBe(1)
  expect(v1.project.reason).toBe("insufficient data")

  // Same maxAgentTimeout + timeoutRecording, but resourceEnforcement flipped
  // ON (the load-aware scheduler's --enforce-resources).
  const resourceEnforcementFlip = [
    trialB("confirmed", 0.6, 0.6, { maxAgentTimeout: 600, resourceEnforcement: false }),
    trialB("confirmed", 0.6, 0.6, { maxAgentTimeout: 600, resourceEnforcement: false }),
    trialB("confirmed", 0.9, 0.6, { maxAgentTimeout: 600, resourceEnforcement: true }),
  ]
  const v2 = plateauVerdict(resourceEnforcementFlip, undefined, 3, PROJECT_SINK)
  expect(v2.project.n).toBe(1)
  expect(v2.project.reason).toBe("insufficient data")
})

test("plateauVerdict: a legacy (pre-Loop-3) event mixed with newly-stamped but consistent events still computes a full window", () => {
  const events = [
    trial("confirmed", 0.8, 0.8), // pre-Loop-3 — no budget-identity fields at all
    trialB("confirmed", 0.8, 0.8, { maxAgentTimeout: 600 }),
    trialB("confirmed", 0.8, 0.8, { maxAgentTimeout: 600 }),
    trialB("reverted", 0.6, 0.8, { maxAgentTimeout: 600 }),
  ]
  const v = plateauVerdict(events, undefined, 4, PROJECT_SINK)
  expect(v.project.n).toBe(4)
  expect(v.project.plateaued).toBe(true)
})

test("plateauVerdict: bench layer plateau also segments by budget-identity", () => {
  const events = [
    abB("reject", 0.0, { maxAgentTimeout: 600 }),
    abB("reject", 0.0, { maxAgentTimeout: 600 }),
    abB("accept", 0.3, { maxAgentTimeout: 900 }), // cross-budget accept must not count toward this layer's window
  ]
  const v = plateauVerdict(events, 3)
  expect(v.bench["account-global"]!.n).toBe(1)
  expect(v.bench["account-global"]!.reason).toBe("insufficient data")
})

// ── loadMetaMetrics ──────────────────────────────────────────────────────

test("loadMetaMetrics annotates each event with its source sink", () => {
  const dir = tmpDir()
  const p = path.join(dir, "m.jsonl")
  fs.writeFileSync(p, JSON.stringify({ event: "rotate", ts: "2026-07-10T00:00:00Z" }) + "\n")
  const evs = loadMetaMetrics([p])
  expect(evs[0]!._sink).toBe(p)
})

test("loadMetaMetrics sorts across mixed ISO-8601 formats (Z vs +00:00)", () => {
  const dir = tmpDir()
  const f = path.join(dir, "m.jsonl")
  // later event listed first (14.900), with the Z/+00:00 format split
  fs.writeFileSync(
    f,
    JSON.stringify({ event: "b", ts: "2026-07-09T13:24:14.900000+00:00" }) +
      "\n" +
      JSON.stringify({ event: "a", ts: "2026-07-09T13:24:14.100Z" }) +
      "\n",
  )
  const got = loadMetaMetrics([f]).map((e) => e.event)
  expect(got).toEqual(["a", "b"])
})

// ── cmdReportLoop: flag write/clear matrix ──────────────────────────────

test("cmdReportLoop: writes/clears PAUSED_FLAG based on the project verdict only; extra --sink / --no-flag never touch it", () => {
  const dir = tmpDir()
  const paths = fakeBenchPaths(path.join(dir, "term-bench2"))
  // defaultMetaMetricsSinks' account-layer sink is now derived from
  // harness-store.ts's accountMetaRoot() (Task L5) — redirect it into this
  // test's tmp dir so nothing here ever resolves against the real $HOME.
  const savedMhHome = process.env["META_HARNESS_HOME"]
  process.env["META_HARNESS_HOME"] = path.join(dir, "account-root")
  const [benchSink, projectSink] = defaultMetaMetricsSinks(paths)
  const flagPath = pausedFlagPath(paths)

  function writeSink(sink: string, events: unknown[]): void {
    fs.mkdirSync(path.dirname(sink), { recursive: true })
    fs.writeFileSync(sink, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }

  try {
  // 4 tie/revert project trials -> project plateaued -> flag written
  writeSink(projectSink!, [
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:00Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:01Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:02Z" },
    { event: "trial", action: "reverted", trialRate: 0.6, baselineRate: 0.8, ts: "2026-07-10T00:00:03Z" },
  ])
  cmdReportLoop(paths, {})
  expect(fs.existsSync(flagPath)).toBe(true)
  const flagData = JSON.parse(fs.readFileSync(flagPath, "utf-8"))
  expect(flagData.ts).toBeDefined()
  expect(flagData.verdict).toBeDefined()
  expect(flagData.verdict.project.plateaued).toBe(true)

  // rerun with a strict-improvement trial appended -> flag removed
  writeSink(projectSink!, [
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:00Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:01Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:02Z" },
    { event: "trial", action: "reverted", trialRate: 0.6, baselineRate: 0.8, ts: "2026-07-10T00:00:03Z" },
    { event: "trial", action: "confirmed", trialRate: 0.95, baselineRate: 0.8, ts: "2026-07-10T00:00:04Z" },
  ])
  cmdReportLoop(paths, {})
  expect(fs.existsSync(flagPath)).toBe(false)

  // bench-only plateau (3 non-accept ab events, no trial events) must NOT write the flag
  writeSink(projectSink!, [])
  writeSink(benchSink!, [
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:00Z" },
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:01Z" },
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:02Z" },
  ])
  cmdReportLoop(paths, {})
  expect(fs.existsSync(flagPath)).toBe(false)

  // re-seed project plateau, then run with extra --sink -> flag untouched (not created)
  writeSink(projectSink!, [
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:00Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:01Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:02Z" },
    { event: "trial", action: "reverted", trialRate: 0.6, baselineRate: 0.8, ts: "2026-07-10T00:00:03Z" },
  ])
  const extraSink = path.join(dir, "extra", "meta-metrics.jsonl")
  writeSink(extraSink, [])
  cmdReportLoop(paths, { sink: [extraSink] })
  expect(fs.existsSync(flagPath)).toBe(false)

  // default sinks again (no extra --sink) but --no-flag -> opts out entirely
  cmdReportLoop(paths, { noFlag: true })
  expect(fs.existsSync(flagPath)).toBe(false)
  } finally {
    if (savedMhHome === undefined) delete process.env["META_HARNESS_HOME"]
    else process.env["META_HARNESS_HOME"] = savedMhHome
  }
})
