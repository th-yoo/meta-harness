import { parseSeries } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-source.ts"
import { detectPeaks } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-peaks.ts"
import { mergeCheck, FIT_FAMILY } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/reval-fit.ts"
import { readFileSync } from "node:fs"
const { xs, ys } = parseSeries(readFileSync("/tmp/claude-1001/robust.dat","utf-8"))
const ax = detectPeaks(ys).map(p=>xs[p]!)
const inv = FIT_FAMILY.find(f=>f.name==="inv-x")!
const us = ax.map(x=>inv.u(x))
const honest = ax.map(x=>1e7/x)
const r = (cs:number[]) => { const m = mergeCheck(us, cs); return m.ok ? "ACCEPT" : `reject(${m.reason})` }
// T6-class fabrication: consistent but INVENTED constants (fake laser offset)
const fab = us.map(u => 137.0 + 9.4e6 * u)
// wrong family: claim the raw x values are the answer
const rawx = [...ax]
// shifted pairing
const sh = [...honest.slice(1), honest[honest.length-1]!*1.01]
console.log(`anchors=${ax.length} | honest=${r(honest)} | FABRICATED=${r(fab)} | shifted=${r(sh)} | raw-x-as-claim=${r(rawx)}`)
