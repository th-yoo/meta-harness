/**
 * score.ts — headless fitness entry (spec §6): pending session + gate
 * adjudication → recordToStores on the STAMPED versions (pins), fleet
 * provenance in env. Refused sessions are constitutionally unscoreable
 * (spec §3.3.1).
 *
 * Reality-binding notes (vs. the task brief's sketch — recordToStores' real
 * parameter list, bench/record.ts:281, matches the brief's call order
 * almost verbatim; the gaps are in two argument SHAPES):
 *
 *  - `FleetPendingSession.toolUsage` (pending.ts) is the fleet wire
 *    contract's collapsed `Record<string, number>` (call counts only — see
 *    run.ts's `toolCallCounts` + file header for why error counts don't
 *    survive the wire), but `recordToStores` wants harness-store.ts's
 *    `ToolUsage` (`Record<string, {calls, errors}>`). `toToolUsage` below
 *    re-expands each count to `{calls: n, errors: 0}` — errors are
 *    unrecoverable at this point, never invented.
 *  - `FleetPendingSession.events` is raw NDJSON opencode events
 *    (`{type, part, sessionID, ...}` — see run.ts's `parseNdjsonLines`), not
 *    harness-store.ts's compact `TrajEvent` (`{t, tool, args, output, error,
 *    text}`) shape `recordToStores` types its `events` param as.
 *    `recordToStores` only ever writes a trajectory file for a FAILED
 *    session (its own `saveTraj` gate, record.ts:305) — i.e. exactly the
 *    case that matters most for forensics. Raw events passed straight
 *    through were NOT harmless: every consumer of a written trajectory
 *    (harness-store.ts's `fmtTrajEvent`, `buildFailureExcerpts` →
 *    propose.ts:583, judge-audit.ts) assumes the compact `TrajEvent` shape,
 *    so a raw tool_use event (no `.t`) rendered as an empty `SAY: ` line —
 *    malformed proposer/judge-audit input with the error signal silently
 *    dropped on every BAD verdict. `toTrajEvents` below fixes this by
 *    reusing drivers/opencode.ts's `normalizeEvents` (the same
 *    tool_use/text/error branches the live opencode driver uses to build
 *    `TrajEvent`s from NDJSON) instead of casting raw events through.
 */
import { archivePending, hasPending, markMergeScored, readArchived, readPending } from "./pending.ts"
import { detectEscalation } from "./squad-def.ts"
import { recordToStores } from "../bench/record.ts"
import { normalizeEvents } from "../bench/drivers/opencode.ts"
import { die, log } from "../bench/util.ts"
import type { ToolUsage, TrajEvent } from "../harness-store.ts"

export type FleetGate = "gate1" | "gate2" | "verdict" | "merge" | "lint" | "infeasible"

/** CLI-facing enumeration of FleetGate, for argv validation (mirrors
 * record.ts's LAYER_CHOICES pattern). */
export const FLEET_GATES: FleetGate[] = ["gate1", "gate2", "verdict", "merge", "lint", "infeasible"]

/** Re-expand the fleet wire contract's collapsed call-count map back into
 * harness-store.ts's ToolUsage shape. See file header — error counts are
 * lost upstream and always recorded as 0 here. */
function toToolUsage(counts: Record<string, number>): ToolUsage {
  const out: ToolUsage = {}
  for (const [tool, calls] of Object.entries(counts)) out[tool] = { calls, errors: 0 }
  return out
}

/** Normalize `FleetPendingSession.events` (raw, already-parsed opencode
 * NDJSON events) into harness-store.ts's compact TrajEvent shape, by
 * re-serializing to NDJSON text and feeding it through
 * drivers/opencode.ts's `normalizeEvents` — the exact same tool_use/text/
 * error branches the live driver uses, so a written trajectory (BAD verdict
 * only, see file header) round-trips through the same shape every other
 * consumer (fmtTrajEvent, buildFailureExcerpts, judge-audit.ts) expects. */
function toTrajEvents(events: unknown[]): TrajEvent[] {
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n")
  return normalizeEvents(ndjson)
}

export async function cmdRoleScore(args: {
  project: string; id: string; verdict: "good" | "bad"
  note?: string; nodePath?: string; gate?: FleetGate
}): Promise<void> {
  // Merge-gate reality (fleet-integration.md §2/§5): squad-run's own
  // evaluator-verdict PASS branch already auto-scores the implementer
  // good/verdict BEFORE printing its "done" outcome — by the time the fleet
  // master calls `role-score --gate merge` on that same id, it has long
  // since been archivePending()'d out of pending/. A merge-gate score is
  // therefore, legitimately, a SECOND score of an already-archived session:
  // fall back to reading (and re-marking) the scored/ copy instead of dying
  // "no pending fleet session". Every OTHER gate keeps the strict
  // pending-only read below (a double-score there stays refused exactly as
  // before — dies, since the id is gone from pending/ and this fallback
  // doesn't apply).
  const isMergeGate = args.gate === "merge"
  const readFromArchive = isMergeGate && !hasPending(args.project, args.id)
  const pending = readFromArchive ? readArchived(args.project, args.id) : readPending(args.project, args.id)

  // Double-merge-score guard: a merge score is allowed exactly once per id
  // (it's already a deliberate second score of a verdict-scored session;
  // a third would silently double-count the same merge decision).
  if (isMergeGate && pending.mergeScoredAt) {
    die(`session ${args.id} was already merge-scored at ${pending.mergeScoredAt} — refusing double merge-score`)
  }

  // Refused guard BEFORE any store write (spec §3.3.1) — constitutionally
  // unscoreable, never lands in a fitness record.
  if (detectEscalation(pending.payload)?.type === "Refused") {
    die(`session ${args.id} carries a Refused escalation — never scored (spec §3.3.1); archive manually if needed`)
  }

  const env: Record<string, unknown> = {
    driver: "opencode",
    harnessHash: pending.renderStamp?.harnessHash,
    fleet: {
      nodePath: args.nodePath ?? pending.nodePath ?? null,
      sliceId: pending.sliceId ?? null,
      gate: args.gate ?? null,
      note: args.note ?? null,
    },
  }

  // Stamp versions as pins — scores route to the exact versions that RAN,
  // immune to activation drift (spec §6 D5). Empty object (not activeVersion
  // fallback) when a pending session somehow lacks a stamp: recordToStores
  // itself falls back to activeVersion(root) per-layer when a pin is absent.
  const pins = pending.renderStamp?.versions ?? {}

  recordToStores(
    pending.sliceId ?? pending.role,
    pending.id,
    args.verdict === "good",
    pending.turnCount,
    toToolUsage(pending.toolUsage),
    pending.model,
    "",
    "global",
    args.project,
    false,
    pending.agent,
    pins,
    env,
    toTrajEvents(pending.events),
    false,
  )
  if (readFromArchive) {
    // Already archived (the normal case for a merge-gate score) — just tag
    // the merge-scored marker in place, nothing to move.
    markMergeScored(args.project, args.id)
  } else {
    archivePending(args.project, args.id)
    if (isMergeGate) markMergeScored(args.project, args.id) // first-ever merge score reached via pending/
  }
  log(`scored ${args.id} ${args.verdict} (gate=${args.gate ?? "-"}) on stamped ${JSON.stringify(pins)}`)
}
