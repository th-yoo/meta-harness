/**
 * record.ts — harness assembly + candidate-store recording for the token-
 * spending subcommands (run/ab).
 *
 * Mirrors term-bench2/runner.py's "harness assembly" section (layer_store_roots
 * :590, parse_pins :613, assemble_agents_md :646) and its "store recording" +
 * "run provenance" sections (:1267-1400: _opencode_version, _plugin_sha,
 * harness_hash, env_block, _session_record, record_to_stores, _harness_meta).
 */
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { runHost } from "./exec.ts"
import type { ExecResult } from "./exec.ts"
import { die, log } from "./util.ts"
import {
  accountGlobalRoot,
  accountRoleRoot,
  projectGlobalRoot,
  projectRoleRoot,
  activeVersion,
  candidateExists,
  listVersions,
  recordSession,
  writeTrajectory,
  pruneTrajectories,
  type ToolUsage,
  type TrajEvent,
  type SessionRecord,
} from "../harness-store.ts"
import { composeHarness, renderAgentsMd, type LayerRef } from "../compose.ts"

// ── harness assembly ───────────────────────────────────────────────────────

export type LayerName = "account-global" | "project-global" | "account-role" | "project-role"

/** Verbatim port of runner.py:577's LAYER_CHOICES. */
export const LAYER_CHOICES: LayerName[] = ["account-global", "project-global", "account-role", "project-role"]

// (system heading, tools heading) per layer; {agent} filled for role layers.
// Verbatim port of runner.py:582's _LAYER_LABELS — the two global layers keep
// their historical headings so default output is byte-identical to the
// pre-role version.
export const LAYER_LABELS: Record<LayerName, [string, string]> = {
  "account-global": ["General coding guidance", "General coding tool usage"],
  "project-global": ["Project guidance", "Project tool usage"],
  "account-role": ["Role guidance ({agent})", "Role tool usage ({agent})"],
  "project-role": ["Project role guidance ({agent})", "Project role tool usage ({agent})"],
}

/**
 * Ordered [(layerName, storeRoot)] in Option Y order: account-global ->
 * project-global -> account-role -> project-role. `layers` gates the
 * account/project side; a non-empty `agent` adds role rows. Verbatim port
 * of runner.py:590's layer_store_roots.
 */
export function layerStoreRoots(layers: string, agent: string, metaRoot: string): [LayerName, string][] {
  const incAccount = layers === "global" || layers === "account"
  const incProject = layers === "global" || layers === "project"
  const roots: [LayerName, string][] = []
  if (incAccount) roots.push(["account-global", accountGlobalRoot()])
  if (incProject) roots.push(["project-global", projectGlobalRoot(metaRoot)])
  if (agent) {
    if (incAccount) roots.push(["account-role", accountRoleRoot(agent)])
    if (incProject) roots.push(["project-role", projectRoleRoot(metaRoot, agent)])
  }
  return roots
}

/**
 * Parse repeated --pin LAYER=vN into {layerName: version}. die() on any
 * error — verbatim port of runner.py:613's parse_pins validations.
 */
export function parsePins(
  pinArgs: string[],
  layers: string,
  agent: string,
  metaRoot: string,
): Record<string, string> {
  if (!pinArgs || pinArgs.length === 0) return {}
  if (layers === "none") die("--pin cannot be combined with --layers none")
  const valid = new Map(layerStoreRoots(layers, agent, metaRoot))
  const pins: Record<string, string> = {}
  for (const spec of pinArgs) {
    const eq = spec.indexOf("=")
    if (eq === -1) die(`--pin must be LAYER=vN, got '${spec}'`)
    const name = spec.slice(0, eq).trim()
    const ver = spec.slice(eq + 1).trim()
    if (!(LAYER_CHOICES as string[]).includes(name)) {
      die(`--pin: unknown layer '${name}' (choices: ${LAYER_CHOICES.join(", ")})`)
    }
    if (!/^v\d+$/.test(ver)) die(`--pin ${name}: version must look like vN, got '${ver}'`)
    if (name in pins) die(`--pin: layer '${name}' pinned twice`)
    if ((name === "account-role" || name === "project-role") && !agent) {
      die(`--pin ${name} requires --agent`)
    }
    if (!valid.has(name as LayerName)) {
      die(`--pin ${name}: layer not included by --layers ${layers}` + (agent ? "" : " (role layers need --agent)"))
    }
    const root = valid.get(name as LayerName)!
    if (!candidateExists(root, ver)) {
      const have = listVersions(root).join(", ") || "none"
      die(`--pin ${name}=${ver}: no such candidate under ${root} (have: ${have})`)
    }
    pins[name] = ver
  }
  return pins
}

/**
 * Build AGENTS.md content from the store layers (Option Y order). With
 * agent="" and pins empty, output is identical to the two-global-layer form.
 * Verbatim port of runner.py:646's assemble_agents_md. Thin delegate onto
 * ../compose.ts's shared layer composition (Task L2) — this function's
 * export + signature are unchanged; see test/compose.test.ts for the
 * byte-parity proof that the delegation didn't change this output.
 */
export function assembleAgentsMd(
  layers: string,
  metaRoot: string,
  agent = "",
  pins: Record<string, string> = {},
): string {
  const layerRefs: LayerRef[] = layerStoreRoots(layers, agent, metaRoot).map(([name, root]) => ({ scope: name, root }))
  return renderAgentsMd(composeHarness(layerRefs, pins), LAYER_LABELS, agent)
}

/** Snapshot which store versions are active/pinned, for results provenance.
 * Verbatim port of runner.py:1377's _harness_meta. */
export function harnessMeta(
  layers: string,
  metaRoot: string,
  agent = "",
  pins: Record<string, string> = {},
): Record<string, unknown> {
  const ag = accountGlobalRoot()
  const pg = projectGlobalRoot(metaRoot)
  const meta: Record<string, unknown> = {
    layers,
    account_active: existsSync(ag) ? activeVersion(ag) : "none",
    project_active: existsSync(pg) ? activeVersion(pg) : "none",
    agent: agent || "",
    pins,
  }
  if (agent) {
    const ar = accountRoleRoot(agent)
    const pr = projectRoleRoot(metaRoot, agent)
    meta["account_role_active"] = existsSync(ar) ? activeVersion(ar) : "none"
    meta["project_role_active"] = existsSync(pr) ? activeVersion(pr) : "none"
  }
  return meta
}

// ── run provenance (env block for confound control) ────────────────────────

export type SpawnFn = (argv: string[], opts?: { timeoutSec?: number }) => Promise<ExecResult>

/** HOST `opencode --version`. Injectable (default runHost) so tests never
 * spawn a real opencode binary. Verbatim port of runner.py:1275's
 * _opencode_version (minus its in-process cache — negligible perf-only
 * deviation, see task report). */
export async function opencodeVersion(execFn: SpawnFn = runHost): Promise<string> {
  try {
    const result = await execFn(["opencode", "--version"], { timeoutSec: 10 })
    const combined = (result.stdout || result.stderr || "").trim()
    const firstLine = combined.split("\n")[0] ?? ""
    return firstLine.slice(0, 40) || "unknown"
  } catch {
    return "unknown"
  }
}

/** `git -C <metaRoot> rev-parse --short HEAD`. Verbatim port of
 * runner.py:1286's _plugin_sha. */
export async function pluginSha(metaRoot: string, execFn: SpawnFn = runHost): Promise<string> {
  try {
    const result = await execFn(["git", "-C", metaRoot, "rev-parse", "--short", "HEAD"], { timeoutSec: 10 })
    return result.stdout.trim() || "unknown"
  } catch {
    return "unknown"
  }
}

/** sha256 (first 16 hex) of the exact injected AGENTS.md bytes. Verbatim
 * port of runner.py:1297's harness_hash. */
export function harnessHash(harnessMd: string): string {
  return createHash("sha256").update(harnessMd, "utf-8").digest("hex").slice(0, 16)
}

export interface EnvBlock {
  agentVersion: string
  pluginSha: string
  harnessHash: string
  maxAgentTimeout: number
  provider: string
  driver: string
  /** Resource-enforcement provenance (task-3-brief.md, D2 invariant):
   * whether --enforce-resources was on for this run. ALWAYS present
   * (unlike RunResultsMeta.resourceEnforcement, which is omitted when
   * false to preserve old results-file shape) — this is a purely
   * informational field embedded in env blocks, never compared strictly
   * anywhere: cmd-ab.ts's resume guard reads it via a `?? false`
   * coalesce, and it is NEVER added to cmd-ab.ts's `runIdent` (the object
   * resumeIdentCheck does a strict per-key compare over) — doing so would
   * kill --resume of every pre-feature partial file even with flags off,
   * the exact ac0cd18 bug class this task fixes. */
  resourceEnforcement: boolean
}

/**
 * Confound-control provenance: the config that, per the infra-noise study,
 * swings outcomes independently of the harness rule under test. Verbatim
 * port of runner.py:1303's env_block, EXCEPT `agentVersion`: Python's
 * `_opencode_version()` ran `opencode --version` on the host because Python's
 * whole runner executed directly on the host (via bwrap) — host and
 * "runtime environment" were the same machine. Under podman they are NOT
 * (see term-bench2/Containerfile's provenance note) — the task brief
 * resolves this explicitly: record the IN-CONTAINER version. Callers that
 * have one (cmd-run.ts/cmd-ab.ts, via a throwaway container — see
 * `inContainerAgentVersion` in cmd-run.ts) pass it as
 * `agentVersionOverride`; omitting it falls back to the host opencode lookup
 * (kept for direct/unit-test callers, and so this function's own default
 * behavior is never silently wrong if a caller forgets to wire the override).
 *
 * `driverId` (task-B3-brief.md) is opaque provenance — which AgentDriver
 * (drivers/index.ts) produced `agentVersion` — not itself used to pick the
 * version lookup; defaults to "opencode" so every pre-B3 caller (direct/
 * unit-test callers that never pass it) is unaffected.
 *
 * `resourceEnforcement` (task-3-brief.md) is provenance for whether
 * --enforce-resources was on; defaults to false so every pre-existing
 * caller (direct/unit-test callers that never pass it) is unaffected.
 */
export async function envBlock(
  harnessMd: string,
  maxAgentTimeout: number,
  model: string,
  metaRoot: string,
  execFn: SpawnFn = runHost,
  agentVersionOverride?: string,
  driverId = "opencode",
  resourceEnforcement = false,
): Promise<EnvBlock> {
  const [ver, sha] = await Promise.all([
    agentVersionOverride !== undefined ? Promise.resolve(agentVersionOverride) : opencodeVersion(execFn),
    pluginSha(metaRoot, execFn),
  ])
  const provider = model.includes("/") ? model.split("/")[0]! : "unknown"
  return {
    agentVersion: ver,
    pluginSha: sha,
    harnessHash: harnessHash(harnessMd),
    maxAgentTimeout: maxAgentTimeout || 0,
    provider,
    driver: driverId,
    resourceEnforcement,
  }
}

/** Build a SessionRecord (matches harness-store.ts's SessionRecord shape).
 * Verbatim port of runner.py:1315's _session_record, PLUS `platform`
 * (Task L1): bench sessions are driven by a selectable AgentDriver
 * (task-B3), so `platform` provenance is the driver id already threaded
 * into `env.driver` by envBlock — no new parameter needed here. Absent when
 * `env` has no `driver` key (e.g. direct/unit-test callers that bypass
 * envBlock), never invented.
 *
 * `elapsed`/`timedOut` (Loop-3 T3) are two new optional trailing params,
 * stamped onto the record only when provided — same conditional-stamp idiom
 * as `platform` above — so every existing (8-arg) caller keeps compiling and
 * producing byte-identical records. */
export function sessionRecord(
  task: string,
  sessionId: string,
  passed: boolean,
  turnCount: number,
  toolUsage: ToolUsage,
  model: string,
  variant: string,
  env: Record<string, unknown> = {},
  elapsed?: number,
  timedOut?: boolean,
): SessionRecord {
  const driver = env["driver"]
  return {
    sessionID: sessionId,
    passed,
    note: `bench:${task}`,
    turnCount,
    timestamp: new Date().toISOString(),
    summary: task,
    model,
    variant: variant || "",
    toolUsage,
    env,
    ...(typeof driver === "string" ? { platform: driver } : {}),
    ...(elapsed !== undefined ? { elapsed } : {}),
    ...(timedOut !== undefined ? { timedOut } : {}),
  }
}

/**
 * Record a session into every applicable layer store. Skipped entirely when
 * noStore, or (hygiene) when turnCount==0 AND it's not a flag-opted-in
 * timeout — a 0-turn run is normally a timeout/auth/transient opencode
 * failure, not a verdict on the harness. Verbatim port of runner.py:1333's
 * record_to_stores, EXTENDED by Loop-3 T3: the skip guard is a
 * DISCRIMINATOR, not a blanket 0-turn drop —
 * `turnCount === 0 && !(timedOut && recordTimeouts)`. With `recordTimeouts`
 * false (default) this is identical to the old `turnCount === 0` guard for
 * every 0-turn run, timeout or not. With it true, a *timeout* 0-turn
 * (`timedOut` true) falls through and is recorded as a genuine fail
 * (passed=false, turnCount=0, timedOut=true, elapsed set); an auth/transient
 * 0-turn (`timedOut` unset/false) is still dropped — that discriminator is
 * the whole point of carrying `timedOut` instead of just deleting the guard.
 */
export function recordToStores(
  task: string,
  sessionId: string,
  passed: boolean,
  turnCount: number,
  toolUsage: ToolUsage,
  model: string,
  variant: string,
  layers: string,
  metaRoot: string,
  noStore: boolean,
  agent = "",
  pins: Record<string, string> = {},
  env: Record<string, unknown> = {},
  events: TrajEvent[] = [],
  saveAllTraj = false,
  timedOut = false,
  recordTimeouts = false,
  elapsed?: number,
): void {
  if (noStore) return
  if (turnCount === 0 && !(timedOut && recordTimeouts)) {
    log("  skip store record: 0 agent turns (auth/transient agent failure)")
    return
  }

  const record = sessionRecord(task, sessionId, passed, turnCount, toolUsage, model, variant, env, elapsed, timedOut)
  const saveTraj = events.length > 0 && (!passed || saveAllTraj)

  for (const [name, root] of layerStoreRoots(layers, agent, metaRoot)) {
    const ver = pins[name] || activeVersion(root)
    const score = recordSession(root, ver, record)
    if (saveTraj) {
      writeTrajectory(root, ver, sessionId, events)
      pruneTrajectories(root, ver)
    }
    log(`  store ${name} ${ver}: nPass=${score.nPass} nFail=${score.nFail}`)
  }
}
