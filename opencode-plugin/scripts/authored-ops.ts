/** Operator lane for playbook ops (v7 authored-update precedent, formalized).
 * Replicates the review gate's MECHANICAL screens exactly — an op the gate
 * would kill pre-LLM is refused here; what this lane deliberately skips is
 * the LLM judgment round, which is the operator's accountability. Writes
 * active/playbook.json atomically and re-exports both .km tables. */
import * as fs from "node:fs"; import * as path from "node:path"
import { readPlaybook, applyPlaybookOps, type PlaybookOp, type Playbook } from "../src/harness-store.ts"
import { screenCheck } from "../src/check-screen.ts"
import { screenHookRule } from "../src/hook-rule-screen.ts"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"

/** Mirrors propose.ts's stampLiveEligible (~line 505) exactly, semantics
 * copied not reinvented: screenCheck's tier must reach the FINAL persisted
 * bullets — applyPlaybookOps itself never sets liveEligible
 * (harness-store.ts) — or exportRuleChecks' `check?.liveEligible === true`
 * filter (rule-checks-export.ts) exports nothing, ever, no matter how many
 * checks screen "live". `add` bullets have no id yet at op time, so they're
 * matched positionally: applyPlaybookOps appends new bullets, in order,
 * after `base.bullets`. `update` bullets are found by id. Like the curate
 * lane (propose.ts:1969) and unlike the propose lane's update-only call
 * (propose.ts:659) — this lane never calls reviewAddedBullets either, so
 * every op kind is stamped here, add included. */
function stampLiveEligible(base: Playbook, finalPb: Playbook, ops: PlaybookOp[], liveEligible: Map<PlaybookOp, boolean>): void {
  let addIdx = base.bullets.length
  for (const op of ops) {
    const le = liveEligible.get(op)
    if (op.op === "add") {
      const bullet = finalPb.bullets[addIdx]
      addIdx++
      if (le !== undefined && bullet?.check) bullet.check.liveEligible = le
    } else if (op.op === "update") {
      if (le === undefined) continue
      const bullet = finalPb.bullets.find((b) => b.id === op.id)
      if (bullet?.check) bullet.check.liveEligible = le
    }
  }
}

export function applyAuthoredOps(a: { storeRoot: string; repoRoot: string; ops: PlaybookOp[]; provenance: string }): { applied: boolean; refusals: string[] } {
  const refusals: string[] = []
  const liveEligible = new Map<PlaybookOp, boolean>()
  for (const op of a.ops) {
    if (op.op === "delete") continue
    if (op.check) {
      const s = screenCheck(op.check)
      if (s.tier === "rejected") refusals.push(`${op.op}:"${op.text.slice(0, 40)}" check ${s.reason}`)
      else liveEligible.set(op, s.tier === "live")
      const probe = (op.check as { failProbe?: { cmd: string; timeoutMs: number } }).failProbe
      if (probe) { const ps = screenCheck(probe); if (ps.tier === "rejected") refusals.push(`${op.op} failProbe ${ps.reason}`) }
    }
    if (op.hookRule) {
      const hs = screenHookRule(op.hookRule)
      if (!hs.ok) refusals.push(`${op.op}:"${op.text.slice(0, 40)}" hookRule ${hs.violation}`)
    }
  }
  if (refusals.length > 0) return { applied: false, refusals }
  const base = readPlaybook(a.storeRoot) ?? { schemaVersion: 1, nextId: 1, bullets: [] }
  const next = applyPlaybookOps(base, a.ops)
  stampLiveEligible(base, next, a.ops, liveEligible)
  const p = path.join(a.storeRoot, "active", "playbook.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p + ".tmp", JSON.stringify(next, null, 2) + "\n"); fs.renameSync(p + ".tmp", p)
  exportRuleChecks(a.repoRoot, a.storeRoot)
  exportHookRules(a.repoRoot, a.storeRoot)
  console.error(`authored-ops[${a.provenance}]: applied ${a.ops.length} op(s)`)
  return { applied: true, refusals: [] }
}

if (import.meta.main) {
  const [storeRoot, opsFile] = process.argv.slice(2)
  if (!storeRoot || !opsFile) { console.error("usage: bun scripts/authored-ops.ts <storeRoot> <ops.json>"); process.exit(2) }
  const ops = JSON.parse(fs.readFileSync(opsFile, "utf8")) as PlaybookOp[]
  const r = applyAuthoredOps({ storeRoot, repoRoot: process.cwd(), ops, provenance: "cli" })
  if (!r.applied) { console.error("REFUSED:\n  " + r.refusals.join("\n  ")); process.exit(1) }
}
