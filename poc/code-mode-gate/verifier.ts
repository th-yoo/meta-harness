/** Gate adapter: wraps kkamak's REAL merge verifier (reval-fit.ts, ships OFF)
 * as an effect gate that returns STEERING on rejection.
 *
 * The steering is the anti-thrash element: a bare reject converts model spend
 * into blind retries (measured: 53/75 thrash sessions, raman class); a reject
 * that names which anchors miss and by how much lets the correction happen
 * INSIDE the same turn. Steering is computed from the fit the verifier itself
 * ran — no new authority, no answer key: residuals are visible to any party.
 */
import { fitAffine, mergeCheck, type MergeResult } from "../../opencode-plugin/src/bench/reval-fit.ts"

export interface AnchorResidual {
  index: number
  u: number
  claimed: number
  fitted: number
  residual: number
}

export interface Steering {
  perAnchor: AnchorResidual[]
  /** indices of anchors ordered worst-first by |residual| */
  worstFirst: number[]
  delta?: number
}

export interface GateVerdict {
  ok: boolean
  reason?: string
  steering?: Steering
  merge: MergeResult
}

export function gateClaim(anchorsU: number[], canonicals: number[]): GateVerdict {
  const merge = mergeCheck(anchorsU, canonicals)
  if (merge.ok) return { ok: true, merge }
  let steering: Steering | undefined
  if (merge.reason === "residual" && anchorsU.length === canonicals.length && anchorsU.length >= 3) {
    const { a, b } = fitAffine(anchorsU, canonicals)
    const perAnchor = anchorsU.map((u, index) => {
      const fitted = a + b * u
      return { index, u, claimed: canonicals[index]!, fitted, residual: fitted - canonicals[index]! }
    })
    const worstFirst = perAnchor
      .map((r) => r.index)
      .sort((i, j) => Math.abs(perAnchor[j]!.residual) - Math.abs(perAnchor[i]!.residual))
    steering = { perAnchor, worstFirst, delta: merge.delta }
  }
  return { ok: false, reason: merge.reason, steering, merge }
}
