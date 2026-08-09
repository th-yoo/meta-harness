// anthropic-cli-warm.ts — N3c-iv of
// docs/superpowers/specs/2026-08-04-send-prompt-interface.md (§3 provider
// table, §5 row anthropic-cli-warm): wraps the ACP warm lane as a
// `SendPromptProvider`. Sessions stay internal to `daemonCall` (user ruling,
// spec §4) — this module never sees one. Ships NO registration side effect —
// same N5-established pattern as N2 (anthropic-api.ts): import this factory
// and wire it at the call site.
//
// gauge-cliwarm-swap: this file was the LAST cc-gate-plugin consumer still on
// the in-repo `../../acp/index.ts` client — docs/reviews/a499848-acp-budget-
// floor-guard.md named it explicitly as the reason that review's own floor
// guard scoped down to the DEFAULT margin only ("the planned guard would
// have pinned a cliff no consumer can currently reach"). `ensureDaemon`/
// `daemonCall` now come from `../../acp-client-singleton.ts`, not the
// published package directly — same reasoning as review-sensor/runner.ts
// (see that file's header and acp-client-singleton.ts's own module doc,
// which names THIS file as the future second consumer): one plugin process
// must funnel every consumer through ONE pinned env so everyone reaches the
// SAME daemon, rather than each call site fingerprinting its own env and
// fragmenting onto N daemons at ~330MB RSS each. `modelProvenBy` has no env/
// daemon coupling, so it still comes straight from the package, matching
// runner.ts's own import split.
//
// THE BUDGETMS FLOOR (live the moment this file left the old client, which
// had no such check): the package's client refuses to send at all — resolves
// `{kind:"no-call"}`, NEVER throws — when the daemon's advertised
// `daemonWorstCaseMs` is >= the call's own `budgetMs`
// (node_modules/@th-yoo/cc-api-daemon/src/acp-client.ts, the "Task 8"
// comment block in `run()`). `sendOpts.timeoutMs` maps verbatim onto
// `budgetMs` below, so any caller passing `timeoutMs <=
// ACP_BUDGET.daemonWorstCaseMs` gets a PERMANENT, SILENT no-call on every
// call, forever — no exception, no log, nothing but a stream of skips.
// review-sensor/runner.ts and a4-review.ts both dodge this by omitting
// `budgetMs` entirely (the package's own default, `ACP_BUDGET.clientBudgetMs`
// = 36 000, clears the floor with margin — see acp-package-surface.test.ts's
// floor-guard test). THIS file is the one caller that passes an explicit
// budget (`sendOpts.timeoutMs`), so it is the one place the floor is
// actually reachable; the guard below reads the floor live off
// `ACP_BUDGET.daemonWorstCaseMs` (never a hardcoded 32000) and fails loudly
// instead of degrading silently.
import type { SendPromptProvider, SendPromptOptions, SendOutcome } from "../send-prompt.ts"
import { ensureDaemon, daemonCall } from "../../acp-client-singleton.ts"
import { modelProvenBy, ACP_BUDGET } from "@th-yoo/cc-api-daemon"
import { buildAgentOutgoingText } from "../agent-transport.ts"

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
      // BUDGETMS FLOOR GUARD (gauge-cliwarm-swap) — checked BEFORE
      // `ensureDaemon`/`daemonCall` are ever touched: below the floor, the
      // package's client refuses to send regardless of daemon state (see
      // this file's header), so there is nothing to gain by even probing.
      // `<=` matches the package's own refusal condition (`dw >= budgetMs`)
      // exactly — equality is already a failure there, so this must not use
      // `<`. Short-circuits to the SAME `{kind:"no-call"}` classification
      // `daemonCall` itself would eventually produce, but LOUD: a caller
      // misconfigured this low sees exactly why, and with what value against
      // what floor, instead of a silent, permanent stream of skips. This
      // check precedes `reachedDaemonCall = true`, so the send-boundary law
      // above is unaffected — nothing was spent, this is honestly no-call.
      if (sendOpts.timeoutMs !== undefined && sendOpts.timeoutMs <= ACP_BUDGET.daemonWorstCaseMs) {
        console.error(
          `anthropic-cli-warm: timeoutMs=${sendOpts.timeoutMs}ms <= ACP_BUDGET.daemonWorstCaseMs=` +
            `${ACP_BUDGET.daemonWorstCaseMs}ms — the daemon client refuses to send under this floor ` +
            `and would resolve {kind:"no-call"} on EVERY call, silently, forever. Raise timeoutMs ` +
            `strictly above the floor.`,
        )
        return { ok: false, kind: "no-call" }
      }

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
      const outcome = await daemonCall(
        outgoingText,
        // model passed VERBATIM, no resolveModelId — the CLI lane never
        // used it. (anthropic-api.ts DOES resolve; that resolution exists
        // for the raw Messages API's own alias table, which the CLI/ACP
        // wire has no equivalent of — nothing here to translate.)
        sendOpts.model,
        env,
        {
          // isolation: daemonCall's REQUIRED opt (N3c-iii), verbatim — never
          // defaulted, never substituted.
          isolation: sendOpts.isolation,
          // timeoutMs -> daemonCall's whole-call budget leg (its own
          // `budgetMs`, default ACP_BUDGET.clientBudgetMs = 36 000 — the
          // package's constant, not the old client's `daemonLegMs`). Absent
          // leaves that default untouched; when PRESENT, the guard above has
          // already proven it clears ACP_BUDGET.daemonWorstCaseMs, so
          // nothing further to check here.
          ...(sendOpts.timeoutMs === undefined ? {} : { budgetMs: sendOpts.timeoutMs }),
          // maxTokens: DELIBERATELY IGNORED. There is no CLI-lane equivalent
          // — the CLI never had an output-length cap, the same reality N5
          // documented for binPath. This is a spec-visible asymmetry between
          // providers (anthropic-api DOES thread maxTokens onto max_tokens);
          // the CLI-warm lane simply has nowhere to put it. Never errors on
          // it — silently dropped, not rejected.
        },
      )

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
