/**
 * pending.ts — the fleet headless-drive pending-session store (spec §5, §3):
 * `role-run` writes one JSON file per drive here; `role-score` (a later
 * task) reads + archives it into fitness records. Deliberately dumb (no
 * validation beyond existence) — `run.ts` owns the shape it writes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import type { RenderStamp } from "./render.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

export interface FleetPendingSession {
  id: string
  role: string
  agent: string
  project: string
  model: string
  turnCount: number
  toolUsage: Record<string, number>
  payload: string
  events: unknown[]
  nodePath?: string
  sliceId?: string
  renderStamp?: RenderStamp
  tokens?: { input: number; output: number }
  cost?: number
  ts: string
  /** ISO timestamp of the last merge-gate score against this (archived)
   * session, set by `markMergeScored` below. Presence refuses a second
   * `role-score --gate merge` on the same id (score.ts's double-merge-score
   * guard) — merge-gate is the one gate that legitimately scores an
   * already-archived session a second time (fleet-integration.md §2/§5), so
   * it needs its own idempotency marker distinct from pending/scored
   * file placement. */
  mergeScoredAt?: string
}

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_")

export function pendingDir(project: string): string {
  return join(project, ".kkamak", "runtime", "fleet")
}

export function writePending(p: FleetPendingSession): void {
  const dir = pendingDir(p.project)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(join(dir, `${sanitize(p.id)}.json`), p)
}

export function listPending(project: string): string[] {
  const dir = pendingDir(project)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
}

export function readPending(project: string, id: string): FleetPendingSession {
  const p = join(pendingDir(project), `${sanitize(id)}.json`)
  if (!existsSync(p)) die(`no pending fleet session '${id}' — pending: [${listPending(project).join(", ")}]`)
  return JSON.parse(readFileSync(p, "utf-8")) as FleetPendingSession
}

/** True if `id` still has a live (unscored) pending file. Used by score.ts's
 * merge-gate path to decide whether to read the normal pending/ location or
 * fall back to the archive (see `readArchived` below). */
export function hasPending(project: string, id: string): boolean {
  return existsSync(join(pendingDir(project), `${sanitize(id)}.json`))
}

function archivedPath(project: string, id: string): string {
  return join(pendingDir(project), "scored", `${sanitize(id)}.json`)
}

/** Reads an already-archived (scored/) session — the merge gate's fallback
 * when the id it's asked to score was already moved out of pending/ by an
 * earlier score (typically squad-run's own verdict auto-score of the
 * implementer, fleet-integration.md §2/§5). Dies (same message shape as
 * `readPending`) if the id is not found in EITHER pending/ or scored/. */
export function readArchived(project: string, id: string): FleetPendingSession {
  const p = archivedPath(project, id)
  if (!existsSync(p)) die(`no pending or archived fleet session '${id}' — pending: [${listPending(project).join(", ")}]`)
  return JSON.parse(readFileSync(p, "utf-8")) as FleetPendingSession
}

export function archivePending(project: string, id: string): void {
  const dir = pendingDir(project)
  const scored = join(dir, "scored")
  mkdirSync(scored, { recursive: true })
  renameSync(join(dir, `${sanitize(id)}.json`), join(scored, `${sanitize(id)}.json`))
}

/** Stamps an archived session with the moment it was merge-scored — the
 * idempotency marker a second `--gate merge` on the same id refuses against
 * (score.ts). The record stays in place (scored/); this just rewrites it
 * in-place with the added field. */
export function markMergeScored(project: string, id: string): void {
  const p = archivedPath(project, id)
  const rec = JSON.parse(readFileSync(p, "utf-8")) as FleetPendingSession
  rec.mergeScoredAt = new Date().toISOString()
  writeJsonAtomic(p, rec)
}
