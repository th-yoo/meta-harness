// anthropic-api.ts — N2 of docs/superpowers/specs/2026-08-04-send-prompt-interface.md
// (§3 provider table, §5 row N2): the first real `SendPromptProvider`,
// driving the raw Messages API through the SAME plumbing transport.ts's
// `sdkCall` already uses (`sdkCallOutcome`, transport.ts's outcome-aware
// core). This module ships no registration — `registerProvider` wiring is
// N5's job, not this one's; import this factory and call it explicitly.
import type { SendPromptProvider, SendPromptOptions, SendOutcome } from "../send-prompt.ts"
import { sdkCallOutcome, resolveModelId, type AuthTokenDeps } from "../transport.ts"

/** `opts.isolation` (a `WarmIsolation` VALUE, acp-wire.ts:137) mapped onto
 * the raw Messages API. Most of `WarmIsolation` has no wire equivalent
 * here and is satisfied by construction rather than by inventing a field
 * for it:
 *  - `settingSources` / `settings` / `persistSession` / `strictMcpConfig` /
 *    `title` — CLI/agent-SDK-only concepts. The raw API sends no
 *    sessions, no settings and no tools, ever, so every one of these is
 *    already true of a bare Messages-API request; there is nothing to
 *    translate.
 *  - `tools: []` — satisfied the same way: the request never carries a
 *    `tools` key.
 *  - `systemPrompt` — the ONE field that maps to wire bytes: non-empty ->
 *    the request's `system` param; empty string (GAUGE_ISOLATION's shape)
 *    -> the key is omitted entirely, preserving today's `sdkCall` request
 *    shape for the gauge's existing callers.
 *  - `thinking` — both shipped isolations (`GAUGE_ISOLATION`,
 *    `REASONING_ISOLATION`) are `{ type: "disabled" }`, which omits the
 *    API `thinking` param (this provider never sends one for the
 *    disabled case, since transport.ts's core has no `thinking` knob at
 *    all yet). `{ type: "enabled" }` has no caller today and no known
 *    budget to send, so guessing one would be new, unproven behavior
 *    wearing this provider's name — refused as `no-call` instead: nothing
 *    is sent, so `no-call` is honest, and a caller can fall back. */
export function makeAnthropicApiProvider(
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
): SendPromptProvider {
  return async (prompt: string, opts: SendPromptOptions): Promise<SendOutcome> => {
    if (opts.isolation.thinking.type === "enabled") {
      return { ok: false, kind: "no-call" }
    }

    const model = resolveModelId(opts.model)
    const outcome = await sdkCallOutcome(prompt, model, env, authDeps, {
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
      schema: opts.schema,
      system: opts.isolation.systemPrompt || undefined,
    })

    if (!outcome.ok) return outcome
    // SendOutcome.model = the requested literal (post-resolveModelId);
    // .canonicalModel = the API's own echo (sdkCallOutcome's `model`,
    // sourced from `response.model`) — the two are deliberately distinct
    // fields, never collapsed into one.
    return { ok: true, text: outcome.text, model, canonicalModel: outcome.model }
  }
}
