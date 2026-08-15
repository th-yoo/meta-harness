// Birth screen for proposer-submitted hookRules (hook-rule evolution spec §2)
// — the hook-rule sibling of check-screen.ts. Pure functions, no I/O. Every
// rejection is a named violation string the review gate ledgers verbatim.
// The portable subset exists so one screened pattern behaves identically under
// the two runtime engines (JS RegExp on dogfood, POSIX ERE `[[ =~ ]]` on
// bench) — the evaluators assume parity, this screen enforces it.

import type { BulletHookRule, ProposedHookRule } from "./harness-store"

export const PORTABLE_SUBSET_NOTE =
  "literals, [...] classes (no backslash escapes inside), |, (...), ^ leading, " +
  "$ terminal or terminal-group alternative, * + ? {m,n}, bare ., escaped metachars"

const TOOL_WHITELIST: ReadonlySet<string> = new Set(["Bash", "Edit", "Write", "Read", "Glob", "Grep"])
const FEEDBACK_INJECTION_MARKERS = ["ignore previous", "ignore all", "disregard", "new instructions", "system prompt"]

/** null = portable; otherwise a short reason (mapped to a violation upstream). */
export function isPortablePattern(p: string): string | null {
  try {
    new RegExp(p)
  } catch {
    return "does not compile"
  }
  // Perl-class shorthands have no POSIX ERE equivalent (\b) or differ (\d\w\s).
  if (/\\[dDwWsSbB]/.test(p)) return "perl-class shorthand"
  if (/\(\?/.test(p)) return "lookaround or inline flag"
  if (/[*+?}]\?/.test(p)) return "lazy quantifier"
  if (/\\[1-9]/.test(p)) return "backreference"
  // Any backslash escape inside a bracket expression: JS reads [\t] as tab,
  // POSIX ERE as literal backslash + t — silent divergence.
  if (/\[[^\]]*\\/.test(p)) return "backslash escape inside bracket expression"
  // $ is anchor-portable only pattern-terminal or as a terminal-group
  // alternative like ( |$) at the very end (spec §2's two accepted spots).
  const dollarAt: number[] = []
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "$" && p[i - 1] !== "\\") dollarAt.push(i)
  }
  for (const i of dollarAt) {
    const isTerminal = i === p.length - 1
    const isTerminalGroupAlt = /^[)|]/.test(p.slice(i + 1)) && /\)$/.test(p)
    if (!isTerminal && !isTerminalGroupAlt) return "mid-pattern $"
  }
  return null
}

/** Nested unbounded quantifier heuristic (linear scan, not re2 equivalence —
 * the P0 probe measured the residual; this catches the (a+|b+)+x shape). */
export function hasBacktrackingRisk(p: string): boolean {
  let depth = 0
  const unboundedAtDepth: boolean[] = [false]
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === "\\") {
      i++
      continue
    }
    if (c === "(") {
      depth++
      unboundedAtDepth[depth] = false
    } else if (c === ")") {
      const inner = unboundedAtDepth[depth] ?? false
      depth = Math.max(0, depth - 1)
      const next = p[i + 1]
      const nextIsUnbounded = next === "+" || next === "*" || (next === "{" && /^\{\d+,\}/.test(p.slice(i + 1)))
      if (inner && nextIsUnbounded) return true
      if (inner) unboundedAtDepth[depth] = true
    } else if (c === "+" || c === "*") {
      unboundedAtDepth[depth] = true
    } else if (c === "{" && /^\{\d+,\}/.test(p.slice(i))) {
      unboundedAtDepth[depth] = true
    }
  }
  return false
}

export type HookRuleScreenResult = { ok: true; rule: ProposedHookRule } | { ok: false; violation: string }

export function screenHookRule(hr: unknown): HookRuleScreenResult {
  if (typeof hr !== "object" || hr === null) return { ok: false, violation: "hook-screen:pattern-not-portable" }
  const o = hr as Record<string, unknown>
  // Checked FIRST: mode is store-owned; its mere presence is a smuggling
  // attempt (check-screen:state-not-proposer-set precedent) — reject, never
  // coerce, regardless of value.
  if ("mode" in o) return { ok: false, violation: "hook-screen:mode-not-proposer-set" }
  if (typeof o.toolMatcher !== "string" || !TOOL_WHITELIST.has(o.toolMatcher))
    return { ok: false, violation: "hook-screen:bad-tool-matcher" }
  const pattern = typeof o.inputPattern === "string" ? o.inputPattern : ""
  if (pattern.length === 0 || pattern.length > 200) return { ok: false, violation: "hook-screen:pattern-too-long" }
  // Anchored = ^-leading OR $-terminal (spec §2: suffix matches like
  // file-extension rules are the documented end-anchor class).
  if (!pattern.startsWith("^") && !/[^\\]\$$/.test(pattern))
    return { ok: false, violation: "hook-screen:pattern-unanchored" }
  if (isPortablePattern(pattern) !== null) return { ok: false, violation: "hook-screen:pattern-not-portable" }
  if (hasBacktrackingRisk(pattern)) return { ok: false, violation: "hook-screen:pattern-backtracking-risk" }
  const feedback = typeof o.feedback === "string" ? o.feedback.trim() : ""
  if (feedback.length === 0 || feedback.length > 200) return { ok: false, violation: "hook-screen:feedback-invalid" }
  const lower = feedback.toLowerCase()
  if (FEEDBACK_INJECTION_MARKERS.some((m) => lower.includes(m)))
    return { ok: false, violation: "hook-screen:feedback-invalid" }
  return {
    ok: true,
    rule: {
      event: "PreToolUse",
      toolMatcher: o.toolMatcher as BulletHookRule["toolMatcher"],
      inputPattern: pattern,
      feedback,
    },
  }
}
