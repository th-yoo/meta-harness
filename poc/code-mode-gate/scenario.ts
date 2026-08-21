/** The task fixture: a unit-convention claim over a harness-enumerated
 * constellation — the same shape the real gate audits (irregular spacing so
 * the constellation is checkable; equal spacing would be refused as
 * uncheckable geometry).
 *
 * The mock model holds TWO hypotheses: H_SHIFTED (a plausible index-shift
 * error — the classic wrong claim the gate exists to reject) and H_HONEST.
 * Scripted behavior: try H_SHIFTED first, correct on rejection. This scripts
 * the CORRECTION so the PoC measures the ARCHITECTURE's cost arithmetic.
 * Whether a real model consumes steering is the un-bought actuation number
 * (prose-actuation prior 1/8) — this PoC deliberately does not claim it.
 */
export const ANCHORS_U = [1.0, 2.3, 2.9, 5.1, 7.8]

const A = 100
const B = 40

export const H_HONEST = ANCHORS_U.map((u) => A + B * u)
export const H_SHIFTED = [...H_HONEST.slice(1), H_HONEST[H_HONEST.length - 1]! + B]

/** Auxiliary read-only lookups the task needs before claiming (stand-ins for
 * readSeries / detectAnchors / sampleStats). Each is one tool call. */
export const AUX_TOOLS = {
  readSeries: () => ({ rows: 1500, cols: 2 }),
  detectAnchors: () => ANCHORS_U,
  sampleStats: () => ({ min: 0.4, max: 9.9 }),
}

export const AUX_TOOL_NAMES = Object.keys(AUX_TOOLS)

/** Tokens re-sent every round trip: system prompt + task + tool schemas +
 * accumulated history. Deliberately conservative (a real coding-agent context
 * is far larger); the composed arm's advantage GROWS with this number. */
export const CONTEXT_TOKENS = 4000
