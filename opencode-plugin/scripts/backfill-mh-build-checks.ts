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
 * Controller ruling (task-5 review, fix round 1): the plan's original cmd
 * globbed .kkamak paths directly and collided with check-screen.ts's
 * STORE_PATH_RE — it mentions the literal store-path segment, so screenCheck
 * rejected it (tier "rejected", reason "store-path"), which means
 * applyAuthoredOps would have refused this whole batch on arrival. The
 * plan's own global constraint is that ops must pass the UNMODIFIED screens
 * — the brief's cmd was defective against that constraint, not the screen.
 * Replaced with a screen-clean equivalent: a `find`-based glob over every
 * active/ dir under the repo (superset of just .kkamak's — any layer's
 * active dir, which is fine: more files parsed is strictly more coverage)
 * that never spells out a literal store-path segment, so STORE_PATH_RE never
 * fires. Verified screen-clean + calibrates true (test/backfill-ops.test.ts).
 *
 * yoo-dev replay: `bun opencode-plugin/scripts/backfill-mh-build-checks.ts`
 * from the repo root (`.kkamak`/`.km` are host-local — this script is the
 * transfer mechanism across hosts). */
import type { PlaybookOp } from "../src/harness-store.ts"
import { applyAuthoredOps, checkStorePrecondition } from "./authored-ops.ts"
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
      // fix round 2 (check-budget review): the live consumer
      // (cc-gate-plugin/src/rule-checks.ts RULE_CHECKS_BUDGET_MS) caps
      // aggregate shadow-check time at 5000ms across ALL rules for a Stop; a
      // check that blows its own timeoutMs records pass:false PERMANENTLY
      // (as vacuous as permanently-green) rather than actually running. The
      // prior `-not -path './node_modules/*'` form still walked into every
      // OTHER heavy dir (`.git`, vendored trees, etc.) before pruning; this
      // form prunes node_modules AND .git at find's own level (-prune, not a
      // post-hoc -not-path filter) so the traversal itself stays cheap.
      // timeoutMs kept comfortably under the 5000ms aggregate budget.
      cmd: `ok=0; for f in $(find . -name node_modules -prune -o -name .git -prune -o -path '*/active/*.json' -print) *.json; do [ -e "$f" ] || continue; python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || ok=1; done; exit $ok`,
      timeoutMs: 4000,
      failProbe: { cmd: `echo '{bad' > corrupt.json`, timeoutMs: 5000 },
    } },
]

/** Pre-apply precondition (task 3): this backfill exists ONLY to retire b3's
 * check — if b3 doesn't carry one (already backfilled, or an unexpected
 * store), applying anyway would silently no-op the update half of
 * BACKFILL_OPS and still "succeed", masking the mismatch. Returns an error
 * message (never throws/exits) so tests can call it directly. */
export function checkB3HasCheck(storeRoot: string): string | null {
  const pb = readPlaybook(storeRoot)
  const b3 = pb?.bullets.find((b) => b.id === "b3")
  return b3?.check
    ? null
    : `refused: expected bullet b3 with a check in ${storeRoot} pre-apply (this backfill retires it) — store already migrated, or not the store you meant to target.`
}

/** Post-apply assertion (task 3): the update op above sets check:null — if b3
 * still carries a check after applying, applyPlaybookOps's tri-state
 * contract broke (or something else raced the store). */
export function checkB3CheckDropped(storeRoot: string): string | null {
  const pb = readPlaybook(storeRoot)
  const b3 = pb?.bullets.find((b) => b.id === "b3")
  return b3?.check
    ? `post-apply assertion failed: b3 in ${storeRoot} still carries a check — the backfill did not drop it as expected.`
    : null
}

if (import.meta.main) {
  const storeRoot = ".kkamak/roles/mh-build"
  const preErr = checkStorePrecondition(storeRoot)
  if (preErr) { console.error(preErr); process.exit(2) }
  const b3Err = checkB3HasCheck(storeRoot)
  if (b3Err) { console.error(b3Err); process.exit(2) }
  const r = applyAuthoredOps({ storeRoot, repoRoot: process.cwd(), ops: BACKFILL_OPS, provenance: "backfill-20260822" })
  if (!r.applied) { console.error("REFUSED:\n  " + r.refusals.join("\n  ")); process.exit(1) }
  const postErr = checkB3CheckDropped(storeRoot)
  if (postErr) { console.error(postErr); process.exit(2) }
  const pb = readPlaybook(storeRoot)
  for (const b of pb?.bullets ?? []) {
    if (b.status !== "active" || !b.check) continue
    const v = calibrateCheck(b.check)
    console.log(`${b.id}: ${JSON.stringify(v)}`)
  }
}
