#!/usr/bin/env bun
/** stamp-narrowing.ts — stamp RejectedEntry.narrowing on ledger entries
 * (rule-8 exception; see opencode-plugin/src/narrowing.ts).
 *
 * Mechanical path: `--from-verdict <version>` runs attributeOverreach on
 * that candidate's ab-verdict.json (needs taskResults) + its diagnosis
 * predictions + guards.json, and stamps matching entries only when the
 * attribution actually certifies overreach.
 *
 * Operator path: `--mechanism "<text>" --attributed-by "operator:<note>"`
 * stamps the selected entries directly — for migrating pre-machinery
 * history whose verdicts lack taskResults/predictions (e.g. gen-2's v2).
 *
 * Selection: `--match <substring>` (repeatable) — every ledger entry whose
 * bullet contains ANY given substring. Dry-run by default; `--write` saves.
 *
 * Usage:
 *   bun scripts/stamp-narrowing.ts --root ~/.config/kkamak/global \
 *     --match "fails twice" --mechanism "..." --attributed-by "operator:x" --write
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { attributeOverreach } from "../opencode-plugin/src/narrowing.ts"
import { readGuards, readAbVerdict, readDiagnosis, type RejectedEntry } from "../opencode-plugin/src/harness-store.ts"

const argv = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const matches: string[] = []
for (let i = 0; i < argv.length; i++) if (argv[i] === "--match") matches.push(argv[i + 1]!)
const root = opt("--root")
const write = argv.includes("--write")
if (!root || matches.length === 0) {
  console.error("usage: stamp-narrowing.ts --root <layer-root> --match <substr> [--match ...] (--from-verdict <vN> | --mechanism <text> --attributed-by <who>) [--write]")
  process.exit(1)
}

let mechanism = opt("--mechanism")
let attributedBy = opt("--attributed-by")
const fromVerdict = opt("--from-verdict")
if (fromVerdict) {
  const verdict = readAbVerdict(root, fromVerdict)
  const tr = (verdict as { taskResults?: Record<string, { candidate: number[]; active: number[] }> } | null)?.taskResults
  const dx = readDiagnosis<{ predictions?: { expect_improve?: unknown } }>(root, fromVerdict)
  const preds = dx?.predictions?.expect_improve
  const expectImprove = Array.isArray(preds) ? preds.filter((x): x is string => typeof x === "string") : []
  if (!tr || expectImprove.length === 0) {
    console.error(`cannot attribute mechanically: ${fromVerdict} verdict taskResults=${!!tr}, expect_improve=${expectImprove.length} — use the operator path`)
    process.exit(2)
  }
  const a = attributeOverreach({ taskResults: tr, expectImprove, guards: readGuards(root) })
  if (!a.invited) {
    console.error(`attribution says NOT invited (improveNet=${a.improveNet}, guardNet=${a.guardNet}) — refusing to stamp`)
    process.exit(3)
  }
  mechanism = a.mechanism
  attributedBy = `ab-verdict:${fromVerdict}`
}
if (!mechanism || !attributedBy) {
  console.error("need --from-verdict or both --mechanism and --attributed-by")
  process.exit(1)
}

const ledgerPath = join(root, "rejected.json")
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as RejectedEntry[]
let stamped = 0
for (const e of ledger) {
  if (!matches.some((m) => e.bullet.includes(m))) continue
  e.narrowing = { invited: true, mechanism, attributedBy }
  stamped++
  console.log(`STAMP [${e.rejectedAt} ${e.version}] ${e.bullet.slice(0, 90)}`)
}
console.log(`${stamped} entr${stamped === 1 ? "y" : "ies"} ${write ? "stamped" : "would be stamped (dry-run; add --write)"}`)
if (write && stamped > 0) writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1) + "\n")
