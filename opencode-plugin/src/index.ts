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
 *   /mh-status                         — per-layer active version, scores, trials, verdicts
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
  listVersions,
  readActiveSystem,
  readActiveTools,
  recordSession,
  readScore,
  readTrial,
  resolveTrial,
  activateCandidate,
  readAbVerdict,
  DEFAULT_SYSTEM_PROMPT,
  type StoreLayer,
  type ToolUsage,
} from "./harness-store.ts"
import { promptHumanScore, handleScoreCommand } from "./score.ts"
import {
  triggerPropose,
  triggerPromote,
  PROJECT_ROLE_THRESHOLD,
  PROJECT_GLOBAL_THRESHOLD,
} from "./propose.ts"
import { proposerSessions } from "./session-state.ts"

// ── Role detection ─────────────────────────────────────────────────────────

/** Any primary agent named "mh-*" opts into the harness system. */
function isMhRole(agent: string): boolean {
  return agent.startsWith("mh-")
}

/**
 * Conservative degenerate-session filter — false negatives are fine, false
 * positives are not. A genuine no-tool Q&A session's captured text almost
 * always exceeds 50 chars; greetings ("Hello! How can I help…") and empty
 * sessions do not, and turnCount === 0 means the model never completed a turn.
 * Such sessions must never count toward a candidate's pass/fail signal.
 */
function isDegenerateSession(turnCount: number, toolUsage: ToolUsage, summary: string): boolean {
  if (turnCount === 0) return true
  const totalCalls = Object.values(toolUsage).reduce((n, t) => n + t.calls, 0)
  return totalCalls === 0 && summary.trim().length < 50
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
const sessionToolUsage = new Map<string, ToolUsage>()

/**
 * Tools whose output is execution results (not file content).
 * Only these get error-heuristic analysis — applying it to read/grep/glob
 * would false-positive on source code that contains error-handling words.
 */
const EXECUTION_TOOLS = new Set(["bash", "task"])

/** Best-effort error detection from execution tool output. */
const ERROR_PATTERN = /\berror\b|\bfailed\b|\bexception\b|no such file|exit code [1-9]|traceback|command not found/i

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
  sessionToolUsage.delete(sessionID)
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

      const layers = layersFor(worktree, agent)

      // Inject each layer's system.md in order (general → specific)
      for (const layer of layers) {
        const system = readActiveSystem(layer.root)
        if (system) {
          output.system.push(system)
          await log(client, "debug", `[hook:system.transform] injected ${layer.scope} system — ${system.length} chars`)
        }
      }

      // Assemble tool-usage guidance from all 4 layers into one section
      const toolParts: string[] = []
      for (const layer of layers) {
        const tools = readActiveTools(layer.root)
        if (tools) toolParts.push(tools)
      }
      if (toolParts.length > 0) {
        output.system.push(`## Tool usage guidance\n\n${toolParts.join("\n\n")}`)
        await log(client, "debug", `[hook:system.transform] injected tool guidance from ${toolParts.length} layer(s)`)
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

    // ── tool-usage capture (mh-* sessions only) ───────────────────────────
    "tool.execute.after": async (toolInput, toolOutput) => {
      const { tool, sessionID } = toolInput
      const agent = sessionAgent.get(sessionID) ?? ""
      if (!isMhRole(agent)) return
      if (proposerSessions.has(sessionID)) return

      const usage = sessionToolUsage.get(sessionID) ?? {}
      const entry = usage[tool] ?? { calls: 0, errors: 0 }
      entry.calls++

      // Error detection only for execution tools (bash, task).
      // File-content tools (read, grep, glob, write, edit) are skipped —
      // their output is file content which naturally contains error-handling
      // words and would produce false positives.
      if (EXECUTION_TOOLS.has(tool)) {
        const outText = typeof toolOutput.output === "string" ? toolOutput.output : ""
        if (ERROR_PATTERN.test(outText)) entry.errors++
      }

      usage[tool] = entry
      sessionToolUsage.set(sessionID, usage)
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

      // Skip degenerate sessions (greetings / no substantive work) BEFORE
      // bothering the human — they must never pollute the fitness signal.
      const turns = sessionTurns.get(sessionID) ?? 0
      const usage = sessionToolUsage.get(sessionID) ?? {}
      const summary = sessionSummary.get(sessionID) ?? ""
      if (isDegenerateSession(turns, usage, summary)) {
        await log(client, "info", `[hook:event] skipping degenerate session ${sessionID} (turns=${turns}, toolCalls=${Object.values(usage).reduce((n, t) => n + t.calls, 0)})`)
        await client.tui.showToast({
          body: { message: "Meta-Harness: session skipped (no substantive work)", variant: "info", duration: 4_000 },
        })
        cleanupSession(sessionID)
        return
      }

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
        toolUsage: sessionToolUsage.get(sessionID) ?? {},
      }

      // Record into all 4 stores
      const layers = layersFor(worktree, agent)
      const scores = layers.map((layer) => {
        const version = activeVersion(layer.root)
        return { layer, score: recordSession(layer.root, version, record) }
      })

      const prLayer = layers.find((l) => l.scope === "project-role")!
      const pgLayer = layers.find((l) => l.scope === "project-global")!
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

      // Resolve any in-progress project-layer trial now that a new score landed.
      for (const l of [pgLayer, prLayer]) {
        const res = resolveTrial(l.root)
        if (res.action === "confirmed") {
          await log(client, "info", `[hook:event] trial confirmed ${l.scope} ${res.trial}`)
          await client.tui.showToast({
            body: {
              message: `Trial confirmed: ${l.scope} ${res.trial} kept (${fmtRate(res.trialRate)} vs baseline ${res.baselineRate === null ? "n/a" : fmtRate(res.baselineRate)})`,
              variant: "success", duration: 6_000,
            },
          })
        } else if (res.action === "reverted") {
          await log(client, "warn", `[hook:event] trial reverted ${l.scope} → ${res.baseline}`)
          await client.tui.showToast({
            body: {
              message: `Trial reverted: ${l.scope} back to ${res.baseline} (${fmtRate(res.trialRate)} < baseline ${fmtRate(res.baselineRate)})`,
              variant: "warning", duration: 6_000,
            },
          })
        } else if (res.action === "abandoned") {
          await log(client, "warn", `[hook:event] trial abandoned ${l.scope}: ${res.reason}`)
        }
      }

      // Selection-gated auto-propose. `>=` (not `% N`) so a deferred trigger
      // stays eligible on the next scored session instead of being lost at the
      // exact multiple; the readTrial guard prevents proposing over an in-flight
      // trial (proposer's own inFlight guard prevents concurrent proposals).
      const prDue = !!projectRoleScore
        && projectRoleScore.sessions.length >= PROJECT_ROLE_THRESHOLD
        && readTrial(prLayer.root) === null
      const pgDue = !!projectGlobalScore
        && projectGlobalScore.sessions.length >= PROJECT_GLOBAL_THRESHOLD
        && readTrial(pgLayer.root) === null

      if (prDue) {
        await log(client, "info", `[hook:event] auto-propose project-role for ${agent}`)
        void triggerPropose(client, worktree, prLayer)
      } else if (pgDue) {
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
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(cmdInput.arguments, layers)
        if (layer) {
          await log(client, "info", `[hook:command] /mh-propose scope=${layer.scope} agent=${agent}`)
          void triggerPropose(client, worktree, layer)
          throw new Error("Meta-Harness: propose cycle started ✓ (this notice is expected)")
        }
        throw new Error(`Meta-Harness: /mh-propose — unknown scope "${cmdInput.arguments.trim()}" (use role|project|role-global|account)`)
      }

      // /mh-activate <scope> <vN> [--force]
      if (cmdInput.command === "mh-activate") {
        const parts = cmdInput.arguments.trim().split(/\s+/).filter(Boolean)
        const force = parts.includes("--force")
        const positional = parts.filter((p) => p !== "--force")
        const scopeArg = positional[0] ?? ""
        const version = positional[1] ?? ""
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(scopeArg, layers)
        if (!layer) {
          throw new Error(`Meta-Harness: /mh-activate — unknown scope "${scopeArg}" (use account|project|role-global|role)`)
        }
        if (!/^v\d+$/.test(version)) {
          throw new Error(`Meta-Harness: /mh-activate — expected a version like v3, got "${version}"`)
        }
        const isAccount = layer.scope === "account-global" || layer.scope === "account-role"
        if (isAccount && !force) {
          const verdict = readAbVerdict(layer.root, version)
          if (!verdict) {
            throw new Error(`Meta-Harness: no ab-verdict.json for ${layer.scope} ${version} — run "runner.py ab --layer ${layer.scope} --candidate ${version} ..." first, or pass --force`)
          }
          if (verdict.winner !== "candidate") {
            throw new Error(`Meta-Harness: ${version} did not win the ab compare (candidate ${fmtRate(verdict.candidateRate)} vs active ${fmtRate(verdict.activeRate)}, n=${verdict.nTasks}, winner=${verdict.winner}) — refusing; pass --force to override`)
          }
        }
        const ok = activateCandidate(layer.root, version)
        if (!ok) {
          throw new Error(`Meta-Harness: candidate ${version} not found (no system.md) for ${layer.scope}`)
        }
        await log(client, "info", `[hook:command] /mh-activate ${layer.scope} ${version}${force ? " --force" : ""}`)
        throw new Error(`Meta-Harness: activated ${layer.scope} ${version} ✓ (this notice is expected)`)
      }

      // /mh-promote [global|role]
      if (cmdInput.command === "mh-promote") {
        const scope = cmdInput.arguments.trim().toLowerCase()
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
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
          void triggerPromote(client, worktree, source, target)
          throw new Error("Meta-Harness: promote cycle started ✓ (this notice is expected)")
        }
        throw new Error(`Meta-Harness: /mh-promote — unknown scope "${scope}" (use global|role)`)
      }

      // /mh-status
      if (cmdInput.command === "mh-status") {
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const lines: string[] = [`Meta-Harness status (agent=${agent}):`]
        for (const layer of layers) {
          const ver = activeVersion(layer.root)
          const score = readScore(layer.root, ver)
          const rate = score.sessions.length > 0 ? `${score.nPass}/${score.sessions.length}` : "no sessions"
          let line = `  ${layer.scope}: active=${ver} (${rate})`
          const trial = readTrial(layer.root)
          if (trial) {
            const ts = readScore(layer.root, trial.trial)
            line += ` | TRIAL ${trial.trial} vs ${trial.baseline} (${ts.sessions.length}/${trial.minSessions})`
          }
          const versions = listVersions(layer.root)
          const newest = versions.length ? versions[versions.length - 1] : undefined
          if (newest && newest !== ver) {
            const verdict = readAbVerdict(layer.root, newest)
            const vinfo = verdict
              ? `verdict=${verdict.winner} (${fmtRate(verdict.candidateRate)} vs ${fmtRate(verdict.activeRate)})`
              : "no verdict"
            line += ` | candidate ${newest}: ${vinfo}`
          }
          lines.push(line)
        }
        throw new Error(lines.join("\n"))
      }
    },
  }
}

export const server: PluginModule["server"] = metaHarness
