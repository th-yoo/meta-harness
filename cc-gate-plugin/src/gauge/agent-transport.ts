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
//
// Fix round 2 (2026-08-03) — context-contamination bug found AFTER the
// initial review: `settingSources: []` does NOT stop the CLI from reading
// this project's auto-memory index (~/.claude/projects/<cwd>/memory/) into
// the first user turn as a `<system-reminder>` block. Measured on the wire:
// without the settings below, every call shipped the full contents of
// MEMORY.md (this repo's persistent notes on gauge/classifier/class-C rules)
// into the context of a call whose job is judging whether a prompt IS
// class C — a measurement instrument contaminated by notes about the thing
// it measures. Task 8 depends on this transport's context being clean for a
// paired-validation comparison against the API-SDK arm; silent contamination
// would have corrupted that comparison. Verified individually against
// sdk.d.ts, not guessed:
//  · `settings: { autoMemoryEnabled: false }` — Settings key, "When false,
//                     Claude will not read from or write to the auto-memory
//                     directory." This is the whole payload win (~10.7KB ->
//                     ~1.6KB measured).
//  · `persistSession: false` — no session transcript written to disk; this
//                     transport is a one-shot classifier, never resumed.
//  · `strictMcpConfig: true` — otherwise project .mcp.json, user settings,
//                     plugin-provided MCP servers and claude.ai connectors
//                     can load into the session.
// Deliberately NOT added:
//  · `cwd`            — measured as redundant once autoMemoryEnabled is
//                     false (both key off the same auto-memory directory
//                     resolution) — dead configuration.
//  · `excludeDynamicSections` — only applies to the `claude_code` PRESET
//                     form of `systemPrompt`; inert here since we pass a
//                     custom string. It also MOVES context into the first
//                     user message rather than removing it, so it would be
//                     the wrong tool even where it does apply.
//
// KNOWN RESIDUAL (do not chase — documented so a later reader does not
// re-litigate it): a ~369-byte `<system-reminder>` carrying the account
// email address and the current date survives every documented isolation
// option tested (settingSources, settings, persistSession, strictMcpConfig,
// cwd). This appears unavoidable via the current SDK surface.
//
// Fix round 3 (2026-08-03) — user-directed design change (not a defect):
// dropped `outputFormat`. It is what materializes the forced
// `StructuredOutput` tool on the wire — measured at 352 bytes of every
// request, the single largest removable item — and it is largely
// redundant: `buildRefinerPrompt` / `buildChannelPrompt` already instruct
// "Output ONLY a JSON object, no prose, no markdown fences" with the exact
// field shape, and `parseRefinerOutput` / `parseChannelOutput` already scan
// first `{` to last `}`, tolerate fences and surrounding prose, and return
// undefined on anything malformed (record stays pending + retryable, never
// fabricated) — the same tolerant-parse contract `sdkCall`'s plain-text path
// in transport.ts already relies on. So when `opts.schema` is given, the
// schema requirement is now carried as a terse trailing instruction appended
// to the OUTGOING text (never mutating the caller's `messageText`), and the
// result is returned as plain text — there is no `structured_output` on the
// result message without `outputFormat`, by design.
// Also added: `thinking: { type: "disabled" }` — measured to drop the
// `thinking` block 40->19 bytes and remove `context_management` entirely
// (59->0 bytes), a further ~86 bytes at zero cost for a single-shot
// classifier that never benefits from extended thinking.
import { query } from "@anthropic-ai/claude-agent-sdk"

export interface AgentSdkOptions {
  schema?: Record<string, unknown>
  maxTokens?: number
  timeoutMs?: number
}

const CALL_TIMEOUT_MS = 60_000

/** Builds the outgoing message text, appending a terse schema instruction
 * when a schema is given. Never mutates the caller's `messageText`. */
function buildOutgoingText(messageText: string, schema: Record<string, unknown> | undefined): string {
  if (!schema) return messageText
  return `${messageText}\n\nRespond with ONLY a JSON object matching this schema, no prose and no markdown fences:\n${JSON.stringify(schema)}`
}

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
      prompt: buildOutgoingText(messageText, opts.schema),
      options: {
        model,
        systemPrompt: "",
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        persistSession: false,
        strictMcpConfig: true,
        tools: [],
        title: "kkamak-gauge",
        maxTurns: 1,
        thinking: { type: "disabled" },
        abortController: controller,
        env: subprocessEnv,
      },
    })
    for await (const m of it) {
      if (m.type === "result") {
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
