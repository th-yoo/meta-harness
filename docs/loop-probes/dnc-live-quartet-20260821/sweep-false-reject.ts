import { mergeCheck } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/reval-fit.ts"
// EXACT TRUE claims (a=0,b=1e7 on u=1/x) at varying anchor counts + geometries.
// Any reject here is a FALSE REJECT of a correct answer.
function run(label: string, xs: number[]) {
  const us = xs.map((x) => 1 / x)
  const cs = xs.map((x) => 1e7 / x)   // the exact true conversion
  const m = mergeCheck(us, cs)
  console.log(`${label.padEnd(34)} n=${String(xs.length).padStart(2)}  ${m.ok ? "accept" : `FALSE-REJECT(${m.reason})`}`)
}
// irregular (realistic spectra), n = 3..8
const pool = [3745.08, 6174.89, 6327.54, 7411.50, 4200.1, 5100.7, 6800.3, 3900.9]
for (let n = 3; n <= 8; n++) run(`irregular anchors`, pool.slice(0, n))
// equal-spaced in u (the known degenerate case)
for (let n = 3; n <= 6; n++) {
  const us = Array.from({ length: n }, (_, i) => 1e-4 * (1 + i))
  run(`equal-spaced in u`, us.map((u) => 1 / u))
}
// symmetric-irregular in u
run(`symmetric irregular in u`, [1, 2, 6, 10, 11].map((k) => 1 / (1e-4 * k)))
