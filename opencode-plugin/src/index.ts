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
import fs from "fs"
import path from "path"
import {
  accountGlobalRoot,
  projectGlobalRoot,
  layersFor,
  bootstrapStore,
  migrateFlatToProjectGlobal,
  activeVersion,
  listVersions,
  readScore,
  readTrial,
  activateCandidate,
  readAbVerdict,
  abAccepted,
  DEFAULT_SYSTEM_PROMPT,
  type StoreLayer,
  readPlaybook,
  activeBulletCount,
  readLastMetric,
} from "./harness-store.ts"
import { handleScoreCommand } from "./score.ts"
import {
  triggerPropose,
  triggerPromote,
  triggerCurate,
  CURATOR_BUDGET,
} from "./propose.ts"
import { proposerSessions, judgeSessions } from "./session-state.ts"
import { OpencodeHost } from "./adapters/opencode-host.ts"
import { EvolutionEngine, InMemorySessionStateStore } from "./engine.ts"

// ── Role detection (adapter-owned — the engine never sniffs "mh-") ──────────

/** Any primary agent named "mh-*" opts into the harness system. */
function isMhRole(agent: string): boolean {
  return agent.startsWith("mh-")
}

const fmtRate = (r: number): string => `${(r * 100).toFixed(0)}%`

/** Map a /mh-* scope argument to a StoreLayer (shared by propose/activate). */
function resolveScopeLayer(scope: string, layers: StoreLayer[]): StoreLayer | undefined {
  const s = scope.trim().toLowerCase()
  if (!s || s === "role" || s === "project-role") return layers.find((l) => l.scope === "project-role")
  if (s === "project" || s === "project-global") return layers.find((l) => l.scope === "project-global")
  if (s === "role-global" || s === "account-role") return layers.find((l) => l.scope === "account-role")
  if (s === "account" || s === "account-global") return layers.find((l) => l.scope === "account-global")
  return undefined
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

  // One-time migration of legacy flat store into project-global
  migrateFlatToProjectGlobal(worktree)

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
        const agent = state.get(cmdInput.sessionID)?.role ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(cmdInput.arguments, layers)
        if (layer) {
          await log(client, "info", `[hook:command] /mh-propose scope=${layer.scope} agent=${agent}`)
          void triggerPropose(host, worktree, layer)
          throw await toastAndSwallow(client, "propose cycle started ✓", "success")
        }
        throw await toastAndSwallow(client, `/mh-propose — unknown scope "${cmdInput.arguments.trim()}" (use role|project|role-global|account)`, "error")
      }

      // /mh-activate <scope> <vN> [--force]
      if (cmdInput.command === "mh-activate") {
        const parts = cmdInput.arguments.trim().split(/\s+/).filter(Boolean)
        const force = parts.includes("--force")
        const positional = parts.filter((p) => p !== "--force")
        const scopeArg = positional[0] ?? ""
        const version = positional[1] ?? ""
        const agent = state.get(cmdInput.sessionID)?.role ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(scopeArg, layers)
        if (!layer) {
          throw await toastAndSwallow(client, `/mh-activate — unknown scope "${scopeArg}" (use account|project|role-global|role)`, "error")
        }
        if (!/^v\d+$/.test(version)) {
          throw await toastAndSwallow(client, `/mh-activate — expected a version like v3, got "${version}"`, "error")
        }
        const isAccount = layer.scope === "account-global" || layer.scope === "account-role"
        if (isAccount && !force) {
          const verdict = readAbVerdict(layer.root, version)
          if (!verdict) {
            throw await toastAndSwallow(client, `no ab-verdict.json for ${layer.scope} ${version} — run "bun term-bench2/runner.ts ab --layer ${layer.scope} --candidate ${version}" first, or pass --force`, "error")
          }
          if (!abAccepted(verdict)) {
            const dec = verdict.decision ?? `winner=${verdict.winner}`
            const hi = verdict.heldIn
            const detail = hi
              ? `held-in delta=${hi.delta >= 0 ? "+" : ""}${hi.delta} p=${hi.mcnemarP} CI90=${JSON.stringify(hi.bootCI90)}`
              : `candidate ${fmtRate(verdict.candidateRate)} vs active ${fmtRate(verdict.activeRate)}, n=${verdict.nTasks}`
            throw await toastAndSwallow(client, `${version} was not accepted by the ab gate (${dec}; ${detail}) — refusing; pass --force to override`, "error")
          }
        }
        const ok = activateCandidate(layer.root, version)
        if (!ok) {
          throw await toastAndSwallow(client, `candidate ${version} not found (no system.md) for ${layer.scope}`, "error")
        }
        await log(client, "info", `[hook:command] /mh-activate ${layer.scope} ${version}${force ? " --force" : ""}`)
        throw await toastAndSwallow(client, `activated ${layer.scope} ${version} ✓`, "success")
      }

      // /mh-promote [global|role]
      if (cmdInput.command === "mh-promote") {
        const scope = cmdInput.arguments.trim().toLowerCase()
        const agent = state.get(cmdInput.sessionID)?.role ?? "mh-build"
        const layers = layersFor(worktree, agent)
        let source: StoreLayer | undefined
        let target: StoreLayer | undefined
        if (!scope || scope === "global") {
          source = layers.find((l) => l.scope === "project-global")
          target = layers.find((l) => l.scope === "account-global")
        } else if (scope === "role") {
          source = layers.find((l) => l.scope === "project-role")
          target = layers.find((l) => l.scope === "account-role")
        }
        if (source && target) {
          await log(client, "info", `[hook:command] /mh-promote ${source.scope}→${target.scope} agent=${agent}`)
          void triggerPromote(host, worktree, source, target)
          throw await toastAndSwallow(client, "promote cycle started ✓", "success")
        }
        throw await toastAndSwallow(client, `/mh-promote — unknown scope "${scope}" (use global|role)`, "error")
      }

      // /mh-curate <scope> — consolidate/prune a layer's playbook (through the gate)
      if (cmdInput.command === "mh-curate") {
        const agent = state.get(cmdInput.sessionID)?.role ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(cmdInput.arguments, layers)
        if (!layer) {
          throw await toastAndSwallow(client, `/mh-curate — unknown scope "${cmdInput.arguments.trim()}" (use role|project|role-global|account)`, "error")
        }
        await log(client, "info", `[hook:command] /mh-curate scope=${layer.scope} agent=${agent}`)
        void triggerCurate(host, worktree, layer)
        throw await toastAndSwallow(client, "curate cycle started ✓", "success")
      }

      // /mh-status
      if (cmdInput.command === "mh-status") {
        const tracked = state.get(cmdInput.sessionID)?.role ?? undefined
        const trackedParticipates = state.get(cmdInput.sessionID)?.participates ?? false
        const agent = tracked ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const sessionState = tracked === undefined
          ? "no message yet — use an mh-* agent to enable scoring"
          : trackedParticipates
            ? `agent=${tracked}, scoring ON`
            : `agent=${tracked} — not scored (switch to an mh-* agent to activate the harness)`
        const lines: string[] = [`Meta-Harness status (stores for ${agent}; this session: ${sessionState}):`]
        for (const layer of layers) {
          const ver = activeVersion(layer.root)
          const score = readScore(layer.root, ver)
          const rate = score.sessions.length > 0 ? `${score.nPass}/${score.sessions.length}` : "no sessions"
          const bullets = activeBulletCount(readPlaybook(layer.root))
          const bulletInfo = bullets > 0 ? ` [${bullets} bullets${bullets > CURATOR_BUDGET ? " — over budget, /mh-curate" : ""}]` : ""
          let line = `  ${layer.scope}: active=${ver} (${rate})${bulletInfo}`
          const trial = readTrial(layer.root)
          if (trial) {
            const ts = readScore(layer.root, trial.trial)
            line += ` | TRIAL ${trial.trial} vs ${trial.baseline} (${ts.sessions.length}/${trial.minSessions})`
          }
          const versions = listVersions(layer.root)
          const newest = versions.length ? versions[versions.length - 1] : undefined
          if (newest && newest !== ver) {
            const verdict = readAbVerdict(layer.root, newest)
            let vinfo = "no verdict"
            if (verdict) {
              const dec = verdict.decision ?? `winner=${verdict.winner}`
              const hi = verdict.heldIn
              vinfo = hi
                ? `${dec} (held-in delta=${hi.delta >= 0 ? "+" : ""}${hi.delta} p=${hi.mcnemarP} CI90=${JSON.stringify(hi.bootCI90)})`
                : `${dec} (${fmtRate(verdict.candidateRate)} vs ${fmtRate(verdict.activeRate)})`
            }
            line += ` | candidate ${newest}: ${vinfo}`
          }
          lines.push(line)
        }

        // Check for plateau pause flag and show status
        const pausedFlagPath = path.join(worktree, ".meta-harness", "paused")
        if (fs.existsSync(pausedFlagPath)) {
          let ts = "unknown"
          try {
            const pausedContent = JSON.parse(fs.readFileSync(pausedFlagPath, "utf8"))
            if (typeof pausedContent.ts === "string") {
              ts = pausedContent.ts
            }
          } catch {
            // Tolerate unreadable/garbage flag content — presence alone means paused
          }
          lines.push(`  PAUSED: auto-propose disabled (plateau since ${ts}) — rm .meta-harness/paused to resume`)
        }

        const prLayer = layers.find((l) => l.scope === "project-role")
        if (prLayer) {
          const last = readLastMetric(prLayer.root, ["trial", "activate", "ab", "propose", "curate"])
          if (last) {
            const detail = [last.action, last.candidate ?? last.version ?? last.trial].filter(Boolean).join(" ")
            lines.push(`  last: ${last.event} ${detail} (${last.ts})`)
          }
        }
        throw await toastAndSwallow(client, lines.join("\n"), "info", 15_000)
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
