/**
 * harness-store.ts
 *
 * Multi-layer filesystem store for the meta-harness evolution system.
 *
 * Four stores form a 2×2 lattice (scope × location):
 *
 *   account-global  ~/.config/opencode/.meta-harness/global/
 *   account-role    ~/.config/opencode/.meta-harness/roles/<agent>/
 *   project-global  <project>/.meta-harness/global/
 *   project-role    <project>/.meta-harness/roles/<agent>/
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

// ── Root resolvers ─────────────────────────────────────────────────────────

const OPENCODE_CONFIG_DIR =
  process.env["XDG_CONFIG_HOME"]
    ? path.join(process.env["XDG_CONFIG_HOME"], "opencode")
    : path.join(os.homedir(), ".config", "opencode")

const ACCOUNT_MH_DIR = path.join(OPENCODE_CONFIG_DIR, ".meta-harness")

export function accountGlobalRoot(): string {
  return path.join(ACCOUNT_MH_DIR, "global")
}

export function accountRoleRoot(agent: string): string {
  return path.join(ACCOUNT_MH_DIR, "roles", agent)
}

export function projectGlobalRoot(worktree: string): string {
  return path.join(worktree, ".meta-harness", "global")
}

export function projectRoleRoot(worktree: string, agent: string): string {
  return path.join(worktree, ".meta-harness", "roles", agent)
}

/** Legacy flat store used before the 4-layer refactor. */
function legacyRoot(worktree: string): string {
  return path.join(worktree, ".meta-harness")
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
}

export type TrialResolution =
  | { action: "none" }
  | { action: "pending"; have: number; need: number }
  | { action: "abandoned"; reason: string }
  | { action: "confirmed"; trial: string; trialRate: number; baselineRate: number | null }
  | { action: "reverted"; trial: string; baseline: string; trialRate: number; baselineRate: number }

/** Verdict written by the Python `ab` runner into candidates/<vN>/ab-verdict.json. */
export interface AbVerdict {
  winner: "candidate" | "active" | "tie"
  candidateRate: number
  activeRate: number
  nTasks: number
  timestamp: string
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

export function writeActive(
  storeRoot: string,
  version: string,
  system: string,
  tools = "",
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
}

export function readScore(storeRoot: string, version: string): CandidateScore {
  return readJson<CandidateScore>(
    candidatePath(storeRoot, version, "score.json"),
    { version, nPass: 0, nFail: 0, sessions: [] },
  )
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
): void {
  writeText(candidatePath(storeRoot, version, "system.md"), system)
  if (tools) writeText(candidatePath(storeRoot, version, "tools.md"), tools)
  writeJson(candidatePath(storeRoot, version, "score.json"), {
    version, nPass: 0, nFail: 0, sessions: [],
  })
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
 */
export function startTrial(
  storeRoot: string,
  trialVersion: string,
  system: string,
  tools: string,
  minSessions: number,
): void {
  const state: TrialState = {
    trial: trialVersion,
    baseline: activeVersion(storeRoot),
    baselineSystem: readActiveSystem(storeRoot),
    baselineTools: readActiveTools(storeRoot),
    startedAt: new Date().toISOString(),
    minSessions,
  }
  writeJson(activePath(storeRoot, TRIAL_FILE), state)
  writeActive(storeRoot, trialVersion, system, tools)
}

function passRate(score: CandidateScore): number {
  return score.sessions.length > 0 ? score.nPass / score.sessions.length : 0
}

/**
 * Resolve an in-progress trial: confirm (keep) if it matches/beats the baseline
 * rate after minSessions, revert (restore baseline text) otherwise. No-op while
 * fewer than minSessions have been scored.
 */
export function resolveTrial(storeRoot: string): TrialResolution {
  const trial = readTrial(storeRoot)
  if (!trial) return { action: "none" }

  // A manual activation / hand-edit changed active out from under the trial.
  if (activeVersion(storeRoot) !== trial.trial) {
    clearTrial(storeRoot)
    return { action: "abandoned", reason: "active version changed under trial" }
  }

  const trialScore = readScore(storeRoot, trial.trial)
  if (trialScore.sessions.length < trial.minSessions) {
    return { action: "pending", have: trialScore.sessions.length, need: trial.minSessions }
  }

  const baselineScore = readScore(storeRoot, trial.baseline)
  const baselineRate = baselineScore.sessions.length > 0 ? passRate(baselineScore) : null
  const trialRate = passRate(trialScore)

  if (baselineRate === null || trialRate >= baselineRate) {
    clearTrial(storeRoot)
    return { action: "confirmed", trial: trial.trial, trialRate, baselineRate }
  }

  writeActive(storeRoot, trial.baseline, trial.baselineSystem, trial.baselineTools)
  clearTrial(storeRoot)
  return { action: "reverted", trial: trial.trial, baseline: trial.baseline, trialRate, baselineRate }
}

/** Activate a candidate as the new active version. False if it has no system.md. */
export function activateCandidate(storeRoot: string, version: string): boolean {
  const system = readText(candidatePath(storeRoot, version, "system.md"))
  if (!system) return false
  const tools = readText(candidatePath(storeRoot, version, "tools.md"))
  writeActive(storeRoot, version, system, tools)
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
      return [
        `  - ${s.sessionID} | ${s.passed ? "PASS" : "FAIL"} | model=${modelStr} | turns=${s.turnCount}${s.note ? ` | note="${s.note}"` : ""}`,
        toolSummary ? `    tools: ${toolSummary}` : null,
        `    summary: ${s.summary.slice(0, 200)}`,
      ].filter(Boolean).join("\n")
    }).join("\n")

    const toolsSection = tools ? `\n\n### tools.md\n\`\`\`\n${tools}\n\`\`\`` : ""

    sections.push(
      `## Candidate ${version} — ${rate}\n\n### system.md\n\`\`\`\n${system || "(empty)"}\`\`\`${toolsSection}\n\n### Session traces\n${traceLines || "  (none)"}`,
    )
  }

  return coveredSection + sections.join("\n\n---\n\n")
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
