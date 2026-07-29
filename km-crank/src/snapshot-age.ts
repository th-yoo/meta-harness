/**
 * snapshot-age.ts — per-host age (in days) of the committed sensor snapshot
 * for a repo, computed from the MAX numeric `ts` field found across that
 * host's evidence/kkamak-sensors/<host>/<basename>.{gate-outcomes,
 * trial-arms}.ndjson files (scripts/km-sensors-sync.sh's export layout) —
 * NEVER file mtime, which lies after a `git checkout`/`pull` (spec §7,
 * deferred from TM6 pending the snapshot layout, now built alongside
 * scripts/km-sensors-sync.sh, §11 items 8/9).
 *
 * Feeds `TrialSitrepDetail.snapshotAges` (sitrep.ts) via `TrialScanDeps`
 * (trial-verdict.ts) / crank.ts, same injectable-root shape as
 * positions.ts's `positionsPath(root)` — pure fs I/O, no globals.
 */
import * as fs from "node:fs"
import * as path from "node:path"

/** The two sensor files km-sensors-sync.sh exports per repo (mirrors
 * scripts/km-sensors-sync.sh's FILES list). */
const SENSOR_KINDS = ["gate-outcomes", "trial-arms"] as const

/** Max numeric `ts` across every ndjson line of `file`. Malformed JSON,
 * blank lines, and lines with a non-numeric/missing `ts` are silently
 * skipped (same tolerance discipline as scan.ts's parseSensorLines) — this
 * feeds a SITREP staleness note, not a hard contract. Returns null if the
 * file is absent or has no usable `ts` at all. */
function maxTs(file: string): number | null {
  let text: string
  try {
    text = fs.readFileSync(file, "utf-8")
  } catch {
    return null
  }
  let max: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as { ts?: unknown }
      if (typeof parsed.ts === "number" && (max === null || parsed.ts > max)) max = parsed.ts
    } catch {
      // skip malformed line
    }
  }
  return max
}

/**
 * Per-host snapshot age for `repo` under `evidenceRoot`
 * (evidence/kkamak-sensors in this repo). Only hosts that actually have
 * snapshot data for this repo's basename are included — a host directory
 * with no matching files is silently absent from the result (never a
 * fabricated 0-line/0-age entry). Sorted by host name for stable rendering.
 */
export function readSnapshotAges(
  evidenceRoot: string,
  repo: string,
  now: number,
): { host: string; ageDays: number }[] {
  let hostDirs: string[]
  try {
    hostDirs = fs
      .readdirSync(evidenceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const base = path.basename(repo)
  const out: { host: string; ageDays: number }[] = []
  for (const host of hostDirs) {
    let hostMax: number | null = null
    for (const kind of SENSOR_KINDS) {
      const m = maxTs(path.join(evidenceRoot, host, `${base}.${kind}.ndjson`))
      if (m !== null && (hostMax === null || m > hostMax)) hostMax = m
    }
    if (hostMax !== null) {
      out.push({ host, ageDays: (now - hostMax) / (24 * 60 * 60 * 1000) })
    }
  }
  out.sort((a, b) => a.host.localeCompare(b.host))
  return out
}
