// Hook-rule evolution P2 (spec §5): Stop-path consumer of the dispatch-side
// per-session accumulator .km/hook-rule-outcomes-<sessionID>.ndjson. The
// dispatch PreToolUse processes (opencode-plugin) append one line per event
// with >=1 match; this reads, flattens, caps, UNLINKS, and hands the array to
// hook-cli for the sensor line's optional `hookRules` field. Crash-safe by
// construction: a leftover file is consumed by the same session's next Stop;
// other sessions' files are never touched. F2: id/matched/mode/ms only —
// the accumulator never carried input text to begin with.
// Fail-open everywhere: any error returns null (absent key is the cleaner
// line, `forced`/`ruleChecks` convention).
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

export interface HookRuleSensorOutcome {
  id: string
  matched: boolean
  mode: string
  ms: number
}

export const HOOK_RULE_OUTCOMES_CAP = 200

export function readAndConsumeHookRuleOutcomes(cwd: string, sessionID: string): HookRuleSensorOutcome[] | null {
  const p = join(cwd, ".km", `hook-rule-outcomes-${sessionID}.ndjson`)
  let raw: string
  try {
    raw = readFileSync(p, "utf-8")
  } catch {
    return null
  }
  try {
    rmSync(p, { force: true })
  } catch {
    // Unlink failure is non-fatal: worst case the next Stop re-reports.
  }
  try {
    const out: HookRuleSensorOutcome[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      let row: { outcomes?: unknown }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!Array.isArray(row.outcomes)) continue
      for (const o of row.outcomes as Array<Record<string, unknown>>) {
        if (typeof o?.id !== "string" || typeof o?.mode !== "string") continue
        out.push({
          id: o.id,
          matched: o.matched === true,
          mode: o.mode,
          ms: typeof o.ms === "number" ? o.ms : 0,
        })
      }
    }
    if (out.length === 0) return null
    if (out.length > HOOK_RULE_OUTCOMES_CAP) {
      console.error(`hook-rule-outcomes: capped ${out.length} -> ${HOOK_RULE_OUTCOMES_CAP} for session ${sessionID}`)
      return out.slice(0, HOOK_RULE_OUTCOMES_CAP)
    }
    return out
  } catch {
    return null
  }
}
