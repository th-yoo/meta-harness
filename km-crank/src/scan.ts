/**
 * scan.ts — PURE parsing/aggregation of kkamak sensor lines.
 *
 * Schema parity with cc-gate-plugin/src/types.ts's SensorLine (and the
 * gate-plugin's own emitter): {ts, sessionID, check, accepted, gateExhausted,
 * rounds, interrupted, marker, durationMs, host, app}. Re-declared locally
 * (rather than imported cross-package) so km-crank stays a standalone
 * package — see CLAUDE.md's cross-host/git-only artifact rule and the task
 * brief's "own the new km-crank/ directory only" constraint.
 *
 * No fs/network here — crank.ts owns all I/O (reading sensor files with byte
 * offsets, etc.) and calls into this module with plain strings/arrays.
 */

/** One round's outcome — mirrors minimal/complete-gate.ts's GateRoundResult
 * union (opencode-plugin/cc-gate-plugin depend on the real type; km-crank
 * only ever treats these as opaque strings emitted verbatim by the sensor). */
export type RoundOutcome =
  | "accepted"
  | "no-verify"
  | "verify-failed"
  | "mutant-survived"
  | "artifact-missing"
  | "requirement-untested"
  | "relation-violated"

export interface SensorLine {
  ts: number
  sessionID: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  rounds: RoundOutcome[]
  interrupted: boolean
  marker: boolean
  durationMs: number
  host: string
  app: string
  /** cc-gate-plugin's skipped-Stop marker (Task 1, fix-them-serialized-teacup
   * plan) — see cc-gate-plugin/src/types.ts's SensorLine for full semantics.
   * Declared here so the type matches the wire shape; `parseSensorLines`
   * below EXCLUDES lines carrying it from its returned array (round-3 review
   * "Important 6" — its per-queued-prompt multiplicity would otherwise skew
   * this repo's new-line-volume contest/threshold toward noisy repos). Note:
   * gauge-only lines (also `rounds: []`) share this same pre-existing
   * distortion and are NOT filtered here — recorded as a known minor,
   * out of scope for this fix. */
  skippedStop?: true
}

/** Runtime shape guard — malformed/partial lines (a torn concurrent write, a
 * hand-edited file, a schema drift) are skipped rather than thrown on. This
 * feeds an aggregation report, not a hard contract; degrade gracefully. */
function isSensorLine(v: unknown): v is SensorLine {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o["ts"] === "number" &&
    typeof o["sessionID"] === "string" &&
    typeof o["check"] === "string" &&
    typeof o["accepted"] === "boolean" &&
    typeof o["gateExhausted"] === "boolean" &&
    Array.isArray(o["rounds"]) &&
    o["rounds"].every((r) => typeof r === "string") &&
    typeof o["interrupted"] === "boolean" &&
    typeof o["marker"] === "boolean" &&
    typeof o["durationMs"] === "number" &&
    typeof o["host"] === "string" &&
    typeof o["app"] === "string"
  )
}

/**
 * Parse ndjson text (one JSON object per line) into SensorLine[]. Blank
 * lines, malformed JSON, and lines not matching the SensorLine shape are
 * silently skipped — never throws. `text` is assumed to already be
 * whole-lines-only (crank.ts's byte-offset reader trims any trailing
 * partial line before calling this).
 *
 * Task 1 (fix-them-serialized-teacup plan, round-3 review "Important 6"):
 * lines carrying `skippedStop:true` are ALSO excluded from the returned
 * array — not just filtered from a downstream count. This repo's crank.ts
 * builds its new-line-volume contest/threshold, `aggregate()`'s totals, and
 * `notable()`'s selection directly off this array's length/contents, so
 * excluding here is what keeps a queued-prompt-heavy repo from looking
 * artificially "busier" than one with equivalent real gate cycles.
 * `cleanAccepts` (below) was already immune (`rounds:[]` never matches
 * `["accepted"]`) — this is about the raw count, not that field.
 */
export function parseSensorLines(text: string): SensorLine[] {
  const out: SensorLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isSensorLine(parsed) && !parsed.skippedStop) out.push(parsed)
  }
  return out
}

export interface Aggregate {
  total: number
  /** Sessions that gated clean in exactly one round: rounds === ["accepted"]. */
  cleanAccepts: number
  /** Sessions whose rounds contain both a "verify-failed" round and an
   * "accepted" round — the gate caught something, the agent fixed it. */
  fixCycles: number
  exhausted: number
  interrupted: number
  medianDurationMs: number
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = nums.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function aggregate(lines: SensorLine[]): Aggregate {
  let cleanAccepts = 0
  let fixCycles = 0
  let exhausted = 0
  let interrupted = 0
  for (const l of lines) {
    if (l.rounds.length === 1 && l.rounds[0] === "accepted") cleanAccepts++
    if (l.rounds.includes("verify-failed") && l.rounds.includes("accepted")) fixCycles++
    if (l.gateExhausted) exhausted++
    if (l.interrupted) interrupted++
  }
  return {
    total: lines.length,
    cleanAccepts,
    fixCycles,
    exhausted,
    interrupted,
    medianDurationMs: median(lines.map((l) => l.durationMs)),
  }
}

/**
 * The exhausted/interrupted/longest sessions, up to `k` total. Exhausted and
 * interrupted sessions are always prioritized (deduped by sessionID); any
 * remaining slots are filled with the longest-running sessions by
 * durationMs, descending. Bounded by `k` — never returns more.
 */
export function notable(lines: SensorLine[], k = 5): SensorLine[] {
  const flagged = lines.filter((l) => l.gateExhausted || l.interrupted)
  const flaggedIds = new Set(flagged.map((l) => l.sessionID))
  const rest = lines
    .filter((l) => !flaggedIds.has(l.sessionID))
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
  return [...flagged, ...rest].slice(0, k)
}
