/**
 * a3 live adapter (meta-harness spec §4) — SHADOW rule-check evaluator.
 * Reads <cwd>/.km/rule-checks.json per hook call (same locked re-read
 * discipline as gate.json — the file is producer-owned and may change
 * between Stops). SHADOW: outcomes annotate the sensor line only; this
 * module has no access to, and no effect on, the Stop decision.
 *
 * The file is host-local and hand-editable, so review-time screening is
 * not sufficient provenance: every cmd is re-screened with
 * gauge/guard.ts's unsafeReason at evaluation time (gauge read-only-guard
 * precedent); a screened-out cmd is recorded {id, refused: true} and
 * never executed.
 *
 * Cost caps — the two-tier gate-check work exists precisely to keep Stops
 * fast, and shadow must not undo it: at most RULE_CHECKS_MAX rules per
 * Stop (file order, excess recorded skipped) under an aggregate
 * RULE_CHECKS_BUDGET_MS wall budget; each check runs with
 * min(rule.timeoutMs, remaining). Skips are visible in the stream
 * ({id, skipped: true}), never silent. Raising either constant is an
 * instrument change (boundary ts in the adoption ledger).
 *
 * F2: outcomes carry {id, pass, ms} / {id, skipped} / {id, refused} —
 * never cmd text, never output. runCheck's `out` is discarded here the
 * same way evaluateGauge discards it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { unsafeReason } from "./gauge/guard.ts"

export const RULE_CHECKS_MAX = 8
export const RULE_CHECKS_BUDGET_MS = 5000
export const RULE_CHECKS_FILE_REL = join(".km", "rule-checks.json")

export type RuleCheckOutcome =
  | { id: string; pass: boolean; ms: number }
  | { id: string; skipped: true }
  | { id: string; refused: true }

interface FileRule { id: string; cmd: string; timeoutMs: number; state: string }

function readRules(cwd: string): FileRule[] | undefined {
  let raw: string
  try {
    raw = readFileSync(join(cwd, RULE_CHECKS_FILE_REL), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown }
    if (!Array.isArray(parsed.rules)) return undefined
    return parsed.rules as FileRule[]
  } catch {
    return undefined
  }
}

export async function evaluateRuleChecks(
  cwd: string,
  runCheckFn: (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; out: string; ms: number }>,
): Promise<RuleCheckOutcome[] | undefined> {
  try {
    const rules = readRules(cwd)
    if (!rules || rules.length === 0) return undefined
    const outcomes: RuleCheckOutcome[] = []
    let remaining = RULE_CHECKS_BUDGET_MS
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      const id = typeof r?.id === "string" ? r.id : "unknown"
      if (typeof r?.cmd !== "string" || typeof r?.timeoutMs !== "number") {
        outcomes.push({ id, skipped: true })
        continue
      }
      if (i >= RULE_CHECKS_MAX || remaining <= 0) {
        outcomes.push({ id, skipped: true })
        continue
      }
      if (unsafeReason(r.cmd) !== undefined) {
        outcomes.push({ id, refused: true })
        continue
      }
      try {
        const res = await runCheckFn(r.cmd, cwd, Math.min(r.timeoutMs, remaining))
        remaining -= res.ms
        outcomes.push({ id, pass: res.code === 0, ms: res.ms })
      } catch {
        // check-runner's runCheck can REJECT (spawn failure) — a mid-loop
        // rejection must not discard already-computed outcomes for this
        // Stop; record this rule skipped and keep going.
        outcomes.push({ id, skipped: true })
      }
    }
    return outcomes
  } catch {
    return undefined // fail-open, gauge/shadow.ts precedent
  }
}
