// FileStateStore — one JSON file per session under <dirAbs>/<sanitized-id>.json.
//
// Durability contract (mirrors opencode-plugin/src/adapters/claude-code/file-state.ts):
//   - load() NEVER throws: absent, corrupt, wrong-shape, or unknown-`v` files all
//     read back as a fresh `{...INITIAL_STATE}` so a broken/tampered file can never
//     break a hook.
//   - save() stamps updatedAt, then either deletes the file (state is
//     initial-equivalent — absent == initial, so we don't litter the dir with
//     empty files) or writes atomically (same-dir tmp file + renameSync) so a
//     concurrent reader — or a process killed mid-write — never observes a torn
//     file. save() is allowed to throw; hook-cli treats a persist failure as
//     fail-open and must see the real error, so we do not swallow it here.
//   - sweep() is rate-limited via a `.last-swept` DOTFILE (never `*.json`, so it
//     is never mistaken for session state, parsed, or deleted by the sweep
//     itself) and never throws.
import fs from "node:fs"
import path from "node:path"
import { type CcGateState, INITIAL_STATE, isInitialState, type StateStore } from "./types.ts"

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000
const LAST_SWEPT_FILE = ".last-swept"

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

export class FileStateStore implements StateStore {
  constructor(readonly dirAbs: string) {}

  private statePath(sessionId: string): string {
    return path.join(this.dirAbs, `${sanitizeSessionId(sessionId)}.json`)
  }

  load(sessionId: string): CcGateState {
    const p = this.statePath(sessionId)
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

  save(sessionId: string, s: CcGateState): void {
    const stamped: CcGateState = { ...s, updatedAt: Date.now() }
    const p = this.statePath(sessionId)

    if (isInitialState(stamped)) {
      // absent == initial: delete rather than write an equivalent-to-empty file.
      try {
        fs.rmSync(p, { force: true })
      } catch {
        // force:true already swallows ENOENT; anything else (e.g. EPERM) is a
        // real persist failure and must propagate per the save() contract.
      }
      return
    }

    fs.mkdirSync(this.dirAbs, { recursive: true })
    const tmp = path.join(
      this.dirAbs,
      `.${path.basename(p)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    )
    fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2) + "\n")
    fs.renameSync(tmp, p)
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
      // rate-limits the next run.
      fs.mkdirSync(this.dirAbs, { recursive: true })
      fs.writeFileSync(markerPath, "")

      let entries: string[]
      try {
        entries = fs.readdirSync(this.dirAbs)
      } catch {
        return
      }

      for (const name of entries) {
        if (!name.endsWith(".json")) continue // never touches .last-swept (not *.json)
        const full = path.join(this.dirAbs, name)
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
      }
    } catch {
      // sweep() never throws to the caller.
    }
  }
}
