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
  }
}
