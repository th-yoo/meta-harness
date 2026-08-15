// Measures the dogfood hook's marginal cost per PreToolUse event at the
// 16-rule cap: readFileSync + JSON.parse + per-tool filter + RegExp.test
// against every rule. Percentiles over ITERS calls, rotating inputs.
// Run: bun docs/loop-probes/hook-rule-p0/latency-probe.ts
import { readFileSync } from "node:fs"

const TABLE = new URL("./assets/hook-rules-16.json", import.meta.url).pathname
const ITERS = 2000

const typical = [
  "ls -la",
  "bun test opencode-plugin/test/rule-gate.test.ts",
  "git status --porcelain",
  "npm install left-pad",
  "grep -rn hookRule opencode-plugin/src",
  'for f in $(find . -name "*.ts"); do wc -l "$f"; done',
]
// 10KB worst-case: long non-matching command (no rule anchors match early).
const worst = "true " + "x".repeat(10_000)
const inputs = [...typical, worst]

function evalOnce(command: string): { matches: number; r16Ms: number } {
  const table = JSON.parse(readFileSync(TABLE, "utf-8"))
  let matches = 0
  let r16Ms = 0
  for (const r of table.rules) {
    if (r.toolMatcher !== "Bash") continue
    const t0 = performance.now()
    if (new RegExp(r.inputPattern).test(command)) matches++
    const ms = performance.now() - t0
    if (r.id === "r16") r16Ms = ms // by id, not array position — survives fixture reordering
  }
  return { matches, r16Ms }
}

const samples: number[] = []
let r16WorstMs = 0
for (let i = 0; i < ITERS; i++) {
  const input = inputs[i % inputs.length]!
  const t0 = performance.now()
  const { r16Ms } = evalOnce(input)
  samples.push(performance.now() - t0)
  if (input === worst) r16WorstMs = Math.max(r16WorstMs, r16Ms)
}
samples.sort((a, b) => a - b)
const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]!
console.log(
  JSON.stringify(
    {
      iters: ITERS,
      p50_ms: +pct(50).toFixed(3),
      p95_ms: +pct(95).toFixed(3),
      max_ms: +samples[samples.length - 1]!.toFixed(3),
      r16_worst_input_max_ms: +r16WorstMs.toFixed(3),
      budget_p95_ms: 5,
      pass: pct(95) <= 5,
    },
    null,
    2,
  ),
)
