// FileStateStore — one JSON file per session under <dirAbs>/<sanitized-id>.json.
//
// Durability contract (CAS port of ~/z2/kkamak/src/runtime/file-state-store.ts):
//   - load() NEVER throws: absent, corrupt, wrong-shape, or unknown-`v` files all
//     read back as a fresh `{...INITIAL_STATE}` so a broken/tampered file can never
//     break a hook.
//   - save() is compare-and-swap: it re-reads what is on disk right before
//     committing and refuses (throws StaleWriteError) when the on-disk
//     updatedAt no longer matches the caller's expectedUpdatedAt — a newer
//     write landed first, and blindly overwriting it is the lost-update race
//     this store exists to prevent. The commit stamps a MONOTONIC updatedAt
//     (max(now, current+1)), then either deletes the file (state is
//     initial-equivalent — absent == initial, so we don't litter the dir) or
//     writes atomically (same-dir tmp file + renameSync) so a concurrent
//     reader — or a process killed mid-write — never observes a torn file.
//     save() is allowed to throw (ENOSPC, EPERM, StaleWriteError alike);
//     hook-cli treats any persist failure as fail-open and must see the real
//     error, so nothing is swallowed here — including the delete path.
//   - save()'s whole read-modify-write runs under a best-effort lockfile
//     (withLock): two concurrent save() calls for the same session serialize
//     instead of racing to land in the gap between one's compare-and-swap
//     read and its rename. Lock acquisition is bounded and degrades to
//     running unlocked (still CAS-protected) — a lock must never wedge a
//     session.
//   - saveResetWithRetry() is the reset-path wrapper: a reset represents
//     unconditional intent (the cycle is over, full stop), so a lost race
//     retries ONCE against freshly loaded state; a second loss is logged and
//     left alone (fail-open still governs). Never throws.
//   - sweep() is rate-limited via a `.last-swept` DOTFILE (never `*.json`, so
//     it is never mistaken for session state, parsed, or deleted by the sweep
//     itself) and never throws. Each deletion runs under a NON-BLOCKING
//     tryLock with staleness re-verified inside the held lock — sweep's
//     rmSync has no CAS backstop, so unlike save() it must never fall
//     through to running unlocked; an unavailable lock skips that file.
import fs from "node:fs"
import path from "node:path"
import { type CcGateState, INITIAL_STATE, isInitialState, type StateStore } from "./types.ts"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const LAST_SWEPT_FILE = ".last-swept"

/**
 * How long save() spins trying to acquire the lockfile before giving up and
 * running its critical section unlocked instead (still compare-and-swap
 * protected — see withLock's doc comment). The critical section is a handful
 * of synchronous fs calls with no awaits in it, so real contention should
 * clear in well under this; it exists as a bound, not a target.
 */
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 500

/**
 * How old a lockfile has to be before it's treated as abandoned by a killed
 * process rather than a live critical section, and reclaimed rather than
 * waited out. Comfortably longer than any real critical section could take.
 */
const DEFAULT_LOCK_STALE_MS = 2_000

/** Thrown by save() when the on-disk updatedAt no longer matches the
 * caller's expected value — a newer write landed first. Typed so tests can
 * assert the refusal class; production callers stay failure-agnostic (any
 * save() throw is the same fail-open, "exactly like ENOSPC"). */
export class StaleWriteError extends Error {}

/** Filesystem-safe per-session id: no path separators, no `..` escapes. */
function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_")
  return safe || "_"
}

/** Structural check that a parsed JSON value matches the frozen CcGateState
 * shape at v1. Anything else (wrong types, missing fields, unknown `v`) is
 * treated the same as "corrupt" by the caller: fresh initial state. */
function isValidState(x: unknown): x is CcGateState {
  if (typeof x !== "object" || x === null) return false
  const s = x as Record<string, unknown>
  return (
    s.v === 1 &&
    typeof s.edited === "boolean" &&
    typeof s.gating === "boolean" &&
    typeof s.round === "number" &&
    Array.isArray(s.outcomes) &&
    typeof s.cycleStartedAt === "number" &&
    typeof s.failStreak === "number" &&
    typeof s.updatedAt === "number"
  )
}

/** Avoids depending on the ambient NodeJS.ErrnoException type. */
function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined
}

/**
 * True if `pid` exists, or if it exists but signalling it is not permitted
 * (a different user's process — still alive, just unconfirmable further).
 * False only on a confirmed ESRCH: no such process. Signal 0 sends nothing;
 * it only probes for existence and permission.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) !== "ESRCH"
  }
}

/**
 * The reset-path persist wrapper (port of kkamak gate.ts resetWithRetry +
 * persist()'s fail-open doctrine). A reset is unconditional intent — the
 * cycle is over, full stop — so silently dropping it on a lost race would
 * leave gating/round stuck for an unrelated later cycle to inherit. One
 * retry against freshly loaded state, not a loop: fail-open still governs,
 * so a second lost race (a third writer in the narrow gap between the
 * retry's own load and its save) is logged and left alone rather than
 * chased further. Never throws.
 */
export function saveResetWithRetry(
  store: StateStore,
  sessionId: string,
  next: CcGateState,
  expectedUpdatedAt: number,
  log: (msg: string) => void,
): void {
  try {
    store.save(sessionId, next, expectedUpdatedAt)
  } catch {
    try {
      const fresh = store.load(sessionId)
      store.save(sessionId, next, fresh.updatedAt)
    } catch (err) {
      log(`cc-gate: reset persist failed twice for ${sessionId}, leaving state as-is: ${String(err)}`)
    }
  }
}

export class FileStateStore implements StateStore {
  constructor(
    readonly dirAbs: string,
    private readonly lockAcquireTimeoutMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    private readonly lockStaleMs = DEFAULT_LOCK_STALE_MS,
  ) {}

  private statePath(sessionId: string): string {
    return path.join(this.dirAbs, `${sanitizeSessionId(sessionId)}.json`)
  }

  load(sessionId: string): CcGateState {
    return this.readRecord(this.statePath(sessionId))
  }

  private readRecord(p: string): CcGateState {
    let raw: string
    try {
      raw = fs.readFileSync(p, "utf-8")
    } catch {
      return { ...INITIAL_STATE } // absent → fresh state
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isValidState(parsed)) return { ...INITIAL_STATE } // wrong-shape / unknown v
      return parsed
    } catch {
      return { ...INITIAL_STATE } // corrupt JSON
    }
  }

  save(sessionId: string, s: CcGateState, expectedUpdatedAt: number): void {
    // mkdir BEFORE lock acquisition (kkamak parity): a first-ever save into a
    // nonexistent dir would otherwise fail the lockfile create with ENOENT
    // and silently degrade to unlocked at the single highest-contention
    // moment — a fresh session's parallel first edits.
    fs.mkdirSync(this.dirAbs, { recursive: true })
    const p = this.statePath(sessionId)
    this.withLock(p, () => this.commit(p, sessionId, s, expectedUpdatedAt))
  }

  /**
   * The compare-and-swap read, the decision, and the commit (write or
   * delete) — the whole read-modify-write withLock() holds a lock across,
   * not just the final write.
   */
  private commit(p: string, sessionId: string, s: CcGateState, expectedUpdatedAt: number): void {
    // Compare-and-swap: re-read what is actually on disk right before
    // committing. A check can run for minutes (checkTimeoutMs), so a caller
    // sitting on a load() from before that wait started is exactly the stale
    // writer this guards against — it must not blindly overwrite whatever
    // landed while it waited.
    const current = this.readRecord(p)
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new StaleWriteError(
        `stale write refused for session ${sessionId}: expected updatedAt ` +
          `${expectedUpdatedAt}, found ${current.updatedAt} on disk — a newer write landed first`,
      )
    }

    // Monotonic, not just "now": two saves inside one burst (or a clock that
    // hasn't ticked a full ms) must never stamp the same updatedAt, or the
    // very next compare-and-swap would be fooled by its own prior write.
    const stamped: CcGateState = { ...s, updatedAt: Math.max(Date.now(), current.updatedAt + 1) }

    // Absent entirely: current is {...INITIAL_STATE} (updatedAt 0), which is
    // exactly what expectedUpdatedAt === 0 just matched — the sentinel for
    // "no record existed at load time" and "no record exists now" are the
    // same value on purpose, so a first-ever save needs no special case.

    // Initial-equivalent: absent already means initial, so writing an
    // equivalent-to-empty record would only litter the directory — delete
    // instead. Runs under the same lock and after the same compare-and-swap
    // as the write path, so a stale reset can no longer delete a concurrent
    // writer's real progress out from under it. No try/catch: a real delete
    // failure (EPERM) is a real persist failure and propagates per the
    // save() contract (force:true already swallows ENOENT).
    if (isInitialState(stamped)) {
      fs.rmSync(p, { force: true })
      return
    }

    const tmp = path.join(
      this.dirAbs,
      `.${path.basename(p)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    )
    fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2) + "\n")
    fs.renameSync(tmp, p)
  }

  /**
   * Best-effort mutual exclusion around commit()'s whole read-modify-write,
   * so two concurrent save() calls for the same session can never interleave
   * one's compare-and-swap read with the other's rename. Lockfile via atomic
   * O_CREAT|O_EXCL create ("wx") — Node's fs exposes no real flock without a
   * native addon.
   *
   * Absolute constraint: a lock that cannot be acquired, a stale lock left
   * by a killed process, or a filesystem that rejects the lock operation
   * outright must never wedge a session. Acquisition is bounded
   * (lockAcquireTimeoutMs); a lock is reclaimed only once it is both older
   * than lockStaleMs AND its recorded holder pid is confirmed dead (see
   * reclaimIfStale); any acquisition failure falls through to running the
   * critical section UNLOCKED rather than throwing or waiting indefinitely.
   * Unlocked is not unsafe here: commit()'s own compare-and-swap still
   * applies. NOTE this fall-through is exactly why sweep() must NOT use
   * withLock — its rmSync has no CAS backstop (see tryLock).
   */
  private withLock<T>(p: string, run: () => T): T {
    const lockPath = `${p}.lock`
    const deadline = Date.now() + this.lockAcquireTimeoutMs
    let locked = false

    do {
      try {
        // Atomic create-and-write: the pid is what lets a later, stalled
        // acquire attempt distinguish an abandoned lock from a merely slow
        // one (see reclaimIfStale), instead of guessing by age alone.
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" })
        locked = true
      } catch (err) {
        if (errorCode(err) !== "EEXIST") break // locking unavailable here — degrade now
        this.reclaimIfStale(lockPath)
      }
    } while (!locked && Date.now() < deadline)

    if (!locked) return run()

    try {
      return run()
    } finally {
      fs.rmSync(lockPath, { force: true })
    }
  }

  /**
   * NON-BLOCKING acquire for sweep: one "wx" attempt, no spin, no reclaim,
   * and — the load-bearing difference from withLock — NO fall-through to
   * running unlocked. sweep()'s rmSync has no compare-and-swap backstop, so
   * falling through unlocked would reopen the exact fresh-write-deleted
   * TOCTOO this lock closes; an unavailable lock means "skip this file this
   * round" (sweep is best-effort hygiene, a later pass catches it). No
   * reclaim is deliberate too: reclaim-then-rmSync on a just-stolen lock
   * would need its own correctness argument; the accepted residual (a
   * crash-abandoned lock makes that one record un-sweepable until a future
   * save() reclaims it via withLock) is a slow hygiene leak, not data loss.
   */
  private tryLock(p: string): boolean {
    try {
      fs.writeFileSync(`${p}.lock`, String(process.pid), { flag: "wx" })
      return true
    } catch {
      return false
    }
  }

  /**
   * Reclaims a lock only when BOTH hold: it is older than lockStaleMs, AND
   * the pid recorded in it no longer exists (process.kill(pid, 0) throws
   * ESRCH). Age alone is not enough — a holder can be merely slow rather
   * than dead (disk stall, scheduler preemption), and stealing a live
   * holder's lock lets two commit() calls run concurrently, both passing
   * their own compare-and-swap: the exact lost update this lock prevents.
   * If the pid cannot be read or parsed, the lock is left alone — the
   * bounded acquire timeout in withLock is what keeps that from wedging.
   *
   * Residual: pid reuse. If a holder crashes and the OS later recycles that
   * exact pid to an unrelated live process, the lock is never reclaimed
   * here — the bounded acquire timeout keeps that case from wedging too, at
   * the cost of a full lockAcquireTimeoutMs stall per save() until the
   * recycled pid itself exits. Untestable by construction (a pid recycle
   * cannot be forced deterministically); documented rather than pinned.
   */
  private reclaimIfStale(lockPath: string): void {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs
      if (age <= this.lockStaleMs) return

      const holder = Number.parseInt(fs.readFileSync(lockPath, "utf-8"), 10)
      if (Number.isNaN(holder) || isProcessAlive(holder)) return

      fs.rmSync(lockPath, { force: true })
    } catch {
      // Gone already, or unreadable — either way the next loop iteration's
      // own open attempt settles it.
    }
  }

  sweep(nowMs: number): void {
    try {
      // Never litter a directory that has no state in it: a Stop hook fires
      // in every repo (gated or not), so bail BEFORE any mkdir/marker-write
      // if this store's dir was never created (nothing ever armed the gate
      // here). This keeps sweeping alive for any repo that ever armed state
      // while not creating .km/cc-gate in untouched cwds.
      if (!fs.existsSync(this.dirAbs)) return

      const markerPath = path.join(this.dirAbs, LAST_SWEPT_FILE)

      let markerMtimeMs: number | undefined
      try {
        markerMtimeMs = fs.statSync(markerPath).mtimeMs
      } catch {
        markerMtimeMs = undefined // no marker yet → not rate-limited
      }

      if (markerMtimeMs !== undefined && nowMs - markerMtimeMs < ONE_HOUR_MS) {
        return // swept recently; skip
      }

      // Touch (create-or-update) the marker first so a crash mid-sweep still
      // rate-limits the next run. (The check-and-touch pair is unguarded:
      // two concurrent Stops can both pass it and double-run a pass — benign
      // under the per-file tryLock below, costing only a duplicate scan.)
      fs.mkdirSync(this.dirAbs, { recursive: true })
      fs.writeFileSync(markerPath, "")

      let entries: string[]
      try {
        entries = fs.readdirSync(this.dirAbs)
      } catch {
        return
      }

      for (const name of entries) {
        if (!name.endsWith(".json")) continue // never touches .last-swept or *.lock
        const full = path.join(this.dirAbs, name)
        if (!this.tryLock(full)) continue // held by a live writer — skip this round
        try {
          // Staleness decided INSIDE the held lock, immediately before the
          // delete: a fresh write that landed between the directory scan and
          // this point re-dates the file and survives.
          let updatedAt: number | undefined
          try {
            const raw = fs.readFileSync(full, "utf-8")
            const parsed: unknown = JSON.parse(raw)
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              typeof (parsed as Record<string, unknown>).updatedAt === "number"
            ) {
              updatedAt = (parsed as Record<string, unknown>).updatedAt as number
            }
          } catch {
            updatedAt = undefined // unparseable → fall back to file mtime
          }

          if (updatedAt === undefined) {
            try {
              updatedAt = fs.statSync(full).mtimeMs
            } catch {
              continue // file vanished; nothing to do
            }
          }

          if (nowMs - updatedAt > SEVEN_DAYS_MS) {
            try {
              fs.rmSync(full, { force: true })
            } catch {
              // best-effort cleanup only
            }
          }
        } finally {
          fs.rmSync(`${full}.lock`, { force: true })
        }
      }
    } catch {
      // sweep() never throws to the caller.
    }
  }
}
