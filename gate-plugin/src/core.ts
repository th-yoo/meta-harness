/**
 * gate-plugin/src/core.ts — standalone completion-gate plugin core
 * (design: docs/2026-07-25-daily-evolution-loop.md §4.1; engine-free).
 * Round semantics reused from minimal/complete-gate.ts. v1: mutants=0.
 * Marker default OFF (C2 verdict, HISTORY.md; overrides hygiene doc §4).
 */
export interface GateConfig {
  check: string
  rounds: number
  marker: boolean
  sensor: string
}

export function parseGateConfig(raw: string): GateConfig | undefined {
  try {
    const j = JSON.parse(raw)
    if (typeof j.check !== "string" || !j.check) return undefined
    return {
      check: j.check,
      rounds: typeof j.rounds === "number" ? j.rounds : 2,
      marker: j.marker === true,
      sensor: typeof j.sensor === "string" ? j.sensor : ".meta-harness/gate-outcomes.ndjson",
    }
  } catch {
    return undefined
  }
}
