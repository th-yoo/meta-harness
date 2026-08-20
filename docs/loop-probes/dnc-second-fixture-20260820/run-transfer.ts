/** Transfer test per pre-registration.md. Run from repo root:
 *    bun docs/loop-probes/dnc-second-fixture-20260820/run-transfer.ts */
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { readSeriesFile } from "../../../opencode-plugin/src/bench/series-source.ts"
import { detectPeaks } from "../../../opencode-plugin/src/bench/series-peaks.ts"
import { mergeCheck, conditioningCheck, FIT_FAMILY } from "../../../opencode-plugin/src/bench/reval-fit.ts"

const dir = import.meta.dir
const { xs, ys } = readSeriesFile(join(dir, "fixture.dat"), dir)
const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf-8")) as { trueChannels: number[]; a: number; b: number }

const idx = detectPeaks(ys)
const px = idx.map((i) => xs[i]!)
console.log(`DIVIDE: n=${px.length} peaks at channels ${px.map((v) => v.toFixed(2)).join(", ")}`)
const step = xs[1]! - xs[0]!
const matched = truth.trueChannels.filter((t) => px.some((p) => Math.abs(p - t) <= 5 * step)).length
console.log(`matched ${matched}/6 true centers within +/-5 samples`)

const us = [...px].sort((a, b) => a - b)
const oracle = us.map((u) => truth.a + truth.b * u)
const arms: [string, number[], boolean][] = [
  ["ORACLE", oracle, true],
  ["b1 shifted", [...oracle.slice(1), oracle[oracle.length - 1]! + truth.b], false],
  ["b2 reversed", [...oracle].reverse(), false],
  ["b3 out-of-family quadratic", us.map((u) => 20 + 0.5 * u * u), false],
  ["BOUNDARY invented (a=3,b=1)", us.map((u) => 3 + u), true],
]
for (const [name, claim, expectOk] of arms) {
  const r = mergeCheck(us, claim)
  const mark = r.ok === expectOk ? "as-registered" : "*** DEVIATES ***"
  console.log(`${name}: ok=${r.ok} reason=${r.reason ?? "-"} R=${r.R?.toExponential(2) ?? "-"} [${mark}]`)
}
for (const m of FIT_FAMILY) {
  const uv = px.map(m.u).sort((a, b) => a - b)
  const d = uv.slice(1).map((v, i) => v - uv[i]!)
  const mean = d.reduce((s, v) => s + v, 0) / d.length
  const cv = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length) / mean
  console.log(`geometry u=${m.name}: spacing CV=${cv.toFixed(3)} alternates=${conditioningCheck(uv, uv.map((u) => 1 + 2 * u)).alternates}`)
}
