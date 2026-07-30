// handleStop — the Stop-transition state machine (Wave 3).
//
// Fast path (no edits, no open cycle) never parses gate.json and never
// calls runCheck — ordinary (non-gated) sessions pay zero gate overhead.
// Once armed (edited or gating), each Stop runs exactly one check round
// via runSingleRound and folds the outcome into round-tracking state per
// GateConfig.rounds, mirroring the opencode plugin's persistent multi-round
// cycle one Stop invocation at a time.
//
// PURE core: no fs/process imports. runSingleRound + deps are the only
// effects; a caught runCheck rejection is an INTERNAL error (spawn/exec
// failure class), never treated as a verify-failed round.
import { INITIAL_STATE } from "../types.ts"
import type { CcGateState, CoreDeps, StopInput, StopResult } from "../types.ts"
import { parseGateConfig } from "../config.ts"
import { buildSensorLine } from "./sensor.ts"
import { runSingleRound } from "./round.ts"
import { HYGIENE_MARKER } from "../../vendor/session2.ts"

export async function handleStop(
  state: CcGateState,
  input: StopInput,
  gateConfigRaw: string | undefined,
  deps: CoreDeps,
): Promise<StopResult> {
  // 1. Fast path: nothing armed the gate — no config parse, no check.
  if (!state.edited && !state.gating) {
    return { state, decision: { kind: "allow" } }
  }

  // 2. Config gate. Missing/invalid gate.json no-ops the gate.
  const cfg = parseGateConfig(gateConfigRaw)
  if (!cfg) {
    if (state.gating) {
      // A cycle was open but the config vanished/broke mid-cycle: reset
      // the cycle silently — no sensor line, since this outcome has no
      // schema shape to record — but `edited` survives (the user's edit
      // is unrelated to the config's disappearance).
      return {
        state: { ...INITIAL_STATE, edited: state.edited },
        decision: { kind: "allow" },
      }
    }
    return { state, decision: { kind: "allow" } }
  }

  // 3. Run one round.
  const started = state.gating ? state.cycleStartedAt : deps.now()

  // Task 2 (fix-them-serialized-teacup plan): time THIS round only, tightly
  // around the runSingleRound call — durationMs (started..now, above) spans
  // every Stop invocation in the cycle including subagent-wait between
  // them; checkElapsed isolates just the check-command wall time. Not
  // captured on the catch-branch below: an internal error consumes no
  // round (cycle fields unchanged there), so there's no round to time.
  const checkStartedAt = deps.now()

  let result: Awaited<ReturnType<typeof runSingleRound>>
  try {
    result = await runSingleRound(deps.runCheck, cfg.check)
  } catch (err) {
    // Internal error class (e.g. spawn failure) — NOT a verify-failed
    // round. Tracked separately via failStreak so a broken check command
    // can't gate a session shut forever.
    deps.log(`handleStop: runCheck threw: ${String(err)}`)
    const newFailStreak = state.failStreak + 1

    if (newFailStreak >= 3) {
      return {
        state: { ...INITIAL_STATE },
        decision: {
          kind: "allow-exhausted",
          message:
            "kkamak: gate disabled for this session after 3 consecutive internal errors — check your gate.json check command",
        },
      }
    }

    // Cycle fields unchanged — no round consumed; the cycle (if any)
    // resumes at the next Stop.
    return {
      state: { ...state, failStreak: newFailStreak },
      decision: { kind: "allow" },
    }
  }

  // Task 2 (fix-them-serialized-teacup plan): this round's own elapsed
  // check time, isolated from durationMs's cross-invocation span.
  const checkElapsed = deps.now() - checkStartedAt

  // 4. Round result outcome.
  if (result.outcome === "accepted") {
    const sensor = buildSensorLine(deps, {
      sessionID: input.session_id,
      check: cfg.check,
      accepted: true,
      gateExhausted: false,
      rounds: [...state.outcomes, "accepted"],
      interrupted: false,
      marker: cfg.marker,
      durationMs: deps.now() - started,
      checkMs: [...(state.checkMs ?? []), checkElapsed],
    })

    return {
      state: { ...INITIAL_STATE },
      decision: cfg.marker
        ? { kind: "allow-with-marker", marker: HYGIENE_MARKER }
        : { kind: "allow" },
      sensor,
    }
  }

  // Failed (any non-accepted outcome, normally "verify-failed").
  if (state.round < cfg.rounds) {
    return {
      state: {
        ...state,
        gating: true,
        round: state.round + 1,
        outcomes: [...state.outcomes, result.outcome],
        cycleStartedAt: started,
        failStreak: 0,
        checkMs: [...(state.checkMs ?? []), checkElapsed],
      },
      decision: {
        kind: "block",
        evidence: result.evidence ?? "check failed",
        round: state.round + 1,
        roundsMax: cfg.rounds,
        ...(result.rawOut !== undefined ? { rawOut: result.rawOut } : {}),
      },
    }
  }

  // Exhausted: rounds budget spent. Marker must NOT fire on exhaustion
  // even with cfg.marker true.
  const sensor = buildSensorLine(deps, {
    sessionID: input.session_id,
    check: cfg.check,
    accepted: true,
    gateExhausted: true,
    rounds: [...state.outcomes, result.outcome],
    interrupted: false,
    marker: false,
    durationMs: deps.now() - started,
    checkMs: [...(state.checkMs ?? []), checkElapsed],
  })

  return {
    state: { ...INITIAL_STATE },
    decision: {
      kind: "allow-exhausted",
      message: `kkamak: gate exhausted after ${cfg.rounds + 1} failing checks — stop allowed; see ${cfg.sensor}`,
    },
    sensor,
  }
}
