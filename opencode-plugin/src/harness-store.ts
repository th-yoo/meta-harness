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
 *       system.md     ← current best prompt for this layer
 *       .version      ← "v0", "v1", …
 *     candidates/
 *       v0/
 *         system.md
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

export interface SessionRecord {
  sessionID: string
  passed: boolean
  note: string
  turnCount: number
  timestamp: string
  summary: string
  model: string
  variant: string
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

export function writeActive(storeRoot: string, version: string, system: string): void {
  writeText(activePath(storeRoot, "system.md"), system)
  writeText(activePath(storeRoot, ".version"), version)
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

export function createCandidate(storeRoot: string, version: string, system: string): void {
  writeText(candidatePath(storeRoot, version, "system.md"), system)
  writeJson(candidatePath(storeRoot, version, "score.json"), {
    version, nPass: 0, nFail: 0, sessions: [],
  })
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
export function buildProposerContext(
  storeRoot: string,
  higherRoots: string[],
): string {
  // Build "already covered" section from more-general layers
  const covered = higherRoots
    .map((r) => readActiveSystem(r))
    .filter(Boolean)
    .join("\n\n")

  const coveredSection = covered
    ? `## Already covered by more-general layers — DO NOT REPEAT\n\n${covered}\n\n---\n\n`
    : ""

  // Build per-candidate sections
  const versions = listVersions(storeRoot)
  const sections: string[] = []

  for (const version of versions) {
    const score = readScore(storeRoot, version)
    const system = readText(candidatePath(storeRoot, version, "system.md"))
    const rate = score.sessions.length > 0
      ? `${score.nPass}/${score.sessions.length} passed (${(score.nPass / score.sessions.length * 100).toFixed(0)}%)`
      : "no sessions yet"

    const traceLines = score.sessions.map((s) => {
      const modelStr = s.variant ? `${s.model || "unknown"}+${s.variant}` : (s.model || "unknown")
      return `  - ${s.sessionID} | ${s.passed ? "PASS" : "FAIL"} | model=${modelStr} | turns=${s.turnCount}${s.note ? ` | note="${s.note}"` : ""}\n    summary: ${s.summary.slice(0, 200)}`
    }).join("\n")

    sections.push(
      `## Candidate ${version} — ${rate}\n\n### system.md\n\`\`\`\n${system || "(empty)"}\n\`\`\`\n\n### Session traces\n${traceLines || "  (none)"}`,
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
