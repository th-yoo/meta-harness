/**
 * squad-trial.ts — tier-2 candidate-selection gate ("Trial-gate stats now",
 * spec §6 channel 2 / §4 tier-2 table): drives N scripted-slice runs against
 * one INACTIVE squad-def candidate version (never the active pointer,
 * spec §1.5 rule 1/`squad-propose.ts`'s own never-touches-active
 * discipline) and compares the batch's pass rate against the active
 * version's EXISTING score.json evidence (sessions recorded before this
 * trial ran).
 *
 * NO auto-activation — this only prints a verdict (confirm-suggested |
 * reject-suggested | insufficient-baseline). A human decides whether to
 * activate the candidate, same tier-1 pattern as propose -> ab/trial ->
 * human `/mh-activate` elsewhere in this codebase (never automatic).
 */
import { existsSync, readFileSync } from "node:fs"
import { activeSquadVersion, squadRoot, type SquadOutcomeRecord } from "./squad-def.ts"
import { candidatePath } from "../harness-store.ts"
import { cmdSquadRun } from "./squad-cli.ts"
import { die, log } from "../bench/util.ts"

export interface SquadTrialResult {
  candidate: string
  nRuns: number
  candPass: number
  candRate: number
  /** From the active version's EXISTING score.json sessions (predating this
   * trial) — null when that version has no scored sessions yet, i.e. no
   * baseline to compare against. */
  activeRate: number | null
  verdict: "confirm-suggested" | "reject-suggested" | "insufficient-baseline"
}

/** score.json shape at squadRoot(type)/candidates/<version>/score.json —
 * same shape squad-def.ts's `recordSquadOutcome` writes (deliberately
 * identical to harness-store's CandidateScore, per that file's comment). */
interface SquadScoreEvidence {
  version: string
  nPass: number
  nFail: number
  sessions: SquadOutcomeRecord[]
}

function readSquadScore(type: string, version: string): SquadScoreEvidence {
  const p = candidatePath(squadRoot(type), version, "score.json")
  if (!existsSync(p)) return { version, nPass: 0, nFail: 0, sessions: [] }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SquadScoreEvidence
  } catch {
    return { version, nPass: 0, nFail: 0, sessions: [] }
  }
}

/**
 * One slice text per trial run, cycled if there are fewer texts than `n`
 * runs. Exactly one of `slice` / `sliceFile` must be given (mirrors
 * squad-run's own mutually-exclusive contract). `sliceFile` is one slice per
 * line — blank lines are dropped.
 */
function resolveSliceTexts(args: { slice?: string; sliceFile?: string }): string[] {
  if (args.sliceFile !== undefined) {
    const lines = readFileSync(args.sliceFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length === 0) {
      die(`squad-trial: --slice-file ${args.sliceFile} has no non-empty lines`)
    }
    return lines
  }
  if (args.slice !== undefined) return [args.slice]
  die("squad-trial requires --slice or --slice-file")
}

/**
 * Run one trial slice via `runFn` (real signature: `cmdSquadRun`). A THROWN
 * error (transient — e.g. an auth/transient drive failure bubbling up
 * uncaught) retries the SAME run once, fresh (never `--resume`: a thrown
 * drive never reaches `saveCheckpoint`, so there is no checkpoint to resume
 * from) — a second failure counts as fail and is logged. `done` -> pass;
 * any other terminal status (`escalation` of any type, or an unexpected
 * `gate` pause despite the `gatePolicy: "auto"` call) -> fail, no retry
 * (only a THROW is treated as transient).
 */
async function runTrialOnce(
  runFn: typeof cmdSquadRun,
  callArgs: Parameters<typeof cmdSquadRun>[0],
  sliceId: string,
): Promise<boolean> {
  try {
    const outcome = await runFn(callArgs)
    return outcome.status === "done"
  } catch (e) {
    log(`squad-trial: run ${sliceId} threw (${(e as Error).message}) — retrying once`)
    try {
      const outcome = await runFn(callArgs)
      return outcome.status === "done"
    } catch (e2) {
      log(`squad-trial: run ${sliceId} failed again on retry (${(e2 as Error).message}) — counting as fail`)
      return false
    }
  }
}

export async function cmdSquadTrial(
  args: {
    project: string
    squadType?: string
    candidate: string
    slice?: string
    sliceFile?: string
    /** Number of trial runs — default 3. */
    n?: number
  },
  runFn?: typeof cmdSquadRun,
): Promise<SquadTrialResult> {
  const run = runFn ?? cmdSquadRun
  const squadType = args.squadType ?? "standard"
  if (args.n !== undefined && (!Number.isInteger(args.n) || args.n < 1)) {
    die(`squad-trial: --n must be a positive integer, got: ${args.n}`)
  }
  const n = args.n ?? 3
  const sliceTexts = resolveSliceTexts(args)

  let candPass = 0
  for (let i = 0; i < n; i++) {
    const sliceId = `trial-${args.candidate}-${i}`
    const slice = sliceTexts[i % sliceTexts.length]!
    const callArgs = {
      project: args.project,
      sliceId,
      slice,
      squadType,
      defVersion: args.candidate,
      // Trial runs must reach a terminal outcome in one shot, never pause
      // for a human — "auto" leaves the candidate def's OWN gatePolicy
      // alone (spec §1.5 rule 4), which is auto/auto for every squad def
      // shipped by this codebase (STANDARD_SQUAD and any tier-2 flow-knob
      // mutation of it — squad-propose.ts's proposer may legally change
      // gate1/gate2 to "human", in which case a trial run would pause; that
      // is surfaced as a non-"done" outcome, i.e. counted as a fail below,
      // never silently retried).
      gatePolicy: "auto" as const,
    }
    const passed = await runTrialOnce(run, callArgs, sliceId)
    if (passed) candPass++
  }

  const candRate = n > 0 ? candPass / n : 0

  const activeVersion = activeSquadVersion(squadType)
  const activeScore = readSquadScore(squadType, activeVersion)
  const activeRate =
    activeScore.sessions.length > 0
      ? activeScore.sessions.filter((s) => s.passed).length / activeScore.sessions.length
      : null

  const verdict: SquadTrialResult["verdict"] =
    activeRate === null ? "insufficient-baseline" : candRate >= activeRate ? "confirm-suggested" : "reject-suggested"

  const result: SquadTrialResult = { candidate: args.candidate, nRuns: n, candPass, candRate, activeRate, verdict }
  console.log(JSON.stringify(result))
  return result
}
