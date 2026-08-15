// Hook-rule ramp scan (hook-rule evolution spec §4): evidence-staged
// shadow→warn promotion and automatic deny→shadow demotion, judged from the
// cc-gate sensor stream (.km/gate-outcomes.ndjson — P2's hookRules outcomes
// + the line's accepted verdict). FP-proxy = matched-sessions-that-passed /
// matched-sessions: a match inside a passing session is false-positive
// evidence, so promotion requires this LOW (≤ θ). warn→deny is deliberately
// absent — that transition is a measured ab treatment (transition-candidate
// constructor), never automatic. Never throws; every transition applies
// through hookRuleTransition's precondition check and the caller-visible
// result is exactly the applied set.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hookRuleTransition,
  readMhConfig,
  readPlaybook,
  type HookRuleTransitionEvidence,
} from "./harness-store.ts"
import { exportHookRules } from "./hook-rules-export.ts"
// proposer.ts is self-contained fs lock helpers (no CC-host dependency) —
// the same cross-process marker the propose/curate writers respect. A ramp
// transition racing an in-flight proposer could mutate the playbook that
// proposer is about to branch from; skip-and-retry (next session close)
// costs nothing because transitions are idempotent evidence re-checks.
import { proposerInFlight } from "./adapters/claude-code/proposer.ts"

export interface RampTransition {
  bulletId: string
  from: string
  to: string
  evidence: HookRuleTransitionEvidence
}

const STREAM_TAIL_LINES = 5000

interface RuleAgg {
  matchedObs: number
  sessions: Set<string>
  passedSessions: Set<string>
}

function aggregate(streamPath: string): Map<string, RuleAgg> | null {
  let raw: string
  try {
    raw = readFileSync(streamPath, "utf-8")
  } catch {
    return null
  }
  const agg = new Map<string, RuleAgg>()
  const lines = raw.split("\n")
  const start = Math.max(0, lines.length - STREAM_TAIL_LINES)
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    let row: { sessionID?: unknown; accepted?: unknown; hookRules?: unknown }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row.sessionID !== "string" || !Array.isArray(row.hookRules)) continue
    for (const o of row.hookRules as Array<Record<string, unknown>>) {
      if (typeof o?.id !== "string" || o.matched !== true) continue
      let a = agg.get(o.id)
      if (!a) {
        a = { matchedObs: 0, sessions: new Set(), passedSessions: new Set() }
        agg.set(o.id, a)
      }
      a.matchedObs++
      a.sessions.add(row.sessionID)
      if (row.accepted === true) a.passedSessions.add(row.sessionID)
    }
  }
  return agg
}

export function rampScan(repoRoot: string, storeRoot: string): RampTransition[] {
  const applied: RampTransition[] = []
  try {
    if (proposerInFlight(repoRoot, storeRoot)) return applied
    const pb = readPlaybook(storeRoot)
    if (!pb) return applied
    const ruled = pb.bullets.filter((b) => b.status === "active" && b.hookRule)
    if (ruled.length === 0) return applied

    const agg = aggregate(join(repoRoot, ".km", "gate-outcomes.ndjson"))
    if (!agg) return applied
    const cfg = readMhConfig()
    const { hookRuleRampN: N, hookRuleRampK: K, hookRuleRampTheta: theta } = cfg

    for (const b of ruled) {
      const a = agg.get(b.id)
      if (!a || a.sessions.size < K) continue
      const fpRate = a.passedSessions.size / a.sessions.size
      const evidence: HookRuleTransitionEvidence = {
        matchedSessions: a.sessions.size,
        matchedObs: a.matchedObs,
        fpRate: Math.round(fpRate * 1000) / 1000,
        sessionIDs: [...a.sessions].slice(0, 50),
      }
      const mode = b.hookRule!.mode
      if (mode === "shadow" && a.matchedObs >= N && fpRate <= theta) {
        if (hookRuleTransition(storeRoot, b.id, "shadow", "warn", evidence))
          applied.push({ bulletId: b.id, from: "shadow", to: "warn", evidence })
      } else if (mode === "deny" && fpRate > theta) {
        if (hookRuleTransition(storeRoot, b.id, "deny", "shadow", evidence))
          applied.push({ bulletId: b.id, from: "deny", to: "shadow", evidence })
      }
      // warn: no automatic path in either direction (spec §4).
    }
    if (applied.length > 0) exportHookRules(repoRoot, storeRoot)
  } catch {
    // Fail-open: a ramp failure must never break the caller (score path).
  }
  return applied
}
