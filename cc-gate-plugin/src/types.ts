// cc-gate-plugin/src/types.ts — the FROZEN shared contract (DAG Wave 1).
// Every other module depends on this file and NEVER on a sibling module's
// internals. A needed change here = stop the wave, amend, re-fan-out.
// Amendment (2026-07-29, km-gauge v2 extractor): GaugeSensorField gained
// class/reason/horizon/downgraded/strike — additive & optional, so v1 sensor
// consumers (present:false / no gauge) are unaffected.
// Amendment (2026-07-29, §4.3 trial-mode prereg, Task 1 of §11 item 6):
// SensorLine gained forced?/pluginVersion? — additive & optional, so
// existing consumers (scan.ts/score.ts) parse old and new lines alike.
import type { GateRoundResult } from "../vendor/complete-gate.ts"

export type RoundOutcome = GateRoundResult["outcome"]

/** CC PostToolUse tool_name values that arm the gate (exact case). */
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"] as const

/** Per-session persisted state — one JSON file under <cwd>/.km/cc-gate/. */
export interface CcGateState {
  v: 1
  edited: boolean
  gating: boolean
  round: number
  outcomes: RoundOutcome[]
  cycleStartedAt: number
  failStreak: number
  updatedAt: number
}

export const INITIAL_STATE: CcGateState = {
  v: 1,
  edited: false,
  gating: false,
  round: 0,
  outcomes: [],
  cycleStartedAt: 0,
  failStreak: 0,
  updatedAt: 0,
}

/** Initial-equivalence ignores updatedAt (a saved initial-equivalent state is deleted instead). */
export function isInitialState(s: CcGateState): boolean {
  return (
    !s.edited && !s.gating && s.round === 0 && s.outcomes.length === 0 &&
    s.cycleStartedAt === 0 && s.failStreak === 0
  )
}

/** Parsed gate.json (repo root). parseGateConfig returns undefined → gate no-ops. */
export interface GateConfig {
  check: string
  rounds: number // default 2
  marker: boolean // default false (C2 verdict)
  sensor: string // default ".km/gate-outcomes.ndjson", relative to cwd
  checkTimeoutMs: number // default 300_000
  gauge: boolean // default false — km-gauge shadow PoC opt-in (2026-07-28 pre-reg)
}

/** Injected IO for the pure core — tests fake this whole surface. */
export interface CoreDeps {
  /** Rejection = internal error class → failStreak path, NOT verify-failed. */
  runCheck(cmd: string): Promise<{ code: number; out: string }>
  now(): number
  hostname(): string
  log(msg: string): void
}

export interface StopInput {
  session_id: string
  cwd: string
}

export type StopDecision =
  | { kind: "allow" }
  | { kind: "allow-with-marker"; marker: string }
  | { kind: "allow-exhausted"; message: string }
  // rawOut: the raw check output captured at the round.ts tee — the reinject
  // composer builds v1's message from it instead of editing kernel prose.
  // (Deliberate contract amendment per this file's protocol; consumers
  // audited: output.ts reads only evidence/kind.)
  | { kind: "block"; evidence: string; round: number; roundsMax: number; rawOut?: string }

/** Delivery seam — applies to BLOCK decisions ONLY; allow-family is mode-independent. */
export type DeliveryMode = "block-json" | "exit2-stderr" | "block-json+context"

export interface EmitPlan {
  stdout?: Record<string, unknown>
  stderr?: string
  exitCode: 0 | 2
}

/** km-gauge v2 classification (pre-reg §2.1/§2.2 extension, 2026-07-29 design). */
export type GaugePromptClass = "A1" | "A2" | "B" | "C" | "D"

/** Class-C only: horizon over which the derived check should be trusted. */
export type GaugeHorizon = "single-turn" | "multi-turn"

/** km-gauge shadow-eval record (pre-reg §2.3) — attached to sensor lines,
 * NEVER consulted by any gate decision. absent/present:false = no gauge. */
export interface GaugeSensorField {
  present: boolean
  executable?: boolean
  /** Safety-guard verdict when the derived check was refused unrun. */
  refused?: string
  pass?: boolean
  wouldBlock?: boolean
  agreesWithFloor?: boolean
  derivationMs?: number
  confidence?: number
  model?: string
  n?: number
  /** v2 classification passthrough (validate.ts) — presence-conditional. */
  class?: GaugePromptClass
  reason?: string
  horizon?: GaugeHorizon
  /** Recorded when validate.ts discards a model-invented/misplaced check. */
  downgraded?: {
    fromClass: GaugePromptClass
    fromCheck: string | null
    rule: string
    token?: string
  }
  /** Two-strike policy state (shadow.ts) for a multi-turn class-C pending. */
  strike?: 1 | 2
}

/** One ndjson sensor line — field names are SCHEMA PARITY with gate-plugin + host/app tags. */
export interface SensorLine {
  ts: number
  sessionID: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  rounds: RoundOutcome[]
  interrupted: boolean
  marker: boolean
  durationMs: number
  host: string
  app: "claude-code"
  gauge?: GaugeSensorField
  /** §4.4 reinject-wording arm for this session (pre-reg §4b). */
  reinject?: "v0" | "v1"
  /** True iff an env override (KKAMAK_REINJECT) forced this session's
   * reinject arm rather than the salted hash choosing it — §4.4 exclusion
   * marker. Sensor-side `forced` covers KKAMAK_REINJECT ONLY: it is NOT a
   * frozen contract for KKAMAK_TRIAL_ARM (§4.3) — that forcing is enforced
   * from the exposure record at join time (`.km/trial-arms.ndjson`'s own
   * `forced` field is the sole and authoritative record), never sensor-side
   * convention (spec §2, plan Global Constraints). Absent means not forced;
   * a stored `false` is never written (absent is the cleaner line). */
  forced?: boolean
  /** cc-gate-plugin version (from .claude-plugin/plugin.json) that emitted
   * this line. Read once per process, resolved module-relative (the plugin
   * runs from a copied install dir, so a repo-relative path would die
   * silently there). Omitted if the manifest is unreadable — fail-open,
   * never throws. */
  pluginVersion?: string
}

/** Handlers return sensor lines; hook-cli owns the append (persist → sensor → emit). */
export interface PromptResult {
  state: CcGateState
  sensor?: SensorLine
}

export interface StopResult {
  state: CcGateState
  decision: StopDecision
  sensor?: SensorLine
}

/** File-backed per-session store (state.ts implements). */
export interface StateStore {
  load(sessionId: string): CcGateState
  save(sessionId: string, s: CcGateState): void
  /** Rate-limited via .last-swept dotfile; deletes *.json with updatedAt older than 7d. */
  sweep(nowMs: number): void
}
