/** Backfill for the mh-build role playbook (shadow-lane upstream fix,
 * 2026-08-22): retire b3's vacuous check, deploy one calibrated check.
 *
 * b3's check `jobs -r | wc -l` is vacuous BY CONSTRUCTION: the check runs in
 * a fresh shell (no jobs table) and `wc` exits 0 regardless — 52/52 recorded
 * passes carry zero information. The bullet TEXT stays (behavioral rule,
 * works as prose); the check is dropped via the tri-state null contract.
 * The replacement check guards a real measured incident class (poisoned
 * rejected.json, 2026-08-17 — store JSON must always parse) and is
 * falsifiable: the probe writes malformed JSON, the check must reject it.
 *
 * yoo-dev replay: `bun opencode-plugin/scripts/backfill-mh-build-checks.ts`
 * from the repo root (`.kkamak`/`.km` are host-local — this script is the
 * transfer mechanism across hosts). */
import type { PlaybookOp } from "../src/harness-store.ts"
import { applyAuthoredOps } from "./authored-ops.ts"
import { calibrateCheck } from "../src/check-calibrate.ts"
import { readPlaybook } from "../src/harness-store.ts"

export const BACKFILL_OPS: PlaybookOp[] = [
  { op: "update", id: "b3",
    text: "When a background run you started is still incomplete at the end of a turn, report it as still running with its check condition — never as done.",
    check: null },
  { op: "add",
    text: "Do not end a turn that modified evolution-store state until every store JSON file you touched still parses.",
    generality: "universal",
    check: {
      cmd: `ok=0; for f in .kkamak/*/active/*.json .kkamak/*/*/active/*.json *.json; do [ -e "$f" ] || continue; python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || ok=1; done; exit $ok`,
      timeoutMs: 15000,
      failProbe: { cmd: `echo '{bad' > corrupt.json`, timeoutMs: 5000 },
    } },
]

if (import.meta.main) {
  const storeRoot = ".kkamak/roles/mh-build"
  const r = applyAuthoredOps({ storeRoot, repoRoot: process.cwd(), ops: BACKFILL_OPS, provenance: "backfill-20260822" })
  if (!r.applied) { console.error("REFUSED:\n  " + r.refusals.join("\n  ")); process.exit(1) }
  const pb = readPlaybook(storeRoot)
  for (const b of pb?.bullets ?? []) {
    if (b.status !== "active" || !b.check) continue
    const v = calibrateCheck(b.check)
    console.log(`${b.id}: ${JSON.stringify(v)}`)
  }
}
