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
import { buildRefinerPrompt } from "./refiner.ts"

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

export interface AuthTokenDeps {
  platform?: NodeJS.Platform
  home?: string
  /** Injected `security` exec; production shells out to the macOS keychain. */
  exec?: (argv: string[]) => string
}

function defaultExec(argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf-8" })
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
 * literals. Nullables are anyOf — the API rejects union type arrays. */
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

/** ONE refiner derivation over the direct API: returns the model's JSON text
 * (feed to parseRefinerOutput), undefined on ANY failure. Same env seams as
 * the CLI path (KKAMAK_GAUGE_MODEL) plus KKAMAK_GAUGE_SDK_BASE_URL /
 * KKAMAK_GAUGE_AUTH_TOKEN so tests stub the whole call over localhost with
 * zero real model calls. */
export async function callModelSdk(
  prompt: string,
  floorCheck: string,
  env: Record<string, string | undefined>,
  authDeps: AuthTokenDeps = {},
): Promise<string | undefined> {
  try {
    const authToken = readAuthToken(env, authDeps)
    if (!authToken) return undefined

    const client = new Anthropic({
      authToken,
      ...(env.KKAMAK_GAUGE_SDK_BASE_URL ? { baseURL: env.KKAMAK_GAUGE_SDK_BASE_URL } : {}),
      maxRetries: 0,
      timeout: CALL_TIMEOUT_MS,
      // OAuth bearer tokens require this beta on /v1/messages.
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    })

    const response = await client.messages.create({
      model: resolveModelId(env.KKAMAK_GAUGE_MODEL ?? "haiku"),
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: buildRefinerPrompt(prompt, floorCheck) }],
      output_config: {
        format: { type: "json_schema", schema: DERIVATION_SCHEMA as unknown as Record<string, unknown> },
      },
    })

    for (const block of response.content) {
      if (block.type === "text" && block.text) return block.text
    }
    return undefined
  } catch {
    return undefined
  }
}
