// anthropic-cli-warm.ts — N3c-iv of
// docs/superpowers/specs/2026-08-04-send-prompt-interface.md (§3 provider
// table, §5 row anthropic-cli-warm): wraps the reviewed ACP client
// (acp-client.ts: `ensureDaemon`, `daemonCall`) as a `SendPromptProvider`.
// Sessions stay internal to `daemonCall` (user ruling, spec §4) — this
// module never sees one. Ships NO registration side effect — same
// N5-established pattern as N2 (anthropic-api.ts): import this factory and
// wire it at the call site.
import type { SendPromptProvider, SendPromptOptions, SendOutcome } from "../send-prompt.ts"
import { ensureDaemon, daemonCall } from "../acp-client.ts"
import { buildAgentOutgoingText } from "../agent-transport.ts"
import { modelProvenBy } from "../acp-wire.ts"

export function makeAnthropicCliWarmProvider(
  env: Record<string, string | undefined>,
  opts: { ensureWaitMs?: number } = {},
): SendPromptProvider {
  return async (prompt: string, sendOpts: SendPromptOptions): Promise<SendOutcome> => {
    // The provider's own send-boundary flag, the interface-level analogue of
    // acp-client.ts's `sentPrompt`. Flipped the INSTANT `daemonCall` is
    // invoked, never after it resolves. `daemonCall` itself never throws
    // (its own documented contract), so nothing between this assignment and
    // its resolution is expected to throw — but IF something did, the bytes
    // may already be in flight, and §6e's rule for a post-send ambiguity is
    // the conservative one: call-consumed, not no-call. Everything BEFORE
    // this line (`ensureDaemon`, `buildAgentOutgoingText`) precedes any
    // possible send, so a throw there is honestly no-call — nothing was
    // spent. This is the whole boundary the wrap exists to keep honest.
    let reachedDaemonCall = false
    try {
      // Fire-and-forget by default (`ensureWaitMs` undefined -> 0): a
      // missing daemon means THIS call lands no-call and falls back, while
      // the spawn warms for the NEXT call — the plan's deliberate split; do
      // not block a record on a daemon boot by default. `daemonCall` runs
      // regardless of the boolean `ensureDaemon` returns: it already
      // refuses no-call itself when no daemon answers, so this provider
      // never duplicates that judgment.
      await ensureDaemon(env, { waitMs: opts.ensureWaitMs ?? 0 })

      // schema -> buildAgentOutgoingText(prompt, schema) when present, the
      // agent lane's entire schema-enforcement mechanism (mirrors
      // agentSdkCall's own call, agent-transport.ts:122); absent -> the
      // bare prompt, matching buildAgentOutgoingText's own no-schema
      // behavior (agent-transport.ts:90).
      const outgoingText = buildAgentOutgoingText(prompt, sendOpts.schema)

      reachedDaemonCall = true
      const outcome = await daemonCall(outgoingText, sendOpts.model, env, {
        // isolation: daemonCall's REQUIRED opt (N3c-iii), verbatim — never
        // defaulted, never substituted.
        isolation: sendOpts.isolation,
        // timeoutMs -> daemonCall's whole-call budget leg (its own
        // `budgetMs`, default ACP_BUDGET.daemonLegMs). Absent leaves that
        // default untouched.
        ...(sendOpts.timeoutMs === undefined ? {} : { budgetMs: sendOpts.timeoutMs }),
        // maxTokens: DELIBERATELY IGNORED. There is no CLI-lane equivalent
        // — the CLI never had an output-length cap, the same reality N5
        // documented for binPath. This is a spec-visible asymmetry between
        // providers (anthropic-api DOES thread maxTokens onto max_tokens);
        // the CLI-warm lane simply has nowhere to put it. Never errors on
        // it — silently dropped, not rejected.
      })

      // no-call / call-consumed pass through UNMODIFIED — daemonCall's own
      // §6e law already did the classification; this provider adds nothing
      // and subtracts nothing.
      if (outcome.kind !== "ok") return { ok: false, kind: outcome.kind }

      // `outcome.model` / `outcome.canonicalModel` are the daemon's model
      // EVIDENCE (the modelUsage key and its canonicalModel), forwarded
      // verbatim by acp-client.ts — its own doc states the daemon does NOT
      // adjudicate, because only the CALLER knows what it asked for. THIS
      // PROVIDER IS THAT CALLER: apply modelProvenBy FIRST, before trusting
      // anything else in `outcome`. Skipping or inverting this check would
      // reinstate the request-echo tautology the interface forbids.
      if (!modelProvenBy(outcome.model, sendOpts.model, outcome.canonicalModel)) {
        // Unproven: a call was spent on the wrong/unproven model. The
        // caller must not retry through this provider — call-consumed,
        // never ok, never no-call.
        return { ok: false, kind: "call-consumed" }
      }
      return {
        ok: true,
        text: outcome.text,
        // model = what was requested (N2's convention, anthropic-api.ts:55).
        model: sendOpts.model,
        // canonicalModel = the daemon's authoritative echo, or the evidence
        // key itself when the daemon reported "" for canonicalModel.
        canonicalModel: outcome.canonicalModel || outcome.model,
      }
    } catch {
      // NEVER throws (interface law). See the boundary comment above.
      return { ok: false, kind: reachedDaemonCall ? "call-consumed" : "no-call" }
    }
  }
}
