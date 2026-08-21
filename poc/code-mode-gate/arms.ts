/** The two arms. Identical task, identical mock-model knowledge, identical
 * final committed claim — only the ORCHESTRATION SHAPE differs.
 *
 * CLASSIC: the standard agent loop. Every tool call is its own model round
 * trip (the model sees the result only in the next context); a gate rejection
 * ends the turn and the steering arrives as feedback in the NEXT trip. This is
 * the measured raman-thrash shape: reject → new turn → retry.
 *
 * COMPOSED: code-mode batching + gated effects. ONE program performs the aux
 * reads, tries H_SHIFTED, consumes the gate's steering in-turn, corrects to
 * H_HONEST, commits. One round trip total.
 */
import { Runtime, type CostMeter } from "./runtime.ts"
import { ANCHORS_U, AUX_TOOLS, AUX_TOOL_NAMES, CONTEXT_TOKENS, H_HONEST, H_SHIFTED } from "./scenario.ts"

export interface ArmOutcome {
  committed: number[] | null
  meter: CostMeter
  rejectionsSeen: number
}

const scenario = { contextTokens: CONTEXT_TOKENS, anchorsU: ANCHORS_U, auxTools: AUX_TOOLS }

const lit = (xs: number[]) => JSON.stringify(xs)

export function runClassic(): ArmOutcome {
  const rt = new Runtime(scenario)
  let rejections = 0

  // one round trip per aux tool call — the loop's fundamental cost shape
  for (const name of AUX_TOOL_NAMES) {
    rt.runTurn(`api.tools.${name}();`)
  }

  // trip: propose the wrong hypothesis; turn ENDS on rejection (feedback is
  // only available to the model in the next context)
  const attempt = rt.runTurn(`api.checkAndCommit(${lit(H_SHIFTED)});`)
  rejections += attempt.verdicts.filter((v) => !v.ok).length

  // next trip: model has read the rejection + steering, proposes corrected claim
  rt.runTurn(`api.checkAndCommit(${lit(H_HONEST)});`)

  return { committed: rt.getCommitted(), meter: rt.meter, rejectionsSeen: rejections }
}

export function runComposed(): ArmOutcome {
  const rt = new Runtime(scenario)
  const program = `
    api.tools.readSeries();
    api.tools.detectAnchors();
    api.tools.sampleStats();
    let verdict = api.checkAndCommit(${lit(H_SHIFTED)});
    if (!verdict.ok) {
      api.log("gate rejected: " + verdict.reason + "; worst anchor index " +
        (verdict.steering ? verdict.steering.worstFirst[0] : "n/a"));
      verdict = api.checkAndCommit(${lit(H_HONEST)});
    }
  `
  const result = rt.runTurn(program)
  return {
    committed: rt.getCommitted(),
    meter: rt.meter,
    rejectionsSeen: result.verdicts.filter((v) => !v.ok).length,
  }
}
