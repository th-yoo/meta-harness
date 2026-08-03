// §6d Agent-SDK transport. Peer of transport.ts's sdkCall, same contract:
// one classification in, model text out, undefined on ANY failure.
//
// Option choices are load-bearing and were established by wire capture
// (2026-08-03) rather than by reading prose docs:
//  · `tools: []`      drops built-in tool DEFINITIONS. `allowedTools: []` is
//                     only a permission filter and leaves 29 definitions on
//                     the request — do not substitute it.
//  · `title`          supplied so the SDK does not spend extra model calls
//                     auto-generating a session title.
//  · `systemPrompt: ""` minimizes, but does NOT empty, the system blocks: an
//                     `x-anthropic-billing-header` line and an agent-identity
//                     line survive. That residue is what §6d's bar measures.
//  · `settingSources: []` keeps CLAUDE.md and user/project settings out.
//  · schema arrives via `outputFormat`, enforced by a forced StructuredOutput
//                     tool — `output_config` is absent by design here.
import { query } from "@anthropic-ai/claude-agent-sdk"

export interface AgentSdkOptions {
  schema?: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
}

const CALL_TIMEOUT_MS = 60_000

export async function agentSdkCall(
  messageText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: AgentSdkOptions = {},
): Promise<string | undefined> {
  // The timeout MUST be able to cancel the query. `query()` exposes
  // `abortController` for exactly this; a bare setTimeout cannot interrupt a
  // `for await` and would let one stalled call hang an entire fenced batch.
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), opts.timeoutMs ?? CALL_TIMEOUT_MS)
  try {
    // `env` REPLACES the subprocess environment (sdk.d.ts: "this value
    // REPLACES the subprocess environment entirely — it is not merged"), so
    // callers must pass a FULL env. Undefined-valued keys are dropped rather
    // than cast away, so the subprocess never receives "undefined" strings.
    const subprocessEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined) subprocessEnv[k] = v

    const it = query({
      prompt: messageText,
      options: {
        model,
        systemPrompt: "",
        settingSources: [],
        tools: [],
        title: "kkamak-gauge",
        maxTurns: 1,
        abortController: controller,
        env: subprocessEnv,
        ...(opts.schema ? { outputFormat: { type: "json_schema" as const, schema: opts.schema } } : {}),
      },
    })
    for await (const m of it) {
      if (m.type === "result") {
        const structured = (m as { structured_output?: unknown }).structured_output
        if (structured !== undefined) return JSON.stringify(structured)
        const text = (m as { result?: unknown }).result
        return typeof text === "string" ? text : undefined
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(deadline)
  }
}
