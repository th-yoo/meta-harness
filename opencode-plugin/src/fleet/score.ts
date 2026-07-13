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
 *    session (its own `saveTraj` gate, record.ts:305), so this shape
 *    mismatch never corrupts a passing score's on-disk trace; the raw events
 *    are still JSON-serializable and worth keeping as failure forensics, so
 *    they're passed through with a type-only cast rather than dropped.
 */
import { archivePending, readPending } from "./pending.ts"
import { detectEscalation } from "./squad-def.ts"
import { recordToStores } from "../bench/record.ts"
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

export async function cmdRoleScore(args: {
  project: string; id: string; verdict: "good" | "bad"
  note?: string; nodePath?: string; gate?: FleetGate
}): Promise<void> {
  // die()s if missing OR already archived (a double-score re-reads the same
  // id after archivePending moved it to scored/, so it's gone from pending/).
  const pending = readPending(args.project, args.id)

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
    pending.events as unknown as TrajEvent[],
    false,
  )
  archivePending(args.project, args.id)
  log(`scored ${args.id} ${args.verdict} (gate=${args.gate ?? "-"}) on stamped ${JSON.stringify(pins)}`)
}
