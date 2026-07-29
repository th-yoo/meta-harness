/**
 * sensor-union.ts — §7 cross-host union verdict input (final review item 3).
 *
 * The verdict engine's original wiring fed `evaluateGateTrial` only the live
 * `.km/{gate-outcomes,trial-arms}.ndjson` of the trial's OWN repo — missing
 * every OTHER host's committed snapshot under evidence/kkamak-sensors/<host>/
 * (scripts/km-sensors-sync.sh's export layout, the same layout snapshot-
 * age.ts already reads for staleness). Spec §7 registers cross-host union
 * ("a union of partial snapshots buys additional N, it does not skew the
 * split"), and `TrialEvaluationInput`'s own doc already promised "union of
 * repos/hosts" — this module is what makes that true.
 *
 * The union happens at the RAW LINE level, deduped by full raw-line identity
 * BEFORE parsing — the sync script's registered dedupe discipline:
 * byte-identical lines are the same observation, not two.
 */
import * as fs from "node:fs"
import * as path from "node:path"

export type SensorSnapshotKind = "gate-outcomes" | "trial-arms"

/**
 * Raw non-blank trimmed lines from every host's committed snapshot file of
 * `kind` for `repo`, under `evidenceRoot`. Missing evidenceRoot, a missing
 * host dir, or a host with no matching file all degrade to "no lines" for
 * that host — never throws (same tolerance discipline as snapshot-age.ts's
 * maxTs — this feeds a verdict input, not a hard contract on snapshot
 * presence).
 */
function snapshotRawLines(evidenceRoot: string, repo: string, kind: SensorSnapshotKind): string[] {
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
  const out: string[] = []
  for (const host of hostDirs) {
    let text: string
    try {
      text = fs.readFileSync(path.join(evidenceRoot, host, `${base}.${kind}.ndjson`), "utf-8")
    } catch {
      continue
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line) out.push(line)
    }
  }
  return out
}

/**
 * Union `liveText`'s raw ndjson lines with every host's committed snapshot
 * of `kind` for `repo`, deduped by full raw-line identity — a line present
 * in both the live file and a snapshot (or in more than one host's
 * snapshot) counts exactly once. Live lines come first (stable order for
 * the common all-local case); snapshot-only lines are appended after, in
 * host-directory-listing order. No evidenceRoot / no matching snapshot
 * files at all → the result is exactly the live lines (deduped against
 * themselves) — IDENTICAL to reading the live file alone.
 */
export function unionRawLines(
  evidenceRoot: string,
  repo: string,
  kind: SensorSnapshotKind,
  liveText: string,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of liveText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  for (const line of snapshotRawLines(evidenceRoot, repo, kind)) {
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}
