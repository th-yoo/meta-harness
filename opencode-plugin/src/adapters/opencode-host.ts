/**
 * adapters/opencode-host.ts
 *
 * OpencodeHost — the HarnessHost implementation backed by the opencode
 * plugin's { client, $, worktree } trio (the PluginInput given to the
 * plugin entrypoint). Every method reproduces, byte-for-byte, the client/$
 * calls that used to live inline in score.ts/judge.ts/propose.ts/
 * env-snapshot.ts before this extraction — same log text, same toast
 * variants/durations, same session.create titles, same session.prompt
 * parts/model/tools shapes.
 *
 * opencode types are confined to this file (and its PluginInput param) so
 * host.ts and its callers stay platform-agnostic — see host.ts's doc.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { HarnessHost } from "../host.ts"
import { proposerSessions, judgeSessions } from "../session-state.ts"

/** ALL tools denied — byte-identical to the judge session's tools block
 * (judge.ts's former runJudge). No tool is needed for an inline-reply judge;
 * this is a structural belt on top of the persona-replaced system prompt. */
const ALL_TOOLS_DENIED = {
  bash: false, read: false, grep: false, glob: false, list: false,
  edit: false, write: false, patch: false,
  webfetch: false, websearch: false,
  task: false, todowrite: false, todoread: false, skill: false,
} as const

export class OpencodeHost implements HarnessHost {
  readonly platform = "opencode"
  readonly projectRoot: string

  private readonly client: PluginInput["client"]
  private readonly $: PluginInput["$"]

  constructor(input: PluginInput) {
    this.client = input.client
    this.$ = input.$
    this.projectRoot = input.worktree
  }

  async log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void> {
    await this.client.app.log({ body: { service: "meta-harness", level, message } })
  }

  async notify(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    durationMs = 5_000,
    title: string | null = "Meta-Harness",
  ): Promise<void> {
    await this.client.tui.showToast({
      body: { ...(title === null ? {} : { title }), message, variant, duration: durationMs },
    })
  }

  async showScorePrompt(text: string, isJudgeSuggestion: boolean): Promise<void> {
    await this.client.tui.showToast({
      body: {
        title: "Meta-Harness: rate this session",
        message: isJudgeSuggestion
          ? "Type /mh-score good  or  /mh-score bad (judge suggestion — edit if wrong)"
          : "Type /mh-score good  or  /mh-score bad",
        variant: "info",
        duration: 30_000,
      },
    })

    // Clear any existing text then pre-fill the command.
    await this.client.tui.clearPrompt()
    await this.client.tui.appendPrompt({ body: { text } })
  }

  async runTextAgent(opts: {
    title: string
    system: string
    prompt: string
    model?: unknown
    timeoutMs?: number
  }): Promise<string | null> {
    let sessionID: string | undefined
    try {
      const sessionRes = await this.client.session.create({ body: { title: opts.title } })
      sessionID = sessionRes.data?.id
      if (!sessionID) return null

      proposerSessions.add(sessionID) // skip all scoring/trajectory hooks
      judgeSessions.add(sessionID)    // system.transform replaces the persona
      const res = await this.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: opts.prompt }],
          ...(opts.model ? { model: opts.model as { providerID: string; modelID: string } } : {}),
          // No tool needed — the judge replies inline. Disable everything as a
          // structural belt (with the persona-replaced system prompt the judge
          // has no tool-use scaffolding anyway).
          tools: ALL_TOOLS_DENIED,
        },
      })

      return (res.data?.parts ?? [])
        .map((p) => (p.type === "text" ? (p as { text?: string }).text ?? "" : ""))
        .join("\n")
    } catch {
      return null
    } finally {
      if (sessionID) {
        proposerSessions.delete(sessionID)
        judgeSessions.delete(sessionID)
      }
    }
  }

  async runTaskAgent(opts: {
    title: string
    prompt: string
    model?: unknown
  }): Promise<{ id: string } | null> {
    const sessionRes = await this.client.session.create({ body: { title: opts.title } })
    const sessionID = sessionRes.data?.id
    if (!sessionID) return null

    proposerSessions.add(sessionID)
    await this.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: opts.prompt }],
        ...(opts.model ? { model: opts.model as { providerID: string; modelID: string } } : {}),
      },
    })
    return { id: sessionID }
  }

  async exec(cmd: string, _timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> {
    const result = await this.$`bash -c ${cmd}`.quiet().nothrow()
    return { stdout: result.stdout.toString("utf8"), exitCode: result.exitCode }
  }
}
