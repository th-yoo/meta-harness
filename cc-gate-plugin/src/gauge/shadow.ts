// km-gauge shadow-at-Stop orchestration (pre-reg §2.3) — picks the pending
// derivation, runs the shadow eval, attaches the gauge field to the outgoing
// sensor line (or fabricates a gauge-only line on fast-path Stops), and
// consumes the pending file into the .done.json audit trail.
//
// SHADOW ONLY: the return value feeds appendSensor and nothing else — the
// Stop DECISION is computed before this runs and is never touched.
import type { GateConfig, SensorLine } from "../types.ts"
import { evaluateGauge } from "./evaluate.ts"
import { consumePending, gaugeDir, pickPending } from "./files.ts"

interface ShadowDeps {
  now(): number
  hostname(): string
  log(msg: string): void
}

/**
 * sensor = the floor gate's outgoing line for this Stop (undefined on the
 * no-edit fast path). Returns the line to append: the input line (with a
 * gauge field when one was evaluated), a fabricated gauge-only line
 * (rounds: [] is the marker — real gate lines always carry ≥1 outcome), or
 * undefined when there is nothing to log.
 */
export async function shadowEvaluateAtStop(
  cwd: string,
  sessionID: string,
  cfg: GateConfig,
  sensor: SensorLine | undefined,
  runCheck: (cmd: string) => Promise<{ code: number; out: string }>,
  deps: ShadowDeps,
): Promise<SensorLine | undefined> {
  try {
    // An interrupt line means the user preempted the cycle — the pending
    // gauge belongs to the NEW prompt's work, keep it for the next cycle.
    if (sensor?.interrupted) return sensor

    const dir = gaugeDir(cwd)
    const pending = pickPending(dir, sessionID)
    if (!pending) return sensor

    // Exhausted lines carry accepted:true for schema parity; a real floor
    // accept is accepted && !gateExhausted.
    const floor = sensor
      ? { ran: true, accepted: sensor.accepted && !sensor.gateExhausted }
      : { ran: false }

    const gauge = await evaluateGauge(pending, floor, runCheck)
    consumePending(dir, sessionID, pending.n, gauge as unknown as Record<string, unknown>)

    if (sensor) return { ...sensor, gauge }

    return {
      ts: deps.now(),
      sessionID,
      check: cfg.check,
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 0,
      host: deps.hostname(),
      app: "claude-code",
      gauge,
    }
  } catch (e) {
    try {
      deps.log(`km-gauge: shadow eval failed (swallowed): ${String(e)}`)
    } catch {
      // nothing more to do
    }
    return sensor
  }
}
