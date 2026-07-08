/**
 * opencode-meta-harness plugin
 *
 * Ports three optimisations from meta-harness (Python) into opencode,
 * and adds a human-scoring + harness-evolution loop.
 *
 * Features:
 *
 * 1. Environment bootstrapping — injects a compact sandbox snapshot
 *    ([Environment Snapshot] block) into the first user message of every
 *    session via the `chat.message` hook. Eliminates 2-5 early exploration
 *    turns the LLM would otherwise spend on `ls`, `which python3`, etc.
 *
 * 2. Fast-command timeout — lowers the bash tool's per-call timeout for
 *    commands known to be instantaneous (cd, ls, echo, …). Loose port of
 *    the marker-based early-exit polling in the Python harness.
 *
 * 3. Anthropic prompt caching — already built into opencode's
 *    transform.ts (`applyCaching()`). No additional work needed.
 *
 * 4. System prompt injection — injects the current best harness system
 *    prompt from .meta-harness/active/system.md into every LLM call via
 *    the `experimental.chat.system.transform` hook.
 *
 * 5. Human scoring — after each session goes idle, prompts the human to
 *    rate it via `/mh-score good|bad [note]`. Score + trace are saved to
 *    .meta-harness/candidates/<version>/traces/.
 *
 * 6. Proposer loop — after SESSIONS_BEFORE_PROPOSE scored sessions, spawns
 *    a child OpenCode session that reads all prior candidates and traces
 *    from the filesystem and proposes an improved system.md.
 *
 * Usage — add to opencode.json:
 *   { "plugin": ["./opencode-plugin/src/index.ts"] }
 *
 * Slash command:
 *   /mh-score good [optional note]
 *   /mh-score bad  [optional note]
 */

import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { gatherEnvSnapshot } from "./env-snapshot.ts"
import { adjustedTimeout } from "./bash-timeout.ts"
import {
  bootstrapIfNeeded,
  readActiveSystem,
  activeVersion,
  recordSession,
} from "./harness-store.ts"
import { promptHumanScore, handleScoreCommand } from "./score.ts"
import { triggerPropose, SESSIONS_BEFORE_PROPOSE } from "./propose.ts"

// ── Session state ──────────────────────────────────────────────────────────

/** Sessions that have already received the env snapshot. */
const bootstrappedSessions = new Set<string>()

/** Sessions where the env snapshot has been injected into the system prompt. */
const snapshotInjected = new Set<string>()

/** Cached env snapshot per session — gathered on first message, injected on first system transform. */
const snapshotCache = new Map<string, string>()

/** Sessions currently awaiting a score — prevents double-scoring on second idle. */
const pendingScore = new Set<string>()

/** Turn counter per session (incremented on each assistant message). */
const sessionTurns = new Map<string, number>()

/** Last assistant message summary per session (for trace). */
const sessionSummary = new Map<string, string>()

// ── Plugin ─────────────────────────────────────────────────────────────────

type Client = PluginInput["client"]
const log = (client: Client, level: "debug" | "info" | "warn" | "error", message: string) =>
  client.app.log({ body: { service: "meta-harness", level, message } })

const metaHarness: Plugin = async (input) => {
  const { worktree, client } = input

  // Bootstrap .meta-harness/ store on first load
  bootstrapIfNeeded(worktree)

  await log(client, "info", `[hook:init] plugin loaded — worktree=${worktree}`)

  return {

    // ── 1: track session start ────────────────────────────────────────────
    "chat.message": async (_msgInput, output) => {
      const { sessionID } = output.message
      await log(client, "debug", `[hook:chat.message] sessionID=${sessionID} firstTime=${!bootstrappedSessions.has(sessionID)}`)
      if (bootstrappedSessions.has(sessionID)) return
      bootstrappedSessions.add(sessionID)
      sessionTurns.set(sessionID, 0)
    },

    // ── 4: system prompt injection disabled — experimental.chat.system.transform
    // causes "assistant message prefill" error with Anthropic models.
    // Tracking issue: hook fires at wrong point in message assembly.
    // "experimental.chat.system.transform": async (sysInput, output) => { ... },

    // ── 2: fast-command timeout ───────────────────────────────────────────
    "tool.execute.before": async (toolInput, output) => {
      await log(client, "debug", `[hook:tool.execute.before] FIRED — tool=${toolInput.tool} sessionID=${toolInput.sessionID}`)
      if (toolInput.tool !== "bash") return
      const args = output.args as { command?: string; timeout?: number; workdir?: string }
      if (typeof args.command !== "string") return
      const adjusted = adjustedTimeout(args.command, args.timeout)
      if (adjusted !== undefined) {
        await log(client, "debug", `[hook:tool.execute.before] lowering bash timeout — cmd="${args.command.slice(0, 40)}" ${args.timeout ?? "∞"}→${adjusted}ms`)
        output.args = { ...args, timeout: adjusted }
      }
    },

    // ── Track assistant turns + last message summary ──────────────────────
    "tool.execute.after": async (toolInput, _output) => {
      await log(client, "debug", `[hook:tool.execute.after] FIRED — tool=${toolInput.tool} sessionID=${toolInput.sessionID}`)
      const { sessionID } = toolInput
      sessionTurns.set(sessionID, (sessionTurns.get(sessionID) ?? 0) + 1)
    },

    "experimental.text.complete": async (textInput, output) => {
      await log(client, "debug", `[hook:experimental.text.complete] FIRED — sessionID=${textInput.sessionID} textLength=${output.text.length}`)
      const { sessionID } = textInput
      sessionSummary.set(sessionID, output.text.slice(0, 500))
    },

    // ── 5 + 6: human scoring + proposer on session idle ──────────────────
    event: async ({ event }) => {
      await log(client, "debug", `[hook:event] FIRED — type=${event.type}`)

      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      if (!sessionID) return

      await log(client, "info", `[hook:event] session.idle — sessionID=${sessionID} bootstrapped=${bootstrappedSessions.has(sessionID)} pendingScore=${pendingScore.has(sessionID)}`)

      // Skip sessions that were never bootstrapped (e.g. proposer sessions)
      if (!bootstrappedSessions.has(sessionID)) return
      // Skip if already waiting for a score (second idle after /mh-score command)
      if (pendingScore.has(sessionID)) return
      // Avoid scoring the same session twice
      bootstrappedSessions.delete(sessionID)
      pendingScore.add(sessionID)

      // Prompt human for score (waits up to 5 min)
      const result = await promptHumanScore(client, sessionID)
      if (result === null) {
        await log(client, "info", `[hook:event] scoring timed out — skipping session ${sessionID}`)
        pendingScore.delete(sessionID)
        return
      }

      const version = activeVersion(worktree)
      const record = {
        sessionID,
        passed: result.passed,
        note: result.note,
        turnCount: sessionTurns.get(sessionID) ?? 0,
        timestamp: new Date().toISOString(),
        summary: sessionSummary.get(sessionID) ?? "",
      }

      const score = recordSession(worktree, version, record)

      await log(client, "info", `[hook:event] scored ${result.passed ? "PASS" : "FAIL"} — ${version} cumulative ${score.nPass}/${score.sessions.length}`)

      await client.tui.showToast({
        body: {
          message: `Score recorded: ${result.passed ? "✓ good" : "✗ bad"} (${version}: ${score.nPass}/${score.sessions.length})`,
          variant: result.passed ? "success" : "warning",
          duration: 4_000,
        },
      })

      // Clean up per-session state
      pendingScore.delete(sessionID)
      snapshotInjected.delete(sessionID)
      snapshotCache.delete(sessionID)
      sessionTurns.delete(sessionID)
      sessionSummary.delete(sessionID)

      // Trigger proposer after enough sessions
      if (score.sessions.length > 0 && score.sessions.length % SESSIONS_BEFORE_PROPOSE === 0) {
        await log(client, "info", `[hook:event] triggering proposer for ${activeVersion(worktree)} → next`)
        void triggerPropose(client, worktree)
      }
    },

    // ── 5: intercept /mh-score command ───────────────────────────────────
    "command.execute.before": async (cmdInput, output) => {
      await log(client, "debug", `[hook:command.execute.before] FIRED — command=${cmdInput.command} arguments="${cmdInput.arguments}" sessionID=${cmdInput.sessionID} parts=${JSON.stringify(output.parts.map(p => ({ type: (p as any).type, text: (p as any).text?.slice(0,50) })))}`)
      const consumed = handleScoreCommand(
        cmdInput.command,
        cmdInput.arguments,
        cmdInput.sessionID,
      )
      if (consumed) {
        await log(client, "info", `[hook:command.execute.before] /mh-score consumed — aborting LLM call`)
        // Throw to abort the command before it reaches the LLM.
        // OpenCode catches this and shows it as an error, but does not call the LLM.
        throw new Error("mh-score: scored")
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
