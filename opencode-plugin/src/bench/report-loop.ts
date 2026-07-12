/**
 * report-loop.ts — loop observability: merge the 3 meta-metrics sinks
 * (bench/project/account), summarize A/B decisions, held-out trend, judge
 * agreement, and the plateau verdict, and write/clear the project-loop pause
 * flag. Mirrors term-bench2/runner.py's report-loop section:
 * default_meta_metrics_sinks (:2432), constants + PAUSED_FLAG (:2443),
 * _slope (:2448), _bench_layer_verdict (:2462), _is_strict_improvement
 * (:2482), plateau_verdict (:2492), _parse_ts (:2548), load_meta_metrics
 * (:2561), summarize_loop (:2585), cmd_report_loop (:2625).
 *
 * The account-layer sink (3rd of `defaultMetaMetricsSinks`) is derived from
 * harness-store.ts's `accountMetaRoot()` (Task L5) — a LAZY resolver
 * (META_HARNESS_HOME > $XDG_CONFIG_HOME/meta-harness > ~/.config/meta-harness)
 * that reads env fresh per call. That supersedes this file's old `home`
 * parameter, which existed only as a workaround for the pre-L5 account root
 * being an import-time constant (env stubbing in tests was infeasible
 * otherwise) — tests now isolate the account-layer sink by setting
 * META_HARNESS_HOME in-process instead. Production call sites (cli.ts)
 * never touch it either way, so behavior there is unchanged.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { BenchPaths } from "./paths.ts"
import { accountMetaRoot } from "../harness-store.ts"
import { log, pySigned, writeJsonAtomic } from "./util.ts"

// ── constants ────────────────────────────────────────────────────────────

export const PLATEAU_AB_K = 3 // last K ab events (per layer) all non-accept
export const PLATEAU_TRIAL_K = 4 // last K resolved project trials without strict improvement

/** The three loop-observability sinks, in write-order precedence: bench
 * (Python appender), project (TS appender, this repo's store), account (TS
 * appender, the user's global opencode config). */
export function defaultMetaMetricsSinks(paths: BenchPaths): string[] {
  return [
    join(paths.resultsDir, "meta-metrics.jsonl"),
    join(paths.metaRoot, ".meta-harness", "meta-metrics.jsonl"),
    join(accountMetaRoot(), "meta-metrics.jsonl"),
  ]
}

/** metaRoot/.meta-harness/paused — mirrors runner.py's module-global
 * PAUSED_FLAG, but derived from `paths` instead of a process-wide constant. */
export function pausedFlagPath(paths: BenchPaths): string {
  return join(paths.metaRoot, ".meta-harness", "paused")
}

// ── event shape ──────────────────────────────────────────────────────────

/** A loop-observability event as read back from a meta-metrics.jsonl line.
 * Untyped beyond the fields these pure functions actually touch — mirrors
 * Python's plain `dict` events (`ab`, `trial`, `judge`, `rotate`, ...). */
export interface MetaMetricEvent {
  event?: string
  layer?: string
  decision?: string
  heldInDelta?: number | null
  heldOutDelta?: number | null
  splitFold?: number
  action?: string
  trialRate?: number | null
  baselineRate?: number | null
  agreed?: boolean
  ts?: string
  _sink?: string
  [k: string]: unknown
}

// ── _slope ───────────────────────────────────────────────────────────────

/** Least-squares slope of ys over their 0-based index. Fewer than 2 points
 * has no meaningful slope; callers treat that as "condition passes". */
function slope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0.0
  const meanX = (n - 1) / 2 // mean of [0, 1, ..., n-1]
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let x = 0; x < n; x++) {
    const dx = x - meanX
    num += dx * (ys[x]! - meanY)
    den += dx * dx
  }
  return den ? num / den : 0.0
}

// ── _bench_layer_verdict ─────────────────────────────────────────────────

export interface LayerVerdict {
  plateaued: boolean
  n: number
  reason: string
}

/** One bench layer's report-only verdict. See plateauVerdict for the exact
 * semantics (heldInDelta trend, break-on-accept). */
function benchLayerVerdict(layerEvents: MetaMetricEvent[], abK: number): LayerVerdict {
  const n = layerEvents.length
  if (n < abK) return { plateaued: false, n, reason: "insufficient data" }
  const window = layerEvents.slice(-abK)
  const noAccept = window.every((e) => e.decision !== "accept")
  const heldIn = window
    .map((e) => e.heldInDelta)
    .filter((v): v is number => v !== undefined && v !== null)
  const slopeOk = heldIn.length < 2 || slope(heldIn) <= 0
  const plateaued = noAccept && slopeOk
  let reason: string
  if (plateaued) reason = `last ${abK} ab events non-accept, heldInDelta flat/falling`
  else if (!noAccept) reason = "accept within window"
  else reason = "heldInDelta rising — underpowered, not stuck"
  return { plateaued, n, reason }
}

// ── _is_strict_improvement ───────────────────────────────────────────────

/** confirmed AND baselineRate not null AND trialRate > baselineRate. A
 * null-baseline confirm (first-candidate bootstrap) and a tie are both
 * neutral — neither counts as an improvement. */
function isStrictImprovement(e: MetaMetricEvent): boolean {
  return (
    e.action === "confirmed" &&
    e.baselineRate !== null &&
    e.baselineRate !== undefined &&
    e.trialRate !== null &&
    e.trialRate !== undefined &&
    e.trialRate > e.baselineRate
  )
}

// ── plateau_verdict ──────────────────────────────────────────────────────

export interface PlateauVerdict {
  bench: Record<string, LayerVerdict>
  project: { plateaued: boolean; n: number; reason: string }
  plateaued: boolean // FLAG BASIS = project only
}

/**
 * PURE. Streams:
 * bench (PER LAYER, report-only): group `ab` events by their `layer` field;
 *   for each layer with >= abK events, plateaued iff the last abK have no
 *   decision=="accept" AND the heldInDelta series over them has slope <= 0
 *   (least-squares over event index; null/undefined excluded; <2 points =>
 *   slope condition passes). heldInDelta — NOT heldOutDelta — is the trend
 *   series: larger sample, undiluted by sentinels, and the metric `accept`
 *   keys on; a rising heldInDelta under all-inconclusive verdicts means
 *   "underpowered, not stuck" and must NOT read as plateau.
 * project (drives the flag): last trialK RESOLVED `trial` events (action
 *   confirmed|reverted) FROM THE PROJECT SINK ONLY (see `_sink` annotation
 *   in loadMetaMetrics) — plateaued iff >= trialK AND none is a strict
 *   improvement.
 * Returns {bench: {layer: {plateaued,n,reason}}, project: {...},
 *          plateaued: project.plateaued}.
 * Rationale: bench `ab` runs are manual — a flag can't stop them, and an
 * account-layer plateau must not pause the project loop. Bench verdicts are
 * printed to inform the human to stop spending on that layer.
 * projectSink: exact `_sink` string trial events must carry to count toward
 * the project stream; null = accept all (back-compat / unit tests without
 * sinks). cmdReportLoop passes defaultMetaMetricsSinks(paths)[1].
 */
export function plateauVerdict(
  events: MetaMetricEvent[],
  abK: number = PLATEAU_AB_K,
  trialK: number = PLATEAU_TRIAL_K,
  projectSink: string | null = null,
): PlateauVerdict {
  const layerEvents: Record<string, MetaMetricEvent[]> = {}
  for (const e of events) {
    if (e.event !== "ab") continue
    const layer = e.layer ?? "account-global"
    ;(layerEvents[layer] ??= []).push(e)
  }
  const bench: Record<string, LayerVerdict> = {}
  for (const [layer, evs] of Object.entries(layerEvents)) bench[layer] = benchLayerVerdict(evs, abK)

  const resolved = events.filter(
    (e) =>
      e.event === "trial" &&
      (e.action === "confirmed" || e.action === "reverted") &&
      (projectSink === null || e._sink === projectSink),
  )
  const n = resolved.length
  let project: { plateaued: boolean; n: number; reason: string }
  if (n < trialK) {
    project = { plateaued: false, n, reason: "insufficient data" }
  } else {
    const window = resolved.slice(-trialK)
    const plateaued = !window.some(isStrictImprovement)
    const reason = plateaued
      ? `no strict improvement in last ${trialK} resolved trials`
      : `strict improvement within last ${trialK} resolved trials`
    project = { plateaued, n, reason }
  }

  return { bench, project, plateaued: project.plateaued }
}

// ── _parse_ts ────────────────────────────────────────────────────────────

// A sentinel that always sorts before any real bench timestamp — mirrors
// Python's `datetime.min.replace(tzinfo=timezone.utc)` used for missing or
// invalid `ts` fields. The exact value doesn't matter, only that it's
// earlier than anything real; JS's minimum representable Date is convenient
// and avoids any Y1-era calendar edge cases.
const EPOCH_MIN = new Date(-8_640_000_000_000_000)

const HAS_OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/

/**
 * Parse ISO-8601 timestamp from an event dict, handling both +00:00 and Z
 * formats. Normalizes naive datetimes (no trailing Z / signed offset) to
 * UTC — JS's Date constructor otherwise treats an offset-less ISO string as
 * LOCAL time, unlike Python's `datetime.fromisoformat`, which keeps it naive
 * (and callers then explicitly attach UTC). Returns EPOCH_MIN for missing or
 * unparseable timestamps.
 */
export function parseTs(e: { ts?: string }): Date {
  const ts = e.ts ?? ""
  if (!ts) return EPOCH_MIN
  const iso = HAS_OFFSET_RE.test(ts) ? ts : `${ts}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? EPOCH_MIN : d
}

// ── load_meta_metrics ────────────────────────────────────────────────────

/**
 * Read each JSONL path that exists, skip missing files and unparseable
 * lines, merge, and sort by parsed ISO-8601 timestamp. Each event is
 * annotated with `_sink: path` at read time (in-memory provenance only —
 * never re-serialized back to the sink) so downstream consumers
 * (plateauVerdict) can tell which sink an event came from.
 */
export function loadMetaMetrics(paths: string[]): MetaMetricEvent[] {
  const events: MetaMetricEvent[] = []
  for (const p of paths) {
    if (!existsSync(p)) continue
    const text = readFileSync(p, "utf-8")
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      let event: MetaMetricEvent
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      event._sink = p
      events.push(event)
    }
  }
  events.sort((a, b) => parseTs(a).getTime() - parseTs(b).getTime())
  return events
}

// ── summarize_loop ───────────────────────────────────────────────────────

export interface LoopSummary {
  abDecisions: Record<string, number>
  trialActions: Record<string, number>
  heldOutDeltas: [string | undefined, number | undefined, number][]
  judgeAgreement: { n: number; rate: number } | null
  plateau: PlateauVerdict
}

/** Pure summary of loop-observability events — the testable core of
 * report-loop. */
export function summarizeLoop(events: MetaMetricEvent[]): LoopSummary {
  const abDecisions: Record<string, number> = {}
  const trialActions: Record<string, number> = {}
  const heldOutDeltas: [string | undefined, number | undefined, number][] = []
  let judgeN = 0
  let judgeAgreed = 0

  for (const e of events) {
    if (e.event === "ab") {
      if (e.decision !== undefined && e.decision !== null) {
        abDecisions[e.decision] = (abDecisions[e.decision] ?? 0) + 1
      }
      const delta = e.heldOutDelta
      if (delta !== undefined && delta !== null) {
        heldOutDeltas.push([e.ts, e.splitFold, delta])
      }
    } else if (e.event === "trial") {
      if (e.action !== undefined && e.action !== null) {
        trialActions[e.action] = (trialActions[e.action] ?? 0) + 1
      }
    } else if (e.event === "judge") {
      judgeN += 1
      if (e.agreed) judgeAgreed += 1
    }
  }

  const judgeAgreement = judgeN > 0 ? { n: judgeN, rate: judgeAgreed / judgeN } : null

  return {
    abDecisions,
    trialActions,
    heldOutDeltas,
    judgeAgreement,
    plateau: plateauVerdict(events),
  }
}

// ── cmd_report_loop ──────────────────────────────────────────────────────

export interface ReportLoopArgs {
  json?: boolean
  sink?: string[]
  noFlag?: boolean
  plateauAbK?: number
  plateauTrialK?: number
}

/**
 * `report-loop [--json] [--sink PATH]... [--no-flag] [--plateau-ab-k K]
 * [--plateau-trial-k K]` — merge the 3 sinks (+ any extra --sink), print (or
 * --json-emit) the summary, and write/clear the project-plateau pause flag.
 * Flag write/clear rules (exact precedence, matching runner.py:2639-2655):
 *   1. any extra --sink present -> flag left untouched (ad-hoc analysis)
 *   2. --no-flag -> flag left untouched
 *   3. project verdict plateaued -> write the flag (ts + verdict, atomic)
 *   4. else -> clear the flag if present, no-op otherwise
 * All flag-related logging goes through `log()` (stderr, see util.ts) so it
 * never pollutes --json's stdout.
 */
export function cmdReportLoop(paths: BenchPaths, args: ReportLoopArgs): void {
  const baseSinks = defaultMetaMetricsSinks(paths)
  const extraSinks = args.sink ?? []
  const sinks = [...baseSinks, ...extraSinks]
  const events = loadMetaMetrics(sinks)
  const summary = summarizeLoop(events)

  const abK = args.plateauAbK ?? PLATEAU_AB_K
  const trialK = args.plateauTrialK ?? PLATEAU_TRIAL_K
  const projectSink = baseSinks[1]!
  const verdict = plateauVerdict(events, abK, trialK, projectSink)
  summary.plateau = verdict // supersede the unfiltered back-compat verdict with the sink-scoped one

  const flagPath = pausedFlagPath(paths)
  const noFlag = args.noFlag ?? false
  if (extraSinks.length > 0) {
    log("plateau: extra --sink present — pause flag left untouched (ad-hoc analysis)")
  } else if (noFlag) {
    log("plateau: --no-flag — pause flag left untouched")
  } else if (verdict.project.plateaued) {
    writeJsonAtomic(flagPath, { ts: new Date().toISOString(), verdict })
    log(`plateau: project verdict PLATEAUED — wrote pause flag → ${flagPath}`)
  } else if (existsSync(flagPath)) {
    rmSync(flagPath)
    log(`plateau: project verdict ok — removed pause flag ${flagPath}`)
  } else {
    log("plateau: project verdict ok — no pause flag to remove")
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  console.log("report-loop: loop observability")
  console.log("=".repeat(60))
  console.log(`sinks checked (${sinks.length}):`)
  for (const p of sinks) console.log(`  ${existsSync(p) ? "✓" : "·"} ${p}`)
  console.log(`events merged: ${events.length}`)
  console.log()

  console.log("A/B decisions:")
  const abEntries = Object.entries(summary.abDecisions).sort(([a], [b]) => a.localeCompare(b))
  if (abEntries.length) {
    for (const [decision, n] of abEntries) console.log(`  ${decision.padEnd(14)} ${n}`)
  } else {
    console.log("  (none)")
  }
  console.log()

  console.log("Trial actions (confirm/revert):")
  const trialEntries = Object.entries(summary.trialActions).sort(([a], [b]) => a.localeCompare(b))
  if (trialEntries.length) {
    for (const [action, n] of trialEntries) console.log(`  ${action.padEnd(14)} ${n}`)
  } else {
    console.log("  (none)")
  }
  console.log()

  console.log("Held-out delta per fold rotation:")
  if (summary.heldOutDeltas.length) {
    for (const [ts, fold, delta] of summary.heldOutDeltas) {
      console.log(`  ${ts}  fold=${fold}  delta=${pySigned(delta, 4)}`)
    }
  } else {
    console.log("  (none)")
  }
  console.log()

  console.log("Judge agreement:")
  const ja = summary.judgeAgreement
  if (ja) {
    console.log(`  n=${ja.n}  rate=${(ja.rate * 100).toFixed(2)}%`)
  } else {
    console.log("  (no judge events)")
  }
  console.log()

  console.log("Plateau:")
  const proj = verdict.project
  const projStatus = proj.plateaued ? "PLATEAUED — pausing the loop" : "ok"
  console.log(`  project: ${projStatus}  (n=${proj.n}, ${proj.reason})`)
  for (const layer of Object.keys(verdict.bench).sort()) {
    const b = verdict.bench[layer]!
    const bStatus = b.plateaued ? "PLATEAUED — stop spending on ab here" : "ok"
    console.log(`  bench ${layer}: ${bStatus}  (report-only; n=${b.n}, ${b.reason})`)
  }
}
