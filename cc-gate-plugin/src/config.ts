import type { GateConfig } from "./types.ts"
import { compileTestPathPattern } from "./core/classify.ts"

/** A1 cycle-tagging: kept only if it compiles as a RegExp — a malformed
 * pattern falls back to the built-in default (field undefined), never
 * disables the gate and never throws. */
function keepIfCompiles(v: unknown): string | undefined {
  return typeof v === "string" && compileTestPathPattern(v) !== undefined ? v : undefined
}

export function parseGateConfig(raw: string | undefined): GateConfig | undefined {
  if (!raw) return undefined

  try {
    const j = JSON.parse(raw)

    // check is required and must be a non-empty string
    if (typeof j.check !== "string" || !j.check) return undefined

    return {
      check: j.check,
      rounds: typeof j.rounds === "number" ? j.rounds : 2,
      marker: j.marker === true,
      sensor: typeof j.sensor === "string" ? j.sensor : ".km/gate-outcomes.ndjson",
      checkTimeoutMs: typeof j.checkTimeoutMs === "number" ? j.checkTimeoutMs : 300_000,
      gauge: j.gauge === true,
      channelNudge: typeof j.channelNudge === "boolean" ? j.channelNudge : undefined,
      testPathPattern: keepIfCompiles(j.testPathPattern),
    }
  } catch {
    return undefined
  }
}
