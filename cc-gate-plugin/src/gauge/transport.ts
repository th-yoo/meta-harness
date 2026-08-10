// km-gauge SDK transport (pre-reg §6c amendment, approved 2026-08-02) — the
// refiner's model call as a direct Anthropic API request instead of a
// detached `claude -p` child. Sends ONLY the refiner prompt (~0.7-3k tokens
// vs ~28k of CC harness), uses structured outputs to make markdown-fence and
// truncation parse failures impossible by construction, and stamps
// `transport: "sdk"` provenance on every derivation record it feeds.
//
// Binding §6c constraints implemented here:
//  - auth = keychain OAuth token passed explicitly as authToken (a zero-arg
//    client does NOT inherit CC credentials — proven 2026-08-02); read per
//    process, never cached to disk
//  - structured outputs: nullable fields use anyOf, NEVER union type arrays
//    (["string","null"] is rejected by the API)
//  - fail-open: every failure returns undefined, same as a CLI spawn
//    failure — swallowed upstream, no gauge record, never touches a session
//  - maxRetries 0: §4 is "exactly 1 call per task-shaped prompt"; a failed
//    record stays "mined"/absent and retryability lives at the record level,
//    not the HTTP level
import Anthropic from "@anthropic-ai/sdk"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { buildRefinerPrompt, buildLabelPrompt, type PromptVariant } from "./refiner.ts"
import { agentSdkCall } from "./agent-transport.ts"
import type { GaugeTransport } from "../types.ts"

const CALL_TIMEOUT_MS = 60_000
const MAX_TOKENS = 2048

/** CLI model aliases the gauge has historically used → API model ids. ONLY
 * "haiku" (the default, and the model of every corpus record to date) is
 * mapped; anything else passes through verbatim so a bad value fails loud
 * at the API (fail-open → visible starvation) instead of being silently
 * remapped to a different instrument. */
export function resolveModelId(model: string): string {
  return model === "haiku" ? "claude-haiku-4-5" : model
}

/** §6d transport selection. Fail-safe by construction: anything other than
 * the exact string "agent-sdk" keeps the incumbent SDK path, so a typo in an
 * env var can never silently retarget an instrument run. "cli" is retired and
 * deliberately not selectable. */
export function selectTransport(env: Record<string, string | undefined>): GaugeTransport {
  return env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk" ? "agent-sdk" : "sdk"
}

export interface AuthTokenDeps {
  platform?: NodeJS.Platform
  home?: string
  /** Injected `security` exec; production shells out to the macOS keychain. */
  exec?: (argv: string[]) => string
}

// 10s cap: a locked keychain / ACL prompt must fail the derivation
// (fail-open, no record) rather than hang the detached child forever.
const EXEC_TIMEOUT_MS = 10_000

function defaultExec(argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS })
}

function parseAccessToken(raw: string): string | undefined {
  try {
    const json = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown }
      accessToken?: unknown
    }
    const token = json.claudeAiOauth?.accessToken ?? json.accessToken
    return typeof token === "string" && token ? token : undefined
  } catch {
    return undefined
  }
}

/** Claude Code's OAuth access token: env override first (test seam +
 * keychain-less hosts), then the macOS keychain item on darwin, then
 * `~/.claude/.credentials.json` everywhere else (the WSL/linux layout).
 * Undefined on any failure — never throws. */
export function readAuthToken(
  env: Record<string, string | undefined>,
  deps: AuthTokenDeps = {},
): string | undefined {
  const override = env.KKAMAK_GAUGE_AUTH_TOKEN
  if (typeof override === "string" && override) return override

  const platform = deps.platform ?? process.platform
  try {
    if (platform === "darwin") {
      const exec = deps.exec ?? defaultExec
      return parseAccessToken(exec(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]))
    }
    const home = deps.home ?? process.env["HOME"] ?? os.homedir()
    return parseAccessToken(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf-8"))
  } catch {
    return undefined
  }
}

/** JSON schema for the refiner's GaugeDerivation output (refiner.ts:14-22).
 * Shape-parity with parseRefinerOutput: same fields, same class/horizon
 * literals. Nullables are anyOf — the API rejects union type arrays.
 * DELIBERATELY looser than parseRefinerOutput on emptiness (no minLength /
 * minItems): structured outputs rejects those constraint keywords, so
 * empty-string/empty-array outputs are legal here and get discarded by
 * parseRefinerOutput downstream — an M0 miss, never a wrong record. */
export const DERIVATION_SCHEMA = {
  type: "object",
  properties: {
    goalSummary: { type: "string" },
    class: { type: "string", enum: ["A1", "A2", "B", "C", "D"] },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    criteria: { type: "array", items: { type: "string" } },
    check: { anyOf: [{ type: "string" }, { type: "null" }] },
    horizon: { anyOf: [{ type: "string", enum: ["single-turn", "multi-turn"] }, { type: "null" }] },
    confidence: { type: "number" },
  },
  required: ["goalSummary", "class", "reason", "criteria", "check", "horizon", "confidence"],
  additionalProperties: false,
} as const

/** JSON schema for `cls-label`'s ClsLabelOutput (refiner.ts's
 * `parseLabelOutput` — `{label, class}`, shape-parity precedent as
 * DERIVATION_SCHEMA/parseRefinerOutput above). Nullable `class` is `anyOf`,
 * same union-type-array-is-rejected constraint. */
export const LABEL_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: ["C", "not-C"] },
    class: { anyOf: [{ type: "string", enum: ["A1", "A2", "B", "C", "D"] }, { type: "null" }] },
  },
  required: ["label", "class"],
  additionalProperties: false,
} as const

/** Optional per-call overrides — added for Task 2 (gauge-classifier 2×2 A/B,
 * `cls-run`/`cls-label`). `opts` defaults to `{}` on every exported call
 * below, and every field of it defaults to the PRE-T2 behavior when absent:
 * `model` absent -> `resolveModelId(env.KKAMAK_GAUGE_MODEL ?? "haiku")`,
 * exactly the literal expression this file used before this param existed.
 * `promptVariant` absent -> `"base"`, `buildRefinerPrompt`'s own default.
 * Every existing production caller (refiner-cli.ts, corpus-replay.ts) calls
 * `callModelSdk` with its original 4 positional args and is therefore
 * BYTE-UNTOUCHED — pinned by gauge-transport.test.ts's
 * "omitting opts preserves pre-T2 behavior" test. */
export interface SdkCallOptions {
  /** Exact API model literal (e.g. `claude-sonnet-5`) — still passed through
   * `resolveModelId`, which is a no-op for anything other than the legacy
   * `"haiku"` CLI alias, so an exact literal here is untouched. */
  model?: string
  promptVariant?: PromptVariant
}

/** Per-call knobs for `sdkCall`. Every field defaults to the original
 * refiner-transport behavior when absent: `schema` absent = a PLAIN text
 * call (no `output_config` key on the request at all — the nudge shape),
 * `maxTokens` absent = 2048, `timeoutMs` absent = 60s. */
export interface SdkTransportOptions {
  /** JSON schema for structured output. Present → the request carries
   * `output_config.format = {type:"json_schema", schema}`; absent → plain
   * text call, no output_config. Same anyOf-never-union constraint as
   * DERIVATION_SCHEMA applies to anything passed here. */
  schema?: Record<string, unknown>
  /** Request max_tokens; defaults to 2048. */
  maxTokens?: number
  /** Whole-call SDK timeout in ms; defaults to 60s. */
  timeoutMs?: number
  /** N2 (anthropic-api provider) addition. Request `system` param.
   * Absent/empty → no `system` key at all — every pre-N2 caller (none of
   * which pass this field) is byte-unchanged. */
  system?: string
}

/** N2 (send-prompt interface, `anthropic-api` provider) addition — §6e's
 * wire-send boundary law, `no-call` vs `call-consumed`, surfaced out of
 * this transport instead of collapsed by `sdkCall`'s `catch {}`.
 * `model` is the API's OWN echo (`response.model`), not the requested
 * literal — callers that need the requested literal already have it.
 * `stopReason` (final-review Important 3, additive): `response.stop_reason`
 * verbatim, on the `ok` arm only. Nothing in this module inspects it —
 * every existing caller of `sdkCallOutcome`/`sdkCall`/`callModelSdk*` is
 * byte-unchanged by its addition (an extra object field nothing reads is
 * not an observable behavior change). It exists so a caller ABOVE this
 * layer (the anthropic-api provider, then minimal/llm-acp.ts's `seatCall`)
 * can tell a reply that hit `max_tokens` apart from one that ended
 * naturally — `sdkCallOutcome` itself never inspects it because a "was this
 * truncated" POLICY (retry? throw? accept?) is a caller decision, not a
 * transport one. */
export type SdkOutcome =
  | { ok: true; text: string; model: string; stopReason?: string }
  | { ok: false; kind: "no-call" | "call-consumed" }

/** Shared call plumbing (auth -> client -> request -> text block
 * extraction) for EVERY gauge-family SDK call: `callModelSdk`
 * (refiner-shaped) and `callModelSdkLabel` (label-rubric-shaped) below,
 * plus channel-run.ts `callChannelModel` (structured, 60s/2048) and
 * hook-cli.ts's C4-nudge transport (plain text, 8s/512) — same auth/env
 * seams (KKAMAK_GAUGE_AUTH_TOKEN / KKAMAK_GAUGE_SDK_BASE_URL), same
 * fail-open-on-anything discipline (undefined on ANY failure, never
 * throws), same maxRetries:0 (§4 exactly-1-call), differing only in
 * prompt text + model literal + the per-call knobs in `opts`.
 *
 * N2 boundary classification (spec §6e, conservative side — when in
 * doubt, `call-consumed`):
 *  - no auth token resolvable -> `no-call` (nothing was ever sent).
 *  - a throw BEFORE `client.messages.create` is entered (client
 *    construction) -> `no-call`.
 *  - anything at or after `messages.create` — thrown SDK error, timeout,
 *    HTTP failure — -> `call-consumed`. A connection error might mean
 *    nothing was sent, but that is unprovable from out here; the
 *    conservative reading wins, same call §6e already makes at the wire
 *    and send-prompt.ts makes at the interface (a throwing provider ->
 *    `call-consumed`).
 *  - response returned but no non-empty text block -> `call-consumed` (a
 *    call was spent; there is just no usable answer). */
export async function sdkCallOutcome(
  messageText: string,
  model: string,
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
  opts: SdkTransportOptions = {},
): Promise<SdkOutcome> {
  // Review finding: readAuthToken's "never throws" contract holds today,
  // but it is not enforced by the type system — a future regression there
  // must degrade to `no-call` (nothing was sent) rather than propagate as
  // an uncaught exception out of this "never throws" function.
  let authToken: string | undefined
  try {
    authToken = readAuthToken(env, authDeps)
  } catch {
    return { ok: false, kind: "no-call" }
  }
  if (!authToken) return { ok: false, kind: "no-call" }

  let client: Anthropic
  try {
    client = new Anthropic({
      authToken,
      // Review finding 1: without an explicit null, the SDK falls back to
      // reading ANTHROPIC_API_KEY from the env and would send BOTH
      // X-Api-Key and Authorization on hosts that carry a key (bench
      // containers do). This transport is OAuth-only, always.
      apiKey: null,
      ...(env.KKAMAK_GAUGE_SDK_BASE_URL ? { baseURL: env.KKAMAK_GAUGE_SDK_BASE_URL } : {}),
      maxRetries: 0,
      timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS,
      // OAuth bearer tokens require this beta on /v1/messages.
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    })
  } catch {
    // Construction failure — the boundary law's "before messages.create is
    // entered" case. Nothing was ever sent.
    return { ok: false, kind: "no-call" }
  }

  try {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? MAX_TOKENS,
      messages: [{ role: "user", content: messageText }],
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.schema
        ? { output_config: { format: { type: "json_schema" as const, schema: opts.schema } } }
        : {}),
    })

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        return {
          ok: true,
          text: block.text,
          model: response.model,
          ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
        }
      }
    }
    return { ok: false, kind: "call-consumed" }
  } catch {
    return { ok: false, kind: "call-consumed" }
  }
}

/** Back-compat wrapper over `sdkCallOutcome` — BYTE-IDENTICAL observable
 * behavior to the pre-N2 implementation: `ok` -> the text, either failure
 * kind -> `undefined`. Every existing caller (`callModelSdk`,
 * `callModelSdkLabel`, `channel-run.ts`, `hook-cli.ts`) keeps this
 * two-value contract untouched; only `sdkCallOutcome` (new, N2-only)
 * exposes the no-call/call-consumed split. */
export async function sdkCall(
  messageText: string,
  model: string,
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
  opts: SdkTransportOptions = {},
): Promise<string | undefined> {
  const outcome = await sdkCallOutcome(messageText, model, env, authDeps, opts)
  return outcome.ok ? outcome.text : undefined
}

/** ONE refiner derivation over the direct API: returns the model's JSON text
 * (feed to parseRefinerOutput), undefined on ANY failure. Same env seams as
 * the CLI path (KKAMAK_GAUGE_MODEL) plus KKAMAK_GAUGE_SDK_BASE_URL /
 * KKAMAK_GAUGE_AUTH_TOKEN so tests stub the whole call over localhost with
 * zero real model calls. `opts` (Task 2) — see SdkCallOptions doc above. */
export async function callModelSdk(
  prompt: string,
  floorCheck: string,
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
  opts: SdkCallOptions = {},
): Promise<string | undefined> {
  const model = resolveModelId(opts.model ?? env.KKAMAK_GAUGE_MODEL ?? "haiku")
  const messageText = buildRefinerPrompt(prompt, floorCheck, opts.promptVariant ?? "base")
  if (selectTransport(env) === "agent-sdk") {
    return agentSdkCall(messageText, model, env, {
      schema: DERIVATION_SCHEMA as unknown as Record<string, unknown>,
    })
  }
  return sdkCall(messageText, model, env, authDeps, {
    schema: DERIVATION_SCHEMA as unknown as Record<string, unknown>,
  })
}

/** `cls-label`'s (Task 2) blind-label call: the SAME `sdkCall` plumbing as
 * `callModelSdk`'s non-agent-sdk path (auth -> client -> request -> text
 * block extraction), but `buildLabelPrompt` (the rubric, not the extraction
 * prompt) + `LABEL_SCHEMA`, and defaults to the pre-registered labeler
 * literal `claude-opus-5` rather than the refiner's haiku default — the
 * label go is never routed through `KKAMAK_GAUGE_MODEL`, so a stray env
 * var armed for the live refiner can never silently retarget the labeler.
 * §6d note: unlike `callModelSdk`, this call is deliberately NOT env-routed
 * through `selectTransport` — only the deriver (`callModelSdk`) is subject
 * to `KKAMAK_GAUGE_TRANSPORT`; labels always go over the direct API SDK. */
export async function callModelSdkLabel(
  prompt: string,
  floorCheck: string,
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
  opts: { model?: string } = {},
): Promise<string | undefined> {
  const model = resolveModelId(opts.model ?? "claude-opus-5")
  const messageText = buildLabelPrompt(prompt, floorCheck)
  // cls-ab Amendment 1 (2026-08-10, pre-data): the SAME per-caller §6d
  // transport branch callModelSdk has above. This function previously
  // hardwired the bare-SDK path, which the per-model-tier 429 wall blocks
  // for the opus labeler while the agent lane serves it — the exact
  // asymmetry measured 2026-08-06 and re-confirmed on the first label go.
  // The labeler MODEL stays the §2.3 literal either way.
  if (selectTransport(env) === "agent-sdk") {
    return agentSdkCall(messageText, model, env, {
      schema: LABEL_SCHEMA as unknown as Record<string, unknown>,
    })
  }
  return sdkCall(messageText, model, env, authDeps, {
    schema: LABEL_SCHEMA as unknown as Record<string, unknown>,
  })
}
