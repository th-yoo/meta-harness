/**
 * minimal/llm.ts — shared host-side one-shot LLM runner for the design-time
 * seats (Proposer, Reviewer, revision calls). Extracted from propose.ts.
 *
 * Prompt rides stdin on BOTH drivers: big prompts (>0.5MB) blow Linux's
 * ~128KB per-argv-string limit (E2BIG, observed live at round 2). opencode
 * run appends piped stdin to the message (cli/cmd/run.ts resolveRunInput).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const PROPOSER_DRIVERS = {
  "claude-code": { defaultModel: "claude-opus-5" },
  opencode: { defaultModel: "anthropic/claude-opus-5" },
} as const
export type ProposerDriverId = keyof typeof PROPOSER_DRIVERS

export interface LlmCallOptions {
  /** ABSOLUTE path to the driver binary, overriding the ambient-PATH lookup.
   *
   * This is the seam that makes the CLI drivers testable without spending.
   * MEASURED 2026-08-04 on Bun 1.3.1: an executable is resolved from the PATH
   * captured at PROCESS START, NOT from a mutated `process.env.PATH` — a fake
   * reachable only via a mutated PATH throws ENOENT, while the same fake
   * resolves fine by absolute path or via an explicit `env`. So a test that
   * prepends a temp dir to `process.env.PATH` and lets this spawn `"claude"`
   * runs the REAL CLI, silently and at real cost. Inject the path instead. */
  binPath?: string
  /** Full environment for the child. Replaces the inherited one when given. */
  env?: Record<string, string>
}

/** One host-side design-time model call.
 *
 * ASYNC since 2026-08-04. It was `Bun.spawnSync`, which blocks the event loop
 * for the entire call, and these seats routinely spend minutes in one. Every
 * call site was already async-tolerant (`reviewBullet.call` is typed
 * `string | Promise<string>` and awaited at review.ts:262), so this is a
 * signature change rather than a control-flow change — but it is what lets a
 * non-blocking transport be substituted for the CLI spawn later. */
export async function llmCall(
  driverId: ProposerDriverId,
  model: string,
  prompt: string,
  opts: LlmCallOptions = {},
): Promise<string> {
  if (driverId === "claude-code") {
    const proc = Bun.spawn([opts.binPath ?? "claude", "-p", "--model", model, "--output-format", "json"], {
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env ? { env: opts.env } : {}),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(`claude call failed (exit ${exitCode}): ${stderr.slice(0, 400)}`)
    return JSON.parse(stdout).result ?? ""
  }
  // opencode, host-side. Isolation mirrors run.ts's container recipe:
  // - XDG_CONFIG_HOME → temp config with ONLY the CC-oauth auth plugin
  //   (skips the user's global config: MCP servers etc.); the plugin is
  //   resolved from opencode's own cache (~/.cache/opencode), untouched.
  // - --dir → empty temp dir; the repo's AGENTS.md is the harness under test
  //   and must not leak into the design-time context.
  // - NO --auto: non-interactive permission requests auto-REJECT, so the
  //   call stays text-only reasoning — no tool execution on host.
  // - agent.build.prompt REPLACES opencode's built-in coding-agent system
  //   prompt (anthropic.txt) — request.ts: agent.prompt ?? SystemPrompt.
  const scratch = mkdtempSync(join(tmpdir(), "minimal-llm-"))
  const workDir = join(scratch, "work")
  const configDir = join(scratch, "config", "opencode")
  mkdirSync(workDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: ["opencode-claude-auth@latest"],
      agent: {
        build: {
          prompt:
            "You are a careful reasoning assistant. Answer directly in plain text in this conversation. Do not use tools, read or modify files, or run commands.",
        },
      },
    }) + "\n",
  )
  const proc = Bun.spawn(
    [opts.binPath ?? "opencode", "run", "--dir", workDir, "--format", "json", "--model", model],
    {
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? { ...process.env, XDG_CONFIG_HOME: join(scratch, "config") },
    },
  )
  const [outText, errText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`opencode call failed (exit ${exitCode}): ${errText.slice(0, 400)}`)
  // --format json = ndjson events; a "text" event fires once per COMPLETED
  // text part (part.time.end gate) carrying the part's full text. Keyed by
  // part.id in case a completed part is re-emitted on a later message update.
  const parts = new Map<string, string>()
  const errors: string[] = []
  for (const line of outText.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    let ev: any
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    if (ev.type === "text" && ev.part?.text) parts.set(String(ev.part.id ?? parts.size), String(ev.part.text))
    if (ev.type === "error") errors.push(JSON.stringify(ev.error).slice(0, 400))
  }
  if (parts.size === 0)
    throw new Error(
      `opencode returned no text${errors.length ? ` — errors: ${errors.join("; ")}` : ` (stderr: ${errText.slice(0, 400)})`}`,
    )
  return [...parts.values()].join("\n")
}
