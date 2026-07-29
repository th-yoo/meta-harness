/**
 * trial-arm.ts — §4.3 salted arm assignment + exposure log (prerequisite build
 * item §11 #1/#2, docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-
 * preregistration.md §2/§3).
 *
 * Salt rationale (§3): `arm = FNV-1a("${trialId}:${sessionID}") % 2`. Hashing
 * sessionID alone would make this trial's arm collinear with the live
 * reinject experiment's arm (`hash(sessionID) % 2`, cc-gate-plugin/src/
 * reinject.ts:29-51) — every session would land in the same arm on both
 * axes, so an effect on one axis could be mistaken for the other's. The
 * trialId is a required salt to decorrelate the two axes.
 *
 * FNV-1a here is a REIMPLEMENTATION of cc-gate-plugin/src/reinject.ts:30-37,
 * not an import — cc-gate-plugin → opencode-plugin is the wrong import
 * direction (opencode-plugin already depends on cc-gate-plugin's types, not
 * the reverse). The constants (0x811c9dc5, 0x01000193, Math.imul >>> 0) are
 * copied byte-for-byte; a divergent hash impl here would be a defect
 * (plan Global Constraints). `fnv1a` is exported so trial-arm.test.ts can
 * assert identity against reinject.ts's own hash on shared sample strings.
 *
 * Exposure log (§2): `.km/trial-arms.ndjson` under the project cwd, sibling
 * of `.km/gate-outcomes.ndjson`. One row per session. The appender dedupes
 * on ANY existing row for a sessionID — under any trialId — not just the
 * exact (sessionID, trialId) composite key: a resumed session would
 * otherwise be silently re-enrolled into a later trial under a fresh key,
 * even though its harness text was composed under an earlier one (§2, the
 * resumed-session re-enrollment trap).
 */
import * as fs from "fs"
import * as path from "path"

export type TrialArm = "baseline" | "trial"

export interface ExposureRow {
  ts: number
  sessionID: string
  trialId: string
  layer: string // scope, e.g. "project-global"
  arm: TrialArm
  forced: boolean
}

/** FNV-1a: identical constants/steps to cc-gate-plugin/src/reinject.ts:30-37
 * (a second divergent hash implementation is a defect, not a variant). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Arm for (trialId, sessionID). Deterministic — same pair always yields the
 * same arm, matching reinject's per-session-stability rationale (§3).
 * `KKAMAK_TRIAL_ARM` mirrors `KKAMAK_REINJECT` (reinject.ts:44-51) but here
 * an invalid/unset value falls through to the hash path with `forced:false`
 * — only the two literal values "baseline"/"trial" force (NOT v0/v1, which
 * is the reinject axis's own vocabulary, not this one's).
 */
export function pickTrialArm(
  trialId: string,
  sessionID: string,
  env: NodeJS.ProcessEnv = process.env,
): { arm: TrialArm; forced: boolean } {
  const forced = env["KKAMAK_TRIAL_ARM"]
  if (forced === "baseline" || forced === "trial") return { arm: forced, forced: true }
  const arm: TrialArm = fnv1a(`${trialId}:${sessionID}`) % 2 === 0 ? "baseline" : "trial"
  return { arm, forced: false }
}

function exposureFilePath(cwd: string): string {
  return path.join(cwd, ".km", "trial-arms.ndjson")
}

/** Type-guard for one parsed ndjson line — tolerant parse skips anything
 * that doesn't shape up as a full ExposureRow. */
function isExposureRow(v: unknown): v is ExposureRow {
  if (v === null || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return (
    typeof r.ts === "number" &&
    typeof r.sessionID === "string" &&
    typeof r.trialId === "string" &&
    typeof r.layer === "string" &&
    (r.arm === "baseline" || r.arm === "trial") &&
    typeof r.forced === "boolean"
  )
}

/**
 * Read exposure rows. `pathOrCwd` accepts either the exact ndjson file path
 * or a project cwd (the `.km/trial-arms.ndjson` path is derived from it).
 * Tolerant parse: missing file → []; corrupt/malformed lines are skipped,
 * not thrown.
 */
export function readExposureRows(pathOrCwd: string): ExposureRow[] {
  const file = pathOrCwd.endsWith(".ndjson") ? pathOrCwd : exposureFilePath(pathOrCwd)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const rows: ExposureRow[] = []
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s) continue
    try {
      const parsed = JSON.parse(s)
      if (isExposureRow(parsed)) rows.push(parsed)
    } catch {
      // corrupt line — skip
    }
  }
  return rows
}

/**
 * Append one exposure row for `cwd`'s project, creating `.km/` if needed.
 * Dedupe is ANY-ROW-FOR-SESSIONID (§2) — if a row already exists for
 * `row.sessionID` under any trialId, this is a no-op (file byte-unchanged)
 * and returns "already-enrolled"; otherwise appends and returns "appended".
 */
export function appendExposureRow(cwd: string, row: ExposureRow): "appended" | "already-enrolled" {
  const file = exposureFilePath(cwd)
  const existing = readExposureRows(file)
  if (existing.some((r) => r.sessionID === row.sessionID)) return "already-enrolled"
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8")
  return "appended"
}
