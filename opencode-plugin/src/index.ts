/**
 * opencode-meta-harness plugin
 *
 * Ports three optimisations from meta-harness (Python) into opencode,
 * and adds a human-scoring + harness-evolution loop.
 *
 * Features:
 *
 * 1. Environment bootstrapping (B) — gathers a compact env snapshot on the
 *    first message of each session and injects it into the system prompt via
 *    experimental.chat.system.transform so the LLM never needs to run ls/which.
 *
 * 2. Fast-command timeout — lowers bash tool timeout for known-fast commands.
 *    Loose port of marker-based polling; opencode already exits as soon as
 *    the process ends.
 *
 * 3. Anthropic prompt caching — built into opencode's transform.ts. No hook.
 *
 * 4. System prompt injection (A) — injects the current best harness system.md
 *    into every LLM call via experimental.chat.system.transform.
 *
 * 5. Human scoring — after session.idle, prompts the human via
 *    /mh-score good|bad [note]. Score + trace saved to filesystem.
 *
 * 6. Proposer loop — after SESSIONS_BEFORE_PROPOSE scored sessions, spawns a
 *    child session that reads all prior traces and proposes an improved system.md.
 *
 * 7. Proposer session exclusion (C) — proposer's own sessions are not scored
 *    and do not receive the harness-under-test system prompt.
 *
 * 8. Model tagging (H2) — each session trace records the LLM model used so the
 *    proposer can diagnose model-specific vs. general failures.
 *
 * Slash commands:
 *   /mh-score good [note]   — rate last session as good
 *   /mh-score bad  [note]   — rate last session as bad
 *   /mh-propose             — manually trigger a propose cycle now
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
import { proposerSessions } from "./session-state.ts"

// ── Per-session state ──────────────────────────────────────────────────────

/** Sessions that have received their first chat.message (used as "active" marker). */
const bootstrappedSessions = new Set<string>()

/** Sessions awaiting a human score — blocks re-entry on second idle event. */
const pendingScore = new Set<string>()

/** Cached env snapshot per session (gathered on first message). */
const snapshotCache = new Map<string, string>()

/** Whether the snapshot has been injected into the system prompt yet. */
const snapshotInjected = new Set<string>()

/** LLM model observed per session (captured in system.transform). */
const sessionModel = new Map<string, string>()

/** Turn counter per session (incremented in experimental.text.complete). */
const sessionTurns = new Map<string, number>()

/** Last assistant text per session (captured in experimental.text.complete). */
const sessionSummary = new Map<string, string>()

// ── Helpers ────────────────────────────────────────────────────────────────

type Client = PluginInput["client"]

const log = (client: Client, level: "debug" | "info" | "warn" | "error", message: string) =>
  client.app.log({ body: { service: "meta-harness", level, message } })

function cleanupSession(sessionID: string): void {
  bootstrappedSessions.delete(sessionID)
  pendingScore.delete(sessionID)
  snapshotCache.delete(sessionID)
  snapshotInjected.delete(sessionID)
  sessionModel.delete(sessionID)
  sessionTurns.delete(sessionID)
  sessionSummary.delete(sessionID)
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const metaHarness: Plugin = async (input) => {
  const { worktree, client } = input

  bootstrapIfNeeded(worktree)
  await log(client, "info", `[hook:init] plugin loaded — worktree=${worktree}`)

  return {

    // ── B: gather env snapshot on first message ───────────────────────────
    "chat.message": async (_msgInput, output) => {
      const { sessionID } = output.message

      // Skip proposer's own sessions
      if (proposerSessions.has(sessionID)) return

      if (bootstrappedSessions.has(sessionID)) return
      bootstrappedSessions.add(sessionID)
      sessionTurns.set(sessionID, 0)

      await log(client, "debug", `[hook:chat.message] first message — sessionID=${sessionID}`)

      // Gather env snapshot now (async OK — fires before the LLM call)
      const snapshot = await gatherEnvSnapshot(input.$)
      await log(client, "debug", `[hook:chat.message] env snapshot length=${snapshot.length}`)
      if (snapshot) snapshotCache.set(sessionID, snapshot)
    },

    // ── A + B: inject system prompt + env snapshot into every LLM call ────
    "experimental.chat.system.transform": async (sysInput, output) => {
      const sessionID = sysInput.sessionID ?? ""
      const modelID = `${sysInput.model.providerID}/${sysInput.model.id}`

      // Skip proposer's own sessions (don't inject the harness under test)
      if (proposerSessions.has(sessionID)) return

      // H2: capture model on first transform for this session
      if (sessionID && !sessionModel.has(sessionID)) {
        sessionModel.set(sessionID, modelID)
        await log(client, "debug", `[hook:system.transform] captured model=${modelID} sessionID=${sessionID}`)
      }

      // A: inject active harness system prompt
      const system = readActiveSystem(worktree)
      if (system) {
        output.system.unshift(system)
        await log(client, "debug", `[hook:system.transform] injected system prompt — ${system.length} chars`)
      }

      // B: inject cached env snapshot once per session
      if (sessionID && !snapshotInjected.has(sessionID)) {
        const snapshot = snapshotCache.get(sessionID)
        if (snapshot) {
          snapshotInjected.add(sessionID)
          output.system.push(snapshot)
          await log(client, "debug", `[hook:system.transform] injected env snapshot — ${snapshot.length} chars`)
        }
      }
    },

    // ── 2: fast-command timeout ───────────────────────────────────────────
    "tool.execute.before": async (toolInput, output) => {
      if (toolInput.tool !== "bash") return
      const args = output.args as { command?: string; timeout?: number; workdir?: string }
      if (typeof args.command !== "string") return
      const adjusted = adjustedTimeout(args.command, args.timeout)
      if (adjusted !== undefined) {
        await log(client, "debug", `[hook:tool.execute.before] bash timeout ${args.timeout ?? "∞"} → ${adjusted}ms`)
        output.args = { ...args, timeout: adjusted }
      }
    },

    // ── E: count turns + capture last assistant text ──────────────────────
    "experimental.text.complete": async (textInput, output) => {
      const { sessionID } = textInput
      if (proposerSessions.has(sessionID)) return
      sessionTurns.set(sessionID, (sessionTurns.get(sessionID) ?? 0) + 1)
      sessionSummary.set(sessionID, output.text.slice(0, 500))
    },

    // ── 5 + 6: human scoring + proposer on session idle ──────────────────
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      if (!sessionID) return

      // C: skip proposer's own sessions entirely
      if (proposerSessions.has(sessionID)) return

      await log(client, "info", `[hook:event] session.idle — sessionID=${sessionID} bootstrapped=${bootstrappedSessions.has(sessionID)} pendingScore=${pendingScore.has(sessionID)}`)

      if (!bootstrappedSessions.has(sessionID)) return
      if (pendingScore.has(sessionID)) return

      bootstrappedSessions.delete(sessionID)
      pendingScore.add(sessionID)

      const result = await promptHumanScore(client, sessionID)
      if (result === null) {
        await log(client, "info", `[hook:event] scoring timed out — skipping ${sessionID}`)
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
        model: sessionModel.get(sessionID) ?? "unknown",  // H2
      }

      const score = recordSession(worktree, version, record)

      await log(client, "info", `[hook:event] scored ${result.passed ? "PASS" : "FAIL"} model=${record.model} — ${version} cumulative ${score.nPass}/${score.sessions.length}`)

      await client.tui.showToast({
        body: {
          message: `Score recorded: ${result.passed ? "✓ good" : "✗ bad"} (${version}: ${score.nPass}/${score.sessions.length})`,
          variant: result.passed ? "success" : "warning",
          duration: 4_000,
        },
      })

      cleanupSession(sessionID)

      if (score.sessions.length > 0 && score.sessions.length % SESSIONS_BEFORE_PROPOSE === 0) {
        await log(client, "info", `[hook:event] triggering proposer — ${version} → next`)
        void triggerPropose(client, worktree)
      }
    },

    // ── 5 + G: intercept /mh-score and /mh-propose commands ──────────────
    "command.execute.before": async (cmdInput, _output) => {
      await log(client, "debug", `[hook:command.execute.before] command=${cmdInput.command} args="${cmdInput.arguments}"`)

      // /mh-score good|bad [note]
      const scoreConsumed = handleScoreCommand(
        cmdInput.command,
        cmdInput.arguments,
        cmdInput.sessionID,
      )
      if (scoreConsumed) {
        await log(client, "info", `[hook:command.execute.before] /mh-score consumed — aborting LLM call`)
        // D: throw to abort the LLM call. session.command has no noReply flag
        // (confirmed by inspecting SDK types), so this is the only reliable abort.
        // OpenCode shows this as an error flash — expected behaviour, not a bug.
        throw new Error("Meta-Harness: score recorded ✓ (this notice is expected)")
      }

      // G: /mh-propose — manual proposer trigger
      if (cmdInput.command === "mh-propose") {
        await log(client, "info", `[hook:command.execute.before] /mh-propose — triggering proposer manually`)
        void triggerPropose(client, worktree)
        throw new Error("Meta-Harness: propose cycle started ✓ (this notice is expected)")
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
