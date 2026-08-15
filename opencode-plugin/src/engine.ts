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
  readActiveBudget,
  budgetIdentityMatches,
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
import { exportRuleChecks } from "./rule-checks-export.ts"
import { exportHookRules } from "./hook-rules-export.ts"
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
import { composeHarness, renderSystemBlocks, type SnapshotOverride } from "./compose.ts"
import { pickTrialArm, type TrialArm } from "./trial-arm.ts"
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

/**
 * F3 — sessionIdle's honest outcome (see its doc comment for the precise
 * guard-branch mapping). Additive: opencode's index.ts discards it, so this
 * has zero effect there; the Claude Code adapter (dispatch.ts) uses it to
 * render a distinct block message per outcome instead of always claiming
 * "score recorded ✓".
 */
export type SessionIdleOutcome = "recorded" | "skipped-degenerate" | "not-active" | "pending"

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
    // F1 — clear a stale pendingScore wedge: sessionIdle persists
    // {bootstrapped:false, pendingScore:true} BEFORE it runs the human-score
    // prompt (see below). If the process dies mid-pipeline (a CC hook
    // timeout/crash), the file-backed state is stuck there forever, and
    // sessionIdle's `if (st0.pendingScore) return` guard would no-op on
    // every future /mh-score. This branch only runs when st.bootstrapped
    // was false, i.e. exactly the state sessionIdle leaves behind on a
    // crash (or a session's genuine first bootstrap, where pendingScore is
    // already false) — in a short-lived-process world, a fresh SessionStart
    // can never observe a score pipeline that is truly still in flight from
    // ITS OWN perspective, so it's always safe to clear.
    st.pendingScore = false

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
  //
  // Arm-aware compose (§4.3 spec §3, prerequisite build item §11/1): when the
  // project-global layer holds a LIVE gate-outcomes trial (`rewardMode ===
  // "gate-outcomes"`) that isn't `awaitingGo` (a queued golden window or a
  // not-yet-human-go'd trial is inert per plan Global Constraints — no arm,
  // no snapshot, active compose), the session's arm is picked ONCE here via
  // `pickTrialArm`, and a baseline-arm session composes project-global from
  // the trial's snapshot fields instead of its active/candidate files. A
  // trial-arm session, and any session with no live gate-outcomes trial (or
  // a legacy trial with no `rewardMode` — legacy trials never had arms),
  // compose exactly as before this change. The picked arm is returned
  // alongside the blocks (not re-derived at the exposure-append call site)
  // so compose-read and exposure-append share the SAME trial read — no
  // TOCTOU between the two.
  //
  // Platform gate (spec §1/§10): §4.3 arms are scoped to Claude Code sessions
  // ONLY — opencode-session arms are an explicit §10 deferral. `armAware`
  // defaults to false so the arm/enrollment path (readTrial → pickTrialArm →
  // snapshot compose → enrollment return) only runs when a caller opts in.
  // The CC adapter (dispatch.ts SessionStart) passes `{armAware: true}`; the
  // opencode adapter (index.ts) passes nothing, so an opencode session always
  // composes the active store (= trial-arm text while a trial runs, same as
  // legacy pre-arm behavior) and never appears in the exposure log.
  async composeInjection(
    sessionId: string,
    opts?: { armAware?: boolean },
  ): Promise<{ blocks: string[]; enrollment?: { trialId: string; arm: TrialArm; forced: boolean } }> {
    const armAware = opts?.armAware ?? false
    const st = this.state.get(sessionId)
    if (!st || !st.participates) return { blocks: [] }
    const agent = st.role ?? ""

    const layers = layersFor(this.worktree, agent)
    const layerRefs = layers.map((l) => ({ scope: l.scope, root: l.root }))

    let snapshot: SnapshotOverride | undefined
    let enrollment: { trialId: string; arm: TrialArm; forced: boolean } | undefined
    if (armAware) {
      const pg = layers.find((l) => l.scope === "project-global")! // v0 arms are project-global only (spec §1)
      const trial = readTrial(pg.root)
      if (trial && trial.rewardMode === "gate-outcomes" && !trial.awaitingGo) {
        const trialId = trial.trialId ?? trial.trial
        const { arm, forced } = pickTrialArm(trialId, sessionId)
        enrollment = { trialId, arm, forced }
        if (arm === "baseline") {
          snapshot = {
            scope: "project-global",
            system: trial.baselineSystem,
            tools: trial.baselineTools,
            playbook: trial.baselinePlaybook ?? null,
          }
        }
      }
    }

    const composed = composeHarness(layerRefs, {}, st.model, snapshot)

    // Env snapshot injects once per session (pushed last, if present).
    const wantsSnapshot = sessionId && !st.snapshotInjected
    const envSnapshot = wantsSnapshot ? st.snapshot : undefined

    const blocks = renderSystemBlocks(composed, envSnapshot)

    for (const layer of composed) {
      if (layer.system) {
        await this.host.log("debug", `[hook:system.transform] injected ${layer.scope} system — ${layer.system.length} chars`)
      }
    }
    const toolLayerCount = composed.filter((l) => l.tools).length
    if (toolLayerCount > 0) {
      await this.host.log("debug", `[hook:system.transform] injected tool guidance from ${toolLayerCount} layer(s)`)
    }
    if (envSnapshot) {
      st.snapshotInjected = true
      this.state.put(sessionId, st)
      await this.host.log("debug", `[hook:system.transform] injected env snapshot`)
    }
    return { blocks, enrollment }
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

  // ── session.idle: the whole scoring + auto-propose pipeline ────────────────
  /**
   * F3 — honest outcomes. Additive return value (was `void`); the opencode
   * adapter (index.ts) awaits sessionIdle and discards the result, so this
   * is zero behavior change there. The Claude Code adapter (dispatch.ts)
   * uses it to render a distinct, honest /mh-score block message instead of
   * an unconditional "score recorded ✓":
   *   "not-active"         — the `!st0?.bootstrapped` / `!st0.participates`
   *                           guards: nothing is tracked for this session,
   *                           OR (on CC) the session was already scored once
   *                           and cleanup() reset it — CC's one-score-per-
   *                           session Phase-A behavior, since no SessionStart
   *                           re-fires without a resume.
   *   "pending"             — the `st0.pendingScore` guard (already-in-flight
   *                           scoring, incl. a not-yet-cleared F1 wedge), or
   *                           promptHumanScore timing out with no verdict.
   *   "skipped-degenerate"  — the degenerate-session filter.
   *   "recorded"            — the full happy path completed.
   */
  // NOTE: gate-plugin reinject turns can re-enter this pipeline — see docs/2026-07-25-daily-evolution-loop.md §4.1 known-interaction note.
  async sessionIdle(sessionId: string): Promise<SessionIdleOutcome> {
    const st0 = this.state.get(sessionId)
    const agent = st0?.role ?? ""
    await this.host.log("info", `[hook:event] session.idle — sessionID=${sessionId} agent=${agent} bootstrapped=${!!st0?.bootstrapped}`)

    if (!st0?.bootstrapped) return "not-active"
    if (!st0.participates) return "not-active"
    if (st0.pendingScore) return "pending"

    const st = st0

    // Skip degenerate sessions (greetings / no substantive work) BEFORE
    // bothering the human — they must never pollute the fitness signal.
    const turns = st.turns
    const usage = st.toolUsage
    const summary = st.summary
    if (isDegenerateSession(turns, usage, summary)) {
      await this.host.log("info", `[hook:event] skipping degenerate session ${sessionId} (turns=${turns}, toolCalls=${Object.values(usage).reduce((n, t) => n + t.calls, 0)})`)
      await this.host.notify("Meta-Harness: session skipped (no substantive work)", "info", 4_000, null)
      this.cleanup(sessionId)
      return "skipped-degenerate"
    }

    st.bootstrapped = false
    st.pendingScore = true
    this.state.put(sessionId, st)

    // Shadow-mode dense judge (Phase 4 Part D): kicked off CONCURRENTLY with the
    // human prompt below so it never delays scoring. Disabled by default
    // (judgeModel === "") — zero behavior change unless explicitly configured.
    const mhCfg = readMhConfig()
    const judgePromise: Promise<JudgeVerdict | null> = mhCfg.judgeModel
      ? runJudge(this.host, this.worktree, sessionId, st.summary, st.turns, st.trajectory).catch(() => null)
      : Promise.resolve(null)

    // Maker-checker (Phase 4 Part D4): once the judge is calibrated, pre-fill the
    // human's score prompt with the judge's verdict — judge proposes, human checks.
    const calBefore = mhCfg.judgeModel
      ? judgeCalibration(mhCfg.judgeMinSessions, mhCfg.judgeMinAgreement)
      : { n: 0, agreement: 0, calibrated: false }
    let prefill: string | undefined
    let usedPrefill = false
    if (calBefore.calibrated) {
      const early = await Promise.race([judgePromise, new Promise<null>((r) => setTimeout(() => r(null), 60_000))])
      if (early) {
        const r = early.reasoning
        const hint = r.length <= 80
          ? r
          : (() => { const c = r.slice(0, 80); const sp = c.lastIndexOf(" "); return (sp > 48 ? c.slice(0, sp) : c).trimEnd() + "…" })()
        prefill = `/mh-score ${early.passed ? "good" : "bad"} judge: ${hint}`
        usedPrefill = true
      }
    }
    const result = await promptHumanScore(this.host, sessionId, undefined, prefill)
    if (result === null) {
      await this.host.log("info", `[hook:event] scoring timed out — skipping ${sessionId}`)
      st.pendingScore = false
      this.state.put(sessionId, st)
      return "pending"
    }

    // De-collide the recorded ID when this session is scored more than once.
    const priorScores = st.scoreCount
    st.scoreCount = priorScores + 1
    this.state.put(sessionId, st)
    const recordID = priorScores === 0 ? sessionId : `${sessionId}#${priorScores + 1}`

    // Record into all 4 stores
    const layers = layersFor(this.worktree, agent)
    const prLayer = layers.find((l) => l.scope === "project-role")!
    const model = st.model ?? "unknown"
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
      turnCount: st.turns,
      timestamp: new Date().toISOString(),
      summary: st.summary,
      model,
      variant: st.variant ?? "",
      toolUsage: st.toolUsage,
      env,
      platform: this.host.platform,
    }

    // Resolve the shadow judge and fold its verdict into `record` BEFORE the
    // recordSession calls below (recordSession writes `record` synchronously).
    const judgeVerdict = await judgePromise
    let judgeLogLine: string | undefined
    if (judgeVerdict) {
      const agreed = judgeVerdict.passed === result.passed
      const trivial = judgeVerdict.trivial === true
      record.judge = {
        passed: judgeVerdict.passed,
        confidence: judgeVerdict.confidence,
        mode: usedPrefill ? "prefill" : "shadow",
        agreed,
        trivial,
      }
      if (!trivial) {
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
      } else {
        judgeLogLine = `[judge] trivial session — judge=${judgeVerdict.passed} human=${result.passed} (excluded from calibration/fitness)`
      }
    }

    const scores = layers.map((layer) => {
      const version = activeVersion(layer.root)
      return { layer, score: recordSession(layer.root, version, record) }
    })

    if (judgeLogLine) await this.host.log("info", judgeLogLine)

    // Persist the trajectory (failures always; passes only with SAVE_ALL_TRAJ).
    const traj = st.trajectory
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

    await this.host.log("info", `[hook:event] scored ${result.passed ? "PASS" : "FAIL"} model=${record.model} agent=${agent} — project-role ${projectRoleScore?.nPass}/${projectRoleScore?.sessions.length}`)

    await this.host.notify(
      `Score recorded: ${result.passed ? "✓ good" : "✗ bad"} (${agent} project-role: ${projectRoleScore?.nPass}/${projectRoleScore?.sessions.length})${record.judge?.trivial ? " — trivial: recorded, not counted toward fitness" : ""}`,
      result.passed ? "success" : "warning",
      4_000, null,
    )

    this.cleanup(sessionId)

    // Resolve any in-progress project-layer trial now that a new score landed.
    for (const l of [pgLayer, prLayer]) {
      const res = resolveTrial(l.root)
      if (res.action === "confirmed") {
        exportRuleChecks(this.worktree, l.root)
        exportHookRules(this.worktree, l.root)
        await this.host.log("info", `[hook:event] trial confirmed ${l.scope} ${res.trial}`)
        await this.host.notify(
          `Trial confirmed: ${l.scope} ${res.trial} kept (${fmtRate(res.trialRate)} vs baseline ${res.baselineRate === null ? "n/a" : fmtRate(res.baselineRate)})`,
          "success", 6_000, null,
        )
      } else if (res.action === "reverted") {
        exportRuleChecks(this.worktree, l.root)
        exportHookRules(this.worktree, l.root)
        await this.host.log("warn", `[hook:event] trial reverted ${l.scope} → ${res.baseline}`)
        await this.host.notify(
          `Trial reverted: ${l.scope} back to ${res.baseline} (${fmtRate(res.trialRate)} < baseline ${fmtRate(res.baselineRate)})`,
          "warning", 6_000, null,
        )
      } else if (res.action === "abandoned") {
        await this.host.log("warn", `[hook:event] trial abandoned ${l.scope}: ${res.reason}`)
      }
    }

    // Selection-gated auto-propose.
    const prDue = !!projectRoleScore
      && nonTrivialCount(projectRoleScore.sessions) >= PROJECT_ROLE_THRESHOLD
      && readTrial(prLayer.root) === null
    const pgDue = !!projectGlobalScore
      && nonTrivialCount(projectGlobalScore.sessions) >= PROJECT_GLOBAL_THRESHOLD
      && readTrial(pgLayer.root) === null

    // Check for project plateau pause flag.
    const pausedFlagPath = path.join(this.worktree, ".kkamak", "paused")
    const paused = fs.existsSync(pausedFlagPath)
    const stAfter = this.state.get(sessionId)
    if (paused && (prDue || pgDue) && stAfter && !stAfter.pausedToastShown) {
      stAfter.pausedToastShown = true
      this.state.put(sessionId, stAfter)
      await this.host.log("info", "[hook:event] auto-propose skipped — project plateau pause flag present")
      await this.host.notify(
        "auto-propose paused (project plateau) — rm .kkamak/paused to resume; /mh-propose still works",
        "info", 10_000,
      )
    } else if (prDue && !paused) {
      await this.host.log("info", `[hook:event] auto-propose project-role for ${agent}`)
      // F5 — microtask invariant: `void` here means the fire-and-forget
      // propose child is only launched because every `await` between here
      // and stageArtifactApply's synchronous spawn call resolves within the
      // current microtask queue drain. On Claude Code, hook-cli.ts's process
      // exits (see its own F5 note) once `main()`'s promise settles — that
      // happens to still be AFTER this point today, but inserting a real
      // async boundary (a genuine I/O await) before stageArtifactApply would
      // silently kill auto-propose on CC: the process would exit before the
      // detached child ever gets spawned, with no error, no log, nothing.
      void triggerPropose(this.host, this.worktree, prLayer)
    } else if (pgDue && !paused) {
      await this.host.log("info", `[hook:event] auto-propose project-global`)
      // F5 — same microtask-invariant caveat as the prDue branch above.
      void triggerPropose(this.host, this.worktree, pgLayer)
    }

    // Anti-bloat nudge: suggest curation when a project layer is over budget.
    for (const l of [prLayer, pgLayer]) {
      if (activeBulletCount(readPlaybook(l.root)) > CURATOR_BUDGET && readTrial(l.root) === null) {
        await this.host.notify(
          `Meta-Harness: ${l.scope} playbook over ${CURATOR_BUDGET} bullets — run /mh-curate`,
          "info", 5_000, null,
        )
        break
      }
    }
    return "recorded"
  }

  // ── /mh-* command routing (the adapter renders the returned data) ──────────
  async handleCommand(command: string, args: string, sessionId: string): Promise<CommandResult> {
    // /mh-score good|bad [note]
    if (handleScoreCommand(command, args, sessionId)) {
      await this.host.log("info", `[hook:command.execute.before] /mh-score consumed`)
      return { consumed: true, kind: "throw", message: "Meta-Harness: score recorded ✓ (this notice is expected)" }
    }

    // /mh-propose [scope]
    if (command === "mh-propose") {
      const agent = this.state.get(sessionId)?.role ?? "mh-build"
      const layers = layersFor(this.worktree, agent)
      const layer = resolveScopeLayer(args, layers)
      if (layer) {
        await this.host.log("info", `[hook:command] /mh-propose scope=${layer.scope} agent=${agent}`)
        // F5 — same microtask-invariant caveat as sessionIdle's auto-propose
        // `void triggerPropose` calls above: relies on this settling before
        // hook-cli.ts's process exits.
        void triggerPropose(this.host, this.worktree, layer)
        return { consumed: true, kind: "toast", message: "propose cycle started ✓", variant: "success" }
      }
      return { consumed: true, kind: "toast", message: `/mh-propose — unknown scope "${args.trim()}" (use role|project|role-global|account)`, variant: "error" }
    }

    // /mh-activate <scope> <vN> [--force]
    if (command === "mh-activate") {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const force = parts.includes("--force")
      const positional = parts.filter((p) => p !== "--force")
      const scopeArg = positional[0] ?? ""
      const version = positional[1] ?? ""
      const agent = this.state.get(sessionId)?.role ?? "mh-build"
      const layers = layersFor(this.worktree, agent)
      const layer = resolveScopeLayer(scopeArg, layers)
      if (!layer) {
        return { consumed: true, kind: "toast", message: `/mh-activate — unknown scope "${scopeArg}" (use account|project|role-global|role)`, variant: "error" }
      }
      if (!/^v\d+$/.test(version)) {
        return { consumed: true, kind: "toast", message: `/mh-activate — expected a version like v3, got "${version}"`, variant: "error" }
      }
      const isAccount = layer.scope === "account-global" || layer.scope === "account-role"
      if (isAccount && !force) {
        const verdict = readAbVerdict(layer.root, version)
        if (!verdict) {
          return { consumed: true, kind: "toast", message: `no ab-verdict.json for ${layer.scope} ${version} — run "bun term-bench2/runner.ts ab --layer ${layer.scope} --candidate ${version}" first, or pass --force`, variant: "error" }
        }
        if (!abAccepted(verdict)) {
          const dec = verdict.decision ?? `winner=${verdict.winner}`
          const hi = verdict.heldIn
          const detail = hi
            ? `held-in delta=${hi.delta >= 0 ? "+" : ""}${hi.delta} p=${hi.mcnemarP} CI90=${JSON.stringify(hi.bootCI90)}`
            : `candidate ${fmtRate(verdict.candidateRate)} vs active ${fmtRate(verdict.activeRate)}, n=${verdict.nTasks}`
          return { consumed: true, kind: "toast", message: `${version} was not accepted by the ab gate (${dec}; ${detail}) — refusing; pass --force to override`, variant: "error" }
        }
        // Budget-identity gate (Loop-3 T6): refuse to activate a candidate
        // measured under a DIFFERENT budget than the layer's active baseline
        // — silent-Goodhart guard (see harness-store.ts's budgetIdentityMatches
        // doc). A pre-Loop-3 verdict (no maxAgentTimeout field) is treated as
        // compatible by budgetIdentityMatches itself, so it falls through here
        // unchanged.
        const activeBudget = readActiveBudget(layer.root)
        if (!budgetIdentityMatches(verdict, activeBudget)) {
          // Loop-3 pre-flip fix #3: when the active baseline has NO recorded
          // budget-identity at all (readActiveBudget found no env-carrying
          // session for it — e.g. it predates budget-identity stamping),
          // the generic per-field message below would render cryptically
          // ("maxAgentTimeout 900s (candidate) vs undefined (active)"). Give
          // this specific case its own actionable wording instead. Reachable
          // here only when budgetIdentityMatches already returned false,
          // which itself only happens once verdict.maxAgentTimeout is known
          // defined (its own first check short-circuits pre-Loop-3 verdicts) —
          // so `verdict.maxAgentTimeout` is safe to render as a number below.
          if (activeBudget.maxAgentTimeout === undefined) {
            return {
              consumed: true,
              kind: "toast",
              message: `${version} was measured under a budget (maxAgentTimeout ${verdict.maxAgentTimeout}s) but ${layer.scope}'s active baseline has no recorded budget-identity — re-baseline it (re-score the active version at the current budget) or pass --force`,
              variant: "error",
            }
          }
          const mismatches: string[] = []
          if (verdict.maxAgentTimeout !== activeBudget.maxAgentTimeout) {
            mismatches.push(`maxAgentTimeout ${verdict.maxAgentTimeout}s (candidate) vs ${activeBudget.maxAgentTimeout}s (active)`)
          }
          if ((verdict.minAgentTimeout ?? 0) !== (activeBudget.minAgentTimeout ?? 0)) {
            mismatches.push(`minAgentTimeout ${verdict.minAgentTimeout ?? 0}s (candidate) vs ${activeBudget.minAgentTimeout ?? 0}s (active)`)
          }
          if ((verdict.timeoutRecording ?? false) !== (activeBudget.timeoutRecording ?? false)) {
            mismatches.push(`timeoutRecording ${verdict.timeoutRecording ?? false} (candidate) vs ${activeBudget.timeoutRecording ?? false} (active)`)
          }
          const verdictEnforcement = verdict.env?.resourceEnforcement ?? false
          const activeEnforcement = activeBudget.resourceEnforcement ?? false
          if (verdictEnforcement !== activeEnforcement) {
            mismatches.push(`resourceEnforcement ${verdictEnforcement} (candidate) vs ${activeEnforcement} (active)`)
          }
          return {
            consumed: true,
            kind: "toast",
            message: `${version} was measured under a different budget than ${layer.scope}'s active baseline (${mismatches.join("; ")}) — refusing to activate (re-baseline per T7, or pass --force to override)`,
            variant: "error",
          }
        }
      }
      const ok = activateCandidate(layer.root, version)
      if (!ok) {
        return { consumed: true, kind: "toast", message: `candidate ${version} not found (no system.md) for ${layer.scope}`, variant: "error" }
      }
      exportRuleChecks(this.worktree, layer.root)
      exportHookRules(this.worktree, layer.root)
      await this.host.log("info", `[hook:command] /mh-activate ${layer.scope} ${version}${force ? " --force" : ""}`)
      return { consumed: true, kind: "toast", message: `activated ${layer.scope} ${version} ✓`, variant: "success" }
    }

    // /mh-promote [global|role]
    if (command === "mh-promote") {
      const scope = args.trim().toLowerCase()
      const agent = this.state.get(sessionId)?.role ?? "mh-build"
      const layers = layersFor(this.worktree, agent)
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
        await this.host.log("info", `[hook:command] /mh-promote ${source.scope}→${target.scope} agent=${agent}`)
        // F5 — same microtask-invariant caveat as sessionIdle's auto-propose
        // `void triggerPropose` calls above.
        void triggerPromote(this.host, this.worktree, source, target)
        return { consumed: true, kind: "toast", message: "promote cycle started ✓", variant: "success" }
      }
      return { consumed: true, kind: "toast", message: `/mh-promote — unknown scope "${scope}" (use global|role)`, variant: "error" }
    }

    // /mh-curate <scope> — consolidate/prune a layer's playbook (through the gate)
    if (command === "mh-curate") {
      const agent = this.state.get(sessionId)?.role ?? "mh-build"
      const layers = layersFor(this.worktree, agent)
      const layer = resolveScopeLayer(args, layers)
      if (!layer) {
        return { consumed: true, kind: "toast", message: `/mh-curate — unknown scope "${args.trim()}" (use role|project|role-global|account)`, variant: "error" }
      }
      await this.host.log("info", `[hook:command] /mh-curate scope=${layer.scope} agent=${agent}`)
      // F5 — same microtask-invariant caveat as sessionIdle's auto-propose
      // `void triggerPropose` calls above.
      void triggerCurate(this.host, this.worktree, layer)
      return { consumed: true, kind: "toast", message: "curate cycle started ✓", variant: "success" }
    }

    // /mh-status
    if (command === "mh-status") {
      const st = this.state.get(sessionId)
      const tracked = st?.role ?? undefined
      const trackedParticipates = st?.participates ?? false
      const agent = tracked ?? "mh-build"
      const layers = layersFor(this.worktree, agent)
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
        const playbook = readPlaybook(layer.root)
        const bullets = activeBulletCount(playbook)
        const bulletInfo = bullets > 0 ? ` [${bullets} bullets${bullets > CURATOR_BUDGET ? " — over budget, /mh-curate" : ""}]` : ""
        let genInfo = ""
        if (playbook) {
          const gen = { universal: 0, vendor: 0, model: 0 }
          for (const b of playbook.bullets) {
            if (b.status !== "active") continue
            gen[b.generality ?? "universal"]++
          }
          if (gen.vendor > 0 || gen.model > 0) {
            genInfo = ` gen[u:${gen.universal} v:${gen.vendor} m:${gen.model}]`
          }
        }
        let line = `  ${layer.scope}: active=${ver} (${rate})${bulletInfo}${genInfo}`
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
      const pausedFlagPath = path.join(this.worktree, ".kkamak", "paused")
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
        lines.push(`  PAUSED: auto-propose disabled (plateau since ${ts}) — rm .kkamak/paused to resume`)
      }

      const prLayer = layers.find((l) => l.scope === "project-role")
      if (prLayer) {
        const last = readLastMetric(prLayer.root, ["trial", "activate", "ab", "propose", "curate"])
        if (last) {
          const detail = [last.action, last.candidate ?? last.version ?? last.trial].filter(Boolean).join(" ")
          lines.push(`  last: ${last.event} ${detail} (${last.ts})`)
        }
      }
      return { consumed: true, kind: "toast", message: lines.join("\n"), variant: "info", duration: 15_000 }
    }

    return { consumed: false }
  }
}
