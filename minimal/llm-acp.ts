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
import { makeAnthropicCliWarmProvider } from "../cc-gate-plugin/src/gauge/providers/anthropic-cli-warm.ts"
import type { AuthTokenDeps } from "../cc-gate-plugin/src/gauge/transport.ts"

const PROVIDER_ID = "anthropic-api"
const WARM_PROVIDER_ID = "anthropic-cli-warm"

/** 2026-08-05 wiring node: env-gated provider selection for this seat.
 * Absent or `"anthropic-api"` -> today's behaviour, byte-identical (pinned
 * by opencode-plugin/test/minimal-llm-acp.test.ts's existing tests passing
 * UNEDITED). `"anthropic-cli-warm"` -> try the warm ACP lane first, falling
 * back to `anthropic-api` ONLY on a `no-call` (the prompt bytes never
 * reached a model — spec-legal to retry elsewhere). Any other value fails
 * loud: a typo here must not silently swap the instrument a proposer/
 * reviewer run is measured against. This wiring is default-off; setting the
 * env var is activation, a separate, separately-logged decision (see this
 * node's report). */
const KKAMAK_SEAT_PROVIDER_ENV = "KKAMAK_SEAT_PROVIDER"

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
  /** Test seam threaded straight through to `makeAnthropicApiProvider`'s
   * (transport.ts's `readAuthToken`) second argument — `platform`/`home`/
   * `exec`. Absent -> `{}`, transport.ts's own default (real `process.platform`
   * + real keychain/`.credentials.json` lookup), i.e. byte-identical to
   * before this field existed. Exists because `env` alone cannot force
   * `readAuthToken`'s branch deterministically: on a real dev machine
   * (WSL2 or a logged-in MacBook) a real credential is often actually
   * resolvable, so a test wanting a guaranteed `no-call` needs to pin
   * `platform`/`home` directly rather than relying on the host's own
   * filesystem/keychain state. */
  authDeps?: AuthTokenDeps
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
 * call's `env` and `authDeps`. Re-registering on repeat calls overwrites the previous
 * closure — fine, since the registry is a plain `Map.set` and every caller
 * of this module only ever wants the LATEST env anyway (simpler than an
 * idempotence dance for a caller that changes env between calls in tests). */
export async function seatCall(model: string, prompt: string, opts: SeatCallOptions = {}): Promise<string> {
  const env = opts.env ?? process.env
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Provider selection: read from the SAME env object every other option on
  // this call reads from (`opts.env ?? process.env` above) — never a bare
  // `process.env` read, so a caller that pins env for determinism (see
  // `authDeps`'s own doc below) gets KKAMAK_SEAT_PROVIDER obeying that pin
  // too. Validated FIRST, before any provider is constructed or registered:
  // a garbage value must fail loud and do nothing else.
  const seatProvider = env[KKAMAK_SEAT_PROVIDER_ENV]
  if (seatProvider !== undefined && seatProvider !== PROVIDER_ID && seatProvider !== WARM_PROVIDER_ID) {
    throw new Error(
      `seatCall(${model}): invalid ${KKAMAK_SEAT_PROVIDER_ENV}=${JSON.stringify(seatProvider)} — ` +
      `valid values are ${JSON.stringify(PROVIDER_ID)} or ${JSON.stringify(WARM_PROVIDER_ID)} ` +
      `(absent defaults to ${JSON.stringify(PROVIDER_ID)})`,
    )
  }
  const useWarm = seatProvider === WARM_PROVIDER_ID

  // final-review Important 3: nothing below `sdkCallOutcome` inspected
  // `response.stop_reason` before this fix, so a proposer/reviewer reply
  // truncated at `maxTokens` came back as `{ok:true}` with cut-off text and
  // was parsed downstream (propose.ts, review.ts) as a COMPLETE answer.
  // Proposals feed the A/B loop, so a truncated one is a wrong record, not
  // a missing one. `truncated` is a local closure captured by THIS call's
  // `onTruncation` (registerProvider already re-registers per call, closing
  // over this call's env/authDeps — same established pattern, see the
  // header comment above): `makeAnthropicApiProvider`'s SendOutcome return
  // value is deliberately untouched by the truncation signal (send-prompt's
  // reviewed type stays byte-unchanged), so the ONLY way to learn "this
  // reply was cut off" from out here is this side channel, checked below
  // BEFORE the reply is ever handed to a caller. Registered unconditionally
  // (as today) — needed both for the default path and as the warm lane's
  // no-call fallback target below.
  let truncated = false
  registerProvider(PROVIDER_ID, makeAnthropicApiProvider(env, opts.authDeps ?? {}, {
    onTruncation: () => { truncated = true },
  }))

  // Constructing `makeAnthropicCliWarmProvider` and calling `sendPrompt`
  // against it happen ONLY inside this block — the default path (`useWarm`
  // false) never imports a daemon probe/spawn/socket touch of any kind,
  // which is exactly the guarantee opencode-plugin/test/minimal-llm-acp.test.ts's
  // "KKAMAK_SEAT_PROVIDER absent" test pins.
  if (useWarm) {
    registerProvider(WARM_PROVIDER_ID, makeAnthropicCliWarmProvider(env))

    const warmOutcome = await sendPrompt(prompt, {
      model,
      isolation: REASONING_ISOLATION,
      provider: WARM_PROVIDER_ID,
      timeoutMs,
      // maxTokens/truncation guard are API-LANE ONLY: the warm/CLI lane has
      // no output cap and DELIBERATELY IGNORES this option (see
      // anthropic-cli-warm.ts's own comment at its `daemonCall` call site)
      // — passed through for call-shape uniformity, never enforced there.
      // Symmetrically, `thinking: { type: "enabled" }` (not a SeatCallOptions
      // field today) would no-call on the warm lane exactly as it does on
      // the api lane (anthropic-api.ts), and fall through to the api lane
      // below like any other no-call — fine, not a bug.
      maxTokens,
    })

    if (warmOutcome.ok) return warmOutcome.text

    // call-consumed: THROW IMMEDIATELY, NEVER FALL BACK. A consumed call
    // followed by an api call would spend a SECOND model call for one seat
    // request — exactly the double-spend §6e (docs/superpowers/specs/
    // 2026-08-04-send-prompt-interface.md) exists to prevent. Naming both
    // the outcome kind and the provider that produced it, so a seat log
    // reads as unambiguously as a `no-call`/`call-consumed` from the
    // default path always has.
    if (warmOutcome.kind === "call-consumed") {
      throw new Error(`seatCall(${model}) failed: call-consumed (provider=${WARM_PROVIDER_ID})`)
    }

    // Only remaining case: `no-call` — the prompt bytes never reached a
    // model on the warm lane, so a fallback is spec-legal (send-prompt.ts's
    // SendOutcome doc). Fall through to exactly ONE more `sendPrompt` call
    // below, same options, on `anthropic-api`.
  }

  const outcome = await sendPrompt(prompt, {
    model,
    isolation: REASONING_ISOLATION,
    provider: PROVIDER_ID,
    timeoutMs,
    maxTokens,
  })

  if (truncated) {
    throw new Error(
      `seatCall(${model}) truncated: response hit maxTokens=${maxTokens} (stop_reason=max_tokens) — ` +
      `a truncated reply must never be treated as complete`,
    )
  }
  if (outcome.ok) return outcome.text
  throw new Error(`seatCall(${model}) failed: ${outcome.kind}`)
}
