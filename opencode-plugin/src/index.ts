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
  abAccepted,
  writeTrajectory,
  pruneTrajectories,
  DEFAULT_SYSTEM_PROMPT,
  type StoreLayer,
  readPlaybook,
  activeBulletCount,
  readLastMetric,
  composeAgentConfig,
  composeEnvPolicy,
  type ToolUsage,
  type TrajEvent,
  type AgentConfig,
  readMhConfig,
  appendJudgeDecision,
  judgeCalibration,
  appendMetaMetric,
  type SessionRecord,
} from "./harness-store.ts"
import { promptHumanScore, handleScoreCommand } from "./score.ts"
import { runJudge, type JudgeVerdict } from "./judge.ts"
import {
  triggerPropose,
  triggerPromote,
  triggerCurate,
  CURATOR_BUDGET,
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
// How many times each opencode session has already been scored. A single
// opencode session can be scored more than once (it re-bootstraps after each
// score cycle); this de-collides the recorded IDs so traces/traj don't
// overwrite. NOT cleared by cleanupSession — it must persist across cycles;
// it resets naturally on plugin reload / opencode restart.
const sessionScoreCount = new Map<string, number>()
const snapshotCache = new Map<string, string>()
const snapshotInjected = new Set<string>()
const sessionModel = new Map<string, string>()
const sessionVariant = new Map<string, string>()
const sessionAgent = new Map<string, string>()
const sessionTurns = new Map<string, number>()
const sessionSummary = new Map<string, string>()
const sessionToolUsage = new Map<string, ToolUsage>()
const sessionTrajectory = new Map<string, TrajEvent[]>()
// Composed agent-config (bash-timeout knobs), cached per session so a bash
// call doesn't re-read all 4 layer files every time. Populated lazily on the
// session's first bash call; cleared in cleanupSession.
const sessionAgentConfig = new Map<string, AgentConfig | null>()

/** Persist trajectories for PASSING sessions too. Default false = failures only. */
const SAVE_ALL_TRAJ = false
/** Cap the per-session trajectory buffer (drop-oldest). */
const TRAJ_BUFFER_CAP = 500

function pushTraj(sessionID: string, ev: TrajEvent): void {
  const buf = sessionTrajectory.get(sessionID) ?? []
  buf.push(ev)
  if (buf.length > TRAJ_BUFFER_CAP) buf.shift()
  sessionTrajectory.set(sessionID, buf)
}

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
  sessionTrajectory.delete(sessionID)
  sessionAgentConfig.delete(sessionID)
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

      // Track model + variant LIVE (both can change mid-session via the TUI;
      // the SessionRecord must reflect what actually ran the scored turns).
      const isPrimary = isMhRole(agent) || agent === "build" || agent === "plan" || agent === ""
      if (isPrimary && msgInput.model) {
        const model = `${msgInput.model.providerID}/${msgInput.model.modelID}`
        sessionModel.set(sessionID, model)
        sessionVariant.set(sessionID, msgInput.variant ?? "")
      }

      // Track the agent LIVE. On a switch, reset the per-session fitness
      // counters so the eventual score reflects ONLY work done under the new
      // agent — system.transform injects per message off this map, so every
      // post-switch turn runs under the new agent's harness composition.
      // (Capture-once was the old behavior; it silently refused to score
      // sessions whose agent was switched to mh-* after the first message.)
      const prev = sessionAgent.get(sessionID)
      if (isPrimary && agent && prev !== undefined && prev !== agent) {
        sessionAgent.set(sessionID, agent)
        sessionTurns.set(sessionID, 0)
        sessionToolUsage.delete(sessionID)
        sessionTrajectory.delete(sessionID)
        sessionSummary.delete(sessionID)
        // The composed agent-config (bash-timeout knobs) is keyed by role
        // layers, so a stale cache entry from the previous agent must go too.
        sessionAgentConfig.delete(sessionID)
        bootstrappedSessions.add(sessionID)
        if (isMhRole(agent)) {
          bootstrapStore(accountRoleRoot(agent), "")
          bootstrapStore(projectRoleRoot(worktree, agent), "")
          await client.tui.showToast({
            body: { title: "Meta-Harness",
                    message: `Harness active for ${agent} from this turn — the session will be scored on work from here.`,
                    variant: "info", duration: 8_000 },
          })
        } else if (isMhRole(prev)) {
          await client.tui.showToast({
            body: { title: "Meta-Harness",
                    message: `Switched to ${agent} — harness inactive; this session will no longer be scored.`,
                    variant: "info", duration: 8_000 },
          })
        }
        await log(client, "info", `[hook:chat.message] agent switch ${prev || "(none)"} → ${agent} — session counters reset`)
      } else if (isPrimary && agent && prev === undefined) {
        sessionAgent.set(sessionID, agent)
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

      // Gather env snapshot (async OK — fires before the LLM call).
      // envPolicy (Phase 4 Part C) is composed the same way as agent-config:
      // most-specific layer that has an active env-policy wins outright.
      const envPolicy = composeEnvPolicy(layersFor(worktree, agent).map((l) => l.root))
      const snapshot = await gatherEnvSnapshot(input.$, envPolicy)
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

      const sessionID = toolInput.sessionID
      let cfg = sessionAgentConfig.get(sessionID)
      if (cfg === undefined) {
        const agent = sessionAgent.get(sessionID) ?? ""
        cfg = agent ? composeAgentConfig(layersFor(worktree, agent).map((l) => l.root)) : null
        sessionAgentConfig.set(sessionID, cfg)
      }

      const adjusted = adjustedTimeout(args.command, args.timeout, cfg)
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
      const outText = typeof toolOutput.output === "string" ? toolOutput.output : ""
      let isError = false
      if (EXECUTION_TOOLS.has(tool)) {
        isError = ERROR_PATTERN.test(outText)
        if (isError) entry.errors++
      }

      usage[tool] = entry
      sessionToolUsage.set(sessionID, usage)
      pushTraj(sessionID, {
        t: "tool", tool,
        output: outText.slice(0, 800),
        error: isError,
      })
    },

    // ── turn counting + summary capture ───────────────────────────────────
    "experimental.text.complete": async (textInput, output) => {
      const { sessionID } = textInput
      if (proposerSessions.has(sessionID)) return
      sessionTurns.set(sessionID, (sessionTurns.get(sessionID) ?? 0) + 1)
      sessionSummary.set(sessionID, output.text.slice(0, 500))
      if (output.text.trim()) pushTraj(sessionID, { t: "text", text: output.text.slice(0, 800) })
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

      // Shadow-mode dense judge (Phase 4 Part D): kicked off CONCURRENTLY with
      // the human prompt below so it never delays scoring. Disabled by default
      // (judgeModel === "") — zero behavior change unless explicitly configured.
      // .catch(() => null) means a broken/slow judge degrades to "no verdict"
      // rather than ever affecting the human's score.
      const mhCfg = readMhConfig()
      const judgePromise: Promise<JudgeVerdict | null> = mhCfg.judgeModel
        ? runJudge(
            client, worktree, sessionID,
            sessionSummary.get(sessionID) ?? "", sessionTurns.get(sessionID) ?? 0,
            sessionTrajectory.get(sessionID) ?? [],
          ).catch(() => null)
        : Promise.resolve(null)

      // Maker-checker (Phase 4 Part D4): once the judge is calibrated (>=80%
      // agreement over >=20 sessions), pre-fill the human's score prompt with
      // the judge's verdict so the human just approves/edits — judge
      // proposes, human checks. The 60s race only runs when calibrated, so
      // the common (uncalibrated / judge disabled) path is completely
      // unaffected: `prefill` stays undefined and promptHumanScore falls
      // back to its "/mh-score good" default — zero behavior change.
      const calBefore = mhCfg.judgeModel
        ? judgeCalibration(mhCfg.judgeMinSessions, mhCfg.judgeMinAgreement)
        : { n: 0, agreement: 0, calibrated: false }
      let prefill: string | undefined
      let usedPrefill = false
      if (calBefore.calibrated) {
        const early = await Promise.race([judgePromise, new Promise<null>((r) => setTimeout(() => r(null), 60_000))])
        if (early) {
          prefill = `/mh-score ${early.passed ? "good" : "bad"} judge: ${early.reasoning.slice(0, 80)}`
          usedPrefill = true
        }
      }
      const result = await promptHumanScore(client, sessionID, undefined, prefill)
      if (result === null) {
        await log(client, "info", `[hook:event] scoring timed out — skipping ${sessionID}`)
        pendingScore.delete(sessionID)
        return
      }

      // De-collide the recorded ID when this opencode session is scored more
      // than once. First score keeps the raw sessionID (back-compat); later
      // scores get "<sessionID>#N" so score.json entries + traces/ + traj/
      // stay distinct. In-memory maps below stay keyed by the raw sessionID.
      const priorScores = sessionScoreCount.get(sessionID) ?? 0
      sessionScoreCount.set(sessionID, priorScores + 1)
      const recordID = priorScores === 0 ? sessionID : `${sessionID}#${priorScores + 1}`

      // Record into all 4 stores
      const layers = layersFor(worktree, agent)
      // Resolved early (rather than after `scores`) because the shadow-judge
      // fold-in below needs a layer root for its meta-metric, and it must run
      // BEFORE `recordSession` so `record.judge` is present when persisted.
      const prLayer = layers.find((l) => l.scope === "project-role")!
      const model = sessionModel.get(sessionID) ?? "unknown"
      // Confound-control provenance: which harness composed this session.
      const env = {
        provider: model.includes("/") ? model.split("/")[0] : "unknown",
        layerVersions: Object.fromEntries(
          layers.map((l) => [l.scope, activeVersion(l.root)]),
        ),
      }
      const record: SessionRecord = {
        sessionID: recordID,
        passed: result.passed,
        note: result.note,
        turnCount: sessionTurns.get(sessionID) ?? 0,
        timestamp: new Date().toISOString(),
        summary: sessionSummary.get(sessionID) ?? "",
        model,
        variant: sessionVariant.get(sessionID) ?? "",
        toolUsage: sessionToolUsage.get(sessionID) ?? {},
        env,
      }

      // Resolve the shadow judge (already running concurrently, or already
      // resolved by now) and fold its verdict into `record` BEFORE the
      // recordSession calls below — recordSession writes `record` to disk
      // synchronously, so anything set on it after that point would be lost.
      // Shadow mode: the judge NEVER alters `record.passed` or `result.passed`;
      // it only records agreement for later calibration.
      const judgeVerdict = await judgePromise
      // Deferred until AFTER recordSession below persists the human's score —
      // this log is diagnostic only and must never gate/delay persistence if
      // client.app.log ever rejects (no outer try/catch on this idle handler).
      let judgeLogLine: string | undefined
      if (judgeVerdict) {
        const agreed = judgeVerdict.passed === result.passed
        record.judge = {
          passed: judgeVerdict.passed,
          confidence: judgeVerdict.confidence,
          mode: usedPrefill ? "prefill" : "shadow",
          agreed,
        }
        appendJudgeDecision({
          ts: record.timestamp,
          sessionID: recordID,
          judge: judgeVerdict.passed,
          human: result.passed,
          model: mhCfg.judgeModel,
        })
        const cal = judgeCalibration(mhCfg.judgeMinSessions, mhCfg.judgeMinAgreement)
        appendMetaMetric(prLayer.root, {
          event: "judge",
          agreed,
          judge: judgeVerdict.passed,
          human: result.passed,
          agreement: cal.agreement,
          n: cal.n,
        })
        judgeLogLine = `[judge] ${agreed ? "AGREE" : "DISAGREE"} judge=${judgeVerdict.passed} human=${result.passed} — calibration ${cal.n}/${mhCfg.judgeMinSessions} @ ${(cal.agreement * 100).toFixed(0)}%`
      }

      const scores = layers.map((layer) => {
        const version = activeVersion(layer.root)
        return { layer, score: recordSession(layer.root, version, record) }
      })

      if (judgeLogLine) await log(client, "info", judgeLogLine)

      // Persist the trajectory (failures always; passes only with SAVE_ALL_TRAJ)
      // to each layer so its proposer can diagnose the root cause later.
      const traj = sessionTrajectory.get(sessionID) ?? []
      if (traj.length && (!record.passed || SAVE_ALL_TRAJ)) {
        for (const { layer } of scores) {
          const version = activeVersion(layer.root)
          writeTrajectory(layer.root, version, recordID, traj)
          pruneTrajectories(layer.root, version)
        }
      }

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

      // Anti-bloat nudge: suggest curation when a project layer is over budget.
      for (const l of [prLayer, pgLayer]) {
        if (activeBulletCount(readPlaybook(l.root)) > CURATOR_BUDGET && readTrial(l.root) === null) {
          await client.tui.showToast({
            body: { message: `Meta-Harness: ${l.scope} playbook over ${CURATOR_BUDGET} bullets — run /mh-curate`,
                    variant: "info", duration: 5_000 },
          })
          break
        }
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
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
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
            throw await toastAndSwallow(client, `no ab-verdict.json for ${layer.scope} ${version} — run "runner.py ab --layer ${layer.scope} --candidate ${version}" first, or pass --force`, "error")
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
          throw await toastAndSwallow(client, "promote cycle started ✓", "success")
        }
        throw await toastAndSwallow(client, `/mh-promote — unknown scope "${scope}" (use global|role)`, "error")
      }

      // /mh-curate <scope> — consolidate/prune a layer's playbook (through the gate)
      if (cmdInput.command === "mh-curate") {
        const agent = sessionAgent.get(cmdInput.sessionID) ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const layer = resolveScopeLayer(cmdInput.arguments, layers)
        if (!layer) {
          throw await toastAndSwallow(client, `/mh-curate — unknown scope "${cmdInput.arguments.trim()}" (use role|project|role-global|account)`, "error")
        }
        await log(client, "info", `[hook:command] /mh-curate scope=${layer.scope} agent=${agent}`)
        void triggerCurate(client, worktree, layer)
        throw await toastAndSwallow(client, "curate cycle started ✓", "success")
      }

      // /mh-status
      if (cmdInput.command === "mh-status") {
        const tracked = sessionAgent.get(cmdInput.sessionID)
        const agent = tracked ?? "mh-build"
        const layers = layersFor(worktree, agent)
        const sessionState = tracked === undefined
          ? "no message yet — use an mh-* agent to enable scoring"
          : isMhRole(tracked)
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
