/**
 * engine.ts — EvolutionEngine
 *
 * The platform-independent core of the meta-harness evolution loop, extracted
 * from the opencode plugin's index.ts. It owns:
 *   - per-session CAPTURE state (behind SessionStateStore),
 *   - the live system-prompt COMPOSITION (via compose.ts),
 *   - the idle SCORING pipeline (judge → human score → recordSession →
 *     trajectory → resolveTrial → auto-propose → curation nudge),
 *   - the /mh-* COMMAND routing.
 *
 * It reaches the outside world ONLY through a HarnessHost (host.ts) and the
 * platform-agnostic harness-store / score / judge / propose functions. It
 * imports NOTHING from @opencode-ai/plugin — a Claude Code adapter (short-lived
 * hook processes + a file-backed SessionStateStore) drives the SAME engine.
 *
 * Role is DECLARED by the adapter, never sniffed here: the adapter passes
 * `participates` (its isMhRole decision) and `isPrimary`; the engine treats
 * role strings opaquely.
 */

import fs from "fs"
import path from "path"
import { gatherEnvSnapshot } from "./env-snapshot.ts"
import { adjustedTimeout } from "./bash-timeout.ts"
import {
  accountRoleRoot,
  projectRoleRoot,
  layersFor,
  bootstrapStore,
  activeVersion,
  listVersions,
  recordSession,
  readScore,
  readTrial,
  resolveTrial,
  activateCandidate,
  readAbVerdict,
  abAccepted,
  writeTrajectory,
  pruneTrajectories,
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
import { runJudge, JUDGE_SYSTEM_PROMPT, type JudgeVerdict } from "./judge.ts"
import {
  triggerPropose,
  triggerPromote,
  triggerCurate,
  CURATOR_BUDGET,
  PROJECT_ROLE_THRESHOLD,
  PROJECT_GLOBAL_THRESHOLD,
} from "./propose.ts"
import { composeHarness, renderSystemBlocks } from "./compose.ts"
import type { HarnessHost } from "./host.ts"

// ── Per-session state ────────────────────────────────────────────────────────

/**
 * One opencode/CC session's capture state — the union of the per-session Maps
 * that used to live in index.ts. `role` is the tracked primary-agent name (or
 * null when none tracked yet); `participates` is the adapter's isMhRole verdict
 * for that role (the engine never recomputes it). `scoreCount` and
 * `pausedToastShown` survive `cleanup()` (they must persist across re-scoring
 * cycles); every other field is transient and reset by cleanup.
 */
export interface SessionState {
  role: string | null
  participates: boolean
  model?: string
  variant?: string
  turns: number
  summary: string
  toolUsage: ToolUsage
  trajectory: TrajEvent[]
  bootstrapped: boolean
  pendingScore: boolean
  snapshot?: string
  snapshotInjected: boolean
  /** undefined = not yet composed; null = composed, no config; else the config. */
  agentConfig?: AgentConfig | null
  /** How many times this session has already been scored (de-collides recorded
   * IDs). Persists across cleanup. */
  scoreCount: number
  /** Whether the plateau-pause toast was already shown. Persists across cleanup. */
  pausedToastShown: boolean
}

export interface SessionStateStore {
  get(id: string): SessionState | undefined
  put(id: string, s: SessionState): void
  delete(id: string): void
}

export class InMemorySessionStateStore implements SessionStateStore {
  private readonly map = new Map<string, SessionState>()
  get(id: string): SessionState | undefined {
    return this.map.get(id)
  }
  put(id: string, s: SessionState): void {
    this.map.set(id, s)
  }
  delete(id: string): void {
    this.map.delete(id)
  }
}

function defaultSessionState(): SessionState {
  return {
    role: null,
    participates: false,
    turns: 0,
    summary: "",
    toolUsage: {},
    trajectory: [],
    bootstrapped: false,
    pendingScore: false,
    snapshotInjected: false,
    scoreCount: 0,
    pausedToastShown: false,
  }
}

// ── Command result (rendered by the adapter) ─────────────────────────────────

export type ToastVariant = "info" | "success" | "warning" | "error"

/**
 * handleCommand returns DATA; the adapter renders it (toast + throw-to-swallow).
 * `kind: "throw"` reproduces /mh-score's throw-only path (no toast); `kind:
 * "toast"` reproduces the other commands' toastAndSwallow path.
 */
export type CommandResult =
  | { consumed: false }
  | { consumed: true; kind: "throw"; message: string }
  | { consumed: true; kind: "toast"; message: string; variant: ToastVariant; duration?: number }

// ── Constants / pure helpers (moved verbatim from index.ts) ──────────────────

/** Persist trajectories for PASSING sessions too. Default false = failures only. */
const SAVE_ALL_TRAJ = false
/** Cap the per-session trajectory buffer (drop-oldest). */
const TRAJ_BUFFER_CAP = 500

/**
 * Tools whose output is execution results (not file content).
 * Only these get error-heuristic analysis — applying it to read/grep/glob
 * would false-positive on source code that contains error-handling words.
 */
const EXECUTION_TOOLS = new Set(["bash", "task"])

/** Best-effort error detection from execution tool output. */
const ERROR_PATTERN = /\berror\b|\bfailed\b|\bexception\b|no such file|exit code [1-9]|traceback|command not found/i

const fmtRate = (r: number): string => `${(r * 100).toFixed(0)}%`

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

/** Count of a score's sessions the judge did NOT rate `trivial:true` (Task 7 /
 * Option A) — auto-propose thresholds must fire on informative sessions only,
 * so a run of greetings/one-liners can't itself trigger a proposal. Sessions
 * with no judge verdict (judge disabled, or verdict null) always count, same
 * as before this feature existed. */
function nonTrivialCount(sessions: SessionRecord[] | undefined): number {
  return (sessions ?? []).filter((s) => s.judge?.trivial !== true).length
}

/** Map a /mh-* scope argument to a StoreLayer (shared by propose/activate). */
function resolveScopeLayer(scope: string, layers: StoreLayer[]): StoreLayer | undefined {
  const s = scope.trim().toLowerCase()
  if (!s || s === "role" || s === "project-role") return layers.find((l) => l.scope === "project-role")
  if (s === "project" || s === "project-global") return layers.find((l) => l.scope === "project-global")
  if (s === "role-global" || s === "account-role") return layers.find((l) => l.scope === "account-role")
  if (s === "account" || s === "account-global") return layers.find((l) => l.scope === "account-global")
  return undefined
}

// ── EvolutionEngine ──────────────────────────────────────────────────────────

export class EvolutionEngine {
  constructor(
    private readonly host: HarnessHost,
    private readonly state: SessionStateStore,
  ) {}

  private get worktree(): string {
    return this.host.projectRoot
  }

  private pushTraj(st: SessionState, ev: TrajEvent): void {
    st.trajectory.push(ev)
    if (st.trajectory.length > TRAJ_BUFFER_CAP) st.trajectory.shift()
  }

  /**
   * Reset a session's transient capture state, PRESERVING scoreCount and
   * pausedToastShown (which must survive across re-scoring cycles — the old
   * index.ts cleanupSession deleted every other Map but left these two).
   * A no-op if the session has no state.
   */
  cleanup(sessionId: string): void {
    const prev = this.state.get(sessionId)
    if (!prev) return
    const fresh = defaultSessionState()
    fresh.scoreCount = prev.scoreCount
    fresh.pausedToastShown = prev.pausedToastShown
    this.state.put(sessionId, fresh)
  }

  // ── chat.message: capture model/variant/role, gather env snapshot ──────────
  async sessionMessage(
    sessionId: string,
    opts: {
      role: string          // raw primary-agent name (may be "")
      isPrimary: boolean
      participates: boolean // adapter's isMhRole(role)
      model?: string        // "provider/model" — undefined when the message had none
      variant?: string
    },
  ): Promise<void> {
    const { role: agent, isPrimary, participates, model, variant } = opts
    const st = this.state.get(sessionId) ?? defaultSessionState()

    // Track model + variant LIVE (both can change mid-session; the SessionRecord
    // must reflect what actually ran the scored turns).
    if (isPrimary && model !== undefined) {
      st.model = model
      st.variant = variant ?? ""
    }

    // Track the role LIVE. On a switch, reset the per-session fitness counters
    // so the eventual score reflects ONLY work done under the new role.
    const prevRole = st.role
    const prevParticipates = st.participates
    if (isPrimary && agent && prevRole !== null && prevRole !== agent) {
      st.role = agent
      st.participates = participates
      st.turns = 0
      st.toolUsage = {}
      st.trajectory = []
      st.summary = ""
      // The composed agent-config is keyed by role layers, so a stale cache
      // entry from the previous role must go too.
      st.agentConfig = undefined
      st.bootstrapped = true
      if (participates) {
        bootstrapStore(accountRoleRoot(agent), "")
        bootstrapStore(projectRoleRoot(this.worktree, agent), "")
        await this.host.notify(
          `Harness active for ${agent} from this turn — the session will be scored on work from here.`,
          "info", 8_000,
        )
      } else if (prevParticipates) {
        await this.host.notify(
          `Switched to ${agent} — harness inactive; this session will no longer be scored.`,
          "info", 8_000,
        )
      }
      await this.host.log("info", `[hook:chat.message] agent switch ${prevRole || "(none)"} → ${agent} — session counters reset`)
      this.state.put(sessionId, st)
      return
    } else if (isPrimary && agent && prevRole === null) {
      st.role = agent
      st.participates = participates
    }

    if (st.bootstrapped) {
      this.state.put(sessionId, st)
      return
    }
    st.bootstrapped = true
    st.turns = 0

    // Bootstrap all role stores on first message (participating roles only).
    if (participates) {
      bootstrapStore(accountRoleRoot(agent), "")
      bootstrapStore(projectRoleRoot(this.worktree, agent), "")
      await this.host.log("debug", `[hook:chat.message] bootstrapped stores for agent=${agent}`)
    }

    // Gather env snapshot (async OK — fires before the LLM call).
    const envPolicy = composeEnvPolicy(layersFor(this.worktree, agent).map((l) => l.root))
    const snapshot = await gatherEnvSnapshot(this.host, envPolicy)
    if (snapshot) st.snapshot = snapshot
    await this.host.log("debug", `[hook:chat.message] env snapshot length=${snapshot.length}`)
    this.state.put(sessionId, st)
  }

  // ── system.transform (non-judge case): inject all 4 layers + env snapshot ──
  async composeInjection(sessionId: string): Promise<string[]> {
    const st = this.state.get(sessionId)
    if (!st || !st.participates) return []
    const agent = st.role ?? ""

    const layers = layersFor(this.worktree, agent)
    const composed = composeHarness(layers.map((l) => ({ scope: l.scope, root: l.root })))

    // Env snapshot injects once per session (pushed last, if present).
    const wantsSnapshot = sessionId && !st.snapshotInjected
    const snapshot = wantsSnapshot ? st.snapshot : undefined

    const blocks = renderSystemBlocks(composed, snapshot)

    for (const layer of composed) {
      if (layer.system) {
        await this.host.log("debug", `[hook:system.transform] injected ${layer.scope} system — ${layer.system.length} chars`)
      }
    }
    const toolLayerCount = composed.filter((l) => l.tools).length
    if (toolLayerCount > 0) {
      await this.host.log("debug", `[hook:system.transform] injected tool guidance from ${toolLayerCount} layer(s)`)
    }
    if (snapshot) {
      st.snapshotInjected = true
      this.state.put(sessionId, st)
      await this.host.log("debug", `[hook:system.transform] injected env snapshot`)
    }
    return blocks
  }

  /** The judge full-replacement system prompt (system.transform judge case). */
  judgeSystemPrompt(_sessionId: string): string | null {
    return JUDGE_SYSTEM_PROMPT
  }

  // ── tool.execute.before: fast-command timeout cap ─────────────────────────
  adjustToolArgs(
    sessionId: string,
    tool: string,
    args: { command?: string; timeout?: number; workdir?: string },
  ): { command?: string; timeout?: number; workdir?: string } | undefined {
    if (tool !== "bash") return undefined
    if (typeof args.command !== "string") return undefined

    const st = this.state.get(sessionId) ?? defaultSessionState()
    let cfg = st.agentConfig
    if (cfg === undefined) {
      const agent = st.role ?? ""
      cfg = agent ? composeAgentConfig(layersFor(this.worktree, agent).map((l) => l.root)) : null
      st.agentConfig = cfg
      this.state.put(sessionId, st)
    }

    const adjusted = adjustedTimeout(args.command, args.timeout, cfg)
    if (adjusted !== undefined) return { ...args, timeout: adjusted }
    return undefined
  }

  // ── tool.execute.after: tool-usage capture (participating sessions only) ──
  recordTool(sessionId: string, tool: string, outputText: string): void {
    const st = this.state.get(sessionId)
    if (!st || !st.participates) return

    const usage = st.toolUsage
    const entry = usage[tool] ?? { calls: 0, errors: 0 }
    entry.calls++

    // Error detection only for execution tools (bash, task).
    let isError = false
    if (EXECUTION_TOOLS.has(tool)) {
      isError = ERROR_PATTERN.test(outputText)
      if (isError) entry.errors++
    }

    usage[tool] = entry
    this.pushTraj(st, { t: "tool", tool, output: outputText.slice(0, 800), error: isError })
    this.state.put(sessionId, st)
  }

  // ── text.complete: turn counting + summary capture ────────────────────────
  recordTurn(sessionId: string, text: string): void {
    const st = this.state.get(sessionId) ?? defaultSessionState()
    st.turns += 1
    st.summary = text.slice(0, 500)
    if (text.trim()) this.pushTraj(st, { t: "text", text: text.slice(0, 800) })
    this.state.put(sessionId, st)
  }
}
