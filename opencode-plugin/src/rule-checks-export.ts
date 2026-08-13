/**
 * a3 live adapter (spec §4) — producer side of the .km/rule-checks.json
 * file contract. Called at every CALLER site where the active playbook
 * changes (Task 2): the helper re-reads the just-committed active playbook
 * from storeRoot rather than accepting one as a parameter, so the
 * resolveTrial CONFIRM branch (playbook already live, nothing passed
 * around) re-derives the export instead of skipping it.
 *
 * repoRoot vs storeRoot: `.km/` is rooted at the repo/project cwd (the
 * live gate reads `<cwd>/.km/rule-checks.json`), while store layers may
 * live under the repo (`<worktree>/.kkamak/...`) OR under the account
 * config dir — which has no repo at all. That is why this takes BOTH
 * roots and why call sites live in the callers (engine/propose/km-crank),
 * where a worktree is in scope, not inside harness-store's transition
 * functions, where it is not.
 *
 * Single-layer by design: the export reflects the TRANSITIONING layer's
 * active playbook only. Multi-layer union is the recorded 5e44620
 * asymmetry note — no cross-layer checks exist yet; do not build it here.
 *
 * F2: cmd text is confined to this gitignored host-local file (and the
 * store it came from). It must never enter the sensor stream or the
 * km-sensors-sync FILES list (test-locked in km-crank/test/
 * repos-parity.test.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { readPlaybook } from "./harness-store.ts"

export const RULE_CHECKS_EXPORT_REL = join(".km", "rule-checks.json")

export interface ExportedRuleCheck {
  id: string
  cmd: string
  timeoutMs: number
  state: "shadow" | "blocking"
}

export function exportRuleChecks(repoRoot: string, storeRoot: string): void {
  try {
    const pb = readPlaybook(storeRoot)
    const rules: ExportedRuleCheck[] =
      pb?.bullets
        .filter((b) => b.status === "active" && b.check?.liveEligible === true)
        .map((b) => ({ id: b.id, cmd: b.check!.cmd, timeoutMs: b.check!.timeoutMs, state: b.check!.state })) ?? []
    const outPath = join(repoRoot, RULE_CHECKS_EXPORT_REL)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ version: 1, writtenTs: Date.now(), rules }, null, 2) + "\n")
  } catch {
    // Fail-open: an export failure must never break a store transition.
    // The consumer treats a stale/absent file as absent (shadow-only).
  }
}
