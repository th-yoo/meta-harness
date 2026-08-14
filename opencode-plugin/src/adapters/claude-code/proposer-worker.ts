/**
 * adapters/claude-code/proposer-worker.ts — the detached bun worker that
 * replaced the detached `claude -p` proposer/promoter/curator child (daemon
 * carrier migration, plan T2).
 *
 * One cycle: read the argsfile (WorkerArgs JSON, argv[2]) → ensureDaemon →
 * ONE toolless daemonCall with OUR system prompt → validate the reply against
 * the kind-specific schema (one repair retry) → write the staged artifact
 * files itself → exit. The LLM never touches disk; everything downstream
 * (proposer locks, applyPendingArtifacts, applyStagedArtifact) is unchanged
 * and still keys off the primary artifact appearing on disk.
 *
 * Deadline discipline (plan T2): the proposer lock becomes reclaimable at
 * `spawnedAt + timeoutMs` (proposer.ts stale expiry), and a re-triggered
 * propose after reclaim computes the SAME version — so a zombie worker racing
 * a fresh one would corrupt shared staging paths. Every blocking step here is
 * budgeted against `deadline = spawnedAt + timeoutMs − WORKER_DEADLINE_MARGIN_MS`;
 * past the deadline the worker exits nonzero WITHOUT writing anything. Total
 * wall clock is therefore provably under the lock horizon.
 *
 * Write order: secondaries first, PRIMARY LAST — applyPendingArtifacts polls
 * the primary (ops.json in playbook mode, system.md otherwise), so
 * primary-last guarantees the artifact set is complete when the apply fires.
 */
import fs from "node:fs"
import { createHash } from "node:crypto"
import { ensureDaemon, daemonCall, closeSession, modelProvenBy } from "@th-yoo/cc-api-daemon"
import { writeTextAtomic } from "../../bench/util.ts"
import {
  seatIsolation,
  seatMaxTokens,
  checkProposeReply,
  checkPromoteReply,
  checkCurateReply,
  WORKER_DEADLINE_MARGIN_MS,
  workerDaemonEnv,
  type WorkerArgs,
  type ReplyCheck,
} from "./daemon-seat.ts"

/** Injectable daemon-client seam — a4-review's exact test pattern. */
export interface WorkerDeps {
  ensure?: typeof ensureDaemon
  call?: typeof daemonCall
  close?: typeof closeSession
}

/** Below this remaining budget a daemon call is pointless — fail instead. */
const MIN_USEFUL_BUDGET_MS = 5_000

const SEAT_TITLE: Record<WorkerArgs["kind"], string> = {
  propose: "kkamak-proposer",
  promote: "kkamak-promoter",
  curate: "kkamak-curator",
}

function log(msg: string): void {
  try {
    process.stderr.write(`[proposer-worker] ${msg}\n`)
  } catch {
    /* detached stderr may be gone — never let logging kill the cycle */
  }
}

/** Reply text → parsed JSON. Tolerates a fenced ```json block (models add
 * fences despite instructions often enough that rejecting them outright
 * would burn the one repair retry on pure formatting). */
export function parseReplyJson(text: string): unknown | undefined {
  let t = text.trim()
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fence?.[1]) t = fence[1].trim()
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

function validateReply(kind: WorkerArgs["kind"], v: unknown, playbookMode: boolean): ReplyCheck<unknown> {
  if (kind === "propose") return checkProposeReply(v, playbookMode)
  if (kind === "promote") return checkPromoteReply(v)
  return checkCurateReply(v)
}

/** Write the staged files for a validated reply — per kind, primary last. */
function writeStagedFiles(args: WorkerArgs, reply: unknown, provenance: Record<string, unknown>): void {
  const sp = args.stagingPaths
  if (sp.kind === "propose") {
    const r = reply as import("./daemon-seat.ts").ProposeReply
    writeTextAtomic(sp.diagnosis, JSON.stringify(r.diagnosis, null, 2))
    if (typeof r.tools === "string" && r.tools.trim()) writeTextAtomic(sp.tools, r.tools)
    if (r.agentConfig) writeTextAtomic(sp.agentConfig, JSON.stringify(r.agentConfig))
    if (r.envPolicy) writeTextAtomic(sp.envPolicy, JSON.stringify(r.envPolicy))
    writeTextAtomic(sp.provenance, JSON.stringify(provenance, null, 2))
    if (sp.playbookMode) {
      writeTextAtomic(sp.ops, JSON.stringify(r.ops))
    } else {
      writeTextAtomic(sp.system, r.system ?? "")
    }
  } else if (sp.kind === "promote") {
    const r = reply as import("./daemon-seat.ts").PromoteReply
    if (typeof r.tools === "string" && r.tools.trim()) writeTextAtomic(sp.tools, r.tools)
    writeTextAtomic(sp.provenance, JSON.stringify(provenance, null, 2))
    writeTextAtomic(sp.system, r.system)
  } else {
    const r = reply as import("./daemon-seat.ts").CurateReply
    writeTextAtomic(sp.provenance, JSON.stringify(provenance, null, 2))
    writeTextAtomic(sp.ops, JSON.stringify(r.ops))
  }
}

/**
 * Run one worker cycle. Returns the process exit code (0 = staged, nonzero =
 * nothing staged; the lock's stale expiry reclaims the cycle). NEVER throws.
 */
export async function runWorkerCycle(
  args: WorkerArgs,
  env: Record<string, string | undefined>,
  deps: WorkerDeps = {},
): Promise<number> {
  const ensure = deps.ensure ?? ensureDaemon
  const call = deps.call ?? daemonCall
  const close = deps.close ?? closeSession
  const denv = workerDaemonEnv(env)

  const deadline = args.spawnedAt + args.timeoutMs - WORKER_DEADLINE_MARGIN_MS
  const remaining = () => deadline - Date.now()
  const sessionIds: string[] = []

  try {
    if (remaining() < MIN_USEFUL_BUDGET_MS) {
      log(`no usable budget on arrival (remaining ${remaining()}ms) — exiting without staging`)
      return 1
    }

    // Detached worker MUST be able to spawn a cold daemon — never the
    // zero-wait silent-skip (that budget-guard behavior is a4-review's,
    // not a production seat's).
    const ready = await ensure(denv, { waitMs: Math.min(30_000, Math.max(0, remaining())) })
    if (!ready) {
      log("daemon unreachable and could not be spawned — exiting without staging")
      return 1
    }

    const isolation = seatIsolation(args.systemPrompt, SEAT_TITLE[args.kind])
    const maxTokens = seatMaxTokens(args.model, args.kind)
    const playbookMode = args.stagingPaths.kind === "propose" && args.stagingPaths.playbookMode

    let retried = false
    let prompt = args.prompt
    for (let attempt = 0; attempt < 2; attempt++) {
      const budgetMs = attempt === 0 ? Math.min(Math.floor(args.timeoutMs / 2), remaining()) : remaining()
      if (budgetMs < MIN_USEFUL_BUDGET_MS) {
        log(`insufficient budget for attempt ${attempt + 1} (${budgetMs}ms) — exiting without staging`)
        return 1
      }

      const outcome = await call(prompt, args.model, denv, { isolation, maxTokens, budgetMs })
      if (outcome.sessionId) sessionIds.push(outcome.sessionId)

      if (outcome.kind !== "ok") {
        log(`daemonCall outcome ${outcome.kind} — exiting without staging`)
        return 1
      }
      if (!modelProvenBy(outcome.model, args.model, outcome.canonicalModel)) {
        log(`model proof failed (asked ${args.model}, got ${outcome.model}/${outcome.canonicalModel}) — exiting without staging`)
        return 1
      }
      // Branch on the SPECIFIC value — absence means unknown, never "not
      // truncated" (agent lane never sets it). A truncated reply would fail
      // validation too; catching it here keeps the actionable signal and
      // skips a retry that would truncate identically.
      if (outcome.stopReason === "max_tokens") {
        log("reply truncated by the api-lane maxTokens cap — exiting without staging")
        return 1
      }

      const parsed = parseReplyJson(outcome.text)
      const checked = parsed === undefined
        ? ({ ok: false, reason: "reply was not parseable JSON" } as const)
        : validateReply(args.kind, parsed, playbookMode)

      if (checked.ok) {
        writeStagedFiles(args, checked.value, {
          artifactId: args.artifactId,
          kind: args.kind,
          model: outcome.model,
          canonicalModel: outcome.canonicalModel,
          promptSha256: createHash("sha256").update(args.prompt).digest("hex"),
          retried,
          ts: Date.now(),
        })
        log(`staged ${args.kind} artifact ${args.artifactId} (retried=${retried})`)
        return 0
      }

      log(`reply invalid (${checked.reason}) — ${attempt === 0 ? "one repair retry" : "exiting without staging"}`)
      retried = true
      prompt = `${args.prompt}\n\n## Repair\n\nYour previous reply was rejected: ${checked.reason}. Reply again with ONLY the corrected single JSON object — no prose, no fences.`
    }
    return 1
  } catch (err) {
    log(`unexpected failure — ${err instanceof Error ? err.message : String(err)}`)
    return 1
  } finally {
    for (const id of sessionIds) {
      try {
        await close(id, denv)
      } catch {
        /* best effort — a close failure never changes the cycle outcome */
      }
    }
  }
}

if (import.meta.main) {
  const argsPath = process.argv[2] ?? ""
  let args: WorkerArgs
  try {
    args = JSON.parse(fs.readFileSync(argsPath, "utf8")) as WorkerArgs
  } catch (err) {
    log(`could not read argsfile ${argsPath} — ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  runWorkerCycle(args, process.env).then((code) => process.exit(code))
}
