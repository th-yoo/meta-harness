/**
 * gate.ts — pure round-gating decision (decideGate), extracted from
 * crank.ts's main() so the FIX 1 (trial-clobber guard) and FIX 2
 * (cross-process proposer lock) skip branches are unit-testable without
 * spawning a proposer, touching Slack, or touching the real store.
 *
 * Also owns the km-crank-private round lock — a plain file next to
 * positions.json that guards against two crank.ts INVOCATIONS racing each
 * other (e.g. a manual `--force` run overlapping the scheduled launchd run).
 *
 * FIX 2 composition note (see the task brief): crank.ts does NOT call
 * host.stageArtifactApply to register its round. ClaudeCodeHost's
 * stageArtifactApply (cc-host.ts) writes the SAME lock-file format that
 * proposer.ts's applyPendingArtifacts scans on EVERY hook event (wired in
 * dispatch.ts: `await applyPendingArtifacts(host, cwd)` runs unconditionally
 * per hook). If crank.ts staged its descriptor there, a live interactive
 * Claude Code session working in the same worktree would fire a hook (any
 * hook — PostToolUse, Stop, ...), dispatch would scan the lock dir, see
 * crank's lock, find the primary staged artifact already on disk (crank
 * polls for exactly that file), and call applyStagedArtifact ITSELF — racing
 * crank's own poll-then-apply call to the very same function on the very
 * same staged files. applyStagedArtifact is not safe under that concurrent
 * double-entry (two createCandidate/startTrial calls for one staged
 * version, second one clobbering or erroring) — a real double-apply risk,
 * not a hypothetical one. So crank.ts only CHECKS
 * host.proposerInFlight?.(layer.root) (read-only — never registers itself in
 * that lock format) and instead takes THIS separate, crank-private lock for
 * mutual exclusion against itself. The residual race this leaves — a live CC
 * session's own /mh-propose starting between crank's proposerInFlight check
 * and crank's nextVersion() call — is accepted and documented in README.md
 * (small window; worst case two candidates land on the same layer with
 * adjacent version numbers, never a corrupted/double-applied one).
 */
import * as fs from "node:fs"
import * as path from "node:path"

export type GateDecision = "run" | "skip-threshold" | "skip-trial" | "skip-inflight"

export interface GateInput {
  /** --force CLI flag: bypasses the threshold/age gate only. */
  force: boolean
  /** Total new sensor lines pooled across all repos this round. */
  newCount: number
  /** THRESHOLD constant. */
  threshold: number
  /** positions.lastRunTs — 0 means "never completed a round". */
  lastRunTs: number
  /** MAX_AGE_DAYS window, in ms. */
  maxAgeMs: number
  /** Current epoch ms. */
  now: number
  /** FIX 1: readTrial(layer.root) !== null — a project-layer trial is
   * already live (started by an interactive session or a prior round). */
  trialInProgress: boolean
  /** FIX 2: host.proposerInFlight?.(layer.root) — a live CC session's own
   * proposer lock for this layer is currently in flight. */
  inFlight: boolean
}

/**
 * PURE. Priority order: threshold/age gate first (cheapest, and — unlike the
 * other two — meaningful even before a target repo/layer has been chosen),
 * then the trial-clobber guard (FIX 1), then the cross-process proposer
 * guard (FIX 2). All three skip outcomes are equivalent from the caller's
 * point of view: log one line, do NOT advance positions, do NOT post Slack,
 * exit 0 — only the outcome kind differs for the log message.
 */
export function decideGate(input: GateInput): GateDecision {
  const ageMs = input.now - input.lastRunTs
  const recentEnough = input.lastRunTs > 0 && ageMs < input.maxAgeMs
  if (!input.force && input.newCount < input.threshold && recentEnough) return "skip-threshold"
  if (input.trialInProgress) return "skip-trial"
  if (input.inFlight) return "skip-inflight"
  return "run"
}

// ── crank-private round lock ────────────────────────────────────────────────
// Lives at <root>/km-crank/crank.lock, alongside positions.json. Guards ONLY
// against two crank.ts processes racing each other — it is not a substitute
// for host.proposerInFlight (which guards against a live interactive CC
// session), and it is not consumed by proposer.ts's applyPendingArtifacts
// (different file, different format, on purpose — see the header note).

export interface CrankLock {
  pid: number
  startedAt: number
}

export function crankLockPath(root: string): string {
  return path.join(root, "km-crank", "crank.lock")
}

/** Corrupt/missing/wrong-shape -> null. Never throws (mirrors positions.ts's
 * readPositions contract). */
export function readCrankLock(root: string): CrankLock | null {
  try {
    const raw = fs.readFileSync(crankLockPath(root), "utf-8")
    const parsed = JSON.parse(raw) as Partial<CrankLock>
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return null
    return { pid: parsed.pid, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

/** PURE. A lock older than `staleAfterMs` is dead weight from a crashed or
 * killed crank process (its own `finally` never ran to release it) — treat
 * as absent so a wedged lock can never permanently block the crank. */
export function isCrankLockStale(lock: CrankLock, now: number, staleAfterMs: number): boolean {
  return now > lock.startedAt + staleAfterMs
}

/**
 * Attempt to take the round lock. Returns true iff acquired — either no live
 * lock existed, or the existing one was stale and got reclaimed. Atomic
 * temp+rename write, mirrors positions.ts's writePositionsAtomic. NOT a
 * kernel-level exclusive lock (no O_EXCL/flock) — crank.ts runs at most once
 * concurrently in practice (single launchd schedule + manual runs are rare
 * and interactive), so a check-then-write race between two crank.ts
 * processes is an accepted, documented residual (same class as the
 * nextVersion race noted above), not something this needs to close with a
 * heavier primitive.
 */
export function acquireCrankLock(root: string, now: number, staleAfterMs: number): boolean {
  const existing = readCrankLock(root)
  if (existing && !isCrankLockStale(existing, now, staleAfterMs)) return false
  const p = crankLockPath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = path.join(path.dirname(p), `.crank.lock.tmp-${process.pid}-${now}`)
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: now }))
  fs.renameSync(tmp, p)
  return true
}

/** Always safe to call even if the lock was never acquired (force: true). */
export function releaseCrankLock(root: string): void {
  fs.rmSync(crankLockPath(root), { force: true })
}
