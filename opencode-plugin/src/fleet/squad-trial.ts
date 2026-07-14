/**
 * squad-trial.ts — tier-2 candidate-selection gate ("Trial-gate stats now",
 * spec §6 channel 2 / §4 tier-2 table): drives N scripted trial slices
 * through BOTH one INACTIVE squad-def candidate version (never the active
 * pointer, spec §1.5 rule 1/`squad-propose.ts`'s own never-touches-active
 * discipline) AND the active def, over the SAME slice set, and compares their
 * pass rates as a PAIRED experiment (Fix 2).
 *
 * Why paired (Fix 2): comparing the candidate's N fresh trials against the
 * active version's UNRELATED score.json history compares two different task
 * sets — an easy trial batch manufactures a false win. Running the active def
 * through the identical trial slices removes that confound: each slice yields
 * a (candidate, active) pass/fail pair on the same task.
 *
 * Why a significance test (Fix 3): a raw `candRate >= activeRate` at n=3
 * promotes on ties and small-n noise. Promotion now requires a McNemar-
 * significant paired edge (reusing tier-1's `mcnemarExactOneSided`, ab-stats.
 * ts) over at least `MIN_TRIAL_PAIRS` pairs — the same rigor the tier-1 A/B
 * loop applies. A candidate that sets a gate to "human" is structurally
 * unwinnable here: this trial calls each run with `gatePolicy: "auto"`, which
 * leaves the def's OWN gatePolicy alone (spec §1.5 rule 4) — a human gate then
 * PAUSES (status "gate", not "done") and is counted as a fail every time. A
 * human reading a reject on such a candidate should read it as "cannot be
 * trialed under auto policy", not "worse than active".
 *
 * NO auto-activation — this only prints a verdict (confirm-suggested |
 * reject-suggested | insufficient-baseline). A human decides whether to
 * activate the candidate, same tier-1 pattern as propose -> ab/trial ->
 * human `/mh-activate` elsewhere in this codebase (never automatic).
 */
import { readFileSync } from "node:fs"
import { activeSquadVersion } from "./squad-def.ts"
import { cmdSquadRun } from "./squad-cli.ts"
import { mcnemarExactOneSided } from "../bench/ab-stats.ts"
import { die, log } from "../bench/util.ts"

/** Held-in significance threshold for the McNemar screen — matches tier-1's
 * `DEFAULT_DECISION_CONFIG.alpha` (ab-stats.ts). */
const TRIAL_ALPHA = 0.05

/** Minimum number of valid paired slices before ANY verdict other than
 * `insufficient-baseline` is possible. McNemar at alpha=0.05 cannot reach
 * significance below 5 all-discordant pairs (1/2^5 = 0.03125 ≤ 0.05, but
 * 1/2^4 = 0.0625 > 0.05), so 5 is the natural floor: below it no genuine
 * promotion is even statistically reachable. */
const MIN_TRIAL_PAIRS = 5

export interface SquadTrialResult {
  candidate: string
  nRuns: number
  candPass: number
  candRate: number
  /** Active def's pass rate over the SAME trial slices (Fix 2 — a true paired
   * baseline, not unrelated history). Null only when no paired samples ran. */
  activeRate: number | null
  /** Discordant pairs: `b` = candidate passed & active failed, `c` = active
   * passed & candidate failed (McNemar's inputs). */
  b: number
  c: number
  /** One-sided McNemar p-value that the candidate beats the active def on the
   * discordant pairs (Fix 3). */
  pValue: number
  verdict: "confirm-suggested" | "reject-suggested" | "insufficient-baseline"
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
  const activeVersion = activeSquadVersion(squadType)

  /** Build one run's call args. `gatePolicy: "auto"` leaves the def's OWN
   * gatePolicy alone (spec §1.5 rule 4): a candidate that mutated a gate to
   * "human" then PAUSES (status "gate", counted as a fail) — structurally
   * unwinnable under an auto-policy trial, by design (see file header). */
  const callArgsFor = (sliceId: string, slice: string, version: string) => ({
    project: args.project,
    sliceId,
    slice,
    squadType,
    defVersion: version,
    gatePolicy: "auto" as const,
  })

  // Paired run (Fix 2): drive the candidate AND the active def through the
  // SAME slice each iteration, so both rates are measured on identical tasks.
  let candPass = 0
  let activePass = 0
  let b = 0 // candidate passed, active failed
  let c = 0 // active passed, candidate failed
  for (let i = 0; i < n; i++) {
    const slice = sliceTexts[i % sliceTexts.length]!
    const candSliceId = `trial-${args.candidate}-${i}`
    // Distinct sliceId so the paired active run gets its own checkpoint/record
    // and never collides with the candidate's on disk.
    const activeSliceId = `trial-${activeVersion}-vs-${args.candidate}-${i}`
    const candPassed = await runTrialOnce(run, callArgsFor(candSliceId, slice, args.candidate), candSliceId)
    const activePassed = await runTrialOnce(run, callArgsFor(activeSliceId, slice, activeVersion), activeSliceId)
    if (candPassed) candPass++
    if (activePassed) activePass++
    if (candPassed && !activePassed) b++
    else if (!candPassed && activePassed) c++
  }

  const candRate = n > 0 ? candPass / n : 0
  const activeRate = n > 0 ? activePass / n : null

  // Significance gate (Fix 3): promote only on a McNemar-significant paired
  // edge over enough pairs — never a raw `>=` on small-n noise.
  const pValue = mcnemarExactOneSided(b, c)
  let verdict: SquadTrialResult["verdict"]
  if (n < MIN_TRIAL_PAIRS) {
    // Too few paired samples for any statistically reachable promotion.
    verdict = "insufficient-baseline"
  } else if (candPass > activePass && pValue <= TRIAL_ALPHA) {
    verdict = "confirm-suggested"
  } else {
    verdict = "reject-suggested"
  }

  const result: SquadTrialResult = {
    candidate: args.candidate,
    nRuns: n,
    candPass,
    candRate,
    activeRate,
    b,
    c,
    pValue,
    verdict,
  }
  console.log(JSON.stringify(result))
  return result
}
