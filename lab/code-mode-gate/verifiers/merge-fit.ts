/** Adapter over kkamak's REAL merge verifier (opencode-plugin reval-fit.ts,
 * ships OFF). Steering = per-anchor residuals worst-first, computed from the
 * fit the verifier itself ran — no new authority, no answer key. Import is
 * read-only; this file must never modify plugin behavior. */
import { fitAffine, mergeCheck } from "../../../opencode-plugin/src/bench/reval-fit.ts"
import type { Verifier } from "../types.ts"

export interface AnchorResidual {
  index: number
  u: number
  claimed: number
  fitted: number
  residual: number
}

export function mergeFitVerifier(anchorsU: number[]): Verifier<number[], AnchorResidual[]> {
  return (canonicals: number[]) => {
    const merge = mergeCheck(anchorsU, canonicals)
    if (merge.ok) return { ok: true }
    if (merge.reason !== "residual" || canonicals.length !== anchorsU.length || anchorsU.length < 3) {
      return { ok: false, reason: merge.reason }
    }
    const { a, b } = fitAffine(anchorsU, canonicals)
    const detail = anchorsU
      .map((u, index) => {
        const fitted = a + b * u
        return { index, u, claimed: canonicals[index]!, fitted, residual: fitted - canonicals[index]! }
      })
      .sort((x, y) => Math.abs(y.residual) - Math.abs(x.residual))
    return {
      ok: false,
      reason: merge.reason,
      steering: {
        summary: `worst anchor index ${detail[0]!.index}: residual ${detail[0]!.residual.toFixed(3)}`,
        detail,
      },
    }
  }
}
