// Pure PreToolUse hook-rule evaluator (hook-rule evolution spec §3, dogfood
// surface). Table string in, decision out — no I/O, no imports from the
// store: `.km/hook-rules.json` (pre-validated at export) IS the interface.
// FAIL-OPEN is the prime directive: any malformed input, evaluator error, or
// deadline breach yields "allow"; deny requires an affirmative match by a
// well-formed rule within budget.

export interface HookRuleOutcome {
  id: string
  matched: boolean
  mode: string
  ms: number
}

export interface HookRuleDecision {
  decision: "allow" | "warn" | "deny"
  feedback?: string
  /** matched rules only — id/mode/ms, never input text (F2) */
  outcomes: HookRuleOutcome[]
  degraded?: "deadline" | "killSwitch"
}

const SEVERITY: Record<string, number> = { shadow: 1, warn: 2, deny: 3 }
const DEFAULT_BUDGET_MS = 50

/** Canonical matched field per tool (spec §3): Bash→command,
 * Edit/Write/Read→file_path, else the JSON-serialized tool input. */
function canonicalInput(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash") return typeof toolInput.command === "string" ? toolInput.command : ""
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read")
    return typeof toolInput.file_path === "string" ? toolInput.file_path : ""
  try {
    return JSON.stringify(toolInput)
  } catch {
    return ""
  }
}

export function evalHookRules(
  tableJson: string | null,
  toolName: string,
  toolInput: Record<string, unknown>,
  budgetMs: number = DEFAULT_BUDGET_MS,
): HookRuleDecision {
  const allow: HookRuleDecision = { decision: "allow", outcomes: [] }
  interface TableShape {
    killSwitch?: boolean
    rules?: unknown
  }
  let table: TableShape | null = null
  try {
    table = tableJson ? (JSON.parse(tableJson) as TableShape) : null
  } catch {
    return allow
  }
  if (!table || !Array.isArray(table.rules)) return allow

  const input = canonicalInput(toolName, toolInput)
  const outcomes: HookRuleOutcome[] = []
  let severest: { mode: string; feedback: string } | null = null
  let degraded: HookRuleDecision["degraded"]
  const start = performance.now()

  for (const raw of table.rules) {
    // Deadline checked between rules — bounds aggregate cost only; a single
    // pathological match is the accepted §8 residual (the §2 subset screen
    // is the real defense, P0-measured).
    if (performance.now() - start > budgetMs) {
      degraded = "deadline"
      break
    }
    const r = raw as { id?: unknown; toolMatcher?: unknown; inputPattern?: unknown; feedback?: unknown; mode?: unknown }
    if (typeof r.id !== "string" || typeof r.inputPattern !== "string" || typeof r.mode !== "string") continue
    if (r.toolMatcher !== toolName) continue
    const t0 = performance.now()
    let matched = false
    try {
      matched = new RegExp(r.inputPattern).test(input)
    } catch {
      continue // malformed rule in table: skip, never fatal
    }
    const ms = performance.now() - t0
    if (!matched) continue
    outcomes.push({ id: r.id, matched: true, mode: r.mode, ms: Math.round(ms * 1000) / 1000 })
    const sev = SEVERITY[r.mode] ?? 0
    if (sev > (severest ? (SEVERITY[severest.mode] ?? 0) : 0)) {
      severest = { mode: r.mode, feedback: typeof r.feedback === "string" ? r.feedback : "" }
    }
  }

  // Deadline breach = fail-open for the whole call (skipped rules can't
  // contribute, and a partial evaluation must never deny).
  if (degraded === "deadline") return { decision: "allow", outcomes, degraded }

  if (!severest || severest.mode === "shadow") return { decision: "allow", outcomes }
  if (severest.mode === "deny") {
    if (table.killSwitch === true)
      return { decision: "warn", feedback: severest.feedback, outcomes, degraded: "killSwitch" }
    return { decision: "deny", feedback: severest.feedback, outcomes }
  }
  return { decision: "warn", feedback: severest.feedback, outcomes }
}
