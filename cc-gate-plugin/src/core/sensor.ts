import type { CoreDeps, RoundOutcome, SensorLine } from "../types.ts"

export function buildSensorLine(
  deps: CoreDeps,
  args: {
    sessionID: string
    check: string
    accepted: boolean
    gateExhausted: boolean
    rounds: RoundOutcome[]
    interrupted: boolean
    marker: boolean
    durationMs: number
    // §4.3 amendment (Task 1 of §11 item 6) — both optional & passed
    // through only when the caller supplies them, so callers that omit
    // them (stop.ts/prompt.ts today) produce byte-identical lines to
    // before this amendment.
    forced?: boolean
    pluginVersion?: string
  },
): SensorLine {
  return {
    ts: deps.now(),
    sessionID: args.sessionID,
    check: args.check,
    accepted: args.accepted,
    gateExhausted: args.gateExhausted,
    rounds: args.rounds,
    interrupted: args.interrupted,
    marker: args.marker,
    durationMs: args.durationMs,
    host: deps.hostname(),
    app: "claude-code",
    ...(args.forced !== undefined ? { forced: args.forced } : {}),
    ...(args.pluginVersion !== undefined ? { pluginVersion: args.pluginVersion } : {}),
  }
}
