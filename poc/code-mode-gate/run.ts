import { runClassic, runComposed } from "./arms.ts"
import { CONTEXT_TOKENS } from "./scenario.ts"

const classic = runClassic()
const composed = runComposed()

const row = (label: string, a: number | string, b: number | string) =>
  console.log(`${label.padEnd(34)} ${String(a).padStart(10)} ${String(b).padStart(10)}`)

console.log(`code-mode batching + zero-spend gate — cost arithmetic (context=${CONTEXT_TOKENS} tok/trip)\n`)
row("", "classic", "composed")
row("model round trips", classic.meter.roundTrips, composed.meter.roundTrips)
row("tool calls (identical work)", classic.meter.toolCalls, composed.meter.toolCalls)
row("gate checks", classic.meter.gateChecks, composed.meter.gateChecks)
row("gate rejections", classic.meter.gateRejections, composed.meter.gateRejections)
row("rejections absorbed in-turn", classic.meter.localRetries, composed.meter.localRetries)
row("approx input tokens", classic.meter.approxTokens, composed.meter.approxTokens)
row(
  "committed claim identical",
  JSON.stringify(classic.committed) === JSON.stringify(composed.committed) ? "yes" : "NO",
  "",
)
console.log(
  `\ntoken ratio classic/composed: ${(classic.meter.approxTokens / composed.meter.approxTokens).toFixed(1)}x` +
    ` (grows linearly with context size and with per-task tool calls)`,
)
