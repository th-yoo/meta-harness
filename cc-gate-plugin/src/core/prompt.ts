// handleUserPromptSubmit — human-preemption transition (Wave 3).
//
// Fires on UserPromptSubmit. If no gate cycle is open, the prompt is
// ordinary and state passes through UNCHANGED (same reference) — this is
// what lets `edited` persist across normal prompts. If a gate cycle WAS
// open, the user preempted it: fully reset to INITIAL_STATE (edited
// cleared too — stand down completely), and if we can still read the gate
// config, emit an interrupted sensor line mirroring the opencode plugin's
// refused-reinject shape (accepted:true + gateExhausted:true is
// deliberate schema parity, not a bug).
//
// Task 1 (fix-them-serialized-teacup plan, 2026-07-30 dogfood finding):
// when NOT gating but edits are unmeasured (`edited:true`), a queued prompt
// has just eaten the Stop boundary — this is the SOLE emission point for
// the `skippedStop` marker (types.ts has the full semantics doc). State is
// left UNCHANGED (`edited` stays true) — this is a marker, not a
// measurement, so the next real Stop still measures the edits cumulatively.
import { INITIAL_STATE } from "../types.ts"
import type { CcGateState, CoreDeps, PromptResult } from "../types.ts"
import { parseGateConfig } from "../config.ts"
import { buildSensorLine } from "./sensor.ts"

export function handleUserPromptSubmit(
  state: CcGateState,
  sessionId: string,
  gateConfigRaw: string | undefined,
  deps: CoreDeps,
): PromptResult {
  if (!state.gating) {
    if (!state.edited) return { state }
    const cfg = parseGateConfig(gateConfigRaw)
    if (!cfg) return { state }
    const sensor = buildSensorLine(deps, {
      sessionID: sessionId,
      check: cfg.check,
      accepted: true,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: 0,
      skippedStop: true,
    })
    return { state, sensor }
  }

  const cfg = parseGateConfig(gateConfigRaw)
  if (!cfg) return { state: { ...INITIAL_STATE } }

  const sensor = buildSensorLine(deps, {
    sessionID: sessionId,
    check: cfg.check,
    accepted: true,
    gateExhausted: true,
    rounds: state.outcomes,
    interrupted: true,
    marker: false,
    durationMs: deps.now() - state.cycleStartedAt,
  })

  return { state: { ...INITIAL_STATE }, sensor }
}
