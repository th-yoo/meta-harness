/** Domain-different verifier: recompute a text-shape claim from the task's own
 * source (the s7 source_crosscheck class — the seam that survived the §1
 * audit). Exists to WITNESS the runtime's verifier-agnosticism: zero vocabulary
 * shared with merge-fit, same Verifier contract, same steering discipline. */
import type { Verifier } from "../types.ts"

export interface RecountClaim {
  lines: number
  words: number
}

export function sourceRecountVerifier(sourceText: string): Verifier<RecountClaim, RecountClaim> {
  const actual: RecountClaim = {
    lines: sourceText.split("\n").filter((l) => l.length > 0).length,
    words: sourceText.split(/\s+/).filter((w) => w.length > 0).length,
  }
  return (claim: RecountClaim) => {
    if (claim.lines === actual.lines && claim.words === actual.words) return { ok: true }
    return {
      ok: false,
      reason: "recount-mismatch",
      steering: {
        summary: `source has ${actual.lines} lines / ${actual.words} words`,
        detail: actual,
      },
    }
  }
}
