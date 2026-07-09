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
  /** Confound-control provenance (harness hash, plugin sha, provider…); optional. */
  env?: Record<string, unknown>
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
}

/** Accept a candidate iff the v2 decision says "accept"; fall back to the v1
 * winner field for pre-v2 verdicts. This is the single gate /mh-activate uses. */
export function abAccepted(v: AbVerdict): boolean {
  return v.decision !== undefined ? v.decision === "accept" : v.winner === "candidate"
}

// ── Meta-harness config (proposer pin) ──────────────────────────────────────

/**
 * The proposer/promoter/curator run on a PINNED strong model — a weak proposer
 * makes the self-improvement loop net-negative (STOP, arXiv 2310.02304), and an
 * unpinned proposer inherits whatever model the user happens to be running.
 * Config: ~/.config/opencode/.meta-harness/config.json.
 */
export interface MhConfig {
  proposerModel: string
  proposerVariant: string
}

const DEFAULT_PROPOSER_MODEL = "anthropic/claude-opus-4-8"
const DEFAULT_PROPOSER_VARIANT = "high"

export function readMhConfig(): MhConfig {
  const raw = readJson<Partial<MhConfig>>(path.join(ACCOUNT_MH_DIR, "config.json"), {})
  return {
    proposerModel: raw.proposerModel || DEFAULT_PROPOSER_MODEL,
    proposerVariant: raw.proposerVariant || DEFAULT_PROPOSER_VARIANT,
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

export interface FailureExcerptOpts {
  maxSessions?: number
  headEvents?: number
  tailEvents?: number
  maxCharsPerSession?: number
}

/**
 * Excerpt the most recent FAILING sessions' trajectories for the reflective
 * proposer — first `headEvents` (task framing) + last `tailEvents` (where failures
 * live), per-session char-capped. Empty string if none have a trajectory.
 */
export function buildFailureExcerpts(storeRoot: string, version: string, opts: FailureExcerptOpts = {}): string {
  const { maxSessions = 3, headEvents = 5, tailEvents = 30, maxCharsPerSession = 5000 } = opts
  const score = readScore(storeRoot, version)
  const failed = score.sessions.filter((s) => !s.passed).slice(-maxSessions).reverse()
  const blocks: string[] = []
  for (const s of failed) {
    const events = readTrajectory(storeRoot, version, s.sessionID)
    if (!events.length) continue
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
    blocks.push(`### ${s.sessionID} — ${s.note || s.summary || "(no label)"}\n${body}`)
  }
  return blocks.join("\n\n")
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
// Sink lives at the nearest ".meta-harness" ancestor of storeRoot, so project
// stores land in the repo-local (git-tracked) sink and account stores land in
// ~/.config/opencode/.meta-harness/meta-metrics.jsonl.

function metricsSinkFor(storeRoot: string): string | null {
  let dir = path.resolve(storeRoot)
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === ".meta-harness") return path.join(dir, "meta-metrics.jsonl")
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

export function writeActive(
  storeRoot: string,
  version: string,
  system: string,
  tools = "",
  playbook?: Playbook | null,
  agentConfig?: AgentConfig | null,
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
  playbook?: Playbook,
  agentConfig?: AgentConfig,
): void {
  writeText(candidatePath(storeRoot, version, "system.md"), system)
  if (tools) writeText(candidatePath(storeRoot, version, "tools.md"), tools)
  if (playbook) writeJson(candidatePath(storeRoot, version, "playbook.json"), playbook)
  if (agentConfig) writeJson(candidatePath(storeRoot, version, AGENT_CONFIG_FILE), agentConfig)
  writeJson(candidatePath(storeRoot, version, "score.json"), {
    version, nPass: 0, nFail: 0, sessions: [],
  })
}

// ── Playbook (Phase 3 — ACE anti-bloat) ─────────────────────────────────────
//
// The playbook is the authoritative artifact; system.md is a RENDERED view of it
// (active bullets, "- text" per line). Every existing reader keeps reading plain
// system.md unchanged — that is the whole backward-compat story.

export interface PlaybookBullet {
  id: string
  text: string
  helpful: number
  harmful: number
  addedBy: string
  status: "active" | "pruned"
  createdAt: string
  updatedAt: string
}

export interface Playbook {
  schemaVersion: 1
  nextId: number
  bullets: PlaybookBullet[]
}

export type PlaybookOp =
  | { op: "add"; text: string }
  | { op: "update"; id: string; text: string }
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
  for (const op of ops) {
    if (op.op === "add") {
      bullets.push({ id: `b${nextId++}`, text: op.text, helpful: 0, harmful: 0,
        addedBy: "candidate", status: "active", createdAt: now, updatedAt: now })
    } else if (op.op === "update") {
      const b = bullets.find((x) => x.id === op.id)
      if (b) { b.text = op.text; b.updatedAt = now }
    } else if (op.op === "delete") {
      const b = bullets.find((x) => x.id === op.id)
      if (b) { b.status = "pruned"; b.updatedAt = now }
    }
  }
  return { schemaVersion: 1, nextId, bullets }
}

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
  playbook: Playbook | null = null,
  agentConfig: AgentConfig | null = null,
): void {
  const state: TrialState = {
    trial: trialVersion,
    baseline: activeVersion(storeRoot),
    baselineSystem: readActiveSystem(storeRoot),
    baselineTools: readActiveTools(storeRoot),
    baselinePlaybook: readPlaybook(storeRoot),
    baselineAgentConfig: readAgentConfig(storeRoot),
    startedAt: new Date().toISOString(),
    minSessions,
  }
  writeJson(activePath(storeRoot, TRIAL_FILE), state)
  writeActive(storeRoot, trialVersion, system, tools, playbook, agentConfig)
  appendMetaMetric(storeRoot, { event: "trial", action: "started", trial: trialVersion, baseline: state.baseline })
}

function passRate(score: CandidateScore): number {
  return score.sessions.length > 0 ? score.nPass / score.sessions.length : 0
}

function sessionModel(s: SessionRecord): string {
  return s.model || "unknown"
}

function rateOf(sessions: SessionRecord[]): number {
  return sessions.length > 0 ? sessions.filter((s) => s.passed).length / sessions.length : 0
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

  // A manual activation / hand-edit changed active out from under the trial.
  if (activeVersion(storeRoot) !== trial.trial) {
    clearTrial(storeRoot)
    return { action: "abandoned", reason: "active version changed under trial" }
  }

  const trialScore = readScore(storeRoot, trial.trial)
  const baselineScore = readScore(storeRoot, trial.baseline)

  // No baseline to compare against — nothing to stratify by; keep original path.
  if (baselineScore.sessions.length === 0) {
    if (trialScore.sessions.length < trial.minSessions) {
      return { action: "pending", have: trialScore.sessions.length, need: trial.minSessions }
    }
    clearTrial(storeRoot)
    const trialRate = passRate(trialScore)
    appendMetaMetric(storeRoot, { event: "trial", action: "confirmed", trial: trial.trial, trialRate, baselineRate: null })
    return { action: "confirmed", trial: trial.trial, trialRate, baselineRate: null }
  }

  const baseModels = new Set(baselineScore.sessions.map(sessionModel))
  const trialSame = trialScore.sessions.filter((s) => baseModels.has(sessionModel(s)))
  if (trialSame.length < trial.minSessions) {
    return { action: "pending", have: trialSame.length, need: trial.minSessions }
  }

  const baselineRate = passRate(baselineScore)
  const trialRate = rateOf(trialSame)

  if (trialRate >= baselineRate) {
    clearTrial(storeRoot)
    appendMetaMetric(storeRoot, { event: "trial", action: "confirmed", trial: trial.trial, trialRate, baselineRate })
    return { action: "confirmed", trial: trial.trial, trialRate, baselineRate }
  }

  writeActive(storeRoot, trial.baseline, trial.baselineSystem, trial.baselineTools,
    trial.baselinePlaybook ?? null, trial.baselineAgentConfig ?? null)
  clearTrial(storeRoot)
  appendMetaMetric(storeRoot, { event: "trial", action: "reverted", trial: trial.trial, trialRate, baselineRate })
  return { action: "reverted", trial: trial.trial, baseline: trial.baseline, trialRate, baselineRate }
}

/** Activate a candidate as the new active version. False if it has no system.md. */
export function activateCandidate(storeRoot: string, version: string): boolean {
  const system = readText(candidatePath(storeRoot, version, "system.md"))
  if (!system) return false
  const tools = readText(candidatePath(storeRoot, version, "tools.md"))
  const playbook = readPlaybook(storeRoot, version)
  const agentConfig = readAgentConfig(storeRoot, version)
  writeActive(storeRoot, version, system, tools, playbook, agentConfig)
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
