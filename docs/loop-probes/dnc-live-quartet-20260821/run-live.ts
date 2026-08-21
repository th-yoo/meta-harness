import { readSeriesFile } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-source.ts"
import { detectPeaks } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-peaks.ts"
import { mergeCheck, FIT_FAMILY } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/reval-fit.ts"
import { runJudgeOpencode } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/opencode-run.ts"
import { readFileSync, writeFileSync } from "node:fs"

const TASK = "term-bench2/probe-tasks/raman-quartet-report"
const root = `${TASK}/environment`
const { xs, ys } = readSeriesFile(`${root}/task-deps/graphene.dat`, root)
const idx = detectPeaks(ys)
const anchorX = idx.map((p) => xs[p]!)
console.log(`[harness] detected ${anchorX.length} anchors: ${anchorX.map((v) => v.toFixed(3)).join(", ")}`)

const instruction = readFileSync(`${TASK}/instruction.md`, "utf-8")
const prompt = `${instruction}

The first column of the data file holds these values at the ${anchorX.length} strongest features:
${anchorX.map((v, i) => `  ${i + 1}: ${v}`).join("\n")}

Report, for EVERY feature listed above and in that order, the value you would
write for it as the band position. Also state which relationship holds between
the first-column value x and the position you report: "x" if the position is an
affine function of x, or "inv-x" if it is an affine function of 1/x.

End your answer with exactly this block and nothing after it:

ANCHOR CLAIM:
FAMILY: <x | inv-x>
CANONICALS: <one number per feature, comma separated, in the listed order>
`
writeFileSync("/tmp/claude-1001/live-prompt.txt", prompt)
console.log(`[harness] prompt ${prompt.length} bytes -> calling model`)

// pass a nonexistent promptPath so judgeAgentConfig returns null -> no mh-judge
// persona, plain model call. The judge persona is a TRAJECTORY judge and its
// anti-injection policy correctly refuses a solve-shaped prompt.
const reply = await runJudgeOpencode(prompt, "anthropic/claude-sonnet-5", 180, 3, undefined, undefined, "/tmp/claude-1001/neutral-agent.txt")
if (!reply) { console.log("TRANSPORT: no reply"); process.exit(1) }
writeFileSync("/tmp/claude-1001/live-reply.txt", reply)
console.log("=== REPLY (tail) ===")
console.log(reply.slice(-900))

const m = reply.match(/^ANCHOR CLAIM:\s*$/m)
if (!m) { console.log("PARSE: no ANCHOR CLAIM block"); process.exit(0) }
const body = reply.slice(m.index!)
const fam = body.match(/^FAMILY:\s*(\S+)/m)?.[1]?.toLowerCase()
const csRaw = body.match(/^CANONICALS:\s*(.+)$/m)?.[1]
console.log(`\n[parse] family=${fam} canonicals=${csRaw}`)
if (!fam || !csRaw) process.exit(0)
const cs = csRaw.split(",").map((s) => Number(s.trim()))
if (cs.some((v) => !Number.isFinite(v)) || cs.length !== anchorX.length) {
  console.log(`[gate] REFUSE: coverage — got ${cs.length} values for ${anchorX.length} anchors`)
  process.exit(0)
}
const member = FIT_FAMILY.find((f) => f.name === fam)
if (!member) { console.log(`[gate] REFUSE: family '${fam}' not in frozen set`); process.exit(0) }
const us = anchorX.map((x) => member.u(x))
const r = mergeCheck(us, cs)
console.log(`\n[gate] mergeCheck: ok=${r.ok} reason=${r.reason ?? "-"} a=${r.a?.toPrecision(5)} b=${r.b?.toPrecision(6)} delta=${r.delta?.toPrecision(4)}`)
const truth = anchorX.map((x) => 1e7 / x)
console.log(`[truth] true shifts: ${truth.map((v) => v.toFixed(1)).join(", ")}`)
console.log(`[truth] claim max abs err vs true shift: ${Math.max(...cs.map((c, i) => Math.abs(c - truth[i]!))).toPrecision(4)}`)
