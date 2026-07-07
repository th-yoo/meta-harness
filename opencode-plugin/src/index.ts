/**
 * opencode-meta-harness plugin
 *
 * Ports three optimisations from meta-harness (Python) into opencode:
 *
 * 1. Environment bootstrapping — injects a compact sandbox snapshot
 *    ([Environment Snapshot] block) into the first user message of every
 *    session via the `chat.message` hook. Eliminates 2-5 early exploration
 *    turns the LLM would otherwise spend on `ls`, `which python3`, etc.
 *
 * 2. Fast-command timeout — lowers the bash tool's per-call timeout for
 *    commands known to be instantaneous (cd, ls, echo, …). Loose port of
 *    the marker-based early-exit polling in the Python harness. opencode's
 *    bash tool already resolves as soon as the process exits, so this is
 *    mainly a safety cap against hanging on accidental infinite waits.
 *
 * 3. Anthropic prompt caching — already built into opencode's
 *    transform.ts (`applyCaching()`). No additional work needed; this
 *    comment is here to document that the feature is present.
 *
 * Usage — add to opencode.json:
 *   { "plugin": ["./opencode-plugin/src/index.ts"] }
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { gatherEnvSnapshot } from "./env-snapshot.ts"
import { adjustedTimeout } from "./bash-timeout.ts"

// Track which sessions have already received the env snapshot so we only
// inject it on the very first user message of each session.
const bootstrappedSessions = new Set<string>()

const metaHarness: Plugin = async (input) => {
  return {
    /**
     * chat.message — called when a new user message is received.
     *
     * On the first message of a session we run the bootstrap command
     * (via the Bun shell the plugin receives in `input.$`) and prepend
     * the resulting snapshot as the very first text part.
     *
     * NOTE: opencode's `assign()` function runs on parts BEFORE this hook
     * fires, so injected parts do not go through `assign()`. We must set
     * `id`, `sessionID`, and `messageID` ourselves so the part can be
     * persisted by `sessions.updatePart()`.
     */
    "chat.message": async (_msgInput, output) => {
      const { sessionID, id: messageID } = output.message
      if (bootstrappedSessions.has(sessionID)) return

      bootstrappedSessions.add(sessionID)

      const snapshot = await gatherEnvSnapshot(input.$)
      if (!snapshot) return

      // Generate a stable id by prefixing the messageID — opencode's own
      // PartID.ascending() uses a monotonic counter; a string id is accepted
      // as-is by PartID.make(). Using a deterministic id avoids duplicate
      // inserts if the hook fires more than once per message (shouldn't happen).
      const partId = `snapshot-${messageID}`

      const snapshotPart = {
        id: partId,
        sessionID,
        messageID,
        type: "text" as const,
        text: snapshot,
        synthetic: true,
      }

      // Prepend so the snapshot appears before the user's own message text.
      output.parts.unshift(snapshotPart as typeof output.parts[number])
    },

    /**
     * tool.execute.before — called before any tool runs.
     *
     * For the bash tool, lower the timeout on fast-returning commands to
     * avoid holding the LLM turn open for the full default 2 minutes when
     * the process exits in milliseconds.
     */
    "tool.execute.before": async (toolInput, output) => {
      if (toolInput.tool !== "bash") return

      const args = output.args as { command?: string; timeout?: number; workdir?: string }
      if (typeof args.command !== "string") return

      const adjusted = adjustedTimeout(args.command, args.timeout)
      if (adjusted !== undefined) {
        output.args = { ...args, timeout: adjusted }
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
