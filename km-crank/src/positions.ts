/**
 * positions.ts — the crank's resumption state: how far it has read into each
 * dogfooded repo's sensor file, plus when it last completed a round.
 *
 * Store: <accountMetaRoot()>/km-crank/positions.json. Host-local by design
 * (this is exactly the ".kkamak/ runtime store" class of state
 * CLAUDE.md calls out as non-shareable — it never needs to travel between
 * hosts; each host tracks its own sensor-file offsets independently).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { accountMetaRoot } from "../../opencode-plugin/src/harness-store.ts"

export interface PositionFileEntry {
  /** Byte offset into the sensor ndjson file already consumed. */
  offset: number
}

export interface Positions {
  /** Keyed by absolute sensor-file path. */
  files: Record<string, PositionFileEntry>
  /** Epoch ms the crank last completed a round (skip decisions use this —
   * NOT advanced on a skip or a proposer timeout, only on a completed round). */
  lastRunTs: number
}

export const EMPTY_POSITIONS: Positions = { files: {}, lastRunTs: 0 }

export function positionsPath(root: string = accountMetaRoot()): string {
  return path.join(root, "km-crank", "positions.json")
}

/** Corrupt, missing, or shape-mismatched → EMPTY_POSITIONS. Never throws. */
export function readPositions(root: string = accountMetaRoot()): Positions {
  try {
    const raw = fs.readFileSync(positionsPath(root), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>)["files"] !== "object" ||
      (parsed as Record<string, unknown>)["files"] === null ||
      typeof (parsed as Record<string, unknown>)["lastRunTs"] !== "number"
    ) {
      return { files: {}, lastRunTs: 0 }
    }
    const rawFiles = (parsed as { files: Record<string, unknown> }).files
    const files: Record<string, PositionFileEntry> = {}
    for (const [k, v] of Object.entries(rawFiles)) {
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>)["offset"] === "number") {
        files[k] = { offset: (v as Record<string, unknown>)["offset"] as number }
      }
    }
    return { files, lastRunTs: (parsed as { lastRunTs: number }).lastRunTs }
  } catch {
    return { files: {}, lastRunTs: 0 }
  }
}

/** mkdir -p + write-to-tmp + rename — never a torn/partial positions.json. */
export function writePositionsAtomic(positions: Positions, root: string = accountMetaRoot()): void {
  const p = positionsPath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = path.join(path.dirname(p), `.positions.json.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(positions, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, p)
}
