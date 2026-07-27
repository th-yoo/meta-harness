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
  /** Optional (grip-fix design S1): 1-based artifact lines the verification
   * actually executes — typically one traced verify run. Fail-open: absent
   * or `undefined` result = no coverage filtering. */
  coveredLines?(): MaybeAsync<Set<number> | undefined>
}

export interface GateRoundResult {
  outcome: "accepted" | "no-verify" | "verify-failed" | "mutant-survived" | "artifact-missing"
  mutantsTried: number
  mutantsSurvived: number
  mutantsKilled: number
  /** S1 provenance: "filtered" = coverage restricted the sites;
   * "fallback-static" = coverage emptied them (vacuity hazard) so static
   * sites were used; "off" = no coverage data. */
  coverage: "off" | "filtered" | "fallback-static"
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
      r: { outcome: "no-verify", mutantsTried: 0, mutantsSurvived: 0, mutantsKilled: 0, coverage: "off" },
      reinjectMsg:
        "not done: leave a runnable verification script at /app/verify.sh (exit 0 = verified) that exercises each promised behavior of your artifact — including scenarios that COMBINE boundary conditions (capacity limits, blocking/awaiting operations inside promised paths) — then run it and fix anything it finds.",
    }
  const v = await io.runVerify(false)
  if (v.code !== 0)
    return {
      r: { outcome: "verify-failed", mutantsTried: 0, mutantsSurvived: 0, mutantsKilled: 0, coverage: "off" },
      reinjectMsg: `not done: your verification script fails:\n${v.out.slice(-OUT_TAIL)}\nFix the artifact (or the script if it is wrong about the contract) and re-run it.`,
    }
  const src = await io.readArtifact()
  if (src === undefined)
    return {
      r: { outcome: "artifact-missing", mutantsTried: 0, mutantsSurvived: 0, mutantsKilled: 0, coverage: "off" },
      reinjectMsg: "not done: the required artifact file is missing.",
    }
  // S1: restrict mutation sites to lines the verification executes. Fail-open
  // on missing coverage; fall back to static sites if coverage empties the
  // list (vacuity hazard — a vacuous probe must not silently pass).
  const covered = io.coveredLines ? await io.coveredLines() : undefined
  let coverage: GateRoundResult["coverage"] = covered ? "filtered" : "off"
  let ms = generateMutants(src, mutants, io.syntaxOk, covered)
  if (covered && ms.length === 0) {
    ms = generateMutants(src, mutants, io.syntaxOk)
    coverage = "fallback-static"
  }
  let survived = 0
  let killed = 0
  let firstDiff = ""
  for (const m of ms) {
    if (!(await io.writeArtifact(m.mutated))) continue
    const mv = await io.runVerify(true)
    await io.restoreArtifact()
    // Non-zero exit on a mutant = killed. A timed-out mutant run also lands
    // here (timeout wrappers exit non-zero): behavior changed detectably —
    // the field's timeout-as-kill rule.
    if (mv.code === 0) {
      survived++
      if (!firstDiff) firstDiff = unifiedDiff(src, m.mutated)
    } else killed++
  }
  // S3: the round fails only when NOTHING was killed — a junk verification
  // kills nothing and is still caught; an equivalent/unreachable straggler
  // among real kills no longer poisons the round (all-must-die retired).
  if (ms.length > 0 && killed === 0)
    return {
      r: { outcome: "mutant-survived", mutantsTried: ms.length, mutantsSurvived: survived, mutantsKilled: 0, coverage },
      reinjectMsg: `not done: your verification did not detect ANY of ${ms.length} injected fault(s) in your artifact. One example it missed:\n${firstDiff}\nYour scenarios do not constrain the behavior they exercise. Strengthen /app/verify.sh with assertions on the exercised paths (combine boundary conditions, e.g. load above every stated capacity bound WHILE operations block or await inside the promised path), confirm it now fails on wrong behavior, then make it pass on the real artifact.`,
    }
  return { r: { outcome: "accepted", mutantsTried: ms.length, mutantsSurvived: survived, mutantsKilled: killed, coverage } }
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
