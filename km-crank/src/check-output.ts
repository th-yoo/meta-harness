/**
 * check-output.ts — PURE parsing/joining of the Phase 1 check-output
 * sidecar (`.km/check-output.ndjson`, emitted by
 * cc-gate-plugin/src/sidecar.ts on block rounds; spec
 * docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
 *
 * Shape re-declared locally rather than imported cross-package — km-crank
 * stays standalone (same rule and rationale as scan.ts's SensorLine).
 * No fs here: crank.ts owns the whole-file read and calls in with strings.
 * The sidecar is host-local and NEVER exported to the evidence snapshot
 * (F2) — this module only feeds proposer evidence rendering.
 */

export interface CheckOutputRecord {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  excerpt: string
  elidedChars?: number
}

function isCheckOutputRecord(v: unknown): v is CheckOutputRecord {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o["ts"] === "number" &&
    typeof o["sessionID"] === "string" &&
    typeof o["round"] === "number" &&
    typeof o["roundsMax"] === "number" &&
    typeof o["check"] === "string" &&
    typeof o["excerpt"] === "string"
  )
}

/** Parse ndjson text into records. Blank lines, malformed JSON, and lines
 * not matching the shape are silently skipped — never throws (degrade
 * gracefully, same contract as scan.ts's parseSensorLines). */
export function parseCheckOutputRecords(text: string): CheckOutputRecord[] {
  const out: CheckOutputRecord[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isCheckOutputRecord(parsed)) out.push(parsed)
  }
  return out
}

/** Group records by sessionID, restricted to `sessionIDs`, each group
 * sorted ts DESC (latest round first — the renderer shows the most recent
 * failures). Sessions with no records are absent from the map. */
export function joinBySession(
  sessionIDs: string[],
  records: CheckOutputRecord[],
): Map<string, CheckOutputRecord[]> {
  const wanted = new Set(sessionIDs)
  const m = new Map<string, CheckOutputRecord[]>()
  for (const r of records) {
    if (!wanted.has(r.sessionID)) continue
    const arr = m.get(r.sessionID)
    if (arr) arr.push(r)
    else m.set(r.sessionID, [r])
  }
  for (const arr of m.values()) arr.sort((a, b) => b.ts - a.ts)
  return m
}
