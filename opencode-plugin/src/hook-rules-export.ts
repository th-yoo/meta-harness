/**
 * Hook-rule evolution (spec §3) — producer side of the .km/hook-rules.json
 * compiled-table contract, the hookRule sibling of rule-checks-export.ts
 * (same call sites, same re-read-from-storeRoot design, same repoRoot vs
 * storeRoot split — see that file's header for the rationale).
 *
 * Caps are enforced HERE and only here (spec §3/§4): consumers never
 * re-screen or re-cap. Truncation is logged to stderr, not the sensor
 * stream (F2 / contract-minimalism — sensor rev is P2).
 *
 * P1: killSwitch is hardcoded false (field present, honored by both
 * evaluators); the toggle mechanism lands with the ramp machinery (P3).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { readPlaybook } from "./harness-store.ts"
import { hasBacktrackingRisk, isPortablePattern } from "./hook-rule-screen.ts"

export const HOOK_RULES_EXPORT_REL = join(".km", "hook-rules.json")
export const HOOK_RULES_MAX = 16
export const HOOK_RULES_DENY_MAX = 4

export interface ExportedHookRule {
  id: string
  event: "PreToolUse"
  toolMatcher: string
  inputPattern: string
  feedback: string
  mode: "shadow" | "warn" | "deny"
}

const numId = (id: string): number => parseInt(id.replace(/^b/, ""), 10) || 0

export function exportHookRules(repoRoot: string, storeRoot: string): void {
  try {
    const pb = readPlaybook(storeRoot)
    const all: ExportedHookRule[] =
      pb?.bullets
        .filter((b) => b.status === "active" && b.hookRule)
        // Defensive re-check: a non-portable pattern in the store (however it
        // got there) is skipped so consumers can trust the table blind.
        .filter((b) => isPortablePattern(b.hookRule!.inputPattern) === null && !hasBacktrackingRisk(b.hookRule!.inputPattern))
        .map((b) => ({
          id: b.id,
          event: b.hookRule!.event,
          toolMatcher: b.hookRule!.toolMatcher,
          inputPattern: b.hookRule!.inputPattern,
          feedback: b.hookRule!.feedback,
          mode: b.hookRule!.mode,
        }))
        .sort((a, z) => numId(a.id) - numId(z.id)) ?? []

    const capped = all.slice(0, HOOK_RULES_MAX)
    let denySeen = 0
    const rules = capped.filter((r) => (r.mode === "deny" ? ++denySeen <= HOOK_RULES_DENY_MAX : true))
    const dropped = all.filter((r) => !rules.includes(r)).map((r) => r.id)
    if (dropped.length > 0)
      console.error(`hook-rules-export: caps truncated ${dropped.length} rule(s): ${dropped.join(",")}`)

    const outPath = join(repoRoot, HOOK_RULES_EXPORT_REL)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ version: 1, writtenTs: Date.now(), killSwitch: false, rules }, null, 2) + "\n")
  } catch {
    // Fail-open: an export failure must never break a store transition.
    // The consumer treats a stale/absent file as absent (allow-everything).
  }
}
