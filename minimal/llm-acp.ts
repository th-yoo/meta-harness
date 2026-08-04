/**
 * minimal/llm-acp.ts — the wiring seam between the design-time seats
 * (Proposer, Reviewer, revision calls — minimal/propose.ts, minimal/review.ts)
 * and the send-prompt interface (docs/superpowers/specs/2026-08-04-send-prompt-interface.md,
 * N5). `minimal/` is host-side only (see minimal/llm.ts's header), and per
 * the controller's 2026-08-05 packaging ruling this may import
 * cc-gate-plugin/src/gauge/*.ts directly by relative path — no vendoring, no
 * package.json boundary.
 *
 * This is the point of the migration: the seats move off the CLI's
 * undeclared harness onto REASONING_ISOLATION, an EXPLICIT isolation set
 * (no tools, no settings sources, a named system prompt) for the first time.
 */
import { registerProvider, sendPrompt, REASONING_ISOLATION } from "../cc-gate-plugin/src/gauge/send-prompt.ts"
import { makeAnthropicApiProvider } from "../cc-gate-plugin/src/gauge/providers/anthropic-api.ts"

const PROVIDER_ID = "anthropic-api"

// These seats "routinely spend minutes in one call" (minimal/llm.ts's own
// header for llmCall) — generous headroom over that, not a tight budget.
const DEFAULT_TIMEOUT_MS = 300_000

// 4x the gauge lane's 2048 default; safe across the current model family's
// caps. The CLI path this replaces (`claude -p`) had no cap at all, so this
// is already more conservative than what it's replacing.
const DEFAULT_MAX_TOKENS = 8192

export interface SeatCallOptions {
  /** Full environment for the provider (auth token, base-url test seam).
   * Defaults to `process.env` when absent. */
  env?: Record<string, string | undefined>
  timeoutMs?: number
  maxTokens?: number
}

/** One design-time seat call over the send-prompt interface. `ok` -> the
 * reply text; `!ok` -> throws an Error whose message names the outcome kind
 * (`no-call` / `call-consumed`, send-prompt.ts's SendOutcome), so seat logs
 * stay diagnosable the way llmCall's own thrown errors were — the kind is
 * never swallowed.
 *
 * Registers the `anthropic-api` provider on every call, closed over this
 * call's `env`. Re-registering on repeat calls overwrites the previous
 * closure — fine, since the registry is a plain `Map.set` and every caller
 * of this module only ever wants the LATEST env anyway (simpler than an
 * idempotence dance for a caller that changes env between calls in tests). */
export async function seatCall(model: string, prompt: string, opts: SeatCallOptions = {}): Promise<string> {
  const env = opts.env ?? process.env
  registerProvider(PROVIDER_ID, makeAnthropicApiProvider(env))

  const outcome = await sendPrompt(prompt, {
    model,
    isolation: REASONING_ISOLATION,
    provider: PROVIDER_ID,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  })

  if (outcome.ok) return outcome.text
  throw new Error(`seatCall(${model}) failed: ${outcome.kind}`)
}
