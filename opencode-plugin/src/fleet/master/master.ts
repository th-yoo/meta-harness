/**
 * master/master.ts — the singleton daemon loop (§9.1, D8.1) + the wiring the
 * `master` CLI subcommand constructs. Assembles the deterministic tick from
 * the six sibling modules: reconcile persisted intent vs git truth ONCE on
 * startup (restart-safety BEFORE serving), then loop
 *   { relayTick (gate/status IO) → scheduler advance }
 * until an injected `until` seam says stop. The `until` seam replaces an
 * infinite `while(true)` so tests never spin forever and a real daemon gets a
 * clean shutdown hook.
 *
 * Singleton authority (D8.1): one logical master = one process, enforced by an
 * advisory lockfile created with O_EXCL semantics (`openSync(path, "wx")` — an
 * ATOMIC exclusive create, never a racy existsSync-then-write). A second live
 * launch dies. A stale-lock TTL-reclaim (reclaiming a lock whose owner is long
 * dead) is OPTIONAL / DEFERRED — not needed for the attended singleton this
 * plan targets; the pid is stamped into the lock so a later unattended
 * deployment has the hook it needs.
 *
 * Determinism invariant (binding): NO LLM in the master decision path.
 * `MasterDeps` exposes NO LLM seam — no driver, no model, no
 * cmdRoleRun-for-judgment. The whole loop is a pure function of durable state +
 * injected deterministic seams (transport / resumeSquad / sub / git /
 * removeWorktree / loadIntents / now). Any LLM-ish formulation (backlog→slice
 * text, gate-question phrasing) is delegated to a leaf node via the shipped
 * role-run/squad-run seam, never executed in-master.
 *
 * Crash-consistency (D9): every durable write the assembled modules make goes
 * through the shared `writeJsonAtomic` (temp+rename); this module adds only the
 * O_EXCL lock and consumes those atomic boundaries — it introduces no new
 * non-atomic write path.
 */
import { dirname, join } from "node:path"
import { openSync, closeSync, unlinkSync, writeSync, mkdirSync } from "node:fs"
import { die } from "../../bench/util.ts"
import { relayTick, type ResumeSquadFn, type RelayDeps } from "./relay.ts"
import { admit, type RunRequest, type SubScheduler } from "./scheduler.ts"
import { reconcile, type GitProbe, type CrashIntent } from "./reconcile.ts"
import type { Transport } from "./transport.ts"
import type { NamespaceRegistry } from "./namespace.ts"

export interface MasterDeps {
  masterRoot: string
  transport: Transport
  resumeSquad: ResumeSquadFn
  registry: NamespaceRegistry
  sub: SubScheduler
  git: GitProbe
  removeWorktree: (dir: string) => void
  /** Assembles the crash intents (one per in-flight DAG node, across every
   * registered project) that `reconcile` consumes on startup. This is where
   * persisted namespace/DAG state is turned into the `CrashIntent[]` input the
   * reconciler takes — added so reconcile-on-startup is BOTH wired and testable
   * (approved extension of the plan's MasterDeps). Defaults to `() => []`. */
  loadIntents?: () => CrashIntent[]
  /** The outward-action seam (self-hosting N2 push/PR), threaded straight into
   * the relay. Fires ONLY on a human approve that terminated a squad. NO LLM. */
  onApprovedTerminal?: RelayDeps["onApprovedTerminal"]
  now?: () => string
}

/** `<masterRoot>/.kkamak/runtime/master/master.lock` (N1b ledger
 * anchoring — under masterRoot, never a throwaway worktree). */
export function masterLockPath(masterRoot: string): string {
  return join(masterRoot, ".kkamak", "runtime", "master", "master.lock")
}

/**
 * Acquire the advisory singleton lock (D8.1). Uses `openSync(path, "wx")` —
 * O_EXCL: the create atomically fails if the lock already exists, so there is
 * no existsSync-then-write race. A live lock → `die("master already running")`.
 * Returns a release fn that unlinks the lock (idempotent — a double release or
 * an already-gone lock is a no-op).
 *
 * NOTE (deferred): a stale-lock TTL-reclaim (take over a lock whose stamped pid
 * is long dead) is intentionally NOT implemented here — the attended singleton
 * this plan targets never needs it. The pid stamp below is the hook for it.
 */
export function acquireSingletonLock(masterRoot: string): () => void {
  const p = masterLockPath(masterRoot)
  mkdirSync(dirname(p), { recursive: true })
  let fd: number
  try {
    fd = openSync(p, "wx") // O_EXCL exclusive create — atomic, no TOCTOU race
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") die("master already running")
    throw e
  }
  writeSync(fd, `${process.pid}\n`) // pid stamp for the deferred TTL-reclaim
  closeSync(fd)
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      unlinkSync(p)
    } catch {
      /* already released / never created — nothing to undo */
    }
  }
}

/**
 * One master iteration: relay gate/status IO, then advance the scheduler over
 * any queued ready requests under the global cap. The queued-request source is
 * empty for now (deterministic) — the backlog→RunRequest formulation is a
 * delegated leaf job (out of scope here), so admit runs against an empty set
 * and is a deterministic no-op until a real request source is injected.
 */
export async function masterTick(deps: MasterDeps): Promise<void> {
  await relayTick({
    masterRoot: deps.masterRoot,
    transport: deps.transport,
    resumeSquad: deps.resumeSquad,
    onApprovedTerminal: deps.onApprovedTerminal,
    now: deps.now,
  })
  const queued: RunRequest[] = []
  await admit({ registry: deps.registry, sub: deps.sub }, queued)
}

/**
 * The daemon loop. Reconciles persisted intent vs git truth ONCE before the
 * first tick (restart-safety before serving), then ticks until `until()`
 * returns true. `intervalMs` (optional) paces the real daemon between ticks;
 * tests omit it, keeping the loop tight and hermetic.
 */
export async function runMaster(
  deps: MasterDeps,
  opts: { until: () => boolean; intervalMs?: number },
): Promise<void> {
  const loadIntents = deps.loadIntents ?? (() => [])
  reconcile({
    masterRoot: deps.masterRoot,
    registry: deps.registry,
    intents: loadIntents(),
    git: deps.git,
    removeWorktree: deps.removeWorktree,
  })
  while (!opts.until()) {
    await masterTick(deps)
    if (opts.intervalMs && opts.intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs))
    }
  }
}
