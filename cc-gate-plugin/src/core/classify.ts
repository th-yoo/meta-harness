// cc-gate-plugin/src/core/classify.ts — A1 cycle-tagging test-path HEURISTIC
// (2026-08-13, ported from ~/z2/kkamak v0.6.0 src/kernel/classify.ts).
//
// This is a text pattern standing in for real analysis — the same shape as
// the import-scanner false positive kkamak filed as its known-issues #9. The
// decisive difference: this classification NEVER blocks and never reaches
// any gate decision. A mislabel costs a wrong telemetry boolean, nothing
// else. Telemetry-only is a hard constraint, pinned by test.
//
// MECHANISM_PATHS note: this file lives under src/core/, which advances the
// km-crank calibration mechanism rev — recorded as the TM1-precedent
// telemetry-only class (GA5 checkMs precedent): no gate decision changes.
import type { CcGateState } from "../types.ts"

/**
 * Default heuristic, mirroring the kkamak kernel's conventions: a path is a
 * test path if any segment is `test`/`tests`/`spec`/`specs`/`__tests__`, or
 * the filename is `test.*`/`spec.*`, or the filename carries a `.test.` /
 * `.spec.` / `_test.` / `-test.` style marker before its extension.
 */
export const DEFAULT_TEST_PATH_PATTERN =
  "(^|/)(tests?|specs?|__tests__)(/|$)" +
  "|(^|/)(tests?|specs?|__tests__)\\.[^/]*$" +
  "|[._-](test|spec)s?\\.[^/]*$"

/** Compile an override pattern; malformed → undefined (caller falls back).
 * Case-INSENSITIVE, matching the kkamak kernel exactly (its own tests pin
 * `Tests/UnitTest1.cs` as a test path — .NET-style conventions). */
export function compileTestPathPattern(pattern: string | undefined): RegExp | undefined {
  if (typeof pattern !== "string" || pattern === "") return undefined
  try {
    return new RegExp(pattern, "i")
  } catch {
    return undefined
  }
}

const DEFAULT_RE = new RegExp(DEFAULT_TEST_PATH_PATTERN, "i")

export function isTestPath(p: string, re?: RegExp): boolean {
  // Backslash-normalized like the kkamak kernel, so a Windows-style path
  // from a foreign payload classifies identically on every host.
  return (re ?? DEFAULT_RE).test(p.replace(/\\/g, "/"))
}

/**
 * Derive the two cycle-tag booleans from a closing cycle's state.
 *
 * Returns {} (fields ABSENT, not false) whenever the touched set cannot be
 * trusted to answer the question: no paths recorded (legacy state file, or
 * no edit event carried a path) or the set was truncated at the cap — a
 * partial set could silently misreport implOnly, and a field that can be
 * silently wrong is worse than one that is absent.
 */
export function computeCycleTags(
  state: Pick<CcGateState, "touchedPaths" | "touchedTruncated">,
  overridePattern?: string,
): { implOnly?: boolean; sameTurnCoEdit?: boolean } {
  const paths = state.touchedPaths
  if (!paths || paths.length === 0 || state.touchedTruncated) return {}
  const re = compileTestPathPattern(overridePattern)
  let test = 0
  for (const p of paths) if (isTestPath(p, re)) test++
  const src = paths.length - test
  return { implOnly: src > 0 && test === 0, sameTurnCoEdit: src > 0 && test > 0 }
}
