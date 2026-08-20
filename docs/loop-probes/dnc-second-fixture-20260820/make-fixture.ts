/** Generates fixture.dat per pre-registration.md. Seed hardcoded — rerunning
 * reproduces the identical file (verify with git diff after regeneration).
 * Run once from repo root:
 *    bun docs/loop-probes/dnc-second-fixture-20260820/make-fixture.ts */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

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
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

const r = prng(424242)
const N = 2000
// six irregular, asymmetric peak centers (sample indices), min separation 120
const centers: number[] = []
while (centers.length < 6) {
  const c = 100 + Math.floor(r() * (N - 200))
  if (centers.every((e) => Math.abs(e - c) >= 120)) centers.push(c)
}
centers.sort((a, b) => a - b)
const widths = centers.map(() => 8 + r() * 12)
const amps = centers.map(() => 3000 + r() * 6000)

const lines: string[] = []
const trueChannels: number[] = []
for (let i = 0; i < N; i++) {
  const x = 100.0 + 0.05 * i
  let y = 500 + 30 * Math.sin(i / 400) + gauss(r) * 25
  centers.forEach((c, k) => { y += amps[k]! * Math.exp(-((i - c) ** 2) / (2 * widths[k]! ** 2)) })
  lines.push(`${x.toFixed(4)}\t${y.toFixed(4)}`)
}
centers.forEach((c) => trueChannels.push(100.0 + 0.05 * c))

const dir = join(import.meta.dir)
writeFileSync(join(dir, "fixture.dat"), lines.join("\n") + "\n")
writeFileSync(join(dir, "truth.json"), JSON.stringify({ seed: 424242, trueChannels, a: -50, b: 8 }, null, 1))
console.log(`wrote fixture.dat (${N} rows), truth.json — centers at channels ${trueChannels.map((v) => v.toFixed(2)).join(", ")}`)
