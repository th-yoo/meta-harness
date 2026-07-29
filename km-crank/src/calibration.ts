/**
 * calibration.ts — the §4.3 false-accept calibration registry + computed
 * staleness (spec §4 rule 1, `docs/superpowers/specs/2026-07-29-trial-mode-
 * gate-outcomes-preregistration.md`).
 *
 * The registry (`km-crank/calibration.json`, committed) holds the cross-host
 * pooled false-accept rate (C2+C1+G1, `minimal/HISTORY.md:240` "CLOSED BY
 * MATH", 2/19 ≈ 10.5%) that the §4.3 verdict engine's FA-consumption rules
 * (spec §4 rules 2-4) lean on. That number is only honest while the
 * mechanism it measured hasn't moved underneath it — so staleness is
 * COMPUTED, never attested: the path-scoped last-modifying commit of the
 * mechanism paths below, compared against the rev baked into the registry
 * at write time.
 *
 * Path-scoped, NEVER repo HEAD: HEAD moves on every unrelated docs commit,
 * which would make verdicts perpetually refused (spec §4 rule 1, verbatim).
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * The probe + completion-gate mechanism, repo-root-relative. Verified
 * against the actual tree on 2026-07-29 (`git log`, import graph, and
 * `cc-gate-plugin/test/self-contained.test.ts`'s vendored-file list):
 *
 * - `minimal/complete-gate.ts` — the binding actuator: verify -> mutation
 *   probe -> spec-coverage probe -> relation probes (docs/2026-07-24-
 *   completion-gate-design.md).
 * - `minimal/mutate.ts` — mutation probe: crude-mutant generation the gate
 *   must catch.
 * - `minimal/spec-probe.ts` — spec-coverage probe: instruction-requirement
 *   coverage of the agent's verify.sh (false-accept L1).
 * - `minimal/session2.ts` — session/IO wiring the gate's GateIO seam is
 *   built from.
 *
 * Deliberately EXCLUDED: `minimal/cover.ts` and the coverage-hook wiring in
 * `minimal/run.ts` (imports at run.ts:29, wiring at :398-718). Confirmed by
 * reading `cc-gate-plugin/src/core/round.ts:43` — the SHIPPED daily gate
 * calls `runCompletionGate(io, { rounds: 1, mutants: 0 })` with no
 * `requirements`/`relations`/`coveredLines` supplied, so `cover.ts` never
 * executes in production; it exists only inside the offline benchmark
 * harness (`minimal/run.ts`) that PRODUCED the FA1 calibration data, not in
 * what ships. `cc-gate-plugin/test/self-contained.test.ts`'s vendored-copy
 * drift guard independently corroborates this: its list is exactly
 * complete-gate.ts / session2.ts / mutate.ts / spec-probe.ts — no cover.ts.
 *
 * - `cc-gate-plugin/src/core` (directory) — round.ts (invokes
 *   `runCompletionGate`), stop.ts (the per-cycle round/outcome state around
 *   it), sensor.ts (`buildSensorLine`: what an "accepted"/"catch"/
 *   "exhausted" classification even IS, the FA rate's subject), edits.ts +
 *   prompt.ts (arm/preemption state feeding the same cycle). Directory-
 *   scoped (not an enumerated file list) so a file ADDED here later is
 *   automatically covered by staleness, not silently exempt.
 * - `cc-gate-plugin/vendor` (directory) — byte-identical shipped copies of
 *   the four `minimal/` kernel files above; the INSTALLED plugin
 *   (`claude plugin install`) runs from here, never from `minimal/`
 *   (`cc-gate-plugin/vendor/README.md`), so vendor drift must independently
 *   stale the registry even when `minimal/` itself is untouched. Directory-
 *   scoped: this also picks up `vendor/README.md`, accepted as harmless
 *   over-inclusion (one avoidable recalibration on a docs-only vendor edit)
 *   against the alternative of a new vendored file silently escaping
 *   detection under an enumerated list.
 */
export const MECHANISM_PATHS: string[] = [
  "minimal/complete-gate.ts",
  "minimal/mutate.ts",
  "minimal/spec-probe.ts",
  "minimal/session2.ts",
  "cc-gate-plugin/src/core",
  "cc-gate-plugin/vendor",
]

export interface Calibration {
  rate: number
  numerator: number
  denominator: number
  wilson95CI: [number, number]
  coveredMechanismRev: string
  date: string
  note?: string
}

function isCalibration(x: unknown): x is Calibration {
  if (typeof x !== "object" || x === null) return false
  const c = x as Record<string, unknown>
  return (
    typeof c["rate"] === "number" &&
    typeof c["numerator"] === "number" &&
    typeof c["denominator"] === "number" &&
    Array.isArray(c["wilson95CI"]) &&
    c["wilson95CI"].length === 2 &&
    typeof c["wilson95CI"][0] === "number" &&
    typeof c["wilson95CI"][1] === "number" &&
    typeof c["coveredMechanismRev"] === "string" &&
    typeof c["date"] === "string" &&
    (c["note"] === undefined || typeof c["note"] === "string")
  )
}

export function calibrationPath(repoRoot: string): string {
  return path.join(repoRoot, "km-crank", "calibration.json")
}

/** Missing file, unreadable, malformed JSON, or shape-mismatched -> null.
 * Never throws — callers (verdict engine) treat null as stale (contract 4). */
export function readCalibration(repoRoot: string): Calibration | null {
  let raw: string
  try {
    raw = fs.readFileSync(calibrationPath(repoRoot), "utf-8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isCalibration(parsed) ? parsed : null
}

/** Real (non-test) path-scoped last-modifying-commit lookup — never repo
 * HEAD. Tests must inject a fake instead of shelling out to git. */
function realGitLastRev(repoRoot: string): (paths: string[]) => string {
  return (paths: string[]) =>
    execFileSync("git", ["log", "-1", "--format=%H", "--", ...paths], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim()
}

/**
 * stale := pathScopedLastCommit(MECHANISM_PATHS) !== cal.coveredMechanismRev
 * — NEVER repo HEAD (spec §4 rule 1).
 *
 * `cal: null` (missing/corrupt registry) is always stale — verdicts are
 * refused rather than silently trusting an absent or unreadable registry
 * (behavior contract 4).
 */
export function calibrationStale(
  repoRoot: string,
  cal: Calibration | null,
  gitLastRev?: (paths: string[]) => string,
): boolean {
  if (cal === null) return true
  const lastRev = (gitLastRev ?? realGitLastRev(repoRoot))(MECHANISM_PATHS)
  return lastRev !== cal.coveredMechanismRev
}
