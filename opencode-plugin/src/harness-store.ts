/**
 * harness-store.ts
 *
 * Multi-layer filesystem store for the meta-harness evolution system.
 *
 * Four stores form a 2×2 lattice (scope × location):
 *
 *   account-global  <accountMetaRoot()>/global/          (default ~/.config/kkamak/global/)
 *   account-role    <accountMetaRoot()>/roles/<agent>/    (default ~/.config/kkamak/roles/<agent>/)
 *   project-global  <project>/.kkamak/global/
 *   project-role    <project>/.kkamak/roles/<agent>/
 *
 * Each store has the same internal layout:
 *   <storeRoot>/
 *     active/
 *       system.md     ← current best behavioral system prompt for this layer
 *       tools.md      ← current best tool-usage guidance for this layer (keyed by tool)
 *       .version      ← "v0", "v1", …
 *     candidates/
 *       v0/
 *         system.md
 *         tools.md
 *         score.json  ← { version, nPass, nFail, sessions: SessionRecord[] }
 *         traces/
 *           <sessionID>.json
 *       v1/ …
 *
 * Injection order (Option Y — role beats global, project beats account):
 *   account-global → project-global → account-role → project-role → env-snapshot
 *
 * Proposer gap-filling: each proposer sees the active text of all more-general
 * layers as "already covered" read-only context and proposes ONLY new rules
 * appropriate to its own scope.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"
import { writeJsonAtomic } from "./bench/util.ts"
// Function-level cycle (failure-retrieval imports store readers back) — safe:
// every cross-reference resolves at call time, not import time.
import { rankRoleFailures, type RoleRankOpts } from "./failure-retrieval.ts"

// ── Root resolvers ─────────────────────────────────────────────────────────
//
// Project rename (2026-07-28): meta-harness → kkamak. The store directory is
// `.kkamak/` per worktree and `~/.config/kkamak` per account; the previous
// names are migrated on first read (migrateAccountRoot / migrateProjectRoot)
// because NONE of this state is git-tracked — an un-migrated host would come
// up with an empty store, which looks like "nothing proposed yet" rather than
// like an error.

/** Account/project store directory name. */
const STORE_DIR_NAME = "kkamak"
/** Per-worktree store directory name. */
const PROJECT_STORE_DIR = ".kkamak"
/** Pre-rename names, newest-first, migrated away from on first use. */
const LEGACY_STORE_DIR_NAME = "meta-harness"
const LEGACY_PROJECT_STORE_DIR = ".meta-harness"

//
// The account-layer root is platform-neutral (Task L5) — it used to be an
// opencode-owned, IMPORT-TIME constant (`~/.config/opencode/.meta-harness`),
// which was wrong the moment the loop runs on a different coding agent AND
// made env stubbing in tests infeasible (an import happens once, long before
// any test's `beforeEach`/`beforeAll` runs). `accountMetaRoot()` reads env
// fresh on every call instead — cheap (a couple of env lookups + path
// joins, no filesystem access), and it doubles as the test seam: tests set
// META_HARNESS_HOME in-process around the calls they care about.
//
// Resolution order:
//   1. KKAMAK_HOME (absolute path, used as-is)
//   2. META_HARNESS_HOME — DEPRECATED pre-rename name, still honored so that
//      existing scripts, launchd jobs and docs keep working
//   3. $XDG_CONFIG_HOME/kkamak
//   4. ~/.config/kkamak

export function accountMetaRoot(): string {
  const override = process.env["KKAMAK_HOME"] ?? process.env["META_HARNESS_HOME"]
  if (override) return override
  const xdg = process.env["XDG_CONFIG_HOME"]
  if (xdg) return path.join(xdg, STORE_DIR_NAME)
  return path.join(os.homedir(), ".config", STORE_DIR_NAME)
}

/** Pre-rename account roots, NEWEST FIRST — the meta-harness-named store
 * (2026-07-28 rename) and, before that, the PRE-L5 opencode-owned location.
 * Used ONLY by migrateAccountRoot() to find legacy content to move; never
 * general-purpose path helpers.
 *
 * Still consulted under an env override: an explicitly-set root is exactly
 * where a legacy store SHOULD be migrated to (pre-rename contract, kept). */
function legacyAccountRoots(): string[] {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const configDir = xdg ?? path.join(os.homedir(), ".config")
  const opencodeConfigDir = xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode")
  return [
    path.join(configDir, LEGACY_STORE_DIR_NAME),
    path.join(opencodeConfigDir, LEGACY_PROJECT_STORE_DIR),
  ]
}

export function accountGlobalRoot(): string {
  return path.join(accountMetaRoot(), "global")
}

export function accountRoleRoot(agent: string): string {
  return path.join(accountMetaRoot(), "roles", agent)
}

export function projectGlobalRoot(worktree: string): string {
  return path.join(worktree, PROJECT_STORE_DIR, "global")
}

export function projectRoleRoot(worktree: string, agent: string): string {
  return path.join(worktree, PROJECT_STORE_DIR, "roles", agent)
}

/** Legacy flat store used before the 4-layer refactor. */
function legacyRoot(worktree: string): string {
  return path.join(worktree, LEGACY_PROJECT_STORE_DIR)
}

// ── Paths inside a store ───────────────────────────────────────────────────

export function activePath(storeRoot: string, file: string): string {
  return path.join(storeRoot, "active", file)
}

export function candidatePath(storeRoot: string, version: string, ...parts: string[]): string {
  return path.join(storeRoot, "candidates", version, ...parts)
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Per-tool usage counts collected during a session. */
export type ToolUsage = Record<string, { calls: number; errors: number }>

export interface SessionRecord {
  sessionID: string
  passed: boolean
  note: string
  turnCount: number
  timestamp: string
  summary: string
  model: string
  variant: string
  /** Tool call counts + best-effort error counts for this session. */
  toolUsage: ToolUsage
  /** Confound-control provenance (harness hash, plugin sha, provider…); optional. */
  env?: Record<string, unknown>
  /** Which coding-agent platform produced this session (Task L1): "opencode"
   * for the live opencode plugin loop, or the bench AgentDriver id
   * (drivers/index.ts) for bench-recorded sessions — e.g. "claude-code".
   * Optional so every pre-L1 on-disk score.json keeps parsing. */
  platform?: string
  /** Measured container-cgroup resource consumption for this session (bench
   * resource-profile capture): `cpuSeconds` = cumulative CPU-seconds the whole
   * container burned (cgroup v2 cpu.stat usage_usec / 1e6), `peakRssMb` = peak
   * RSS (memory.peak). Read from the container's OWN cgroup just before teardown
   * — a MEASURED footprint, distinct from the DECLARED task.toml `cpus`/mem the
   * container was capped at. Feeds resource-profile.ts's memorized per-task/
   * per-host profile so the scheduler packs on real load, not a static int.
   * Optional so pre-capture records + non-podman callers keep parsing. */
  cpuSeconds?: number
  peakRssMb?: number
  /** Final memory cap (MB) the session's LAST container ran under, post
   * measured-raise and post OOM-escalation. Only stamped by the run/ab
   * callers under --enforce-resources; optional so pre-loadaware-B5 records
   * and unenforced runs keep parsing. */
  capMemoryMb?: number
  /** True when raiseCapMeasured lifted the INITIAL container memory cap
   * above the declared/floored task.toml value. Only stamped alongside
   * `capMemoryMb` under --enforce-resources; optional so pre-loadaware-B5
   * records and unenforced runs keep parsing. */
  capRaised?: boolean
  /** Dense LLM judge verdict for this session (Phase 4 Part D), when the judge
   * ran — shadow mode never affects `passed`; prefill mode may pre-populate the
   * human /mh-score prompt. Optional so pre-D1 records keep parsing. */
  judge?: {
    passed: boolean
    confidence?: number
    mode: "shadow" | "prefill"
    agreed?: boolean
    /** Judge-rated triviality (Task 7 / Option A): a session too trivial
     * (greeting, single-file read, one-liner lookup…) to be an informative
     * fitness signal. When true, `resolveTrial` excludes this session from
     * both the trial-side and baseline-side rate computations, and index.ts
     * excludes it from auto-propose counts and judge calibration. Absent on
     * pre-Task-7 records and treated the same as false. */
    trivial?: boolean
  }
  /** Wall-clock seconds this session consumed (cmd-run.ts elapsed). Optional so
   *  pre-Loop-3 records keep parsing; absent ⇒ unknown. */
  elapsed?: number
  /** True iff the agent phase hit the wall timeout (turnCount will be 0).
   *  Optional; absent ⇒ false. Only ever recorded when the operator has
   *  opted in via MhConfig.recordTimeouts (Loop-3 T3) — see record.ts's
   *  recordToStores guard. */
  timedOut?: boolean
  /** The REAL per-task agent wall-clock budget (seconds) this session ran
   *  under — `taskTimeouts()`'s resolved `agentTimeout` (the task.toml
   *  `agent.timeout_sec` override, default 900, capped by the run's
   *  --max-agent-timeout). Deliberately NOT the same value as
   *  `env.maxAgentTimeout` (the RUN-LEVEL cap): the two diverge whenever a
   *  task.toml override sits below the run cap, or the run cap sits above
   *  900 — in exactly that case `env.maxAgentTimeout` understates the wall a
   *  timed-out session actually hit. Optional so pre-fix records keep
   *  parsing; absent ⇒ buildProposerContext's TIMEOUT marker falls back to
   *  `env.maxAgentTimeout` (back-compat). Loop-3 pre-flip fix #1. */
  agentTimeout?: number
}

export interface CandidateScore {
  version: string
  nPass: number
  nFail: number
  sessions: SessionRecord[]
}

/** Describes one layer in the injection stack. */
export interface StoreLayer {
  root: string
  scope: "account-global" | "project-global" | "account-role" | "project-role"
  /** Roots of more-general layers, in order — used to build gap-filling context. */
  higherRoots: string[]
}

/**
 * State of an in-progress project-layer trial. Presence of active/.trial means
 * a candidate is live provisionally and awaiting enough scored sessions to
 * confirm or revert. The baseline text is snapshotted here so a revert never
 * depends on the baseline candidate directory still existing.
 */
export interface TrialState {
  trial: string
  baseline: string
  baselineSystem: string
  baselineTools: string
  startedAt: string
  minSessions: number
  /** Snapshot of the baseline playbook so a revert restores it (Phase 3). */
  baselinePlaybook?: Playbook | null
  /** Snapshot of the baseline agent config so a revert restores it (Phase 4B). */
  baselineAgentConfig?: AgentConfig | null
  /** Snapshot of the baseline env policy so a revert restores it (Phase 4C). */
  baselineEnvPolicy?: EnvPolicy | null
  /** §4.3 gate-outcomes trials only — marks this trial as governed by the
   * new decision engine (trial-verdict.ts / resolveGateTrial), so the OLD
   * resolveTrial's stand-down guard (Task 4) and composeInjection's
   * arm-aware path (this task) both key off it. Legacy trials (undefined)
   * never had arms — they compose active-only, exactly as before this
   * field existed. OPTIONAL interface field only, added by Task 3; the
   * behavior that sets/reads it beyond compose (startTrial/resolveTrial)
   * is Task 4's. */
  rewardMode?: "gate-outcomes"
  /** §4.3 gate-outcomes trials only — the salt used in `pickTrialArm`'s
   * `(trialId, sessionID)` hash (spec §3). Falls back to `trial` (the
   * candidate version string) at call sites until Task 4 populates this
   * distinctly. OPTIONAL interface field only, added by Task 3. */
  trialId?: string
  /** Plan Global Constraints: golden-baseline window (§4.3 spec §5) — arms
   * are the current incumbent (as "trial") vs. a frozen golden snapshot (as
   * "baseline"), evaluated under the same decision rule as an ordinary
   * gate-outcomes trial. Layered on `.trial` rather than a second state
   * marker (build-time decision, plan Global Constraints) so it inherits
   * readTrial's existing clobber guard for free. OPTIONAL interface field. */
  golden?: boolean
  /** Plan Global Constraints: a queued golden window (or any trial not yet
   * human-go'd) is inert — compose ignores it (no arm assignment, active
   * compose), the verdict engine ignores it, only the human-go path
   * activates it. OPTIONAL interface field only, added by Task 3. */
  awaitingGo?: boolean
}

export type TrialResolution =
  | { action: "none" }
  | { action: "pending"; have: number; need: number }
  | { action: "abandoned"; reason: string }
  | { action: "confirmed"; trial: string; trialRate: number; baselineRate: number | null }
  | { action: "reverted"; trial: string; baseline: string; trialRate: number; baselineRate: number }

/** Per-set paired statistics block in a v2 verdict. */
export interface AbSetStats {
  nTasks: number
  nPairs: number
  b: number
  c: number
  delta: number
  mcnemarP: number
  bootCI90: [number, number]
}

/** Per-set paired time-to-resolve stats block (W1a) — mirrors AbSetStats but
 * for agent-phase elapsed seconds instead of reward pass/fail. Report-only
 * in this phase (a later phase wires it as a decision tiebreaker). Mirrors
 * ab-stats.ts's SpeedStats field-for-field (kept independent, not imported,
 * matching this file's existing AbSetStats/PairStats split — see that type's
 * neighbors). */
export interface AbSpeedStats {
  nTasks: number
  nPairs: number
  medianCandidate: number
  medianActive: number
  medianRatio: number
  fasterB: number
  slowerC: number
  signTestP: number
}

/** Verdict written by the Python `ab` runner into candidates/<vN>/ab-verdict.json.
 * v1 fields (winner/rates) are always present; v2 adds the statistical decision. */
export interface AbVerdict {
  winner: "candidate" | "active" | "tie"
  candidateRate: number
  activeRate: number
  nTasks: number
  timestamp: string
  // v2 (optional — old verdicts still parse)
  schemaVersion?: number
  decision?: "accept" | "reject" | "inconclusive"
  reasons?: string[]
  heldIn?: AbSetStats
  heldOut?: AbSetStats | null
  earlyStopped?: boolean
  split?: unknown
  // Loop-3 T6 (additive-optional — old verdicts still parse): budget-identity
  // provenance. `maxAgentTimeout`/`timeoutRecording` are stamped top-level by
  // cmd-ab.ts's verdictDict; `env.resourceEnforcement` is sourced from the
  // existing `env` block (envBlock() in record.ts) rather than duplicated —
  // only the one field this gate cares about is typed here.
  maxAgentTimeout?: number
  /** Loosest-envelope agent-timeout FLOOR (--min-agent-timeout) this verdict
   * was measured under. Part of the budget-identity tuple alongside
   * maxAgentTimeout — absent = no floor (pre-feature verdicts stay compatible,
   * coalesced to 0 by budgetIdentityMatches). */
  minAgentTimeout?: number
  timeoutRecording?: boolean
  env?: { resourceEnforcement?: boolean; maxAgentTimeout?: number }
  /** W1a (time-to-resolve, report-only in this phase): paired agent-phase
   * elapsed-seconds stats over both-pass run-pairs, mirroring heldIn/heldOut
   * above but for speed instead of reward. null iff there were no qualifying
   * pairs (cmd-ab.ts's ab-stats.ts pairedSpeedStats). Absent entirely on
   * pre-W1a verdicts. */
  speed?: { heldIn: AbSpeedStats | null; heldOut: AbSpeedStats | null }
  // a3 routing T8 (additive-optional — old verdicts still parse): per-arm
  // rule-routing checked-bullet identity. The SAME `checksHashOf` hash T5's
  // `env.checksHash` records for arm B alone — this is where arm A's (the
  // active baseline's) OWN identity lands, since the single `env` block
  // above only ever covers arm B (T5 review note: envBlock is computed
  // once, from the candidate/arm-B harness). Stamped on EVERY verdict going
  // forward (checkless included, coalesced to `EMPTY_CHECKS_HASH` on both
  // sides) — optional here only because pre-T8 verdicts on disk lack the
  // key entirely, same convention as `maxAgentTimeout` above.
  activeChecksHash?: string
  candidateChecksHash?: string
  /** Stamped iff EITHER checksHash above is not `EMPTY_CHECKS_HASH`: a
   * checked-rule bundle's regressions are NOT attributable between rule
   * TEXT (the helpful/harmful playbook bookkeeping every ab already scores)
   * and check BEHAVIOR (the gate's pass/block decisions) — a candidate that
   * "loses" could be a worse RULE or just a stricter/flakier CHECK. See
   * `ruleCheckTotals` below and cmd-run.ts's `RunTaskResult.ruleChecks` (the
   * per-attempt annotation this aggregates). Absent — not merely
   * false/empty — on a checkless verdict, so existing consumers that only
   * ever `if (verdict.checkBundleCaveat)` stay byte-shape-compatible. */
  checkBundleCaveat?: string
  /** Per-rule `{blocked, exhausted}` totals aggregated across every
   * attempt's `ruleChecks` annotation (T7), split per arm — the caveat's
   * pointer target. `blocked` sums `perRule[bulletId].blocked` across
   * attempts that named this bulletId as the (sole, most-recently-failing)
   * rule; `exhausted` counts ATTEMPTS whose gate exhausted while THIS
   * bulletId was that failing rule — rounds/exhausted are gate-level, not
   * per-rule (rule-gate.ts's F2 scope cut: `perRule` tracks only the most
   * recently failing bulletId's entry), so per-attempt attribution to the
   * failing bulletId is the closest reading state.json's shape supports.
   * Present only alongside `checkBundleCaveat` (undefined on a checkless
   * verdict).
   *
   * RUN-TIME DUTY (not code, not this task): the FIRST real checked-rule ab
   * run whose verdict lands here with a non-empty caveat must ALSO stamp a
   * boundary timestamp in docs/2026-08-01-gauntlet-adoption-ledger.md (a3
   * plan documentation step) — an operational step for whoever runs that
   * ab, not something verdict assembly can do at write time. */
  ruleCheckTotals?: {
    active: Record<string, { blocked: number; exhausted: number }>
    candidate: Record<string, { blocked: number; exhausted: number }>
  }
}

/** Accept a candidate iff the v2 decision says "accept"; fall back to the v1
 * winner field for pre-v2 verdicts. This is the single gate /mh-activate uses. */
export function abAccepted(v: AbVerdict): boolean {
  return v.decision !== undefined ? v.decision === "accept" : v.winner === "candidate"
}

// ── Budget-identity guard (Loop-3 T6) ───────────────────────────────────────
//
// A verdict measured under a DIFFERENT budget than the layer's current active
// baseline is a silent-Goodhart risk: a candidate can "win" an A/B purely
// because it ran with a longer --max-agent-timeout, a different recordTimeouts
// policy, or without the resource ceilings the baseline was scored under —
// none of which is a genuine harness-rule improvement. The tuple compared is
// {maxAgentTimeout, timeoutRecording, resourceEnforcement}. Pre-Loop-3
// verdicts (maxAgentTimeout === undefined — the field didn't exist before T6)
// are treated as compatible: there is no budget-identity CLAIM to violate, so
// old verdicts keep activating exactly as before this feature.

/** The budget-identity figures a layer's ACTIVE version was measured under —
 * used as the comparison target for budgetIdentityMatches. Sourced from the
 * active version's score.json sessions' env block (T3/T4's env.maxAgentTimeout
 * / env.resourceEnforcement stamps — the most recent session with an env
 * block wins) plus, for timeoutRecording (which lives on the VERDICT, not the
 * per-session env block), the active version's own ab-verdict.json if it has
 * one. An empty/no-sessions/no-verdict active version yields all-undefined —
 * budgetIdentityMatches then only ever compares against undefined, which a
 * verdict with defined figures will NOT match (a real mismatch, not silently
 * waved through) unless the verdict is itself pre-Loop-3. */
/** Scan `sessions` from the end for the most recent env block carrying
 * maxAgentTimeout/resourceEnforcement (most-recent-with-an-env-block wins) —
 * shared by `readActiveBudget` (a whole candidate version's sessions) and
 * `resolveTrial` (Loop-3 T7: a trial's own just-measured session subset), so
 * both derive the tuple via literally the same scan rather than two
 * hand-rolled copies that could drift. */
function budgetFromSessions(
  sessions: SessionRecord[],
): { maxAgentTimeout?: number; minAgentTimeout?: number; resourceEnforcement?: boolean } {
  let maxAgentTimeout: number | undefined
  let minAgentTimeout: number | undefined
  let resourceEnforcement: boolean | undefined
  for (let i = sessions.length - 1; i >= 0; i--) {
    const env = sessions[i]?.env as
      | { maxAgentTimeout?: number; minAgentTimeout?: number; resourceEnforcement?: boolean }
      | undefined
    if (!env) continue
    // maxAgentTimeout is the sentinel field an env-carrying session always has
    // (record.ts stamps it as `|| 0`); once it's found, this is the winning
    // env block, so read minAgentTimeout (which is OMITTED when no floor — an
    // absent key legitimately means "no floor", not "keep scanning") from the
    // SAME block rather than continuing to hunt for a later floor.
    if (maxAgentTimeout === undefined) {
      maxAgentTimeout = env.maxAgentTimeout
      minAgentTimeout = env.minAgentTimeout
    }
    if (resourceEnforcement === undefined) resourceEnforcement = env.resourceEnforcement
    if (maxAgentTimeout !== undefined && resourceEnforcement !== undefined) break
  }
  return { maxAgentTimeout, minAgentTimeout, resourceEnforcement }
}

export function readActiveBudget(storeRoot: string): {
  maxAgentTimeout?: number
  minAgentTimeout?: number
  timeoutRecording?: boolean
  resourceEnforcement?: boolean
  checksHash?: string
} {
  const version = activeVersion(storeRoot)
  if (!version) return {}
  const score = readScore(storeRoot, version)
  const { maxAgentTimeout, minAgentTimeout, resourceEnforcement } = budgetFromSessions(score.sessions)
  const activeVerdict = readAbVerdict(storeRoot, version)
  const checksHash = checksHashOf(readPlaybook(storeRoot))
  return { maxAgentTimeout, minAgentTimeout, resourceEnforcement, timeoutRecording: activeVerdict?.timeoutRecording, checksHash }
}

/** The budget-identity-bearing subset of fields `budgetIdentityMatches`'s
 * `verdict` param actually reads — deliberately narrower than `AbVerdict` so
 * other budget-stamped shapes (report-loop.ts's `MetaMetricEvent`, Loop-3 T7)
 * can reuse this comparison without satisfying `AbVerdict`'s full shape
 * (winner/candidateRate/... aren't needed here). `AbVerdict` is structurally
 * assignable to this type, so existing callers (engine.ts) are unaffected. */
export interface BudgetStamp {
  maxAgentTimeout?: number
  minAgentTimeout?: number
  timeoutRecording?: boolean
  env?: { resourceEnforcement?: boolean }
  /** sha256 of the rule-routing checks bundle (a3 routing T2). Absent on
   * pre-T2 records — coalesced against `EMPTY_CHECKS_HASH` below, matching
   * the file's `?? 0`/`?? false` back-compat convention. */
  checksHash?: string
}

/**
 * True iff `verdict`'s budget-identity tuple {maxAgentTimeout, timeoutRecording,
 * resourceEnforcement, checksHash} matches `activeBudget`'s — the gate
 * /mh-activate uses (engine.ts) before activating an account-scope candidate.
 * `timeoutRecording` and `resourceEnforcement` are `?? false`-coalesced on
 * both sides (an absent key and an explicit `false` mean the same thing,
 * matching the existing resourceEnforcement-coalescing convention elsewhere
 * in this codebase — see cmd-ab.ts's --resume guard). `checksHash` follows
 * the same convention, coalescing an absent hash (pre-T2 record) to
 * `EMPTY_CHECKS_HASH` (the hash of "no checks") on both sides.
 */
export function budgetIdentityMatches(
  verdict: BudgetStamp,
  activeBudget: { maxAgentTimeout?: number; minAgentTimeout?: number; timeoutRecording?: boolean; resourceEnforcement?: boolean; checksHash?: string },
): boolean {
  if (verdict.maxAgentTimeout === undefined) return true // pre-Loop-3 — no claim to violate
  if (verdict.maxAgentTimeout !== activeBudget.maxAgentTimeout) return false
  // Loosest-envelope floor (--min-agent-timeout): part of the identity tuple.
  // An absent key and an explicit 0 both mean "no floor" (`?? 0`), so a verdict
  // measured before the floor feature existed matches an also-floor-less active
  // baseline — back-compat preserved — while a real floor mismatch rejects.
  if ((verdict.minAgentTimeout ?? 0) !== (activeBudget.minAgentTimeout ?? 0)) return false
  if ((verdict.timeoutRecording ?? false) !== (activeBudget.timeoutRecording ?? false)) return false
  const verdictEnforcement = verdict.env?.resourceEnforcement ?? false
  const activeEnforcement = activeBudget.resourceEnforcement ?? false
  if (verdictEnforcement !== activeEnforcement) return false
  if ((verdict.checksHash ?? EMPTY_CHECKS_HASH) !== (activeBudget.checksHash ?? EMPTY_CHECKS_HASH)) return false
  return true
}

// ── Meta-harness config (proposer pin) ──────────────────────────────────────

/**
 * The proposer/promoter/curator run on a PINNED strong model — a weak proposer
 * makes the self-improvement loop net-negative (STOP, arXiv 2310.02304), and an
 * unpinned proposer inherits whatever model the user happens to be running.
 * Config: <accountMetaRoot()>/config.json (see the "Root resolvers" section
 * above — default ~/.config/kkamak/config.json).
 */
export interface MhConfig {
  proposerModel: string
  proposerVariant: string
  /** Dense LLM judge (Phase 4 Part D) — "" (default) means the judge is DISABLED. */
  judgeModel: string
  judgeVariant: string
  /** Minimum number of shadow decisions before the judge can gate anything. */
  judgeMinSessions: number
  /** Minimum judge/human agreement rate (over the last judgeMinSessions decisions)
   * required before the judge is considered calibrated. */
  judgeMinAgreement: number
  /** Minutes the plugin waits for a proposer/promoter/curator session to write
   * its staging artifact. An agentic proposer that explores the candidate
   * archive (source + trajectories) needs longer than the old digest-only
   * proposer did. */
  proposerTimeoutMin: number
  /** Loop-3 T3: record a wall-clock agent-phase timeout as a genuine stored
   * fail (passed=false, turnCount=0, timedOut=true) instead of silently
   * dropping it. Default OFF (false) so today's behavior — every 0-turn run
   * dropped, timeout or not — is byte-identical until an operator opts in;
   * flipping it is a deliberate cutover that needs a manual re-baseline
   * (proposer/AB sees a new failure mode). See record.ts's recordToStores
   * guard, the single place this flag is consulted for the skip decision. */
  recordTimeouts: boolean
  /** Directory of externally-mined TB2-leaderboard strategy evidence (Phase 8
   * / W4b — see docs/tb2-evidence-mining.md), e.g. "evidence/tb2-leaderboard"
   * at the repo root. A non-absolute value resolves against the repo root
   * (makeBenchPaths().metaRoot, via propose.ts's resolveConfigPath) — never
   * against process.cwd(). "" (default) means the proposer-prompt external-
   * evidence section (propose.ts's buildExternalEvidenceSection, src/
   * evidence.ts) is DISABLED — config-gated, off by default. */
  externalEvidenceDir: string
  /** Which splits.json the LIVE contamination guard reads to decide which
   * externalEvidenceDir tasks are presently held-out. "" (default) resolves
   * to makeBenchPaths().splitsFile; set to e.g. "term-bench2/splits/
   * loop2.json" when a non-default split (Phase 6 loop2) is the active one —
   * a non-absolute value resolves against the repo root (makeBenchPaths().
   * metaRoot, via propose.ts's resolveConfigPath), never process.cwd().
   * Fail-safe (propose.ts's triggerPropose): if the resolved file doesn't
   * exist, the external-evidence section is disabled entirely for that
   * propose cycle — never show unchecked evidence. */
  activeSplitFile: string
}

const DEFAULT_PROPOSER_MODEL = "anthropic/claude-opus-5"
const DEFAULT_PROPOSER_VARIANT = "high"
const DEFAULT_JUDGE_MIN_SESSIONS = 20
const DEFAULT_JUDGE_MIN_AGREEMENT = 0.8
const DEFAULT_PROPOSER_TIMEOUT_MIN = 20

export function readMhConfig(configDir: string = accountMetaRoot()): MhConfig {
  const raw = readJson<Partial<MhConfig>>(path.join(configDir, "config.json"), {})
  const timeoutRaw = raw.proposerTimeoutMin
  const proposerTimeoutMin =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(timeoutRaw, 120)
      : DEFAULT_PROPOSER_TIMEOUT_MIN
  return {
    proposerModel: raw.proposerModel || DEFAULT_PROPOSER_MODEL,
    proposerVariant: raw.proposerVariant || DEFAULT_PROPOSER_VARIANT,
    judgeModel: raw.judgeModel ?? "",
    judgeVariant: raw.judgeVariant ?? "",
    judgeMinSessions: raw.judgeMinSessions ?? DEFAULT_JUDGE_MIN_SESSIONS,
    judgeMinAgreement: raw.judgeMinAgreement ?? DEFAULT_JUDGE_MIN_AGREEMENT,
    proposerTimeoutMin,
    recordTimeouts: raw.recordTimeouts ?? false,
    externalEvidenceDir: raw.externalEvidenceDir ?? "",
    activeSplitFile: raw.activeSplitFile ?? "",
  }
}

/** Split "provider/model" into the {providerID, modelID} shape the session API
 * wants. Returns undefined for a bare (unprefixed) name — the caller then lets
 * opencode resolve the default, rather than sending a malformed spec. */
export function parseModelSpec(model: string): { providerID: string; modelID: string } | undefined {
  const i = model.indexOf("/")
  if (i <= 0 || i === model.length - 1) return undefined
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

/** Stamp candidate provenance (which proposer produced it) for attribution. */
export function writeCandidateMeta(storeRoot: string, version: string, meta: Record<string, unknown>): void {
  writeJson(candidatePath(storeRoot, version, "meta.json"), meta)
}

// ── Judge calibration store (Phase 4 Part D — shadow-calibrated dense judge) ─
//
// Bookkeeping only: the judge shadow-runs alongside human /mh-score and every
// (judge verdict, human verdict) pair is appended here. judgeCalibration()
// looks at the last N decisions to decide whether the judge agrees with humans
// often enough to be trusted for anything beyond shadow logging.

const JUDGE_CALIBRATION_FILE = "judge-calibration.json"

function judgeCalibrationPath(file?: string): string {
  return file ?? path.join(accountMetaRoot(), JUDGE_CALIBRATION_FILE)
}

export interface JudgeDecision {
  ts: string
  sessionID: string
  judge: boolean
  human: boolean
  model: string
}

interface JudgeCalibrationStore {
  schemaVersion: 1
  decisions: JudgeDecision[]
}

/** Append one judge/human decision pair. Read-modify-write of a single JSON
 * object (not JSONL). Best-effort — observability must never break the loop. */
export function appendJudgeDecision(d: JudgeDecision, file?: string): void {
  try {
    const p = judgeCalibrationPath(file)
    const store = readJson<JudgeCalibrationStore>(p, { schemaVersion: 1, decisions: [] })
    store.decisions.push(d)
    writeJson(p, store)
  } catch { /* observability must never break the loop */ }
}

/** Agreement rate over the LAST `minSessions` decisions. `n` = min(total,
 * minSessions); `calibrated` requires both enough decisions (n >= minSessions)
 * AND high enough agreement among them. Empty/missing file -> all zero/false. */
export function judgeCalibration(
  minSessions: number,
  minAgreement: number,
  file?: string,
): { n: number; agreement: number; calibrated: boolean } {
  const store = readJson<JudgeCalibrationStore>(judgeCalibrationPath(file), { schemaVersion: 1, decisions: [] })
  const total = store.decisions.length
  const n = Math.min(total, minSessions)
  if (n === 0) return { n: 0, agreement: 0, calibrated: false }
  const window = store.decisions.slice(-minSessions)
  const agreeing = window.filter((d) => d.judge === d.human).length
  const agreement = agreeing / window.length
  const calibrated = total >= minSessions && agreement >= minAgreement
  return { n, agreement, calibrated }
}

// ── Trajectories + diagnosis (Phase 2) ──────────────────────────────────────

/** Compact per-step event (shared shape with runner.normalize_events). */
export interface TrajEvent {
  t: "tool" | "text" | "error"
  tool?: string
  args?: string
  output?: string
  error?: boolean
  text?: string
}

export function trajPath(storeRoot: string, version: string, sessionID: string): string {
  return candidatePath(storeRoot, version, "traj", `${sessionID}.ndjson`)
}

export function writeTrajectory(storeRoot: string, version: string, sessionID: string, events: TrajEvent[]): void {
  const p = trajPath(storeRoot, version, sessionID)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n"), "utf-8")
}

export function readTrajectory(storeRoot: string, version: string, sessionID: string): TrajEvent[] {
  let raw: string
  try { raw = fs.readFileSync(trajPath(storeRoot, version, sessionID), "utf-8") } catch { return [] }
  const out: TrajEvent[] = []
  for (const ln of raw.split("\n")) {
    const s = ln.trim()
    if (!s) continue
    try { out.push(JSON.parse(s) as TrajEvent) } catch { /* skip bad line */ }
  }
  return out
}

export function pruneTrajectories(storeRoot: string, version: string, keepFailures = 20, keepPasses = 5): number {
  const dir = candidatePath(storeRoot, version, "traj")
  let files: string[]
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")) } catch { return 0 }
  const score = readScore(storeRoot, version)
  const passedById = new Map(score.sessions.map((s) => [s.sessionID, s.passed]))
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
  let keptF = 0, keptP = 0, removed = 0
  for (const f of files) {
    const passed = passedById.get(f.replace(/\.ndjson$/, "")) === true
    const [kept, cap] = passed ? [keptP, keepPasses] : [keptF, keepFailures]
    if (kept < cap) { if (passed) keptP++; else keptF++ }
    else { fs.rmSync(path.join(dir, f), { force: true }); removed++ }
  }
  return removed
}

function fmtTrajEvent(e: TrajEvent): string {
  if (e.t === "tool") return `TOOL ${e.tool ?? "?"}${e.error ? " [ERROR]" : ""}: ${e.args ?? ""}${e.output ? ` → ${e.output}` : ""}`
  if (e.t === "error") return `ERROR: ${e.text ?? ""}`
  return `SAY: ${e.text ?? ""}`
}

/** Merged opts: excerpt-shaping fields (consumed here) + RoleRankOpts fields
 * (forwarded to rankRoleFailures; maxSessions is used ONLY by this function's
 * over-select loop — inert inside rankRoleFailures). */
export interface FailureExcerptOpts extends RoleRankOpts {
  headEvents?: number
  tailEvents?: number
  maxCharsPerSession?: number
}

/**
 * Excerpt the most instructive FAILING sessions' trajectories for the
 * reflective proposer, ranked by importance × taxonomy-diversity across ALL
 * candidate versions (not just the active one's recency tail). Over-selects
 * and skips sessions whose trajectory was pruned (E1). Per session: first
 * `headEvents` (task framing) + last `tailEvents` (where failures live),
 * char-capped. Empty string if none of the ranked failures has a trajectory.
 */
export function buildFailureExcerpts(storeRoot: string, opts: FailureExcerptOpts = {}): string {
  const { maxSessions = 3, headEvents = 5, tailEvents = 30, maxCharsPerSession = 5000 } = opts
  const ranked = rankRoleFailures(storeRoot, opts)
  const blocks: string[] = []
  for (const r of ranked) {
    if (blocks.length >= maxSessions) break
    const events = readTrajectory(storeRoot, r.version, r.sessionID)
    if (!events.length) continue // pruned/missing trajectory — skip (E1)
    let picked: TrajEvent[]
    if (events.length <= headEvents + tailEvents) {
      picked = events
    } else {
      const elided = events.length - headEvents - tailEvents
      picked = [
        ...events.slice(0, headEvents),
        { t: "text", text: `[… ${elided} events elided …]` } as TrajEvent,
        ...events.slice(-tailEvents),
      ]
    }
    const body = picked.map(fmtTrajEvent).join("\n").slice(0, maxCharsPerSession)
    const label = labelForSession(storeRoot, r.version, r.sessionID)
    blocks.push(`### ${r.sessionID} [${r.taxonomy}] — ${label}\n${body}`)
  }
  return blocks.join("\n\n")
}

/** note || summary || "(no label)" for a session, looked up by (version, id). */
function labelForSession(storeRoot: string, version: string, sessionID: string): string {
  const s = readScore(storeRoot, version).sessions.find((x) => x.sessionID === sessionID)
  return (s?.note || s?.summary || "(no label)")
}

export function writeDiagnosis(storeRoot: string, version: string, diagnosis: unknown): void {
  writeJson(candidatePath(storeRoot, version, "diagnosis.json"), diagnosis)
}

export function readDiagnosis<T = unknown>(storeRoot: string, version: string): T | null {
  return readJson<T | null>(candidatePath(storeRoot, version, "diagnosis.json"), null)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readText(p: string): string {
  try { return fs.readFileSync(p, "utf-8").trim() } catch { return "" }
}

function writeText(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, "utf-8")
}

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T } catch { return fallback }
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8")
}

// ── Loop observability (meta-metrics.jsonl) ────────────────────────────────
//
// Mirrors the Python appender (term-bench2/bench_store.py append_meta_metric).
// Sink lives at the nearest ".kkamak" ancestor of storeRoot, so project stores
// land in the repo-local sink and account stores land in
// <accountMetaRoot()>/meta-metrics.jsonl (default ~/.config/kkamak/meta-metrics.jsonl).
// The pre-rename ".meta-harness" basename is still recognised so a store that
// has not been migrated yet keeps writing to its existing sink.

function metricsSinkFor(storeRoot: string): string | null {
  let dir = path.resolve(storeRoot)
  for (let i = 0; i < 6; i++) {
    const base = path.basename(dir)
    if (base === PROJECT_STORE_DIR || base === LEGACY_PROJECT_STORE_DIR) {
      return path.join(dir, "meta-metrics.jsonl")
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Append one loop-observability event (best-effort — never throws). */
export function appendMetaMetric(storeRoot: string, event: Record<string, unknown>): void {
  try {
    const sink = metricsSinkFor(storeRoot)
    if (!sink) return
    fs.mkdirSync(path.dirname(sink), { recursive: true })
    const stamped = { ts: new Date().toISOString(), ...event }
    fs.appendFileSync(sink, JSON.stringify(stamped) + "\n", "utf-8")
  } catch { /* observability must never break the loop */ }
}

/** Last event of any of the given types from this store's meta-metrics sink, or null. */
export function readLastMetric(storeRoot: string, events: string[]): Record<string, unknown> | null {
  try {
    const sink = metricsSinkFor(storeRoot)
    if (!sink || !fs.existsSync(sink)) return null
    const lines = fs.readFileSync(sink, "utf-8").trim().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      const s = line.trim()
      if (!s) continue
      try {
        const e = JSON.parse(s) as Record<string, unknown>
        if (e.event && events.includes(String(e.event))) return e
      } catch { /* skip bad line */ }
    }
    return null
  } catch { return null }
}

// ── Store API ──────────────────────────────────────────────────────────────

export function activeVersion(storeRoot: string): string {
  return readText(activePath(storeRoot, ".version")) || "v0"
}

export function listVersions(storeRoot: string): string[] {
  const dir = path.join(storeRoot, "candidates")
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
  } catch { return [] }
}

export function nextVersion(storeRoot: string): string {
  const versions = listVersions(storeRoot)
  if (versions.length === 0) return "v1"
  const max = Math.max(...versions.map((v) => parseInt(v.slice(1))))
  return `v${max + 1}`
}

export function readActiveSystem(storeRoot: string): string {
  return readText(activePath(storeRoot, "system.md"))
}

export function readActiveTools(storeRoot: string): string {
  return readText(activePath(storeRoot, "tools.md"))
}

/** True iff `<storeRoot>/candidates/<version>` exists as a directory.
 * Mirrors bench_store.py's candidate_exists (term-bench2/bench_store.py:185). */
export function candidateExists(storeRoot: string, version: string): boolean {
  try {
    return fs.statSync(candidatePath(storeRoot, version)).isDirectory()
  } catch {
    return false
  }
}

/** Read a candidate version's system.md (as opposed to the active layer's).
 * Mirrors bench_store.py's read_candidate_system (:189) — used by the bench
 * runner's --pin support (record.ts's assembleAgentsMd). */
export function readCandidateSystem(storeRoot: string, version: string): string {
  return readText(candidatePath(storeRoot, version, "system.md"))
}

/** Read a candidate version's tools.md. Mirrors bench_store.py's
 * read_candidate_tools (:193). */
export function readCandidateTools(storeRoot: string, version: string): string {
  return readText(candidatePath(storeRoot, version, "tools.md"))
}

export function writeActive(
  storeRoot: string,
  version: string,
  system: string,
  tools = "",
  playbook?: Playbook | null,
  agentConfig?: AgentConfig | null,
  envPolicy?: EnvPolicy | null,
): void {
  writeText(activePath(storeRoot, "system.md"), system)
  writeText(activePath(storeRoot, ".version"), version)
  // Removing (not skipping) a stale tools.md is required so reverting/activating
  // a tool-less version doesn't leave the previous version's tools.md behind.
  if (tools) {
    writeText(activePath(storeRoot, "tools.md"), tools)
  } else {
    fs.rmSync(activePath(storeRoot, "tools.md"), { force: true })
  }
  // playbook: undefined = leave alone (legacy/no-playbook flows); object = write;
  // null = remove (revert/activate a version that has no playbook).
  if (playbook !== undefined) {
    if (playbook) writeJson(activePath(storeRoot, "playbook.json"), playbook)
    else fs.rmSync(activePath(storeRoot, "playbook.json"), { force: true })
  }
  // agentConfig: same tri-state contract as playbook above (Phase 4 Part B).
  if (agentConfig !== undefined) {
    if (agentConfig) writeJson(activePath(storeRoot, AGENT_CONFIG_FILE), agentConfig)
    else fs.rmSync(activePath(storeRoot, AGENT_CONFIG_FILE), { force: true })
  }
  // envPolicy: same tri-state contract as playbook/agentConfig above (Phase 4 Part C).
  if (envPolicy !== undefined) {
    if (envPolicy) writeJson(activePath(storeRoot, ENV_POLICY_FILE), envPolicy)
    else fs.rmSync(activePath(storeRoot, ENV_POLICY_FILE), { force: true })
  }
}

export function readScore(storeRoot: string, version: string): CandidateScore {
  return readJson<CandidateScore>(
    candidatePath(storeRoot, version, "score.json"),
    { version, nPass: 0, nFail: 0, sessions: [] },
  )
}

/** A version's failure taxonomy (bench failure-taxonomy). `entries` = per-trajectory
 * classification; `modeCounts` = mode → count; `byTask` = task → its modes. */
export interface Taxonomy {
  version: string
  model: string
  nClassified: number
  modeCounts: Record<string, number>
  entries: { sessionID: string; task: string; mode: string; failurePoint: string; rootCause: string; generalMechanism: string }[]
  byTask: Record<string, string[]>
}

export function writeTaxonomy(storeRoot: string, version: string, t: Taxonomy): void {
  writeJsonAtomic(candidatePath(storeRoot, version, "taxonomy.json"), t)
}

export function readTaxonomy(storeRoot: string, version: string): Taxonomy | null {
  const p = candidatePath(storeRoot, version, "taxonomy.json")
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Taxonomy
  } catch {
    return null
  }
}

export function recordSession(
  storeRoot: string,
  version: string,
  record: SessionRecord,
): CandidateScore {
  writeJson(
    candidatePath(storeRoot, version, "traces", `${record.sessionID}.json`),
    record,
  )
  const score = readScore(storeRoot, version)
  score.sessions.push(record)
  score.nPass = score.sessions.filter((s) => s.passed).length
  score.nFail = score.sessions.filter((s) => !s.passed).length
  writeJson(candidatePath(storeRoot, version, "score.json"), score)
  return score
}

export function createCandidate(
  storeRoot: string,
  version: string,
  system: string,
  tools = "",
  playbook?: Playbook,
  agentConfig?: AgentConfig,
  envPolicy?: EnvPolicy,
): void {
  writeText(candidatePath(storeRoot, version, "system.md"), system)
  if (tools) writeText(candidatePath(storeRoot, version, "tools.md"), tools)
  if (playbook) writeJson(candidatePath(storeRoot, version, "playbook.json"), playbook)
  if (agentConfig) writeJson(candidatePath(storeRoot, version, AGENT_CONFIG_FILE), agentConfig)
  if (envPolicy) writeJson(candidatePath(storeRoot, version, ENV_POLICY_FILE), envPolicy)
  writeJson(candidatePath(storeRoot, version, "score.json"), {
    version, nPass: 0, nFail: 0, sessions: [],
  })
}

// ── Playbook (Phase 3 — ACE anti-bloat) ─────────────────────────────────────
//
// The playbook is the authoritative artifact; system.md is a RENDERED view of it
// (active bullets, "- text" per line). Every existing reader keeps reading plain
// system.md unchanged — that is the whole backward-compat story.

/** A rule-routing executable check attached to a bullet (a3 rule routing).
 * `state` and `liveEligible` are stamped downstream (applyPlaybookOps /
 * check-screen.ts) — never accepted directly from a proposer/curator op. */
export interface BulletCheck {
  cmd: string
  timeoutMs: number
  /** live-consumer state; TB2 trial arms always enforce regardless. */
  state: "shadow" | "blocking"
  /** Screen-stamped (Tier L, check-screen.ts). Never proposer-set. */
  liveEligible?: boolean
}

export interface PlaybookBullet {
  id: string
  text: string
  helpful: number
  harmful: number
  addedBy: string
  status: "active" | "pruned"
  createdAt: string
  updatedAt: string
  generality?: "universal" | "vendor" | "model"
  slice?: string
  check?: BulletCheck
}

export interface Playbook {
  schemaVersion: 1
  nextId: number
  bullets: PlaybookBullet[]
}

export type PlaybookOp =
  | { op: "add"; text: string; generality?: "universal" | "vendor" | "model"; slice?: string; check?: { cmd: string; timeoutMs: number } }
  | { op: "update"; id: string; text: string; generality?: "universal" | "vendor" | "model"; slice?: string; check?: { cmd: string; timeoutMs: number } }
  | { op: "delete"; id: string }

export function readPlaybook(storeRoot: string, version?: string): Playbook | null {
  const p = version
    ? candidatePath(storeRoot, version, "playbook.json")
    : activePath(storeRoot, "playbook.json")
  const pb = readJson<Playbook | null>(p, null)
  if (!pb || !Array.isArray(pb.bullets)) return null
  return pb
}

/** Rendered system.md = active bullets, one "- text" per line (ids/counters hidden). */
export function renderPlaybook(pb: Playbook): string {
  return pb.bullets.filter((b) => b.status === "active").map((b) => `- ${b.text}`).join("\n")
}

/** Injection-time filter: keep a bullet iff its generality tag matches `model`.
 * universal/untagged → always; vendor → providerID === slice; model → full
 * "provider/model" or bare modelID === slice. Unparseable model → only universal. */
export function matchesModel(b: PlaybookBullet, model: string): boolean {
  const g = b.generality
  if (g === undefined || g === "universal") return true
  const spec = parseModelSpec(model)
  if (!spec) return false
  if (g === "vendor") return spec.providerID === b.slice
  if (g === "model") return model === b.slice || spec.modelID === b.slice
  return true
}

/** renderPlaybook restricted to matchesModel bullets. renderPlaybook itself
 * (the full, model-less view for stored system.md + no-op guards) is UNCHANGED. */
export function renderPlaybookRouted(pb: Playbook, model: string): string {
  return pb.bullets
    .filter((b) => b.status === "active" && matchesModel(b, model))
    .map((b) => `- ${b.text}`)
    .join("\n")
}

/** One-time migration of a store's active system.md into a playbook (counters 0).
 * Each non-empty line becomes a bullet; render(migrate(x)) is the normalized x. */
export function migrateSystemToPlaybook(storeRoot: string): Playbook {
  const now = new Date().toISOString()
  const addedBy = activeVersion(storeRoot)
  const lines = readActiveSystem(storeRoot)
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
  const bullets: PlaybookBullet[] = lines.map((text, i) => ({
    id: `b${i + 1}`, text, helpful: 0, harmful: 0, addedBy,
    status: "active", createdAt: now, updatedAt: now,
  }))
  return { schemaVersion: 1, nextId: bullets.length + 1, bullets }
}

/** Apply proposer/curator ops (add | update | delete). Pure — returns a new
 * Playbook. delete sets status:"pruned" (audit-kept), never removes the row. */
export function applyPlaybookOps(base: Playbook, ops: PlaybookOp[]): Playbook {
  const now = new Date().toISOString()
  const bullets = base.bullets.map((b) => ({ ...b }))
  let nextId = base.nextId
  const coerceGen = (x: unknown): "universal" | "vendor" | "model" | undefined =>
    x === undefined ? undefined : (x === "universal" || x === "vendor" || x === "model" ? x : "universal")
  const capSlice = (s: unknown): string | undefined =>
    s === undefined ? undefined : String(s).slice(0, 64)
  for (const op of ops) {
    if (op.op === "add") {
      bullets.push({ id: `b${nextId++}`, text: op.text, helpful: 0, harmful: 0,
        addedBy: "candidate", status: "active", createdAt: now, updatedAt: now,
        generality: coerceGen(op.generality), slice: capSlice(op.slice),
        ...(op.check ? { check: { cmd: op.check.cmd, timeoutMs: op.check.timeoutMs, state: "shadow" as const } } : {}) })
    } else if (op.op === "update") {
      const b = bullets.find((x) => x.id === op.id)
      if (b) {
        b.text = op.text; b.updatedAt = now
        if (op.generality !== undefined) b.generality = coerceGen(op.generality)
        if (op.slice !== undefined) b.slice = capSlice(op.slice)
        if (op.check !== undefined) b.check = { cmd: op.check.cmd, timeoutMs: op.check.timeoutMs, state: "shadow" as const }
      }
    } else if (op.op === "delete") {
      const b = bullets.find((x) => x.id === op.id)
      if (b) { b.status = "pruned"; b.updatedAt = now }
    }
  }
  return { schemaVersion: 1, nextId, bullets }
}

/** Canonical (order-independent, key-order-fixed) JSON serialization of a
 * checks list — the hash input for `checksHashOf`. Sorted by `bulletId` so
 * op-application order never perturbs the hash; each entry serialized with
 * exactly the keys {bulletId, cmd, timeoutMs} in that order (state/
 * liveEligible deliberately excluded — they're live-consumer/screen state,
 * not part of the check's *identity*). */
export function canonicalChecksJson(
  checks: Array<{ bulletId: string; cmd: string; timeoutMs: number }>,
): string {
  const sorted = [...checks].sort((a, b) => (a.bulletId < b.bulletId ? -1 : a.bulletId > b.bulletId ? 1 : 0))
  return "[" + sorted.map((c) => `{"bulletId":${JSON.stringify(c.bulletId)},"cmd":${JSON.stringify(c.cmd)},"timeoutMs":${c.timeoutMs}}`).join(",") + "]"
}

/** A playbook's ACTIVE-status checked bullets, in `canonicalChecksJson`'s
 * input shape — the enforced set a TB2 arm injects (a3 routing T7's
 * cmd-run.ts/cmd-ab.ts wiring) AND the input `checksHashOf` hashes below.
 * Extracted so both call sites share one filter instead of two independent
 * copies drifting apart. `null` (no playbook) yields `[]`. */
export function activeChecks(
  playbook: Playbook | null,
): Array<{ bulletId: string; cmd: string; timeoutMs: number }> {
  return (playbook?.bullets ?? [])
    .filter((b) => b.status === "active" && b.check)
    .map((b) => ({ bulletId: b.id, cmd: b.check!.cmd, timeoutMs: b.check!.timeoutMs }))
}

/** sha256 (full hex) of an already-extracted checks list, canonically
 * serialized (`canonicalChecksJson`). `checksHashOf` below is the
 * single-playbook convenience wrapper (`checksHashOfList(activeChecks(pb))`);
 * this direct form exists for a3 routing T7's cmd-run.ts, which unions
 * checks across MULTIPLE composed layers (one assembled harness, no arm
 * split — spec §3's single-harness degenerate case) and so has no single
 * `Playbook` object to hand `checksHashOf`. */
export function checksHashOfList(checks: Array<{ bulletId: string; cmd: string; timeoutMs: number }>): string {
  return createHash("sha256").update(canonicalChecksJson(checks), "utf-8").digest("hex")
}

/** sha256 (full hex) of the ACTIVE-status bullets' checks, canonically
 * serialized — the budget-identity tuple's rule-routing component
 * (`budgetIdentityMatches`, a3 routing T2). A playbook with zero checks (or
 * `null`, e.g. no playbook at all) hashes to `EMPTY_CHECKS_HASH`. */
export function checksHashOf(playbook: Playbook | null): string {
  return checksHashOfList(activeChecks(playbook))
}

/** Precomputed `checksHashOf(null)` — the hash every legacy/checkless
 * playbook coalesces to (`budgetIdentityMatches`'s `?? EMPTY_CHECKS_HASH`). */
export const EMPTY_CHECKS_HASH = checksHashOf(null)

/** Reflective counter attribution (ACE): ++helpful/++harmful on the ACTIVE
 * playbook's bullets, from the proposer's diagnosis of the active version's runs. */
export function applyBulletAssessments(
  storeRoot: string,
  assessments: { id: string; verdict: "helpful" | "harmful" }[],
): void {
  const pb = readPlaybook(storeRoot)
  if (!pb) return
  const now = new Date().toISOString()
  for (const a of assessments) {
    const b = pb.bullets.find((x) => x.id === a.id)
    if (!b) continue
    if (a.verdict === "helpful") b.helpful++
    else b.harmful++
    b.updatedAt = now
  }
  writeJson(activePath(storeRoot, "playbook.json"), pb)
}

/** Count of active (non-pruned) bullets — used for the curator budget/toast. */
export function activeBulletCount(pb: Playbook | null): number {
  return pb ? pb.bullets.filter((b) => b.status === "active").length : 0
}

/**
 * Seed a store's playbook from its active system.md on first use, NON-destructively:
 * writes active/playbook.json only and leaves active/system.md as-is (so the injected
 * prompt is unchanged until a candidate is activated). Returns null for an empty store
 * (nothing to migrate — the proposer stays in legacy whole-file mode there).
 */
export function seedPlaybook(storeRoot: string): Playbook | null {
  const existing = readPlaybook(storeRoot)
  if (existing) return existing
  if (!readActiveSystem(storeRoot).trim()) return null
  const pb = migrateSystemToPlaybook(storeRoot)
  writeJson(activePath(storeRoot, "playbook.json"), pb)
  return pb
}

// ── AgentConfig (Phase 4 Part B — evolvable bash-timeout knobs) ────────────
//
// Rides the same lifecycle as the playbook (createCandidate → active →
// activateCandidate/trial revert), one file per store: agent-config.json.
// No field-level merging across layers — composeAgentConfig picks the whole
// artifact from the most-specific layer that has one.

export interface AgentConfig {
  schemaVersion: 1
  fastTimeoutMs?: number
  extraFastCommands?: string[]
  extraSlowCommands?: string[]
}

const AGENT_CONFIG_FILE = "agent-config.json"
const FAST_TIMEOUT_MIN_MS = 500
const FAST_TIMEOUT_MAX_MS = 30000
const AGENT_CONFIG_COMMAND_RE = /^[a-z0-9._+-]{1,32}$/
const AGENT_CONFIG_MAX_COMMANDS = 20

function filterCommandList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((c): c is string => typeof c === "string" && AGENT_CONFIG_COMMAND_RE.test(c))
    .slice(0, AGENT_CONFIG_MAX_COMMANDS)
}

/** Validate/normalize a raw agent-config.json payload. null if not an object
 * or schemaVersion !== 1. Clamps fastTimeoutMs, filters command lists to the
 * allowed pattern (capped at 20 entries each), and drops unknown fields. */
export function validateAgentConfig(raw: unknown): AgentConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r["schemaVersion"] !== 1) return null

  const out: AgentConfig = { schemaVersion: 1 }
  if (typeof r["fastTimeoutMs"] === "number" && !Number.isNaN(r["fastTimeoutMs"])) {
    out.fastTimeoutMs = Math.min(FAST_TIMEOUT_MAX_MS, Math.max(FAST_TIMEOUT_MIN_MS, r["fastTimeoutMs"]))
  }
  const extraFastCommands = filterCommandList(r["extraFastCommands"])
  if (extraFastCommands) out.extraFastCommands = extraFastCommands
  const extraSlowCommands = filterCommandList(r["extraSlowCommands"])
  if (extraSlowCommands) out.extraSlowCommands = extraSlowCommands
  return out
}

/** Dual-read like readPlaybook: candidate version if given, else the active
 * layer file. Always validates — corrupt/legacy-shaped JSON reads as null. */
export function readAgentConfig(storeRoot: string, version?: string): AgentConfig | null {
  const p = version
    ? candidatePath(storeRoot, version, AGENT_CONFIG_FILE)
    : activePath(storeRoot, AGENT_CONFIG_FILE)
  return validateAgentConfig(readJson<unknown>(p, null))
}

/** Most-specific layer (last in `layerRoots`) that HAS an active agent-config
 * wins outright — no field-level merging across layers. */
export function composeAgentConfig(layerRoots: string[]): AgentConfig | null {
  let result: AgentConfig | null = null
  for (const root of layerRoots) {
    const cfg = readAgentConfig(root)
    if (cfg) result = cfg
  }
  return result
}

// ── EnvPolicy (Phase 4 Part C — evolvable environment-probe knobs) ─────────
//
// Rides the same lifecycle as agentConfig/playbook, one file per store:
// env-policy.json. No field-level merging across layers — composeEnvPolicy
// picks the whole artifact from the most-specific layer that has one.

export interface EnvPolicy {
  schemaVersion: 1
  /** Which environment probes to run; omitted = enabled (default all true). */
  probes?: { ls?: boolean; lang?: boolean; pkg?: boolean; mem?: boolean }
  /** Absolute, shell-safe path to `ls`; default "/app" is applied by the consumer. */
  lsPath?: string
  /** Clamp [5, 100]; default 25 is applied by the consumer. */
  maxLsEntries?: number
  /** Subset of the fixed language-probe whitelist. */
  languageProbes?: string[]
}

const ENV_POLICY_FILE = "env-policy.json"
const ENV_POLICY_LS_PATH_RE = /^\/[A-Za-z0-9_/.-]{0,120}$/
const ENV_POLICY_MIN_LS_ENTRIES = 5
const ENV_POLICY_MAX_LS_ENTRIES = 100
const ENV_POLICY_LANGUAGE_WHITELIST = new Set([
  "python3", "gcc", "g++", "node", "java", "rustc", "go",
])

/** Validate/normalize a raw env-policy.json payload. null if not an object or
 * schemaVersion !== 1. Drops a shell-unsafe/relative lsPath, clamps
 * maxLsEntries, filters languageProbes to the fixed whitelist, and drops
 * unknown fields. */
export function validateEnvPolicy(raw: unknown): EnvPolicy | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r["schemaVersion"] !== 1) return null

  const out: EnvPolicy = { schemaVersion: 1 }

  const probesRaw = r["probes"]
  if (typeof probesRaw === "object" && probesRaw !== null && !Array.isArray(probesRaw)) {
    const p = probesRaw as Record<string, unknown>
    const probes: EnvPolicy["probes"] = {}
    for (const key of ["ls", "lang", "pkg", "mem"] as const) {
      if (typeof p[key] === "boolean") probes[key] = p[key] as boolean
    }
    if (Object.keys(probes).length > 0) out.probes = probes
  }

  if (typeof r["lsPath"] === "string" && ENV_POLICY_LS_PATH_RE.test(r["lsPath"])) {
    out.lsPath = r["lsPath"]
  }

  if (typeof r["maxLsEntries"] === "number" && !Number.isNaN(r["maxLsEntries"])) {
    out.maxLsEntries = Math.min(
      ENV_POLICY_MAX_LS_ENTRIES,
      Math.max(ENV_POLICY_MIN_LS_ENTRIES, r["maxLsEntries"]),
    )
  }

  if (Array.isArray(r["languageProbes"])) {
    const languageProbes = r["languageProbes"]
      .filter((c): c is string => typeof c === "string" && ENV_POLICY_LANGUAGE_WHITELIST.has(c))
    if (languageProbes.length > 0) out.languageProbes = languageProbes
  }

  return out
}

/** Dual-read like readAgentConfig: candidate version if given, else the active
 * layer file. Always validates — corrupt/legacy-shaped JSON reads as null. */
export function readEnvPolicy(storeRoot: string, version?: string): EnvPolicy | null {
  const p = version
    ? candidatePath(storeRoot, version, ENV_POLICY_FILE)
    : activePath(storeRoot, ENV_POLICY_FILE)
  return validateEnvPolicy(readJson<unknown>(p, null))
}

/** Most-specific layer (last in `layerRoots`) that HAS an active env-policy
 * wins outright — no field-level merging across layers. */
export function composeEnvPolicy(layerRoots: string[]): EnvPolicy | null {
  let result: EnvPolicy | null = null
  for (const root of layerRoots) {
    const policy = readEnvPolicy(root)
    if (policy) result = policy
  }
  return result
}

// ── Trial mode + activation gate ───────────────────────────────────────────

const TRIAL_FILE = ".trial"

export function readTrial(storeRoot: string): TrialState | null {
  const t = readJson<TrialState | null>(activePath(storeRoot, TRIAL_FILE), null)
  if (!t || typeof t.trial !== "string" || typeof t.baseline !== "string") return null
  return t
}

export function clearTrial(storeRoot: string): void {
  fs.rmSync(activePath(storeRoot, TRIAL_FILE), { force: true })
}

/**
 * Put `trialVersion` live provisionally and record a .trial snapshot so it can
 * be reverted later. Scores from /mh-score flow into the trial candidate
 * automatically (recordSession targets the active version, which is now the
 * trial).
 *
 * `opts.rewardMode: "gate-outcomes"` marks this as a §4.3-governed trial:
 * the old rate-comparison resolveTrial stands down on it (first-branch
 * guard below) and only resolveGateTrial may resolve it. A trialId is
 * ALWAYS generated when rewardMode is set (`${trialVersion}-${startedAt}` —
 * the salt trial-verdict.ts's arm assignment hashes, spec §3) — this is a
 * required-when-rewardMode invariant, not an optional caller-supplied value.
 * `opts.golden`/`opts.awaitingGo` layer the queued-golden-window build-time
 * decision (plan Global Constraints) onto the same `.trial` file rather than
 * a second state marker, so it inherits readTrial's existing clobber guard
 * for free. `awaitingGo` means "queued, not started": the snapshot/trial
 * metadata is recorded but active is left untouched — only the (future)
 * human-go path flips it live.
 */
export function startTrial(
  storeRoot: string,
  trialVersion: string,
  system: string,
  tools: string,
  minSessions: number,
  playbook: Playbook | null = null,
  agentConfig: AgentConfig | null = null,
  envPolicy: EnvPolicy | null = null,
  opts?: { rewardMode?: "gate-outcomes"; golden?: boolean; awaitingGo?: boolean },
): void {
  const startedAt = new Date().toISOString()
  const state: TrialState = {
    trial: trialVersion,
    baseline: activeVersion(storeRoot),
    baselineSystem: readActiveSystem(storeRoot),
    baselineTools: readActiveTools(storeRoot),
    baselinePlaybook: readPlaybook(storeRoot),
    baselineAgentConfig: readAgentConfig(storeRoot),
    baselineEnvPolicy: readEnvPolicy(storeRoot),
    startedAt,
    minSessions,
  }
  if (opts?.rewardMode) {
    state.rewardMode = opts.rewardMode
    state.trialId = `${trialVersion}-${startedAt}`
  }
  if (opts?.golden) state.golden = true
  if (opts?.awaitingGo) state.awaitingGo = true
  writeJson(activePath(storeRoot, TRIAL_FILE), state)
  // awaitingGo trials are queued, not started — leave active untouched.
  if (!opts?.awaitingGo) {
    writeActive(storeRoot, trialVersion, system, tools, playbook, agentConfig, envPolicy)
  }
  appendMetaMetric(storeRoot, {
    event: "trial", action: "started", trial: trialVersion, baseline: state.baseline,
    ...(state.rewardMode ? { rewardMode: state.rewardMode, trialId: state.trialId } : {}),
    ...(state.golden ? { golden: true } : {}),
    ...(state.awaitingGo ? { awaitingGo: true } : {}),
  })
}

function sessionModel(s: SessionRecord): string {
  return s.model || "unknown"
}

function rateOf(sessions: SessionRecord[]): number {
  return sessions.length > 0 ? sessions.filter((s) => s.passed).length / sessions.length : 0
}

/** Sessions the judge rated `trivial:true` are excluded from every rate/count
 * computation below (Task 7 / Option A) — they're still recorded on disk, just
 * uninformative about harness quality (greetings, single-file reads…), so they
 * must not move a trial confirm/revert decision in either direction. Sessions
 * with no judge verdict (judge disabled, or verdict null) are unaffected. */
function nonTrivial(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.filter((s) => s.judge?.trivial !== true)
}

/**
 * Resolve an in-progress trial: confirm (keep) if it matches/beats the baseline
 * rate after minSessions, revert (restore baseline text) otherwise. No-op while
 * fewer than minSessions have been scored.
 *
 * Confound control: the comparison is **same-model only** — a model switch must
 * not masquerade as a rule effect (harness gains are model-specific). Trial
 * sessions are filtered to the model set present in the baseline; other-model
 * sessions are still recorded, just excluded from this gate. If the baseline has
 * no sessions there is nothing to match, so the original (unfiltered) behaviour
 * applies.
 */
export function resolveTrial(storeRoot: string): TrialResolution {
  const trial = readTrial(storeRoot)
  if (!trial) return { action: "none" }

  // §4.3 stand-down guard (spec §6, plan Global Constraints): a gate-outcomes
  // trial is owned end-to-end by resolveGateTrial — this function must not
  // touch it. MUST be the very first branch, before any score read: this
  // fires on EVERY /mh-score call (engine.ts:607), far more often than a
  // crank round, so an underspecified guard here would be a silent
  // confirm/revert race that bypasses the entire §4.3 decision rule from a
  // completely different code path.
  if (trial.rewardMode === "gate-outcomes") return { action: "none" }

  // A manual activation / hand-edit changed active out from under the trial.
  if (activeVersion(storeRoot) !== trial.trial) {
    clearTrial(storeRoot)
    return { action: "abandoned", reason: "active version changed under trial" }
  }

  const trialScore = readScore(storeRoot, trial.trial)
  const baselineScore = readScore(storeRoot, trial.baseline)
  const trialSessions = nonTrivial(trialScore.sessions)
  const baselineSessions = nonTrivial(baselineScore.sessions)

  // Loop-3 T7 (producer wiring): the budget-identity tuple these TRIAL
  // sessions were actually measured under — stamped onto every "trial" event
  // emitted below so report-loop.ts's segmentByCurrentBudgetIdentity has a
  // real signal (mirrors cmd-ab.ts's verdictDict stamp for "ab" events).
  // maxAgentTimeout/resourceEnforcement come from the exact same scan
  // readActiveBudget uses (budgetFromSessions) over the session SUBSET that
  // produced trialRate in each branch below; timeoutRecording is the CURRENT
  // MhConfig.recordTimeouts — there's no per-session/per-trial record of that
  // policy flag (it's a runtime switch, not a session-scoped fact), so "what
  // the policy is right now" is the only available source.
  const { recordTimeouts: timeoutRecording } = readMhConfig()
  function budgetStamp(sessions: SessionRecord[]) {
    const { maxAgentTimeout, minAgentTimeout, resourceEnforcement } = budgetFromSessions(sessions)
    return { maxAgentTimeout, minAgentTimeout, timeoutRecording, env: { resourceEnforcement } }
  }

  // No baseline to compare against — nothing to stratify by; keep original path.
  if (baselineSessions.length === 0) {
    if (trialSessions.length < trial.minSessions) {
      return { action: "pending", have: trialSessions.length, need: trial.minSessions }
    }
    clearTrial(storeRoot)
    const trialRate = rateOf(trialSessions)
    appendMetaMetric(storeRoot, {
      event: "trial", action: "confirmed", trial: trial.trial, trialRate, baselineRate: null,
      ...budgetStamp(trialSessions),
    })
    return { action: "confirmed", trial: trial.trial, trialRate, baselineRate: null }
  }

  const baseModels = new Set(baselineSessions.map(sessionModel))
  const trialSame = trialSessions.filter((s) => baseModels.has(sessionModel(s)))
  if (trialSame.length < trial.minSessions) {
    return { action: "pending", have: trialSame.length, need: trial.minSessions }
  }

  const baselineRate = rateOf(baselineSessions)
  const trialRate = rateOf(trialSame)

  if (trialRate >= baselineRate) {
    clearTrial(storeRoot)
    appendMetaMetric(storeRoot, {
      event: "trial", action: "confirmed", trial: trial.trial, trialRate, baselineRate,
      ...budgetStamp(trialSame),
    })
    return { action: "confirmed", trial: trial.trial, trialRate, baselineRate }
  }

  writeActive(storeRoot, trial.baseline, trial.baselineSystem, trial.baselineTools,
    trial.baselinePlaybook ?? null, trial.baselineAgentConfig ?? null, trial.baselineEnvPolicy ?? null)
  clearTrial(storeRoot)
  appendMetaMetric(storeRoot, {
    event: "trial", action: "reverted", trial: trial.trial, trialRate, baselineRate,
    ...budgetStamp(trialSame),
  })
  return { action: "reverted", trial: trial.trial, baseline: trial.baseline, trialRate, baselineRate }
}

/** Verdict handed to `resolveGateTrial` by the (separately-built, km-crank
 * Task 6) §4.3 decision engine — this module only ENACTS it, it never
 * computes it. `"rollback"` covers both the ordinary three-clause-fails case
 * and the `T_MAX` insufficient-events case (spec §5); the ledger `action`
 * distinguishes them by `reason === "insufficient-events"` (see below). */
export type GateTrialVerdict =
  | { verdict: "keep" }
  | { verdict: "rollback"; reason: string }
  | { verdict: "deferred"; reason: string }
  | { verdict: "abandoned"; reason: string }

/**
 * §4.3 gate-outcomes trial enactment authority (spec §6). Reads the live
 * trial and enacts whatever verdict it's handed via the same primitives
 * `resolveTrial` already uses (`writeActive`/`clearTrial`/`appendMetaMetric`)
 * — it never computes the verdict itself (that's trial-verdict.ts, km-crank
 * Task 6). `action: "none"` covers three inert cases: no trial at all, a
 * legacy (non-gate-outcomes) trial (owned by the old `resolveTrial`, not
 * this function), and a queued `awaitingGo` trial (spec/plan: inert
 * everywhere until human-go).
 *
 * Abandon-on-active-changed (spec §5/§6) is checked HERE, unconditionally,
 * before any verdict is enacted — same precedent as `resolveTrial`'s
 * existing abandon branch (`:1336-1339` above), just re-homed to this
 * authority for gate-outcomes trials: `activeVersion(storeRoot) !==
 * trial.trial` means the trial candidate is already superseded, so that
 * early guard is clear-only — nothing to restore, the active version moved
 * on without this function's help.
 *
 * An EXPLICIT `{verdict:"abandoned"}` (exposure-divergence, calibration-
 * stale) is a different case: it is only ever reached when the guard above
 * did NOT fire, i.e. `activeVersion(storeRoot) === trial.trial` — the trial
 * candidate is still the live active version. Leaving it active on abandon
 * would ship an unvalidated candidate permanently. So this branch restores
 * the baseline with the same `writeActive` call `case "rollback"` uses, then
 * clears the trial (spec §5 abandon amendment clause 2, pre-data, TM6
 * review, 54238eb).
 */
export function resolveGateTrial(
  storeRoot: string,
  v: GateTrialVerdict,
): { action: "kept" | "rolled-back" | "deferred" | "abandoned" | "none" } {
  const trial = readTrial(storeRoot)
  if (!trial || trial.rewardMode !== "gate-outcomes" || trial.awaitingGo) {
    return { action: "none" }
  }

  if (activeVersion(storeRoot) !== trial.trial) {
    clearTrial(storeRoot)
    appendMetaMetric(storeRoot, {
      event: "trial", action: "abandoned", trial: trial.trial,
      reason: "active version changed under trial",
    })
    return { action: "abandoned" }
  }

  switch (v.verdict) {
    case "keep": {
      clearTrial(storeRoot)
      appendMetaMetric(storeRoot, { event: "trial", action: "keep", trial: trial.trial, baseline: trial.baseline })
      return { action: "kept" }
    }
    case "rollback": {
      writeActive(storeRoot, trial.baseline, trial.baselineSystem, trial.baselineTools,
        trial.baselinePlaybook ?? null, trial.baselineAgentConfig ?? null, trial.baselineEnvPolicy ?? null)
      clearTrial(storeRoot)
      const ledgerAction = v.reason === "insufficient-events" ? "insufficient-events" : "rollback"
      appendMetaMetric(storeRoot, {
        event: "trial", action: ledgerAction, trial: trial.trial, baseline: trial.baseline, reason: v.reason,
      })
      return { action: "rolled-back" }
    }
    case "deferred": {
      // Floors met, metric null — NO enactment, no state change; just a
      // ledger breadcrumb so SITREP can see the trial is still live.
      appendMetaMetric(storeRoot, { event: "trial", action: "deferred", trial: trial.trial, reason: v.reason })
      return { action: "deferred" }
    }
    case "abandoned": {
      // Reached only when the active-changed guard above did NOT fire — the
      // trial candidate is still active. Restore the baseline (same call as
      // "rollback") so an engine-computed abandon never leaves an
      // unvalidated candidate live.
      writeActive(storeRoot, trial.baseline, trial.baselineSystem, trial.baselineTools,
        trial.baselinePlaybook ?? null, trial.baselineAgentConfig ?? null, trial.baselineEnvPolicy ?? null)
      clearTrial(storeRoot)
      appendMetaMetric(storeRoot, {
        event: "trial", action: "abandoned", trial: trial.trial, baseline: trial.baseline, reason: v.reason,
      })
      return { action: "abandoned" }
    }
  }
}

/** Activate a candidate as the new active version. False if it has no system.md. */
export function activateCandidate(storeRoot: string, version: string): boolean {
  const system = readText(candidatePath(storeRoot, version, "system.md"))
  if (!system) return false
  const tools = readText(candidatePath(storeRoot, version, "tools.md"))
  const playbook = readPlaybook(storeRoot, version)
  const agentConfig = readAgentConfig(storeRoot, version)
  const envPolicy = readEnvPolicy(storeRoot, version)
  writeActive(storeRoot, version, system, tools, playbook, agentConfig, envPolicy)
  appendMetaMetric(storeRoot, { event: "activate", version })
  clearTrial(storeRoot) // manual activation supersedes any in-flight trial
  return true
}

/** Read a candidate's TB2 A/B verdict, or null if absent/corrupt. */
export function readAbVerdict(storeRoot: string, version: string): AbVerdict | null {
  const v = readJson<AbVerdict | null>(candidatePath(storeRoot, version, "ab-verdict.json"), null)
  if (!v || (v.winner !== "candidate" && v.winner !== "active" && v.winner !== "tie")) return null
  return v
}

/** Format the source layer's active-version score + traces as promotion evidence. */
export function buildPromotionEvidence(sourceRoot: string): string {
  const version = activeVersion(sourceRoot)
  const score = readScore(sourceRoot, version)
  const pct = score.sessions.length > 0
    ? (score.nPass / score.sessions.length * 100).toFixed(0) : "0"
  const header = `Proven rules from ${version}: ${score.nPass}/${score.sessions.length} passed (${pct}%)`
  const lines = score.sessions.map((s) => {
    const modelStr = s.variant ? `${s.model || "unknown"}+${s.variant}` : (s.model || "unknown")
    const toolSummary = s.toolUsage ? formatToolUsage(s.toolUsage) : ""
    return [
      `  - ${s.sessionID} | ${s.passed ? "PASS" : "FAIL"} | model=${modelStr} | turns=${s.turnCount}${s.note ? ` | note="${s.note}"` : ""}`,
      toolSummary ? `    tools: ${toolSummary}` : null,
      `    summary: ${s.summary.slice(0, 200)}`,
    ].filter(Boolean).join("\n")
  }).join("\n")
  return `${header}\n\n${lines || "  (no sessions)"}`
}

/**
 * Bootstrap a store. No-op if active/system.md already exists.
 * baseline = "" means start empty (account-global, account-role, project-role).
 * baseline = DEFAULT_SYSTEM_PROMPT for project-global.
 */
export function bootstrapStore(storeRoot: string, baseline: string): void {
  if (readText(activePath(storeRoot, "system.md")) !== "") return
  if (!baseline) {
    // Empty store — no v0 candidate yet; first proposer will create v1.
    fs.mkdirSync(path.join(storeRoot, "active"), { recursive: true })
    fs.mkdirSync(path.join(storeRoot, "candidates"), { recursive: true })
    return
  }
  createCandidate(storeRoot, "v0", baseline)
  writeActive(storeRoot, "v0", baseline)
}

/**
 * One-time migration: if the old flat .meta-harness/{active,candidates} exists
 * at worktree root and project-global hasn't been set up yet, move it there.
 * This preserves any evolved improvements (e.g. the v2 "do more, not less" rule).
 */
/**
 * Project-store rename migration (2026-07-28): `<worktree>/.meta-harness/` →
 * `<worktree>/.kkamak/`, leaving a back-compat symlink at the old path.
 *
 * Automatic for the same reason as migrateAccountRoot(): the project store is
 * NOT git-tracked, so a host that pulls the rename without migrating comes up
 * with an empty store — indistinguishable from "nothing proposed yet". Never
 * throws; a failed migration logs and leaves both trees untouched.
 */
export function migrateProjectRoot(worktree: string): void {
  const oldRoot = path.join(worktree, LEGACY_PROJECT_STORE_DIR)
  const newRoot = path.join(worktree, PROJECT_STORE_DIR)

  let oldStat: fs.Stats | null = null
  try {
    oldStat = fs.lstatSync(oldRoot)
  } catch {
    return // nothing at the old location — first run or already migrated
  }
  if (!oldStat.isDirectory()) return // already a symlink from a prior migration

  if (fs.existsSync(newRoot)) {
    if (isRealStore(oldRoot)) {
      console.error(
        `[kkamak] WARNING: project store stranded at old path:\n` +
        `  Old path (has evolved content): ${oldRoot}\n` +
        `  New path (exists): ${newRoot}\n` +
        `  Remediation: merge the old directory into the new one manually`,
      )
    }
    return
  }

  try {
    fs.renameSync(oldRoot, newRoot)
  } catch (err) {
    console.error(
      `[kkamak] ERROR: project store migration failed (old store stranded):\n` +
      `  Old path: ${oldRoot}\n  New path: ${newRoot}\n` +
      `  Error: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }

  try {
    fs.symlinkSync(PROJECT_STORE_DIR, oldRoot)
  } catch { /* best-effort back-compat link; the move itself already succeeded */ }

  console.error(`[kkamak] migrated project store: ${oldRoot} -> ${newRoot} (symlink left at old path)`)
}

export function migrateFlatToProjectGlobal(worktree: string): void {
  const flat = legacyRoot(worktree)
  const flatActive = path.join(flat, "active", "system.md")
  const target = projectGlobalRoot(worktree)
  const targetActive = path.join(target, "active", "system.md")

  // Only migrate if the old flat layout exists and the new one doesn't
  if (!fs.existsSync(flatActive)) return
  if (fs.existsSync(targetActive)) return

  // Move flat/active → global/active and flat/candidates → global/candidates
  const flatActiveDir = path.join(flat, "active")
  const flatCandidatesDir = path.join(flat, "candidates")
  const targetActiveDir = path.join(target, "active")
  const targetCandidatesDir = path.join(target, "candidates")

  if (fs.existsSync(flatActiveDir)) {
    fs.mkdirSync(path.dirname(targetActiveDir), { recursive: true })
    fs.renameSync(flatActiveDir, targetActiveDir)
  }
  if (fs.existsSync(flatCandidatesDir)) {
    fs.mkdirSync(path.dirname(targetCandidatesDir), { recursive: true })
    fs.renameSync(flatCandidatesDir, targetCandidatesDir)
  }
}

/**
 * One-time migration of the account-layer root off its old opencode-owned
 * location (legacyAccountRoot(): ~/.config/opencode/.meta-harness, XDG-aware
 * exactly like the pre-L5 constant) onto the new platform-neutral one
 * (accountMetaRoot(): KKAMAK_HOME > META_HARNESS_HOME > $XDG_CONFIG_HOME/kkamak >
 * ~/.config/kkamak).
 *
 * Called from BOTH the plugin's init (index.ts) and the bench CLI's process
 * entrypoint (term-bench2/runner.ts) — either can be first to touch the
 * store, so this must be idempotent regardless of call order:
 *
 *   new root exists (real dir or otherwise)  -> no-op. Already migrated, or
 *     a fresh install that never had an old store; either way there's
 *     nothing to move, and touching it again would be destructive.
 *   new missing, old missing                 -> no-op. Nothing to migrate;
 *     the caller's own bootstrapStore/mkdir scaffolding handles first-run.
 *   new missing, old is a real directory     -> fs.renameSync(old, new),
 *     then fs.symlinkSync(new, old) so anything stale still reading the old
 *     path keeps working. Logs one line.
 *   new missing, old is already a symlink    -> no-op (a prior migration
 *     already ran; don't re-migrate a symlink even if its target has since
 *     vanished — that's a foreign/manual state, not this function's job).
 *
 * EDGE — META_HARNESS_HOME set: migration still targets the RESOLVED root.
 * An env override changes WHERE content lands, not WHETHER a real old store
 * gets migrated: migrate old -> resolved-new whenever resolved-new doesn't
 * exist and old is a real directory. This is deliberately the simplest
 * correct rule (task-L5-brief.md) — no special-casing based on which tier of
 * accountMetaRoot()'s precedence produced the resolved path.
 *
 * Concurrent-safe enough for solo use: the rename+symlink pair is wrapped so
 * a lost race (the other entry point already migrated) or a genuine failure
 * both fall back to a silent no-op rather than throwing — migration must
 * never block plugin or bench startup.
 */
export function migrateAccountRoot(): void {
  const newRoot = accountMetaRoot()

  // Legacy roots are tried NEWEST FIRST, so a host that skipped a rename
  // still lands on its most recent store rather than a stale ancestor.
  for (const oldRoot of legacyAccountRoots()) {
    let oldStat: fs.Stats | null = null
    try {
      oldStat = fs.lstatSync(oldRoot)
    } catch {
      continue // nothing at this old location — try the next one
    }
    if (!oldStat.isDirectory()) continue // symlink (prior migration) or non-dir

    // Detect poisoned state: newRoot exists AND old path is a real directory
    // with content. A prior migration failed (rename threw) after
    // mkdir(newRoot.parent) succeeded, permanently poisoning the guard.
    if (fs.existsSync(newRoot)) {
      if (isRealStore(oldRoot)) {
        console.error(
          `[kkamak] WARNING: account store stranded at old path (migration may have failed earlier):\n` +
          `  Old path (has evolved content): ${oldRoot}\n` +
          `  New path (exists): ${newRoot}\n` +
          `  Remediation: move the old directory to the new location manually, or set KKAMAK_HOME and retry`,
        )
      }
      return
    }

    try {
      fs.mkdirSync(path.dirname(newRoot), { recursive: true })
      fs.renameSync(oldRoot, newRoot)
    } catch (err) {
      // Lost a race with a concurrent migration, or genuinely failed (e.g. an
      // EXDEV cross-device rename under an unusual KKAMAK_HOME) — log it loud
      // so the user can discover the stranded store, then never block startup.
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(
        `[kkamak] ERROR: account store migration failed (old store stranded):\n` +
        `  Old path: ${oldRoot}\n` +
        `  New path: ${newRoot}\n` +
        `  Error: ${errorMsg}\n` +
        `  Remediation: move the old directory to the new location manually, or set KKAMAK_HOME and retry`,
      )
      return
    }

    try {
      fs.symlinkSync(newRoot, oldRoot)
    } catch { /* best-effort back-compat link only; the move itself already succeeded */ }

    console.error(`[kkamak] migrated account store: ${oldRoot} -> ${newRoot} (symlink left at old path)`)
    return
  }
}

/**
 * Check if oldRoot is a "real" store with content (not just empty scaffolding).
 * Looks for: (a) non-empty global/active/, (b) any entry under roles/, (c) config.json exists,
 * (d) non-empty legacy top-level active/ (pre-layer store layout).
 */
export function isRealStore(storeRoot: string): boolean {
  // Check (a): global/active has content (new account-store layout)
  try {
    const globalActiveDir = path.join(storeRoot, "global", "active")
    const entries = fs.readdirSync(globalActiveDir)
    if (entries.length > 0) return true
  } catch {
    // global/active doesn't exist or can't be read — check other conditions
  }

  // Check (b): roles/ has any entries (existing check, any layer)
  try {
    const rolesDir = path.join(storeRoot, "roles")
    const entries = fs.readdirSync(rolesDir)
    if (entries.length > 0) return true
  } catch {
    // roles dir doesn't exist or can't be read — check config.json
  }

  // Check (c): config.json exists at storeRoot
  try {
    const configPath = path.join(storeRoot, "config.json")
    if (fs.existsSync(configPath)) return true
  } catch {
    // config.json check failed — not a real store
  }

  // Also check legacy layout: active/ (not global/active) for backward compat with old stores
  try {
    const activeDir = path.join(storeRoot, "active")
    const entries = fs.readdirSync(activeDir)
    if (entries.length > 0) return true
  } catch {
    // active dir doesn't exist or can't be read — not a real store
  }

  return false
}

/**
 * Build the proposer context for one store: all candidates with scores and
 * trace excerpts. Includes the gap-filling "already covered" section from
 * higher-layer active prompts.
 */
/** Format tool-usage map as a compact summary string, e.g. "bash×5(1err) read×3 edit×2" */
export function formatToolUsage(toolUsage: ToolUsage): string {
  return Object.entries(toolUsage)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, { calls, errors }]) =>
      errors > 0 ? `${tool}×${calls}(${errors}err)` : `${tool}×${calls}`,
    )
    .join(" ")
}

export function buildProposerContext(
  storeRoot: string,
  higherRoots: string[],
): string {
  // Build "already covered" section from more-general layers (system + tools)
  const coveredParts: string[] = []
  for (const r of higherRoots) {
    const sys = readActiveSystem(r)
    const tools = readActiveTools(r)
    if (sys) coveredParts.push(`### system.md\n${sys}`)
    if (tools) coveredParts.push(`### tools.md\n${tools}`)
  }

  const coveredSection = coveredParts.length > 0
    ? `## Already covered by more-general layers — DO NOT REPEAT\n\n${coveredParts.join("\n\n")}\n\n---\n\n`
    : ""

  // Build per-candidate sections
  const versions = listVersions(storeRoot)
  const sections: string[] = []

  for (const version of versions) {
    const score = readScore(storeRoot, version)
    const system = readText(candidatePath(storeRoot, version, "system.md"))
    const tools = readText(candidatePath(storeRoot, version, "tools.md"))
    const rate = score.sessions.length > 0
      ? `${score.nPass}/${score.sessions.length} passed (${(score.nPass / score.sessions.length * 100).toFixed(0)}%)`
      : "no sessions yet"

    const traceLines = score.sessions.map((s) => {
      const modelStr = s.variant ? `${s.model || "unknown"}+${s.variant}` : (s.model || "unknown")
      const toolSummary = s.toolUsage ? formatToolUsage(s.toolUsage) : ""
      // Loop-3 T4: a timedOut session (turnCount=0, events:[] — no trajectory
      // was ever captured) must NOT read as an ordinary FAIL. Render the wall
      // it hit distinctly using the elapsed/budget fields T3 stamped onto the
      // record, so the proposer can tell "agent ran out of budget" apart from
      // every other failure mode at a glance. Back-compat: `s.timedOut`
      // absent/false ⇒ this appends nothing, line is unchanged.
      //
      // Denominator (Loop-3 pre-flip fix #1): prefer `s.agentTimeout` — the
      // REAL per-task budget the session ran under (taskTimeouts()'s resolved
      // agentTimeout) — over `env.maxAgentTimeout` (the RUN-LEVEL cap). They
      // diverge whenever a task.toml override sits below the run cap, or the
      // run cap sits above the 900s default; rendering the run-level cap in
      // that case understates the wall a genuine timeout hit. Fall back to
      // env.maxAgentTimeout only when agentTimeout is absent (pre-fix records).
      const budget = s.agentTimeout ?? (s.env as { maxAgentTimeout?: number } | undefined)?.maxAgentTimeout
      const timeoutMarker = s.timedOut
        ? ` | TIMEOUT ${s.elapsed ?? "?"}s / ${budget ?? "?"}s budget`
        : ""
      // W1b: slow-pass visibility — mark passes burning >= 0.5 of their budget
      // as near-timeouts, so the proposer can diagnose what burned time.
      // Uses existing full-`elapsed`/budget convention like TIMEOUT marker.
      const slowPassMarker = s.passed && typeof s.elapsed === "number" && typeof budget === "number" && s.elapsed >= 0.5 * budget
        ? ` | SLOW-PASS ${s.elapsed}s / ${budget}s budget`
        : ""
      return [
        `  - ${s.sessionID} | ${s.passed ? "PASS" : "FAIL"} | model=${modelStr} | turns=${s.turnCount}${timeoutMarker}${slowPassMarker}${s.note ? ` | note="${s.note}"` : ""}`,
        toolSummary ? `    tools: ${toolSummary}` : null,
        `    summary: ${s.summary.slice(0, 200)}`,
      ].filter(Boolean).join("\n")
    }).join("\n")

    const toolsSection = tools ? `\n\n### tools.md\n\`\`\`\n${tools}\n\`\`\`` : ""

    sections.push(
      `## Candidate ${version} — ${rate}\n\n### system.md\n\`\`\`\n${system || "(empty)"}\`\`\`${toolsSection}\n\n### Session traces\n${traceLines || "  (none)"}`,
    )
  }

  // Generic, store-level wire-contract surfacing (spec §1.5: the wire is the
  // consumer-owned contract; the generator must SEE it, not infer it from
  // examples). A layer root MAY contain contract.md — written by a fleet
  // squad def via syncWireContracts (squad-def.ts) — with NO import of fleet
  // code here; this function only reads a plain file if present. A live
  // propose-loop demo found three generations converge on a plausible-but-
  // wrong verdict casing because that requirement appeared nowhere in the
  // evidence shown to the proposer — this closes that gap for any layer.
  const contract = readText(path.join(storeRoot, "contract.md"))
  const contractSection = contract
    ? `\n\n---\n\n## Consumer wire contract (verbatim — outputs MUST satisfy this)\n\n${contract}`
    : ""

  return coveredSection + sections.join("\n\n---\n\n") + contractSection
}

// ── Layer stack builder ────────────────────────────────────────────────────

/**
 * Build the ordered 4-layer stack for a given role.
 * Injection order: account-global → project-global → account-role → project-role.
 * Each layer's higherRoots = all layers before it (for gap-filling context).
 */
export function layersFor(worktree: string, agent: string): StoreLayer[] {
  const ag = accountGlobalRoot()
  const pg = projectGlobalRoot(worktree)
  const ar = accountRoleRoot(agent)
  const pr = projectRoleRoot(worktree, agent)

  return [
    { root: ag, scope: "account-global",  higherRoots: [] },
    { root: pg, scope: "project-global",  higherRoots: [ag] },
    { root: ar, scope: "account-role",    higherRoots: [ag, pg] },
    { root: pr, scope: "project-role",    higherRoots: [ag, pg, ar] },
  ]
}

// ── Default system prompt ──────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `\
You are an AI coding assistant. Before starting any task, orient yourself:
- Read the task requirements carefully
- Check relevant existing files before writing new ones
- Prefer editing existing files over creating new ones
- Run tests or type-checks after making changes to verify correctness
- Do not leave debug code, TODOs, or placeholder comments in the output`

// ── rejected ledger (review-gate rejections; permanent proposer input) ──────

export interface RejectedEntry {
  rejectedAt: string
  scope: string
  version: string
  bullet: string
  violations: string[]
  source: "review-gate"
}

/**
 * A ledger entry rejected ONLY on bullet form ("When …"/"Do not … until …"
 * phrasing). Its IDEA passed every content check, so it is rephrase-eligible:
 * the proposer prompt invites a rephrase (propose.ts ledgerSection) and the
 * review duplicate check must NOT compare candidates against it — otherwise
 * every invited rephrase dies as "duplicate" of its own rejected ancestor.
 */
export function isFormOnlyReject(e: RejectedEntry): boolean {
  return e.violations.length > 0 && e.violations.every((v) => v.startsWith("form:"))
}

export function readRejectedLedger(root: string): RejectedEntry[] {
  const j = readJson<unknown>(path.join(root, "rejected.json"), [])
  return Array.isArray(j) ? (j as RejectedEntry[]) : []
}

export function appendRejectedLedger(root: string, e: RejectedEntry): void {
  const p = path.join(root, "rejected.json")
  const cur = readRejectedLedger(root)
  cur.push(e)
  writeJsonAtomic(p, cur) // pretty (2-space) + trailing newline — same format as the writeFileSync it replaces
}
