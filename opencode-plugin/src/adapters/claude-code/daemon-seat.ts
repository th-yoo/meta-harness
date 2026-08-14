/**
 * adapters/claude-code/daemon-seat.ts — shared contracts for the daemon-carried
 * LLM seats (judge, proposer/promoter/curator), per the daemon carrier
 * migration (docs/superpowers/plans/2026-08-14-daemon-carrier-migration-plan.md T0,
 * spec docs/superpowers/specs/2026-08-14-daemon-carrier-migration-design.md).
 *
 * Both migration tracks (judge body-swap and the proposer worker) build their
 * daemonCall inputs from THIS module so the isolation object, model fallback,
 * and maxTokens lane-gating stay structurally identical across seats.
 */
import { routeBackend, type WarmIsolation } from "@th-yoo/cc-api-daemon"
import type { PlaybookOp } from "../../harness-store.ts"

/** Fallback model when a seat is invoked with `model: undefined` — the daemon
 * hard-requires a non-empty model on session/prompt (no daemon-side default,
 * unlike the old `claude -p` transport where omitting `--model` fell back to
 * the CLI's own default). BARE model id (A4_MODEL's convention), NOT the
 * prefixed "anthropic/…" config-string form `DEFAULT_PROPOSER_MODEL` uses —
 * daemonCall is only ever fed bare canonical ids in this codebase. */
export const DEFAULT_JUDGE_MODEL = "claude-opus-5"

/** Seats that ride the daemon. "judge" covers both the dense judge and the
 * review gate (both arrive via host.runTextAgent). */
export type SeatKind = "judge" | "propose" | "promote" | "curate"

/** Partial WarmIsolation base — deliberately missing `systemPrompt` and
 * `title`; complete it ONLY via `seatIsolation` below so every seat builds a
 * structurally identical object. `settings.autoMemoryEnabled` is nested (the
 * WarmIsolation shape, acp-wire.ts), not a flat field. */
const SEAT_ISOLATION_BASE = {
  settingSources: [] as [],
  settings: { autoMemoryEnabled: false as const },
  persistSession: false as const,
  strictMcpConfig: true as const,
  tools: [] as [],
  thinking: { type: "disabled" } as { type: "disabled" },
}

/** The one blessed way to build a seat's WarmIsolation. */
export function seatIsolation(systemPrompt: string, title: string): WarmIsolation {
  return { ...SEAT_ISOLATION_BASE, systemPrompt, title }
}

/** Reply-size caps, api lane ONLY. The daemon hard-rejects any session/prompt
 * carrying maxTokens on the agent lane (ACP_ERR_NO_CALL, acp-daemon.ts) —
 * and routeBackend sends every non-haiku model (i.e. every default seat
 * model) to the agent lane, which has no max_tokens equivalent at all. So:
 * a number ONLY when the model routes "api"; `undefined` otherwise. Passing
 * a number unconditionally is a total outage, not a soft cap. */
export function seatMaxTokens(model: string, seat: SeatKind): number | undefined {
  if (routeBackend(model) !== "api") return undefined
  return seat === "judge" ? 4096 : 16384
}

/** Turn budget for the detached worker's daemon (propose/promote/curate —
 * NOT the judge). The gauge-sized default (ACP_BUDGET.turnTimeoutMs, 16s)
 * deterministically kills real proposer turns: a 40KB account-global prompt
 * plus a multi-KB JSON reply cannot clear 16s on opus (live-diagnosed
 * 2026-08-14 — constant 16.0-16.2s call-consumed, aborted_streaming,
 * duration_api_ms 0). 480s: ample for prefill + a 16KB reply, and the
 * resulting advertised worst case (non-turn legs 16s + 480s = 496s) sits
 * under the worker's attempt-1 budgetMs (600s for the standard 20min
 * descriptor) with >=3s of §6e slack — checked by a test.
 *
 * CONFIG FLOOR (architect review): this number implies
 * cfg.proposerTimeoutMin >= 17 — attempt-1 budgetMs is timeoutMs/2, and
 * below ~998s of descriptor timeout the client guard (advertised worst
 * case >= budgetMs) refuses every cycle pre-send: silent, free, and
 * permanent until the config rises. readMhConfig clamps only to (0, 120].
 * Boundary pinned by the config-floor test in proposer-worker.test.ts. */
export const WORKER_TURN_TIMEOUT_MS = 480_000

/** Env for the worker's daemon calls. ACP_TURN_TIMEOUT_MS is deliberately
 * NOT in the daemon's ACP_ENV_DENYLIST, so setting it changes the
 * envFingerprint: the worker gets its OWN daemon instance with long turns
 * while the gauge/judge daemon (plain env, default fingerprint) keeps its
 * 16s fail-fast budget. Isolation via the existing fingerprint mechanism —
 * no daemon-side contract change beyond the honest worst-case
 * advertisement (cc-api-daemon 0.8.1). */
export function workerDaemonEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, ACP_TURN_TIMEOUT_MS: String(WORKER_TURN_TIMEOUT_MS) }
}

// ── worker argsfile ────────────────────────────────────────────────────────

/** Staged-file paths the worker writes, per kind. Absolute paths, computed by
 * triggerPropose/triggerPromote/triggerCurate (the same staging paths the old
 * heredoc prompt embedded as relative paths). The worker must NEVER write a
 * file outside its kind's set — the promote/curate apply paths clean up only
 * the exact files they know about, so stray proposer-shaped files would leak
 * in the staging dir forever. */
export type WorkerStagingPaths =
  | {
      kind: "propose"
      /** true → primary artifact is ops.json (playbook mode); false → system.md. */
      playbookMode: boolean
      system: string
      tools: string
      diagnosis: string
      ops: string
      agentConfig: string
      envPolicy: string
      provenance: string
    }
  | { kind: "promote"; system: string; tools: string; provenance: string }
  | { kind: "curate"; ops: string; provenance: string }

/** The JSON file `runTaskAgent` hands the detached worker (argv[2]).
 * `spawnedAt` is stamped by cc-host at spawn time — it necessarily precedes
 * the descriptor's own spawnedAt (stamped moments later in triggerPropose),
 * so a deadline computed from it is always ≤ the lock's stale-expiry horizon. */
export interface WorkerArgs {
  kind: SeatKind & ("propose" | "promote" | "curate")
  prompt: string
  systemPrompt: string
  /** Bare model id for daemonCall (already resolved; never the "anthropic/…" form). */
  model: string
  stagingPaths: WorkerStagingPaths
  /** The descriptor's timeoutMs (cfg.proposerTimeoutMin * 60_000). */
  timeoutMs: number
  /** Epoch ms at spawn. Deadline = spawnedAt + timeoutMs − WORKER_DEADLINE_MARGIN_MS. */
  spawnedAt: number
  /** Correlation id for logs/provenance (replaces the old --session-id plumbing). */
  artifactId: string
}

/** Headroom the worker reserves so it is provably dead (exited, staging files
 * written or not at all) strictly BEFORE its proposer lock becomes
 * reclaimable — a reclaimed lock lets a re-triggered propose compute the SAME
 * version (nextVersion is on-disk-derived) and write the SAME staging paths,
 * so a zombie worker racing a fresh one is staging corruption. */
export const WORKER_DEADLINE_MARGIN_MS = 30_000

// ── reply contracts ────────────────────────────────────────────────────────

/** What the propose seat must return as its entire reply: one JSON object.
 * Mirrors the artifacts the old tool-using child wrote via heredocs. */
export interface ProposeReply {
  /** The diagnosis payload previously heredoc'd into <scope>-<version>-diagnosis.json. */
  diagnosis: Record<string, unknown>
  /** Playbook mode: the ops.json payload ({ops: [...]}). */
  ops?: { ops: PlaybookOp[] }
  /** Legacy (non-playbook) mode: the improved system.md text. */
  system?: string
  tools?: string
  agentConfig?: Record<string, unknown>
  envPolicy?: Record<string, unknown>
  explanation?: string
}

export interface PromoteReply {
  system: string
  tools?: string
}

export interface CurateReply {
  /** Curate ops — `add` is forbidden (the curator consolidates, it never invents). */
  ops: { ops: PlaybookOp[] }
}

export type SeatReplyFor<K extends WorkerArgs["kind"]> = K extends "propose"
  ? ProposeReply
  : K extends "promote"
    ? PromoteReply
    : CurateReply

/** Validation outcome — `reason` feeds the one-shot repair nudge verbatim. */
export type ReplyCheck<T> = { ok: true; value: T } | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Loose structural check of one PlaybookOp (harness-store.ts's union). The
 * downstream applyStagedArtifact path re-screens ops (screenOpsChecks) — this
 * validator only has to catch shape garbage early enough to trigger the
 * repair retry instead of staging an unusable artifact. */
function isPlaybookOpShape(v: unknown): v is PlaybookOp {
  if (!isRecord(v)) return false
  if (v.op === "add") return typeof v.text === "string" && v.text.length > 0
  if (v.op === "update") return typeof v.id === "string" && typeof v.text === "string"
  if (v.op === "delete") return typeof v.id === "string"
  return false
}

function checkOpsPayload(v: unknown, label: string): ReplyCheck<{ ops: PlaybookOp[] }> {
  if (!isRecord(v) || !Array.isArray(v.ops)) return { ok: false, reason: `${label} must be {"ops": [...]}` }
  for (const op of v.ops) {
    if (!isPlaybookOpShape(op)) return { ok: false, reason: `${label} contains a malformed op: ${JSON.stringify(op)}` }
  }
  return { ok: true, value: { ops: v.ops as PlaybookOp[] } }
}

export function checkProposeReply(v: unknown, playbookMode: boolean): ReplyCheck<ProposeReply> {
  if (!isRecord(v)) return { ok: false, reason: "reply must be a single JSON object" }
  if (!isRecord(v.diagnosis)) return { ok: false, reason: `"diagnosis" is required and must be an object` }
  if (playbookMode) {
    const ops = checkOpsPayload(v.ops, `"ops"`)
    if (!ops.ok) return ops
  } else if (typeof v.system !== "string" || v.system.trim().length === 0) {
    return { ok: false, reason: `"system" is required (non-empty string) in system.md mode` }
  }
  if (v.tools !== undefined && typeof v.tools !== "string") return { ok: false, reason: `"tools" must be a string when present` }
  if (v.agentConfig !== undefined && !isRecord(v.agentConfig)) return { ok: false, reason: `"agentConfig" must be an object when present` }
  if (v.envPolicy !== undefined && !isRecord(v.envPolicy)) return { ok: false, reason: `"envPolicy" must be an object when present` }
  return { ok: true, value: v as unknown as ProposeReply }
}

export function checkPromoteReply(v: unknown): ReplyCheck<PromoteReply> {
  if (!isRecord(v)) return { ok: false, reason: "reply must be a single JSON object" }
  if (typeof v.system !== "string" || v.system.trim().length === 0) {
    return { ok: false, reason: `"system" is required (non-empty string)` }
  }
  if (v.tools !== undefined && typeof v.tools !== "string") return { ok: false, reason: `"tools" must be a string when present` }
  return { ok: true, value: v as unknown as PromoteReply }
}

export function checkCurateReply(v: unknown): ReplyCheck<CurateReply> {
  if (!isRecord(v)) return { ok: false, reason: "reply must be a single JSON object" }
  const ops = checkOpsPayload(v.ops, `"ops"`)
  if (!ops.ok) return ops
  for (const op of ops.value.ops) {
    if (op.op === "add") return { ok: false, reason: `curate replies must not contain "add" ops (consolidate, don't invent)` }
  }
  return { ok: true, value: { ops: ops.value } }
}
