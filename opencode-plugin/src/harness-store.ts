/**
 * harness-store.ts
 *
 * Filesystem layout for the meta-harness evolution store.
 *
 * <project>/
 *   .meta-harness/
 *     active/
 *       system.md          ← current best system prompt (injected every turn)
 *       .version           ← "v0", "v1", …
 *     candidates/
 *       v0/
 *         system.md        ← snapshot of system.md at time of creation
 *         score.json       ← { version, nPass, nFail, sessions: SessionRecord[] }
 *         traces/
 *           <sessionID>.json  ← { sessionID, passed, note, turnCount, timestamp, summary }
 *       v1/ …
 */

import * as fs from "fs"
import * as path from "path"

// ── Paths ──────────────────────────────────────────────────────────────────

export const STORE_DIR = ".meta-harness"
export const ACTIVE_DIR = `${STORE_DIR}/active`
export const CANDIDATES_DIR = `${STORE_DIR}/candidates`

export function activePath(worktree: string, file: string): string {
  return path.join(worktree, ACTIVE_DIR, file)
}

export function candidatePath(worktree: string, version: string, ...parts: string[]): string {
  return path.join(worktree, CANDIDATES_DIR, version, ...parts)
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionRecord {
  sessionID: string
  /** true = human rated good, false = human rated bad */
  passed: boolean
  /** optional free-text note from the human rater */
  note: string
  turnCount: number
  timestamp: string
  /** first ~500 chars of last assistant message, for proposer diagnosis */
  summary: string
}

export interface CandidateScore {
  version: string
  nPass: number
  nFail: number
  sessions: SessionRecord[]
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

/** Return current active version tag, e.g. "v0". */
export function activeVersion(worktree: string): string {
  return readText(activePath(worktree, ".version")) || "v0"
}

/** Return list of candidate version tags sorted ascending. */
export function listVersions(worktree: string): string[] {
  const dir = path.join(worktree, CANDIDATES_DIR)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
  } catch { return [] }
}

/** Next version tag after the highest existing one. */
export function nextVersion(worktree: string): string {
  const versions = listVersions(worktree)
  if (versions.length === 0) return "v1"
  const max = Math.max(...versions.map((v) => parseInt(v.slice(1))))
  return `v${max + 1}`
}

/** Read the active system prompt (empty string if not yet bootstrapped). */
export function readActiveSystem(worktree: string): string {
  return readText(activePath(worktree, "system.md"))
}

/** Write system.md to the active directory and mark the version. */
export function writeActive(worktree: string, version: string, system: string): void {
  writeText(activePath(worktree, "system.md"), system)
  writeText(activePath(worktree, ".version"), version)
}

/** Read score.json for a candidate. */
export function readScore(worktree: string, version: string): CandidateScore {
  return readJson<CandidateScore>(
    candidatePath(worktree, version, "score.json"),
    { version, nPass: 0, nFail: 0, sessions: [] },
  )
}

/** Append a session record to the candidate's score.json and traces/. */
export function recordSession(
  worktree: string,
  version: string,
  record: SessionRecord,
): CandidateScore {
  // Write individual trace file
  writeJson(
    candidatePath(worktree, version, "traces", `${record.sessionID}.json`),
    record,
  )

  // Update aggregated score
  const score = readScore(worktree, version)
  score.sessions.push(record)
  score.nPass = score.sessions.filter((s) => s.passed).length
  score.nFail = score.sessions.filter((s) => !s.passed).length
  writeJson(candidatePath(worktree, version, "score.json"), score)

  return score
}

/** Create a new candidate version directory with a system.md. */
export function createCandidate(
  worktree: string,
  version: string,
  system: string,
): void {
  writeText(candidatePath(worktree, version, "system.md"), system)
  writeJson(candidatePath(worktree, version, "score.json"), {
    version, nPass: 0, nFail: 0, sessions: [],
  })
}

/**
 * Bootstrap the store from the project's AGENTS.md (or a default prompt).
 * No-op if active/system.md already exists.
 */
export function bootstrapIfNeeded(worktree: string): void {
  if (readText(activePath(worktree, "system.md"))) return

  // Always use the default behavioral system prompt as v0 baseline.
  // AGENTS.md is project documentation, not a behavioral system prompt.
  const system = DEFAULT_SYSTEM_PROMPT

  createCandidate(worktree, "v0", system)
  writeActive(worktree, "v0", system)
}

/**
 * Build the full proposer context: all candidates with scores + trace
 * excerpts. Designed to be read by the proposer agent.
 */
export function buildProposerContext(worktree: string): string {
  const versions = listVersions(worktree)
  const sections: string[] = []

  for (const version of versions) {
    const score = readScore(worktree, version)
    const system = readText(candidatePath(worktree, version, "system.md"))
    const rate = score.sessions.length > 0
      ? `${score.nPass}/${score.sessions.length} passed (${(score.nPass / score.sessions.length * 100).toFixed(0)}%)`
      : "no sessions yet"

    const traceLines = score.sessions.map((s) =>
      `  - ${s.sessionID} | ${s.passed ? "PASS" : "FAIL"} | turns=${s.turnCount}${s.note ? ` | note="${s.note}"` : ""}\n    summary: ${s.summary.slice(0, 200)}`,
    ).join("\n")

    sections.push(
      `## Candidate ${version} — ${rate}\n\n### system.md\n\`\`\`\n${system}\n\`\`\`\n\n### Session traces\n${traceLines || "  (none)"}`,
    )
  }

  return sections.join("\n\n---\n\n")
}

// ── Default system prompt (used when no AGENTS.md exists) ─────────────────

const DEFAULT_SYSTEM_PROMPT = `\
You are an AI coding assistant. Before starting any task, orient yourself:
- Read the task requirements carefully
- Check relevant existing files before writing new ones
- Prefer editing existing files over creating new ones
- Run tests or type-checks after making changes to verify correctness
- Do not leave debug code, TODOs, or placeholder comments in the output`
