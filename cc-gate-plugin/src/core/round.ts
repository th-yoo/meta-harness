// runSingleRound — rounds:1 capture-and-refuse over runCompletionGate.
//
// Wraps the completion gate's multi-round loop into a single synchronous-
// feeling round: build a GateIO whose reinject() captures the "not done"
// message instead of continuing an agent session, then always returns
// false so runCompletionGate stops immediately after the first round.
//
// rounds:1 (not rounds:0) is deliberate — with rounds:0 the gate returns
// gateExhausted on attempt 0 WITHOUT ever calling reinject, so the evidence
// message would never be produced. rounds:1 lets attempt 0 fail and call
// reinject (attempt 0 < opts.rounds 1), which is where we capture the
// message; reinject then returns false, so the loop exits right there
// without a second check-round.
import type { RoundOutcome } from "../types.ts"
import { runCompletionGate, type GateIO } from "../../vendor/complete-gate.ts"

export async function runSingleRound(
  runCheck: (cmd: string) => Promise<{ code: number; out: string }>,
  check: string,
): Promise<{ outcome: RoundOutcome; evidence?: string; rawOut?: string }> {
  let evidence: string | undefined
  // Tee the raw check output at OUR IO seam: the reinject composer builds
  // v1's message from it instead of editing the kernel's prose.
  let lastOut: string | undefined

  const io: GateIO = {
    verifyExists: () => true,
    runVerify: async () => {
      const r = await runCheck(check)
      lastOut = r.out
      return r
    },
    readArtifact: () => "",
    writeArtifact: () => false,
    restoreArtifact: () => true,
    syntaxOk: () => true,
    reinject: (message: string) => {
      evidence = message
      return false
    },
  }

  const result = await runCompletionGate(io, { rounds: 1, mutants: 0 })

  // The harness's own accepted/gateExhausted are ignored on purpose:
  // persistent state (outside this module) owns the real multi-round
  // cycle, so under this single-shot harness a failure always presents
  // as "exhausted" — the per-round outcome + captured evidence is the
  // signal callers actually need.
  // rawOut only on verify-failed: if requirements/relations are ever wired
  // in, a PASSING check output must never be composed under a "check
  // failed" headline (architect review Q1).
  const outcome = result.rounds[0]!.outcome
  return {
    outcome,
    evidence,
    ...(outcome === "verify-failed" && lastOut !== undefined ? { rawOut: lastOut } : {}),
  }
}
