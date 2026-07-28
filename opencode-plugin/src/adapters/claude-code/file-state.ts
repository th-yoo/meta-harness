/**
 * adapters/claude-code/file-state.ts
 *
 * FileSessionStateStore — a `SessionStateStore` (engine.ts) backed by one JSON
 * file per session. It exists because Claude Code drives the EvolutionEngine
 * from SHORT-LIVED hook processes (one `bun hook-cli.ts <event>` invocation per
 * hook event): the in-memory `InMemorySessionStateStore` the opencode plugin
 * uses cannot carry a session's capture state from one hook process to the next,
 * so the state must live on disk.
 *
 * Layout: `<accountMetaRoot()>/runtime/cc/<session_id>.json`. Using the L5 lazy
 * `accountMetaRoot()` resolver means tests get hermeticity for free (they set
 * `KKAMAK_HOME` to a tmp dir; nothing ever touches the real ~/.config).
 *
 * Durability / safety contract (the adapter's prime directive: a broken hook
 * must NEVER break a user's normal CC session):
 *   - writes are atomic (same-dir temp file + rename, via bench/util's
 *     writeJsonAtomic) so a concurrent reader — or a process killed mid-write —
 *     never observes a torn file;
 *   - a missing OR corrupt file reads back as `undefined` (treated as "no state
 *     yet"), with a best-effort warning; it never throws into the hook.
 */

import fs from "node:fs"
import path from "node:path"
import { accountMetaRoot } from "../../harness-store.ts"
import { writeJsonAtomic } from "../../bench/util.ts"
import type { SessionState, SessionStateStore } from "../../engine.ts"

/** `<accountMetaRoot()>/runtime/cc` — resolved fresh on every call (mirrors the
 * L5 lazy account-root convention, so KKAMAK_HOME re-stubbing in tests is
 * honored without a cached import-time constant). */
export function ccRuntimeDir(): string {
  return path.join(accountMetaRoot(), "runtime", "cc")
}

/** Filesystem-safe per-session state path. session_id is a UUID in practice;
 * the sanitize is a defensive belt so a hostile/malformed id can never escape
 * the runtime dir (no `..`, no path separators). */
export function sessionStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "_"
  return path.join(ccRuntimeDir(), `${safe}.json`)
}

export class FileSessionStateStore implements SessionStateStore {
  /** `warn` defaults to stderr; the hook-cli passes its host logger so corrupt
   * -file warnings land in the same place as every other adapter log. */
  constructor(private readonly warn: (msg: string) => void = (m) => console.error(m)) {}

  get(id: string): SessionState | undefined {
    const p = sessionStatePath(id)
    let raw: string
    try {
      raw = fs.readFileSync(p, "utf-8")
    } catch {
      return undefined // absent → no state yet (the common first-touch case)
    }
    try {
      return JSON.parse(raw) as SessionState
    } catch {
      // Corrupt file (e.g. a crash between open and rename on a non-atomic
      // legacy write, or manual tampering): treat as absent so the session
      // starts clean rather than crashing the hook. Warn but never throw.
      this.warn(`[cc-file-state] corrupt session-state file, treating as absent: ${p}`)
      return undefined
    }
  }

  put(id: string, s: SessionState): void {
    writeJsonAtomic(sessionStatePath(id), s)
  }

  delete(id: string): void {
    try {
      fs.rmSync(sessionStatePath(id), { force: true })
    } catch {
      // force:true already swallows ENOENT; guard anything else (e.g. EPERM)
      // so cleanup can never break a hook.
    }
  }
}
