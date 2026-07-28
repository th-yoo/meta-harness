/**
 * adapters/claude-code/proposer.ts
 *
 * The Claude Code half of the proposer/promoter/curator transport (Task L8):
 * the LOCK FILE + apply-on-next-event machinery that makes a detached child's
 * staged artifact land even though the hook process that spawned it is long
 * gone.
 *
 * Why this exists: on opencode, triggerPropose runs in the long-lived plugin
 * process — it spawns the child, then polls waitForFile and applies inline. On
 * Claude Code, triggerPropose runs inside a SHORT-LIVED hook process that exits
 * seconds after spawning the child; nobody is left to poll. So instead:
 *
 *   1. At spawn time, triggerPropose hands the descriptor to
 *      host.stageArtifactApply → writeProposerLock writes a lock file under
 *      `<worktree>/.kkamak/proposer-locks/<sanitized-root>.json`. That
 *      file's presence IS the cross-process "in flight" marker (proposerInFlight)
 *      that replaces propose.ts's in-memory `inFlight` Set (useless across
 *      processes), and it carries the full descriptor needed to apply later.
 *
 *   2. On EVERY subsequent hook event (any session, any type), dispatch calls
 *      applyPendingArtifacts, which scans the lock dir and, for each lock whose
 *      child has now written its primary artifact, runs the shared
 *      applyStagedArtifact (propose.ts) — creating the candidate/trial exactly
 *      as the opencode inline path would. A lock whose child never produced an
 *      artifact within its timeout horizon is reclaimed (stale expiry) so a
 *      crashed child can never wedge the layer.
 *
 * Prime directive: nothing here throws into the hook — every filesystem touch is
 * guarded; a corrupt lock is logged and removed, an apply failure is logged and
 * skipped, and the whole scan is a no-op when the lock dir is absent.
 */

import fs from "node:fs"
import path from "node:path"
import type { HarnessHost, StagedArtifactDescriptor } from "../../host.ts"
import { applyStagedArtifact } from "../../propose.ts"

/** `<worktree>/.kkamak/proposer-locks` — locks live in the worktree (that
 * is where /mh-propose is issued and where the staging files are written, even
 * for account-layer candidates whose store root is elsewhere). */
export function proposerLocksDir(worktree: string): string {
  return path.join(worktree, ".kkamak", "proposer-locks")
}

/** Filesystem-safe lock filename keyed by store ROOT — one live cycle per root,
 * mirroring propose.ts's `inFlight` Set semantics (a propose and a curate on the
 * same root can't run at once; different roots are independent). */
function sanitizeRoot(root: string): string {
  return root.replace(/[^A-Za-z0-9._-]/g, "_") || "_"
}

export function proposerLockPath(worktree: string, root: string): string {
  return path.join(proposerLocksDir(worktree), `${sanitizeRoot(root)}.json`)
}

/** Persist a descriptor as the lock for its layer root. Atomic (temp + rename)
 * so a concurrent scan never reads a torn file. */
export function writeProposerLock(d: StagedArtifactDescriptor): void {
  const p = proposerLockPath(d.worktree, d.layer.root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(d))
  fs.renameSync(tmp, p)
}

function readProposerLock(p: string): StagedArtifactDescriptor | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as StagedArtifactDescriptor
  } catch {
    return null
  }
}

/** A lock is stale once its child's give-up horizon (spawnedAt + timeoutMs) has
 * passed — timestamp-based (robust across resume) rather than pid liveness. */
function isStale(d: StagedArtifactDescriptor, now: number): boolean {
  return now > d.spawnedAt + d.timeoutMs
}

/**
 * Cross-process in-flight guard (backs ClaudeCodeHost.proposerInFlight). True
 * iff a live (non-stale) lock exists for `root`. A stale lock reads as NOT in
 * flight so the next /mh-propose can reclaim the layer (applyPendingArtifacts
 * removes the stale file on its own next pass).
 */
export function proposerInFlight(worktree: string, root: string, now: number = Date.now()): boolean {
  const d = readProposerLock(proposerLockPath(worktree, root))
  if (!d) return false
  return !isStale(d, now)
}

/**
 * Apply-on-next-event scan: for every proposer lock in the worktree, apply its
 * staged artifact if the child has written it (removing the lock), or reclaim
 * the lock if the child timed out. Called by dispatch on every hook event.
 * Never throws.
 */
export async function applyPendingArtifacts(
  host: HarnessHost,
  worktree: string,
  now: number = Date.now(),
): Promise<void> {
  const dir = proposerLocksDir(worktree)
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
  } catch {
    return // no lock dir → nothing pending (the common case)
  }

  for (const f of files) {
    const p = path.join(dir, f)
    try {
      const d = readProposerLock(p)
      if (!d) {
        // Corrupt/half-written lock — can't apply; remove so it can't wedge.
        await host.log("warn", `[cc-proposer] corrupt proposer lock ${p} — removing`)
        fs.rmSync(p, { force: true })
        continue
      }

      const result = await applyStagedArtifact(host, d)
      if (result === "applied") {
        fs.rmSync(p, { force: true })
        await host.log("info", `[cc-proposer] applied ${d.kind} ${d.layer.scope} ${d.version} — lock cleared`)
      } else if (isStale(d, now)) {
        // Child never produced its artifact within the horizon — reclaim.
        host.notify(`${d.kind} timed out for ${d.layer.scope} — nothing created`, "warning", 5_000)
        fs.rmSync(p, { force: true })
        await host.log("warn", `[cc-proposer] stale ${d.kind} lock for ${d.layer.scope} ${d.version} — reclaimed`)
      }
      // else: still pending within horizon — leave the lock for a later event.
    } catch (err) {
      // A single bad lock must never break the hook (prime directive).
      await host.log("warn", `[cc-proposer] apply failed for ${p} (swallowed): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
