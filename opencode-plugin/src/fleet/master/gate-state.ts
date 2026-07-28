/**
 * master/gate-state.ts — the master's durable authority log: what is
 * currently awaiting a human gate, and what human instructions have already
 * been processed. This is the R1-REQUIRED exposure surface (so the human,
 * the durability layer, can verify state and re-send drops) and the D8.1
 * durable log. Anchored under `masterRoot` (survives worktree cleanup, per
 * the N1b ledger-anchoring idiom), writes are atomic (D9) via the shared
 * `writeJsonAtomic` (temp+rename — a reader never observes a torn file).
 *
 * Single-writer: the master is a singleton authority (D8.1) — exactly one
 * process ever writes this log, so no flock/lock is needed here (contrast
 * a multi-writer store, which would need one). Every mutator is a plain
 * read → modify → writeJsonAtomic round-trip.
 */
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { die, writeJsonAtomic } from "../../bench/util.ts"

export type GateKind = "gate1" | "gate2" | "verdict" | "merge" | "escalation"

export interface PendingGate {
  project: string
  sliceId: string
  kind: GateKind
  payload: string
  raisedAt: string
  relayRef?: string
}

export interface ProcessedRecord {
  inboundId: string
  project: string
  sliceId: string
  answer: string
  processedAt: string
}

export interface MasterLog {
  pending: PendingGate[]
  processed: ProcessedRecord[]
}

/** `<masterRoot>/.kkamak/runtime/master/gate-log.json` */
export function masterLogPath(masterRoot: string): string {
  return join(masterRoot, ".kkamak", "runtime", "master", "gate-log.json")
}

/** Missing file → empty log. A stray `*.tmp` sibling from an interrupted
 * writer never breaks this read: we only ever read the committed path,
 * never glob for temp files (the writeJsonAtomic temp+rename discipline
 * guarantees the committed path is always whole JSON or absent). */
export function loadMasterLog(masterRoot: string): MasterLog {
  const p = masterLogPath(masterRoot)
  if (!existsSync(p)) return { pending: [], processed: [] }
  const raw = readFileSync(p, "utf-8")
  try {
    return JSON.parse(raw) as MasterLog
  } catch (e) {
    die(`master/gate-state: corrupt log at ${p}: ${(e as Error).message}`)
  }
}

/** Atomic upsert on (project, sliceId, kind): a duplicate raise (e.g. a
 * re-sent escalation) replaces the existing pending entry rather than
 * doubling it — idempotent by construction. */
export function raiseGate(masterRoot: string, g: PendingGate): void {
  const log = loadMasterLog(masterRoot)
  const idx = log.pending.findIndex(
    (p) => p.project === g.project && p.sliceId === g.sliceId && p.kind === g.kind,
  )
  if (idx === -1) log.pending.push(g)
  else log.pending[idx] = g
  writeJsonAtomic(masterLogPath(masterRoot), log)
}

/** Records the relay message id a pending gate was last relayed under (so a
 * re-poll can recognize an already-sent gate). Matches on (project, sliceId,
 * kind) — a sliceId can have multiple co-pending gates of different kinds,
 * and only the matching one should be stamped. No-op if no matching pending
 * gate exists (the gate may have already been resolved). */
export function markRelayed(
  masterRoot: string,
  project: string,
  sliceId: string,
  kind: GateKind,
  relayRef: string,
): void {
  const log = loadMasterLog(masterRoot)
  for (const p of log.pending) {
    if (p.project === project && p.sliceId === sliceId && p.kind === kind) p.relayRef = relayRef
  }
  writeJsonAtomic(masterLogPath(masterRoot), log)
}

/** Moves the pending gate matching (project, sliceId, kind) out of `pending`
 * and appends the given record to `processed` — never duplicated. Kind-aware
 * so that a co-pending gate of a different kind for the same sliceId (e.g.
 * an escalation raised alongside a gate1) is left untouched rather than
 * silently dropped. */
export function resolveGate(
  masterRoot: string,
  project: string,
  sliceId: string,
  kind: GateKind,
  rec: ProcessedRecord,
): void {
  const log = loadMasterLog(masterRoot)
  log.pending = log.pending.filter(
    (p) => !(p.project === project && p.sliceId === sliceId && p.kind === kind),
  )
  log.processed.push(rec)
  writeJsonAtomic(masterLogPath(masterRoot), log)
}

/** The R1 query/exposure surface: all pending gates, optionally filtered to
 * one project namespace. */
export function pendingGates(masterRoot: string, project?: string): PendingGate[] {
  const log = loadMasterLog(masterRoot)
  return project === undefined ? log.pending : log.pending.filter((p) => p.project === project)
}
