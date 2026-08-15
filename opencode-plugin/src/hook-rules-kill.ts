/**
 * hook-rules-kill.ts — global hook-rule kill-switch toggle (hook-rule P3
 * plan, T4; spec §4). Persists `hookRulesKillSwitch` into the store-root
 * config (readMhConfig's file) and re-exports the compiled table so
 * `.km/hook-rules.json` flips immediately — "instantly" here means the next
 * hook process reads the new table; both surfaces' evaluators already honor
 * the field (P1: deny is evaluated as warn while killSwitch is true).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { exportHookRules } from "./hook-rules-export.ts"

export function setHookRulesKillSwitch(repoRoot: string, storeRoot: string, on: boolean): void {
  const cfgPath = join(storeRoot, "config.json")
  // Read-modify-write of the RAW file (not the defaults-filled readMhConfig
  // view) so every other config key survives the toggle byte-for-byte.
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>
  } catch {
    raw = {}
  }
  raw.hookRulesKillSwitch = on
  mkdirSync(storeRoot, { recursive: true })
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n")
  exportHookRules(repoRoot, storeRoot)
}
