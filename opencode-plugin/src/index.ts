/**
 * opencode-meta-harness plugin
 *
 * 4-layer harness evolution system for mh-* agents.
 *
 * Layers (injection order, general → specific):
 *   account-global  <accountMetaRoot()>/global/          (default ~/.config/kkamak/global/)
 *   project-global  <project>/.kkamak/global/
 *   account-role    <accountMetaRoot()>/roles/<agent>/    (default ~/.config/kkamak/roles/<agent>/)
 *   project-role    <project>/.kkamak/roles/<agent>/
 *   env-snapshot    (pushed last as context)
 *
 * A session uses the harness iff it runs under a primary agent whose name
 * starts with "mh-" (e.g. mh-build, mh-review, mh-debug).
 *
 * Scoring feeds all 4 layers (degenerate/greeting sessions are filtered out).
 * Auto-propose: project-role@5, project-global@10 (skipped while a trial runs).
 *
 * Selection gate — a proposed candidate never auto-activates:
 *   project layers  → trial mode: live provisionally, kept only if it matches/
 *                     beats the baseline pass-rate after TRIAL_MIN_SESSIONS.
 *   account layers  → stay inactive until a TB2 ab-verdict; /mh-activate then
 *                     refuses unless the candidate won (or --force).
 *
 * Slash commands:
 *   /mh-score good|bad [note]          — rate last session
 *   /mh-propose [scope]                — trigger proposer (project→trial, account→candidate)
 *     scope: (none)=project-role, project=project-global,
 *            role-global=account-role, account=account-global
 *   /mh-activate <scope> <vN> [--force] — activate a candidate (account gated on ab-verdict)
 *   /mh-promote [global|role]          — promote proven project rules to the account layer
 *   /mh-curate [scope]                 — consolidate/prune a layer's playbook (through the gate)
 *   /mh-status                         — per-layer active version, scores, trials, verdicts, bullet count
 *
 * The platform-independent evolution logic (per-session capture, the idle
 * scoring pipeline, the /mh-* command handlers) lives in EvolutionEngine
 * (engine.ts). This file is the opencode ADAPTER: it maps opencode hooks onto
 * engine methods, owns mh-role detection (the engine never sniffs "mh-"), the
 * judge/proposer session Sets, and command rendering (toast + throw-to-swallow).
 */

import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import {
  accountGlobalRoot,
  projectGlobalRoot,
  bootstrapStore,
  migrateFlatToProjectGlobal,
  migrateProjectRoot,
  migrateAccountRoot,
  DEFAULT_SYSTEM_PROMPT,
} from "./harness-store.ts"
import { proposerSessions, judgeSessions } from "./session-state.ts"
import { OpencodeHost } from "./adapters/opencode-host.ts"
import { EvolutionEngine, InMemorySessionStateStore } from "./engine.ts"

// ── Role detection (adapter-owned — the engine never sniffs "mh-") ──────────

/** Any primary agent named "mh-*" opts into the harness system. */
function isMhRole(agent: string): boolean {
  return agent.startsWith("mh-")
}

// ── Helpers ────────────────────────────────────────────────────────────────

type Client = PluginInput["client"]

const log = (client: Client, level: "debug" | "info" | "warn" | "error", message: string) =>
  client.app.log({ body: { service: "meta-harness", level, message } })

/**
 * Surface a user-facing command result. opencode 1.17.x does NOT render a thrown
 * command.execute.before error as a visible TUI notice — it only logs it at ERROR
 * level (so a throw-only command like /mh-status looked like "nothing happened").
 * Route the message through a toast, then throw the returned Error so the command
 * is still swallowed and its (often empty) body never reaches the LLM.
 * Usage: `throw await toastAndSwallow(client, msg, "info")`.
 */
const toastAndSwallow = async (
  client: Client,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
  duration?: number,
): Promise<Error> => {
  await client.tui.showToast({
    body: {
      title: "Meta-Harness",
      message,
      variant,
      duration: duration ?? (variant === "error" ? 10_000 : 8_000),
    },
  })
  return new Error(message)
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const metaHarness: Plugin = async (input) => {
  const { worktree, client } = input
  const host = new OpencodeHost(input)
  const state = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, state)

  // Project rename (meta-harness → kkamak) FIRST: it moves the whole
  // `.meta-harness/` tree to `.kkamak/`. Running it after the flat migration
  // below would let that one create `.kkamak/` and strand the old tree.
  migrateProjectRoot(worktree)

  // One-time migration of legacy flat store into project-global
  migrateFlatToProjectGlobal(worktree)

  // One-time migration of the account-layer root off its old opencode-owned
  // location (Task L5) — safe to run every init; no-op once migrated (or on
  // a fresh install that never had an old store).
  migrateAccountRoot()

  // Bootstrap project-global with DEFAULT_SYSTEM_PROMPT (account layers start empty)
  bootstrapStore(projectGlobalRoot(worktree), DEFAULT_SYSTEM_PROMPT)
  bootstrapStore(accountGlobalRoot(), "")

  await log(client, "info", `[hook:init] plugin loaded — worktree=${worktree}`)

  return {

    // ── chat.message: capture model/variant/role, gather env snapshot ─────
    "chat.message": async (msgInput, output) => {
      const { sessionID } = output.message
      if (proposerSessions.has(sessionID)) return

      const agent = msgInput.agent ?? ""
      const isPrimary = isMhRole(agent) || agent === "build" || agent === "plan" || agent === ""
      const model = msgInput.model ? `${msgInput.model.providerID}/${msgInput.model.modelID}` : undefined

      await engine.sessionMessage(sessionID, {
        role: agent,
        isPrimary,
        participates: isMhRole(agent),
        model,
        variant: msgInput.variant,
      })
    },

    // ── system.transform: inject all 4 layers + env snapshot ─────────────
    "experimental.chat.system.transform": async (sysInput, output) => {
      const sessionID = sysInput.sessionID ?? ""

      // Judge sessions: REPLACE the entire system array with the judge persona.
      if (judgeSessions.has(sessionID)) {
        const jp = engine.judgeSystemPrompt(sessionID)
        output.system.length = 0
        if (jp !== null) output.system.push(jp)
        await log(client, "info", `[judge] system prompt replaced for ${sessionID}`)
        return
      }

      if (proposerSessions.has(sessionID)) return

      for (const block of await engine.composeInjection(sessionID)) {
        output.system.push(block)
      }
    },

    // ── fast-command timeout ──────────────────────────────────────────────
    "tool.execute.before": async (toolInput, output) => {
      const newArgs = engine.adjustToolArgs(
        toolInput.sessionID,
        toolInput.tool,
        output.args as { command?: string; timeout?: number; workdir?: string },
      )
      if (newArgs) output.args = newArgs
    },

    // ── tool-usage capture (mh-* sessions only) ───────────────────────────
    "tool.execute.after": async (toolInput, toolOutput) => {
      const { tool, sessionID } = toolInput
      if (proposerSessions.has(sessionID)) return
      const outText = typeof toolOutput.output === "string" ? toolOutput.output : ""
      engine.recordTool(sessionID, tool, outText)
    },

    // ── turn counting + summary capture ───────────────────────────────────
    "experimental.text.complete": async (textInput, output) => {
      const { sessionID } = textInput
      if (proposerSessions.has(sessionID)) return
      engine.recordTurn(sessionID, output.text)
    },

    // ── session.idle: scoring + auto-propose (delegated to the engine) ────
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (proposerSessions.has(sessionID)) return
      await engine.sessionIdle(sessionID)
    },

    // ── /mh-* commands (routed by the engine; rendered here) ─────────────
    "command.execute.before": async (cmdInput, _output) => {
      await log(client, "debug", `[hook:command.execute.before] command=${cmdInput.command} args="${cmdInput.arguments}"`)

      const result = await engine.handleCommand(cmdInput.command, cmdInput.arguments, cmdInput.sessionID)
      if (!result.consumed) return
      // Swallow the command so its (often empty) body never reaches the LLM.
      // /mh-score throws only (opencode logs it); the rest toast then throw.
      if (result.kind === "throw") throw new Error(result.message)
      throw await toastAndSwallow(client, result.message, result.variant, result.duration)
    },
  }
}

export const server: PluginModule["server"] = metaHarness
