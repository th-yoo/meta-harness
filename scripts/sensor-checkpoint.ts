/**
 * sensor-checkpoint.ts — the pre-registered review-sensor cadence
 * checkpoint reader (spec
 * docs/superpowers/specs/2026-08-05-review-sensor-synthesis-design.md §5,
 * due 2026-08-13).
 *
 * Implements the CHECKPOINT-READING RULING (user, 2026-08-11, recorded in
 * the spec BEFORE any events/day number was computed): one event toward
 * the >=25/day bar = one pass line with a DISTINCT (baseSha, headSha)
 * pair within its calendar day (local midnight, mirroring the sensor's
 * own day-cap semantics in review-sensor/core.ts). Repeat reviews of an
 * unchanged main diff collapse to one event per day; skip lines never
 * count. The raw pass-line count is reported alongside for transparency —
 * the RULED number is `eventsPerDay`.
 *
 * Reader only: touches no sensor state, no constants, no stream — F2
 * holds trivially (counts out, nothing in). Distinct from p2-tally's
 * computeB2Shadow, which serves P2's shadow read under its OWN
 * pre-registered definition and is deliberately not modified.
 *
 * Usage (on the armed host, at the checkpoint):
 *   bun scripts/sensor-checkpoint.ts [--stream <ndjson>] [--since <ts>] [--until <ts>]
 * Defaults: stream .km/review-findings.ndjson (repo root), since the
 * effective boundary ts, until now.
 */
import fs from "node:fs"
import path from "node:path"

/** Pre-registered bar (spec §5): the 14-day d=0.30 horizon is reachable
 * iff realized cadence >= 25 events/day. */
export const CADENCE_BAR = 25

/** Effective arming boundary on yoo-dev (live-proven sensor, HISTORY.md
 * 2026-08-06 entry): the checkpoint window starts here. */
export const SENSOR_EFFECTIVE_BOUNDARY_TS = 1785996709580

/** Tolerant view of one stream line — pass lines carry baseSha/headSha
 * (review-sensor/core.ts passLine), skip lines carry skipped+reason. */
export interface SensorStreamLine {
  ts?: number
  skipped?: boolean
  reason?: string
  baseSha?: string
  headSha?: string
  findingsCount?: number
  host?: string
}

export interface CheckpointResult {
  /** The RULED count: distinct (baseSha, headSha) per calendar day, summed. */
  ruledEvents: number
  /** All in-window non-skip lines — transparency alongside the ruled number. */
  rawPassLines: number
  /** In-window pass lines missing a usable sha pair: excluded from the
   * ruled count, surfaced so the reading is never silently lossy. */
  malformedPassLines: number
  skipsByReason: Record<string, number>
  /** Calendar days spanned by [since, until], inclusive of both ends. */
  spanDays: number
  eventsPerDay: number
  barMet: boolean
}

/** Local-midnight day key — the same day semantics as the sensor's own
 * daily cap (review-sensor/core.ts getDayKey). */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function computeCheckpoint(
  lines: SensorStreamLine[],
  since: number,
  until: number,
): CheckpointResult {
  const perDayPairs = new Map<string, Set<string>>()
  let rawPassLines = 0
  let malformedPassLines = 0
  const skipsByReason: Record<string, number> = {}

  for (const line of lines) {
    if (typeof line.ts !== "number" || line.ts < since || line.ts > until) continue
    if (line.skipped === true) {
      const reason = typeof line.reason === "string" ? line.reason : "(unknown)"
      skipsByReason[reason] = (skipsByReason[reason] ?? 0) + 1
      continue
    }
    rawPassLines += 1
    if (typeof line.baseSha !== "string" || typeof line.headSha !== "string") {
      malformedPassLines += 1
      continue
    }
    const day = dayKey(line.ts)
    let pairs = perDayPairs.get(day)
    if (!pairs) {
      pairs = new Set()
      perDayPairs.set(day, pairs)
    }
    pairs.add(`${line.baseSha} ${line.headSha}`)
  }

  let ruledEvents = 0
  for (const pairs of perDayPairs.values()) ruledEvents += pairs.size

  // Calendar days covered by the window, inclusive — computed from local
  // midnights, not a ms division, so a window ending mid-day still counts
  // that day (the spec reads "after 7 calendar days armed").
  const startDay = new Date(since)
  startDay.setHours(0, 0, 0, 0)
  const endDay = new Date(until)
  endDay.setHours(0, 0, 0, 0)
  const spanDays = until >= since ? Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000) + 1 : 0

  const eventsPerDay = spanDays > 0 ? ruledEvents / spanDays : 0
  return {
    ruledEvents,
    rawPassLines,
    malformedPassLines,
    skipsByReason,
    spanDays,
    eventsPerDay,
    barMet: eventsPerDay >= CADENCE_BAR,
  }
}

function readStream(file: string): SensorStreamLine[] {
  if (!fs.existsSync(file)) return []
  const out: SensorStreamLine[] = []
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as SensorStreamLine)
    } catch {
      /* torn/garbage line — a reader must not die on it; it simply never
       * enters any count (it is not a parseable pass OR skip line) */
    }
  }
  return out
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const repoRoot = path.resolve(import.meta.dir, "..")
  const stream = argValue(argv, "--stream") ?? path.join(repoRoot, ".km", "review-findings.ndjson")
  const since = Number(argValue(argv, "--since") ?? SENSOR_EFFECTIVE_BOUNDARY_TS)
  const until = Number(argValue(argv, "--until") ?? Date.now())
  const r = computeCheckpoint(readStream(stream), since, until)
  console.log(JSON.stringify({ stream, since, until, bar: CADENCE_BAR, ...r }, null, 2))
  console.log(
    `\ncheckpoint: ${r.ruledEvents} ruled events (${r.rawPassLines} raw pass lines, ` +
      `${r.malformedPassLines} malformed) over ${r.spanDays} day(s) = ` +
      `${r.eventsPerDay.toFixed(2)}/day vs bar ${CADENCE_BAR} -> ${r.barMet ? "BAR MET" : "BAR NOT MET"}`,
  )
  if (!r.barMet) {
    console.log(
      "per pre-registration: constants return to the user for amendment " +
        "(debounce / cap / reach / horizon) — an instrument change, new boundary ts. Nothing self-adjusts.",
    )
  }
}
