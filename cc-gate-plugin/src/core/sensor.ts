// TODO(E): buildSensorLine — gate-plugin schema parity + host/app tags
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
  void deps; void args
  throw new Error("TODO(E)")
}
