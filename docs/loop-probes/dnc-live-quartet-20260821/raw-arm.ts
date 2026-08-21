import { mergeCheck, FIT_FAMILY } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/reval-fit.ts"
import { runJudgeOpencode } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/opencode-run.ts"
import { readFileSync, writeFileSync } from "node:fs"

// same four anchors, RAW conventions: EU decimal comma, descending file order
const rawLines = ["7411,503835", "6327,542514", "6174,891631", "3745,081694"]
const numeric = rawLines.map((s) => Number(s.replace(",", ".")))

const instruction = readFileSync("term-bench2/probe-tasks/raman-quartet-report/instruction.md", "utf-8")
const prompt = `${instruction}

The first column of the data file holds these values at the ${rawLines.length} strongest features, quoted exactly as they appear in the file:
${rawLines.map((v, i) => `  ${i + 1}: ${v}`).join("\n")}

Report, for EVERY feature listed above and in that order, the value you would
write for it as the band position. Also state which relationship holds between
the first-column value x and the position you report: "x" if the position is an
affine function of x, or "inv-x" if it is an affine function of 1/x.

End your answer with exactly this block and nothing after it:

ANCHOR CLAIM:
FAMILY: <x | inv-x>
CANONICALS: <one number per feature, comma separated, in the listed order>
`
writeFileSync("/tmp/claude-1001/raw-prompt.txt", prompt)
console.log("[harness] RAW arm: EU comma + descending, peak-finding still done")

const reply = await runJudgeOpencode(prompt, "anthropic/claude-sonnet-5", 180, 3, undefined, undefined, "/tmp/claude-1001/neutral-agent.txt")
if (!reply) { console.log("OUTCOME D: transport, no reply"); process.exit(1) }
writeFileSync("/tmp/claude-1001/raw-reply.txt", reply)
console.log("=== REPLY (tail) ===\n" + reply.slice(-800))

const m = reply.match(/^ANCHOR CLAIM:\s*$/m)
if (!m) { console.log("\nOUTCOME D: no ANCHOR CLAIM block"); process.exit(0) }
const body = reply.slice(m.index!)
const fam = body.match(/^FAMILY:\s*(\S+)/m)?.[1]?.toLowerCase()
const csRaw = body.match(/^CANONICALS:\s*(.+)$/m)?.[1]
console.log(`\n[parse] family=${fam}  canonicals=${csRaw}`)
if (!fam || !csRaw) process.exit(0)
// canonicals may themselves be comma-decimal; split on comma-space or bare comma between numbers
const cs = csRaw.split(/,\s+|\s+/).map((s) => Number(s.trim().replace(/,$/, ""))).filter((v) => Number.isFinite(v))
console.log(`[parse] ${cs.length} numeric canonicals: ${cs.join(" | ")}`)
if (cs.length !== numeric.length) { console.log(`[gate] REFUSE coverage: ${cs.length} vs ${numeric.length}`); process.exit(0) }
const member = FIT_FAMILY.find((f) => f.name === fam)
if (!member) { console.log(`[gate] REFUSE: family '${fam}' not frozen`); process.exit(0) }
const us = numeric.map((x) => member.u(x))
const r = mergeCheck(us, cs)
console.log(`[gate] ok=${r.ok} reason=${r.reason ?? "-"} a=${r.a?.toPrecision(5)} b=${r.b?.toPrecision(6)}`)
const truth = numeric.map((x) => 1e7 / x)
console.log(`[truth] true shifts: ${truth.map((v) => v.toFixed(1)).join(", ")}`)
console.log(`[truth] max abs err: ${Math.max(...cs.map((c, i) => Math.abs(c - truth[i]!))).toPrecision(4)}`)
