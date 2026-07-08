/**
 * opencode-meta-harness plugin
 *
 * 4-layer harness evolution system for mh-* agents.
 *
 * Layers (injection order, general → specific):
 *   account-global  ~/.config/opencode/.meta-harness/global/
 *   project-global  <project>/.meta-harness/global/
 *   account-role    ~/.config/opencode/.meta-harness/roles/<agent>/
 *   project-role    <project>/.meta-harness/roles/<agent>/
 *   env-snapshot    (pushed last as context)
 *
 * A session uses the harness iff it runs under a primary agent whose name
 * starts with "mh-" (e.g. mh-build, mh-review, mh-debug).
 *
 * Scoring feeds all 4 layers. Auto-propose: project-role@5, project-global@10.
 * Account layers are manual-only (/mh-propose role-global | account).
 *
 * Slash commands:
 *   /mh-score good|bad [note]          — rate last session
 *   /mh-propose [scope]                — trigger proposer
 *     scope: (none)=project-role, project=project-global,
 *            role-global=account-role, account=account-global
 */

import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { gatherEnvSnapshot } from "./env-snapshot.ts"
import { adjustedTimeout } from "./bash-timeout.ts"
import {
  accountGlobalRoot,
  accountRoleRoot,
  projectGlobalRoot,
  projectRoleRoot,
  layersFor,
  bootstrapStore,
  migrateFlatToProjectGlobal,
  activeVersion,
  readActiveSystem,
  recordSession,
  DEFAULT_SYSTEM_PROMPT,
  type StoreLayer,
} from "./harness-store.ts"
import { promptHumanScore, handleScoreCommand } from "./score.ts"
import {
  triggerPropose,
  PROJECT_ROLE_THRESHOLD,
  PROJECT_GLOBAL_THRESHOLD,
} from "./propose.ts"
import { proposerSessions } from "./session-state.ts"

// ── Role detection ─────────────────────────────────────────────────────────

/** Any primary agent named "mh-*" opts into the harness system. */
function isMhRole(agent: string): boolean {
  return agent.startsWith("mh-")
}

// ── Per-session state ──────────────────────────────────────────────────────

const bootstrappedSessions = new Set<string>()
const pendingScore = new Set<string>()
const snapshotCache = new Map<string, string>()
const snapshotInjected = new Set<string>()
const sessionModel = new Map<string, string>()
const sessionVariant = new Map<string, string>()
const sessionAgent = new Map<string, string>()
const sessionTurns = new Map<string, number>()
const sessionSummary = new Map<string, string>()

function cleanupSession(sessionID: string): void {
  bootstrappedSessions.delete(sessionID)
  pendingScore.delete(sessionID)
  snapshotCache.delete(sessionID)
  snapshotInjected.delete(sessionID)
  sessionModel.delete(sessionID)
  sessionVariant.delete(sessionID)
  sessionAgent.delete(sessionID)
  sessionTurns.delete(sessionID)
  sessionSummary.delete(sessionID)
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Client = PluginInput["client"]

const log = (client: Client, level: "debug" | "info" | "warn" | "error", message: string) =>
  client.app.log({ body: { service: "meta-harness", level, message } })

// ── Plugin ─────────────────────────────────────────────────────────────────

const metaHarness: Plugin = async (input) => {
  const { worktree, client } = input

  // One-time migration of legacy flat store into project-global
  migrateFlatToProjectGlobal(worktree)

  // Bootstrap project-global with DEFAULT_SYSTEM_PROMPT (account layers start empty)
  bootstrapStore(projectGlobalRoot(worktree), DEFAULT_SYSTEM_PROMPT)
  bootstrapStore(accountGlobalRoot(), "")

  await log(client, "info", `[hook:init] plugin loaded — worktree=${worktree}`)

  return {

    // ── chat.message: capture model/variant/agent, gather env snapshot ────
    "chat.message": async (msgInput, output) => {
      const { sessionID } = output.message
      if (proposerSessions.has(sessionID)) return

      const agent = msgInput.agent ?? ""

      // Capture model + variant from primary mh-* or build/plan agents
      const isPrimary = isMhRole(agent) || agent === "build" || agent === "plan" || agent === ""
      if (isPrimary && msgInput.model && !sessionModel.has(sessionID)) {
        const model = `${msgInput.model.providerID}/${msgInput.model.modelID}`
        const variant = msgInput.variant ?? ""
        sessionModel.set(sessionID, model)
        sessionVariant.set(sessionID, variant)
        sessionAgent.set(sessionID, agent)
        await log(client, "debug", `[hook:chat.message] captured model=${model} variant=${variant || "none"} agent=${agent}`)
      }

      if (bootstrappedSessions.has(sessionID)) return
      bootstrappedSessions.add(sessionID)
      sessionTurns.set(sessionID, 0)

      // Bootstrap all 4 stores for this role on first message
      if (isMhRole(agent)) {
        bootstrapStore(accountRoleRoot(agent), "")
        bootstrapStore(projectRoleRoot(worktree, agent), "")
        await log(client, "debug", `[hook:chat.message] bootstrapped stores for agent=${agent}`)
      }

      // Gather env snapshot (async OK — fires before the LLM call)
      const snapshot = await gatherEnvSnapshot(input.$)
      if (snapshot) snapshotCache.set(sessionID, snapshot)
      await log(client, "debug", `[hook:chat.message] env snapshot length=${snapshot.length}`)
    },

    // ── system.transform: inject all 4 layers + env snapshot ─────────────
    "experimental.chat.system.transform": async (sysInput, output) => {
      const sessionID = sysInput.sessionID ?? ""
      if (proposerSessions.has(sessionID)) return

      const agent = sessionAgent.get(sessionID) ?? ""
      if (!isMhRole(agent)) return

      // Inject each layer's active prompt in order (general → specific)
      const layers = layersFor(worktree, agent)
      for (const layer of layers) {
        const system = readActiveSystem(layer.root)
        if (system) {
          output.system.push(system)
          await log(client, "debug", `[hook:system.transform] injected ${layer.scope} — ${system.length} chars`)
        }
      }

      // Inject env snapshot once per session (pushed last)
      if (sessionID && !snapshotInjected.has(sessionID)) {
        const snapshot = snapshotCache.get(sessionID)
        if (snapshot) {
          snapshotInjected.add(sessionID)
          output.system.push(snapshot)
          await log(client, "debug", `[hook:system.transform] injected env snapshot`)
        }
      }
    },

    // ── fast-command timeout ──────────────────────────────────────────────
    "tool.execute.before": async (toolInput, output) => {
      if (toolInput.tool !== "bash") return
      const args = output.args as { command?: string; timeout?: number; workdir?: string }
      if (typeof args.command !== "string") return
      const adjusted = adjustedTimeout(args.command, args.timeout)
      if (adjusted !== undefined) {
        output.args = { ...args, timeout: adjusted }
      }
    },

    // ── turn counting + summary capture ───────────────────────────────────
    "experimental.text.complete": async (textInput, output) => {
      const { sessionID } = textInput
      if (proposerSessions.has(sessionID)) return
      sessionTurns.set(sessionID, (sessionTurns.get(sessionID) ?? 0) + 1)
      sessionSummary.set(sessionID, output.text.slice(0, 500))
    },

    // ── session.idle: scoring + auto-propose ──────────────────────────────
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (proposerSessions.has(sessionID)) return

      const agent = sessionAgent.get(sessionID) ?? ""
      await log(client, "info", `[hook:event] session.idle — sessionID=${sessionID} agent=${agent} bootstrapped=${bootstrappedSessions.has(sessionID)}`)

      if (!bootstrappedSessions.has(sessionID)) return
      if (!isMhRole(agent)) return
      if (pendingScore.has(sessionID)) return

      bootstrappedSessions.delete(sessionID)
      pendingScore.add(sessionID)

      const result = await promptHumanScore(client, sessionID)
      if (result === null) {
        await log(client, "info", `[hook:event] scoring timed out — skipping ${sessionID}`)
        pendingScore.delete(sessionID)
        return
      }

      const record = {
        sessionID,
        passed: result.passed,
        note: result.note,
        turnCount: sessionTurns.get(sessionID) ?? 0,
        timestamp: new Date().toISOString(),
        summary: sessionSummary.get(sessionID) ?? "",
        model: sessionModel.get(sessionID) ?? "unknown",
        variant: sessionVariant.get(sessionID) ?? "",
      }

      // Record into all 4 stores
      const layers = layersFor(worktree, agent)
      const scores = layers.map((layer) => {
        const version = activeVersion(layer.root)
        return { layer, score: recordSession(layer.root, version, record) }
      })

      const projectRoleScore = scores.find((s) => s.layer.scope === "project-role")?.score
      const projectGlobalScore = scores.find((s) => s.layer.scope === "project-global")?.score

      await log(client, "info", `[hook:event] scored ${result.passed ? "PASS" : "FAIL"} model=${record.model} agent=${agent} — project-role ${projectRoleScore?.nPass}/${projectRoleScore?.sessions.length}`)

      await client.tui.showToast({
        body: {
          message: `Score recorded: ${result.passed ? "✓ good" : "✗ bad"} (${agent} project-role: ${projectRoleScore?.nPass}/${projectRoleScore?.sessions.length})`,
          variant: result.passed ? "success" : "warning",
          duration: 4_000,
        },
      })

      cleanupSession(sessionID)

      // Auto-propose: project-role@PROJECT_ROLE_THRESHOLD, project-global@PROJECT_GLOBAL_THRESHOLD
      const prLayer = layers.find((l) => l.scope === "project-role")!
      const pgLayer = layers.find((l) => l.scope === "project-global")!

      if (projectRoleScore && projectRoleScore.sessions.length % PROJECT_ROLE_THRESHOLD === 0) {
        await log(client, "info", `[hook:event] auto-propose project-role for ${agent}`)
        void triggerPropose(client, worktree, prLayer)
      } else if (projectGlobalScore && projectGlobalScore.sessions.length % PROJECT_GLOBAL_THRESHOLD === 0) {
        await log(client, "info", `[hook:event] auto-propose project-global`)
        void triggerPropose(client, worktree, pgLayer)
      }
    },

    // ── /mh-score + /mh-propose commands ─────────────────────────────────
    "command.execute.before": async (cmdInput, _output) => {
      await log(client, "debug", `[hook:command.execute.before] command=${cmdInput.command} args="${cmdInput.arguments}"`)

      // /mh-score good|bad [note]
      const scoreConsumed = handleScoreCommand(
        cmdInput.command,
        cmdInput.arguments,
        cmdInput.sessionID,
      )
      if (scoreConsumed) {
        await log(client, "info", `[hook:command.execute.before] /mh-score consumed`)
        throw new Error("Meta-Harness: score recorded ✓ (this notice is expected)")
      }

      // /mh-propose [scope]
      if (cmdInput.command === "mh-propose") {
        const scope = cmdInput.arguments.trim().toLowerCase()
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
        const layers = layersFor(worktree, agent)

        let layer: StoreLayer | undefined
        if (!scope || scope === "role" || scope === "project-role") {
          layer = layers.find((l) => l.scope === "project-role")
        } else if (scope === "project" || scope === "project-global") {
          layer = layers.find((l) => l.scope === "project-global")
        } else if (scope === "role-global" || scope === "account-role") {
          layer = layers.find((l) => l.scope === "account-role")
        } else if (scope === "account" || scope === "account-global") {
          layer = layers.find((l) => l.scope === "account-global")
        }

        if (layer) {
          await log(client, "info", `[hook:command.execute.before] /mh-propose scope=${layer.scope} agent=${agent}`)
          void triggerPropose(client, worktree, layer)
        } else {
          await log(client, "warn", `[hook:command.execute.before] /mh-propose unknown scope="${scope}"`)
        }

        throw new Error("Meta-Harness: propose cycle started ✓ (this notice is expected)")
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
