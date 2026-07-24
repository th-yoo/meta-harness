/**
 * minimal/complete-gate.ts — the completion gate (binding actuator),
 * docs/2026-07-24-completion-gate-design.md.
 *
 * Refuses to accept an attempt until: verify.sh exists → verify.sh passes →
 * the adequacy probe passes (no crude mutant of the artifact survives the
 * agent's own verification). Each failure reinjects a "not done" message with
 * concrete evidence (missing script / failing output tail / surviving-mutant
 * diff) into the SAME agent session, bounded by `rounds`. After the bound the
 * attempt is accepted anyway (gateExhausted recorded) — the gate shapes
 * behavior, the task grader still owns reward.
 *
 * IO is injected: run.ts wires podman-exec + opencode-session calls; tests
 * use fakes. The gate never touches the task grader (invariant 1).
 */
import { generateMutants, unifiedDiff } from "./mutate.ts"

type MaybeAsync<T> = T | Promise<T>

export interface GateIO {
  verifyExists(): MaybeAsync<boolean>
  /** Run /app/verify.sh. `onMutant` true while a mutant is installed. */
  runVerify(onMutant?: boolean): MaybeAsync<{ code: number; out: string }>
  readArtifact(): MaybeAsync<string | undefined>
  writeArtifact(content: string): MaybeAsync<boolean>
  restoreArtifact(): MaybeAsync<boolean>
  syntaxOk(mutated: string): boolean
  /** Continue the agent session with a "not done" message. */
  reinject(message: string): MaybeAsync<boolean>
}

export interface GateRoundResult {
  outcome: "accepted" | "no-verify" | "verify-failed" | "mutant-survived" | "artifact-missing"
  mutantsTried: number
  mutantsSurvived: number
}

export interface GateResult {
  accepted: boolean
  gateExhausted: boolean
  rounds: GateRoundResult[]
}

const OUT_TAIL = 600

async function checkRound(io: GateIO, mutants: number): Promise<{ r: GateRoundResult; reinjectMsg?: string }> {
  if (!(await io.verifyExists()))
    return {
      r: { outcome: "no-verify", mutantsTried: 0, mutantsSurvived: 0 },
      reinjectMsg:
        "not done: leave a runnable verification script at /app/verify.sh (exit 0 = verified) that exercises each promised behavior of your artifact — including scenarios that COMBINE boundary conditions (capacity limits, blocking/awaiting operations inside promised paths) — then run it and fix anything it finds.",
    }
  const v = await io.runVerify(false)
  if (v.code !== 0)
    return {
      r: { outcome: "verify-failed", mutantsTried: 0, mutantsSurvived: 0 },
      reinjectMsg: `not done: your verification script fails:\n${v.out.slice(-OUT_TAIL)}\nFix the artifact (or the script if it is wrong about the contract) and re-run it.`,
    }
  const src = await io.readArtifact()
  if (src === undefined)
    return {
      r: { outcome: "artifact-missing", mutantsTried: 0, mutantsSurvived: 0 },
      reinjectMsg: "not done: the required artifact file is missing.",
    }
  const ms = generateMutants(src, mutants, io.syntaxOk)
  let survived = 0
  let firstDiff = ""
  for (const m of ms) {
    if (!(await io.writeArtifact(m.mutated))) continue
    const mv = await io.runVerify(true)
    await io.restoreArtifact()
    if (mv.code === 0) {
      survived++
      if (!firstDiff) firstDiff = unifiedDiff(src, m.mutated)
    }
  }
  if (survived > 0)
    return {
      r: { outcome: "mutant-survived", mutantsTried: ms.length, mutantsSurvived: survived },
      reinjectMsg: `not done: your verification did not detect an injected fault in your artifact:\n${firstDiff}\nYour scenarios under-cover the contract. Strengthen /app/verify.sh with scenarios that combine boundary conditions (e.g. load above every stated capacity bound WHILE operations block or await inside the promised path), confirm it now fails on wrong behavior, then make it pass on the real artifact.`,
    }
  return { r: { outcome: "accepted", mutantsTried: ms.length, mutantsSurvived: 0 } }
}

export async function runCompletionGate(
  io: GateIO,
  opts: { rounds: number; mutants: number },
): Promise<GateResult> {
  const rounds: GateRoundResult[] = []
  for (let attempt = 0; ; attempt++) {
    const { r, reinjectMsg } = await checkRound(io, opts.mutants)
    rounds.push(r)
    if (r.outcome === "accepted") return { accepted: true, gateExhausted: false, rounds }
    if (attempt >= opts.rounds)
      return { accepted: true, gateExhausted: true, rounds }
    if (!(await io.reinject(reinjectMsg!)))
      return { accepted: true, gateExhausted: true, rounds }
  }
}
