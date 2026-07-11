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

// ── plateauVerdict ───────────────────────────────────────────────────────

const PROJECT_SINK = "/repo/.meta-harness/meta-metrics.jsonl" // passed explicitly as projectSink

function ab(decision: string, hiDelta: number, layer = "account-global"): MetaMetricEvent {
  // heldInDelta is the trend series
  return { event: "ab", layer, decision, heldInDelta: hiDelta, heldOutDelta: 0.0, splitFold: 0, ts: "2026-07-10T00:00:00Z" }
}

function trial(action: string, tr: number | null, br: number | null, sink = PROJECT_SINK): MetaMetricEvent {
  return { event: "trial", action, trialRate: tr, baselineRate: br, ts: "2026-07-10T00:00:00Z", _sink: sink }
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
  const foreign = Array(4).fill(trial("confirmed", 0.8, 0.8, "/home/u/.config/opencode/.meta-harness/meta-metrics.jsonl"))
  const v2 = plateauVerdict(foreign, undefined, undefined, PROJECT_SINK)
  expect(v2.project.reason.startsWith("insufficient")).toBe(true)
})

test("plateauVerdict: insufficient data", () => {
  const v = plateauVerdict([ab("reject", 0.0)])
  expect(v.bench["account-global"]!.plateaued).toBe(false)
  expect(v.plateaued).toBe(false)
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
  const homeDir = path.join(dir, "home")
  const [benchSink, projectSink] = defaultMetaMetricsSinks(paths, homeDir)
  const flagPath = pausedFlagPath(paths)

  function writeSink(sink: string, events: unknown[]): void {
    fs.mkdirSync(path.dirname(sink), { recursive: true })
    fs.writeFileSync(sink, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }

  // 4 tie/revert project trials -> project plateaued -> flag written
  writeSink(projectSink!, [
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:00Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:01Z" },
    { event: "trial", action: "confirmed", trialRate: 0.8, baselineRate: 0.8, ts: "2026-07-10T00:00:02Z" },
    { event: "trial", action: "reverted", trialRate: 0.6, baselineRate: 0.8, ts: "2026-07-10T00:00:03Z" },
  ])
  cmdReportLoop(paths, {}, homeDir)
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
  cmdReportLoop(paths, {}, homeDir)
  expect(fs.existsSync(flagPath)).toBe(false)

  // bench-only plateau (3 non-accept ab events, no trial events) must NOT write the flag
  writeSink(projectSink!, [])
  writeSink(benchSink!, [
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:00Z" },
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:01Z" },
    { event: "ab", layer: "account-global", decision: "reject", heldInDelta: 0.0, ts: "2026-07-10T00:00:02Z" },
  ])
  cmdReportLoop(paths, {}, homeDir)
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
  cmdReportLoop(paths, { sink: [extraSink] }, homeDir)
  expect(fs.existsSync(flagPath)).toBe(false)

  // default sinks again (no extra --sink) but --no-flag -> opts out entirely
  cmdReportLoop(paths, { noFlag: true }, homeDir)
  expect(fs.existsSync(flagPath)).toBe(false)
})
