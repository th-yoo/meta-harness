/** Noise sweep per addendum-02-noise-pre.md. Run from repo root:
 *    bun docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts */
import { conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../../../opencode-plugin/src/bench/reval-fit.ts"

// deterministic PRNG (xorshift128+), seeded — no Math.random, no Date.now
function prng(seed: number): () => number {
  let s0 = seed >>> 0 || 1
  let s1 = (seed * 2654435761) >>> 0 || 2
  return () => {
    let x = s0
    const y = s1
    s0 = y
    x ^= x << 23
    x >>>= 0
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0
    return ((s1 + y) >>> 0) / 4294967296
  }
}
function gauss(r: () => number): number {
  // Box-Muller
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

const US = [1.0, 2.3, 2.9, 5.1, 7.8]
const TRUTH = US.map((u) => 100 + 40 * u)
const SHIFTED = [...TRUTH.slice(1), TRUTH[4]! + 40]
const SPAN = Math.max(...TRUTH) - Math.min(...TRUTH)
const SIGMAS = [0.001, 0.005, 0.01, 0.02, 0.05]
const TRIALS = 200

for (const sig of SIGMAS) {
  const honest: number[] = []
  const shifted: number[] = []
  let falseReject = 0
  for (let seed = 1; seed <= TRIALS; seed++) {
    const r = prng(seed + SIGMAS.indexOf(sig) * 1000)
    const noise = () => gauss(r) * sig * SPAN
    const h = conditioningCheck(US, TRUTH.map((c) => c + noise()))
    const s = conditioningCheck(US, SHIFTED.map((c) => c + noise()))
    honest.push(h.R)
    shifted.push(s.R)
    if (!h.ok) falseReject++
  }
  const gap = Math.min(...honest) / Math.max(...shifted)
  const survives = gap >= 100
  console.log(
    `sigma=${(sig * 100).toFixed(1)}%: GAP(worst-case)=${gap.toExponential(2)} ` +
    `threshold-${R_THRESHOLD_PLACEHOLDER}-${survives ? "SURVIVES" : "FAILS"} ` +
    `honest-false-reject=${falseReject}/${TRIALS}`,
  )
}
