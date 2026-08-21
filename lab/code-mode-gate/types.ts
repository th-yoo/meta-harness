/** Contracts for the composed runtime: code-mode batching + gated effects.
 * Pure types and arithmetic — no I/O, no worker, no verifier domain content.
 * The runtime layer must stay verifier-agnostic; domain words live only under
 * verifiers/. */

export type FailureCode = "timeout" | "output_limit_exceeded" | "pending_limit_exceeded" | "guest_error"

export interface Limits {
  /** watchdog kill for one guest turn */
  timeoutMs: number
  /** max concurrently in-flight RPCs a guest may hold open */
  maxPendingCalls: number
  /** cap on total guest log bytes per turn */
  maxOutputBytes: number
}

/** Mirrors the reference implementation's defaults so cost comparisons stay
 * comparable — cited, not asserted: openclaw/openclaw
 * src/agents/code-mode-runtime.ts (DEFAULT_TIMEOUT_MS = 10_000,
 * DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024, DEFAULT_MAX_PENDING_TOOL_CALLS = 16).
 * Their DEFAULT_MEMORY_LIMIT_BYTES (64MB) is deliberately NOT mirrored — Bun
 * Workers cannot enforce one. This is a thread boundary with a watchdog, NOT
 * a security sandbox; the hostile-guest reference is OpenClaw's QuickJS-WASI
 * worker. */
export const DEFAULT_LIMITS: Limits = { timeoutMs: 10_000, maxPendingCalls: 16, maxOutputBytes: 64 * 1024 }

/** Steering: what a gate rejection tells the guest so correction can happen
 * IN-TURN. `summary` is human/model-readable; `detail` is verifier-shaped. */
export interface Steering<S = unknown> {
  summary: string
  detail: S
}

export interface Verdict<S = unknown> {
  ok: boolean
  reason?: string
  steering?: Steering<S>
}

/** A verifier is a PURE deterministic function — the zero-spend property the
 * whole composition rests on. It must derive nothing from who is asking. */
export type Verifier<C, S = unknown> = (claim: C) => Verdict<S>

export interface CostMeter {
  roundTrips: number
  toolCalls: number
  gateChecks: number
  gateRejections: number
  /** rejections in a turn that ALSO produced a later acceptance. TEMPORAL
   * co-occurrence, not proven causal steering consumption — a guest that
   * ignored the steering and happened to succeed later scores identically.
   * Causal actuation is the un-bought number; see README. */
  localRetries: number
  approxTokens: number
}

export function newMeter(): CostMeter {
  return { roundTrips: 0, toolCalls: 0, gateChecks: 0, gateRejections: 0, localRetries: 0, approxTokens: 0 }
}

export function approxTokensOf(s: string): number {
  return Math.ceil(s.length / 4)
}
