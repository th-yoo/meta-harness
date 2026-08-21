/** Rule-check report (shadow-lane upstream fix, task 6, plan deliverable).
 *
 * Two data sources that never talk to each other today: a layer's active
 * playbook (which checks EXIST + whether they're calibrated — check-calibrate.ts,
 * re-run live here, since calibration is not persisted anywhere) and the
 * sensor ndjson stream (whether those checks actually PASS in the field —
 * SensorLine.ruleChecks, cc-gate-plugin/src/types.ts). This prints both,
 * per rule-check id, side by side, so "is this check worth trusting" and "is
 * it actually catching anything" can be read off one report instead of
 * cross-referencing two files by hand. Plain lines, no table library.
 *
 * Ids reported = union of (playbook bullets carrying a check) and (ids seen
 * in the sensor stream) — an id with sensor data but no matching playbook
 * check (rotated out, or from a different layer's export) still gets its
 * tallies printed, just with calibration "n/a (not-in-playbook)" instead of
 * a live calibrateCheck run.
 */
import { readFileSync, existsSync } from "node:fs"
import { readPlaybook, type PlaybookBullet } from "../src/harness-store.ts"
import { calibrateCheck, type CalibrationReason } from "../src/check-calibrate.ts"
import type { RuleCheckOutcome } from "../../cc-gate-plugin/src/types.ts"

interface Tally { pass: number; fail: number; skip: number; refused: number }

function emptyTally(): Tally {
  return { pass: 0, fail: 0, skip: 0, refused: 0 }
}

function tallyOutcome(t: Tally, o: RuleCheckOutcome): void {
  if ("skipped" in o && o.skipped) t.skip++
  else if ("refused" in o && o.refused) t.refused++
  else if ("pass" in o) { if (o.pass) t.pass++; else t.fail++ }
}

/** Parses the sensor ndjson stream into a per-id tally map. Malformed lines
 * (bad JSON, missing/non-array ruleChecks) are skipped, not fatal — the
 * sensor file is producer-owned and append-only; a partial write at the tail
 * is expected, not an error condition for a report. */
export function tallySensorStream(sensorPath: string): Map<string, Tally> {
  const tallies = new Map<string, Tally>()
  if (!existsSync(sensorPath)) return tallies
  const raw = readFileSync(sensorPath, "utf8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: { ruleChecks?: unknown }
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!Array.isArray(obj.ruleChecks)) continue
    for (const o of obj.ruleChecks as RuleCheckOutcome[]) {
      if (!o || typeof o.id !== "string") continue
      const t = tallies.get(o.id) ?? emptyTally()
      tallyOutcome(t, o)
      tallies.set(o.id, t)
    }
  }
  return tallies
}

function calibrationLabel(b: PlaybookBullet | undefined): { calibrated: string; reason: CalibrationReason | "not-in-playbook" } {
  if (!b?.check) return { calibrated: "n/a", reason: "not-in-playbook" }
  const v = calibrateCheck(b.check)
  return { calibrated: String(v.calibrated), reason: v.reason }
}

/** Builds the full report as a string (main just console.logs it — testable
 * without capturing stdout). */
export function buildRuleCheckReport(storeRoot: string, sensorPath: string): string {
  const pb = readPlaybook(storeRoot)
  const checked = pb?.bullets.filter((b) => b.status === "active" && b.check) ?? []
  const byId = new Map(checked.map((b) => [b.id, b]))
  const sensorTallies = tallySensorStream(sensorPath)

  const ids = Array.from(new Set([...byId.keys(), ...sensorTallies.keys()])).sort()

  const lines: string[] = []
  lines.push(`rule-check report — storeRoot=${storeRoot} sensor=${sensorPath}`)
  if (ids.length === 0) {
    lines.push("(no rule-checks in the playbook and none seen in the sensor stream)")
    return lines.join("\n")
  }
  for (const id of ids) {
    const { calibrated, reason } = calibrationLabel(byId.get(id))
    const t = sensorTallies.get(id) ?? emptyTally()
    lines.push(`${id}: calibrated=${calibrated} reason=${reason} pass=${t.pass} fail=${t.fail} skip=${t.skip} refused=${t.refused}`)
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const [storeRoot, sensorPath] = process.argv.slice(2)
  if (!storeRoot) {
    console.error("usage: bun scripts/rule-check-report.ts <storeRoot> [sensorPath=.km/gate-outcomes.ndjson]")
    process.exit(2)
  }
  console.log(buildRuleCheckReport(storeRoot, sensorPath ?? ".km/gate-outcomes.ndjson"))
}
