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
}

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_")

export function pendingDir(project: string): string {
  return join(project, ".meta-harness", "runtime", "fleet")
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

export function archivePending(project: string, id: string): void {
  const dir = pendingDir(project)
  const scored = join(dir, "scored")
  mkdirSync(scored, { recursive: true })
  renameSync(join(dir, `${sanitize(id)}.json`), join(scored, `${sanitize(id)}.json`))
}
