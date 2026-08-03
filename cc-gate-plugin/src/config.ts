import type { GateConfig } from "./types.ts"

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
    }
  } catch {
    return undefined
  }
}
