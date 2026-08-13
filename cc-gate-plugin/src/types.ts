// cc-gate-plugin/src/types.ts — the FROZEN shared contract (DAG Wave 1).
// Every other module depends on this file and NEVER on a sibling module's
// internals. A needed change here = stop the wave, amend, re-fan-out.
// Amendment (2026-07-29, km-gauge v2 extractor): GaugeSensorField gained
// class/reason/horizon/downgraded/strike — additive & optional, so v1 sensor
// consumers (present:false / no gauge) are unaffected.
// Amendment (2026-07-29, §4.3 trial-mode prereg, Task 1 of §11 item 6):
// SensorLine gained forced?/pluginVersion? — additive & optional, so
// existing consumers (scan.ts/score.ts) parse old and new lines alike.
// Amendment (2026-07-30, fix-them-serialized-teacup plan, Task 1):
// SensorLine gained skippedStop?: true — additive & optional, recording the
// unmeasured-edits-across-a-prompt-boundary dogfood finding.
// Amendment (2026-07-30, fix-them-serialized-teacup plan, Task 2):
// Amendment (2026-08-13, A1 cycle-tagging port from ~/z2/kkamak v0.6.0):
// CcGateState gained touchedPaths?/touchedTruncated?; SensorLine gained
// implOnly?/sameTurnCoEdit?; GateConfig gained testPathPattern? — all
// additive & optional. Raw paths live in .km/ state ONLY and never reach
// the sensor line (derived booleans only, F2-clean).
// SensorLine + CcGateState both gained checkMs?: number[] — additive &
// optional, recording per-round check time (deps.now() around
// runSingleRound) so durationMs's subagent-wait inflation (live dogfood:
// 420s/174s cycles, ~1s actual check) has a companion measurement that
// isn't reinterpreted from durationMs itself.
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
  /** Task 2 (fix-them-serialized-teacup plan): per-round check elapsed-ms,
   * accumulated across Stop invocations exactly as `outcomes` is. Absent on
   * legacy state files and never declared on INITIAL_STATE (a freshly-reset
   * cycle has no rounds yet, same convention as `outcomes: []` being the
   * only array INITIAL_STATE actually declares — this one stays undefined
   * until the first round runs). */
  checkMs?: number[]
  /** A1 cycle-tagging (2026-08-13): repo-relative-or-absolute paths the
   * cycle's edit tools touched, deduped, capped at TOUCHED_PATHS_CAP.
   * Absent on legacy state files and never declared on INITIAL_STATE
   * (same convention as checkMs). Paths NEVER leave .km/ state — the
   * sensor line carries only the derived booleans. */
  touchedPaths?: string[]
  /** Set (true) the first time a path is dropped because touchedPaths hit
   * TOUCHED_PATHS_CAP — a truncated set cannot answer "impl-only?", so
   * the derived sensor fields are omitted for the whole cycle. Absent is
   * the only false. */
  touchedTruncated?: true
}

/** Cap on touchedPaths so a huge refactor cannot grow the state record
 * without bound. 200 mirrors the kkamak kernel's cap (its HANDOFF-A1
 * ruling); hitting it sets touchedTruncated and the cycle's tag fields
 * are omitted rather than computed from a partial set. */
export const TOUCHED_PATHS_CAP = 200

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

/** Initial-equivalence ignores updatedAt (a saved initial-equivalent state is deleted instead).
 * Task 2 (fix-them-serialized-teacup plan) hardening: a state carrying only
 * `checkMs` (every other field back at its initial value) must NOT read as
 * initial — otherwise FileStateStore.save() would silently rmSync it away,
 * losing in-flight per-round timing for a cycle that is, e.g., between two
 * Stop invocations with round-tracking fields already reset by some other
 * path. Same `?? []`-shaped emptiness check as `outcomes`. */
export function isInitialState(s: CcGateState): boolean {
  return (
    !s.edited && !s.gating && s.round === 0 && s.outcomes.length === 0 &&
    s.cycleStartedAt === 0 && s.failStreak === 0 &&
    (!s.checkMs || s.checkMs.length === 0) &&
    (!s.touchedPaths || s.touchedPaths.length === 0) && !s.touchedTruncated
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
  channelNudge?: boolean // default undefined/off — C4 nudge arming flag (2026-08-03 channel-ladder Task 5; inert until true)
  /** A1 cycle-tagging: optional override for the test-path HEURISTIC
   * (core/classify.ts). A string that fails to compile as a RegExp is
   * dropped (field undefined → built-in default), never a parse failure —
   * same never-throw discipline as every other field. Telemetry only:
   * structurally unable to influence any gate decision. */
  testPathPattern?: string
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
/** Why the instrument produced nothing. Present iff `present` is false
 * (pre-reg §6b amendment, 2026-08-01). `no-record` is deliberately
 * collective — armed but nothing to attach, covering not-task-shaped,
 * daily-cap, a swallowed spawn error, and a still-pending derivation. */
export type GaugeOffReason = "disabled" | "env-off" | "no-record"

export interface GaugeSensorField {
  present: boolean
  /** Set ONLY when present is false. Distinct from `reason`, which carries
   * the CLASSIFICATION reason — overloading one key with instrument state
   * would let a consumer grouping by `reason` mix the two populations. */
  offReason?: GaugeOffReason
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
  /** §6c derive-transport provenance passthrough — the Split rule (per-
   * transport reporting) is read off the sensor stream, so the field must
   * reach the line, not just the gauge file store. Absent = pre-boundary
   * CLI derivation; never fabricated. */
  transport?: GaugeTransport
}

/** §6d: a third transport joins the §6c pair. §6e: a fourth, the warm
 * daemon lane. Order is incumbent-first so existing readings that sort by
 * this array do not reshuffle. */
export const GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const
export type GaugeTransport = (typeof GAUGE_TRANSPORTS)[number]

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
  /** §4.4 reinject-wording arm for this session (pre-reg §4b; "v2" is the
   * env-gated Loop F arm, pending amendment ruling). */
  reinject?: "v0" | "v1" | "v2"
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
  /** Fix-them-serialized-teacup plan, Task 1 (2026-07-30 dogfood finding):
   * `true` means "a user prompt arrived while edits were unmeasured
   * (`edited:true, gating:false`)". Deliberately coarse semantics — three
   * caveats apply:
   *   1. Emission point is SOLELY the prompt path (`src/core/prompt.ts`) —
   *      the line reports the unmeasured STATE at prompt time, whatever
   *      earlier event produced it: a queued prompt eating the Stop
   *      boundary, or a Stop that no-op'd on a transiently unreadable
   *      gate.json (`src/core/stop.ts:32-45` returns unchanged state; no
   *      instrumentation added there — its leftover state is detected at
   *      the NEXT prompt).
   *   2. The label claims only "edits went unmeasured across a prompt
   *      boundary", never "queued prompt" specifically.
   *   3. Repeated queued prompts in one open turn each emit a line: the
   *      counter measures unmeasured-boundary EVENTS, not distinct skipped
   *      Stops.
   * Absent means no such boundary was observed; a stored `false` is never
   * written (absent is the cleaner line, same convention as `forced`). */
  skippedStop?: true
  /** Phase 3 Task 2 (5th pre-data amendment, prompt-check-mechanize plan,
   * 2026-07-31): `true` iff this UserPromptSubmit's skippedStop condition
   * triggered a detached prompt-check spawn (single-flighted via
   * `.km/cc-gate/prompt-check.lock`, prompt-check-spawn.ts). Amendment
   * discipline: this field ACCOMPANIES the `skippedStop` line already
   * appended for the same prompt — it is never a replacement signal, and a
   * sensor line never carries `promptCheck` without `skippedStop` also
   * being `true` on some line for the same boundary. Absent means no spawn
   * was attempted or recorded here; a stored `false` is never written (same
   * convention as `forced`/`skippedStop`). Populated by T3's detached CLI,
   * not by this task's hook-cli wiring. */
  promptCheck?: true
  /** Companion to `promptCheck` (5th amendment) — the `now` timestamp (ms)
   * captured at spawn time, i.e. the same value written into the lockfile's
   * `spawnTs` and forwarded as the detached prompt-check-cli's third argv.
   * Present iff `promptCheck` is present. */
  spawnTs?: number
  /** Task 2 (fix-them-serialized-teacup plan, 2026-07-30 dogfood finding):
   * per-round check elapsed-ms — `deps.now()` wrapped tightly around each
   * `runSingleRound` call in stop.ts, one entry per round that actually ran
   * (never for the internal-error/spawn-failure path, which consumes no
   * round). `durationMs` is UNCHANGED and still spans
   * `cycleStartedAt → now` across every Stop invocation in the cycle,
   * including subagent-wait between them; `checkMs` is the additive
   * companion that isolates just the check-command wall time, so the two
   * are never conflated. Emitted only on accept/exhaust (the same points
   * `durationMs` is emitted), carrying the full per-round array for the
   * cycle. Absent on lines from before this amendment. */
  checkMs?: number[]
  /** A1 cycle-tagging (2026-08-13, ported from kkamak v0.6.0): true iff
   * the cycle touched source files and no test files, by the
   * testPathPattern heuristic (core/classify.ts). ABSENT — not false —
   * whenever the touched-path set cannot be trusted to answer the
   * question: no paths recorded (legacy state, no edit carried a path) or
   * the set was truncated at TOUCHED_PATHS_CAP. Never present on a
   * skippedStop diagnostic line (that cycle has not finished). Raw paths
   * never appear on the line — derived booleans only (F2). */
  implOnly?: boolean
  /** True iff the cycle touched both source and test files in one turn —
   * implementation and its tests authored together, the shape behind the
   * review-caught defects the kkamak dogfood log documents. Same absence
   * rules as implOnly; computed together from the same touched set. */
  sameTurnCoEdit?: boolean
  /** a3 live adapter (spec §4): shadow rule-check outcomes for this Stop.
   * Outcomes only — {id, pass, ms} | {id, skipped} | {id, refused} — never
   * command text (F2). Present iff .km/rule-checks.json existed with a
   * non-empty rules array this Stop; absent otherwise (absent is the
   * cleaner line, same convention as `forced`). SHADOW: these never
   * influenced the Stop decision. Caps: RULE_CHECKS_MAX / _BUDGET_MS
   * (src/rule-checks.ts); skips/refusals are visible states, not silence. */
  ruleChecks?: RuleCheckOutcome[]
}

/** a3 live adapter (spec §4): outcome of one shadow rule check. Defined here
 * (not src/rule-checks.ts) because types.ts is the FROZEN shared contract
 * that other modules depend on and never the reverse (see file header) —
 * src/rule-checks.ts imports and re-exports this type rather than owning
 * it. F2: outcomes never carry command text or check output. */
export type RuleCheckOutcome =
  | { id: string; pass: boolean; ms: number }
  | { id: string; skipped: true }
  | { id: string; refused: true }

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
  /**
   * Compare-and-swap persist: `expectedUpdatedAt` is the `updatedAt` of the
   * state the caller loaded (0 when no record existed at load time — absent
   * reads back as INITIAL_STATE, whose updatedAt is 0, so the two sentinels
   * coincide on purpose). save() re-reads the on-disk record right before
   * committing and THROWS (StaleWriteError) when its updatedAt no longer
   * matches — a newer write landed first, and blindly overwriting it is the
   * lost-update race this parameter exists to prevent. Callers treat any
   * save() throw — stale race, ENOSPC, EPERM — as the same fail-open.
   */
  save(sessionId: string, s: CcGateState, expectedUpdatedAt: number): void
  /** Rate-limited via .last-swept dotfile; deletes *.json with updatedAt older than 7d. */
  sweep(nowMs: number): void
}
