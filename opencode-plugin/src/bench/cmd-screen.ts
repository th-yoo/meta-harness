/**
 * cmd-screen.ts — `screen` subcommand (Phase 7 / W4a): a cheap k=1
 * candidate-tournament that ranks N candidate prompt versions of ONE layer
 * so only the winner advances to the expensive k=5 `ab` verdict.
 *
 * NOT a bash script — cmd-run.ts's `cmdRun` (exported, injectable here as
 * `runFn`) does the heavy lifting per candidate; this module is a thin
 * per-candidate sweep loop plus a pure ranking function. Each candidate gets
 * its own `--results-file <outDir>/<vN>.json`, which (a) forces `noStore` in
 * cmdRun (cmd-run.ts:491ish — resultsFile set => noStore true) so a screen
 * NEVER writes the version store, and (b) is the free-resume mechanism: a
 * results file already stamped `status: "complete"` (results.ts's
 * writeRunResults) is skipped entirely on a re-invocation.
 *
 * Screen never emits a verdict (that's `ab`'s job, with acceptance
 * authority) — it only ORDERS candidates and prints an `ADVANCE:` hint
 * naming the top candidate's follow-up `bench ab` invocation.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { BenchPaths } from "./paths.ts"
import { LAYER_CHOICES, type LayerName } from "./record.ts"
import { cmdRun, type CmdRunArgs } from "./cmd-run.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import type { TaskAgg } from "./results.ts"
import { BenchError, die, log, pyFixed, writeJsonAtomic } from "./util.ts"

// ── ranking ────────────────────────────────────────────────────────────

/** The subset of a run-results JSON (results.ts's writeRunResults shape)
 * rankScreens actually reads. Loosely typed (`[k: string]: unknown`) since
 * a results file carries many more fields (model, harness, env, ...) this
 * module has no opinion on. */
export interface ScreenResultsLike {
  n_pass?: number
  n_total?: number
  status?: string
  tasks?: Record<string, TaskAgg>
  [k: string]: unknown
}

/** One candidate's sweep outcome, fed into rankScreens. `results` is the
 * parsed contents of that candidate's results file (present iff the sweep
 * reached a usable results file — either freshly written or resumed from a
 * prior complete run); `error` is set instead when the candidate's cmdRun
 * call threw (error isolation) or never produced a readable/complete
 * results file. */
export interface ScreenEntry {
  candidate: string
  results?: ScreenResultsLike
  error?: string
}

export interface ScreenRank {
  candidate: string
  /** -1 for an error row — always sorts behind every real (nPass >= 0) row,
   * including a genuine 0-pass sweep. */
  nPass: number
  nTotal: number
  /** Sum of `elapsed` over PASSING tasks only (setup_failed tasks stamp
   * elapsed 0.0 and never pass, so they're excluded from this sum simply by
   * virtue of the pass filter — never compare fail-times, same discipline
   * as ab-stats.ts's pairedSpeedStats). A passing task with a missing/empty
   * `elapsed` array contributes 0 to the sum but flips `missingElapsed`. */
  passElapsed: number
  /** True iff at least one PASSING task had no elapsed reading to sum —
   * i.e. `passElapsed` is known-incomplete for this candidate. Only used as
   * the final tiebreak key (complete-data candidates rank ahead of
   * incomplete-data ones on an exact nPass+passElapsed tie); an error row
   * is always `true` (there is no usable data at all). */
  missingElapsed: boolean
  error?: string
}

/**
 * Pure ranking function: sorts a completed sweep's per-candidate results
 * into a `bench ab`-ready order.
 *
 * Order: nPass desc, then passElapsed asc, then complete-data-first on an
 * exact tie (a candidate with `missingElapsed` false ranks ahead of one
 * with `missingElapsed` true — its passElapsed number is trustworthy, the
 * other's is a known undercount). Error rows always sort last, regardless
 * of any of the above.
 */
export function rankScreens(entries: ScreenEntry[]): ScreenRank[] {
  const ranked = entries.map((e): ScreenRank => {
    if (e.error || !e.results || e.results.status !== "complete") {
      return {
        candidate: e.candidate,
        nPass: -1,
        nTotal: 0,
        passElapsed: Infinity,
        missingElapsed: true,
        error: e.error ?? "no complete results",
      }
    }
    const tasks = e.results.tasks ?? {}
    let passElapsed = 0
    let missingElapsed = false
    for (const agg of Object.values(tasks)) {
      const rewards = agg.rewards ?? []
      const passed = rewards.length > 0 && Math.max(...rewards) === 1
      if (!passed) continue
      const elapsed = agg.elapsed ?? []
      if (elapsed.length === 0) {
        missingElapsed = true
        continue
      }
      passElapsed += elapsed.reduce((a, b) => a + b, 0)
    }
    return {
      candidate: e.candidate,
      nPass: e.results.n_pass ?? 0,
      nTotal: e.results.n_total ?? 0,
      passElapsed,
      missingElapsed,
    }
  })
  return ranked.sort((a, b) => {
    if (Boolean(a.error) !== Boolean(b.error)) return a.error ? 1 : -1
    if (a.nPass !== b.nPass) return b.nPass - a.nPass
    if (a.passElapsed !== b.passElapsed) return a.passElapsed - b.passElapsed
    return Number(a.missingElapsed) - Number(b.missingElapsed)
  })
}

// ── cmd_screen ─────────────────────────────────────────────────────────

export interface CmdScreenArgs {
  layer: LayerName
  candidates: string[]
  agent?: string
  tasks?: string[]
  taskFile?: string
  all?: boolean
  model?: string
  variant?: string
  layers?: "global" | "account" | "project" | "none"
  staging?: StagingMode
  driver?: string
  maxAgentTimeout?: number
  maxVerifierTimeout?: number
  /** Loosest-envelope floor — defaults to 3600s (cmdScreen, not cmd-run.ts,
   * owns this default): the SAME floor the follow-up `ab --k 5` uses, so a
   * screen's ordering is never budget-confounded against the ab that
   * decides based on it. Stamped verbatim into the ranking output
   * (`ranking.json`'s `minAgentTimeout`) so that guarantee is verifiable
   * after the fact, not just asserted in a comment. */
  minAgentTimeout?: number
  /** Budget-packed concurrent task execution, threaded straight through to
   * EACH candidate's own cmdRun call (architect MAJOR ×2 — a serial
   * N-candidate × k=1 sweep would defeat the velocity purpose of a k=1
   * screen). Same contract as cmd-run.ts's CmdRunArgs.parallel. */
  parallel?: boolean
  enforceResources?: boolean
  minCpus?: number
  minMemMb?: number
  cpuBudget?: number
  memBudget?: number
  noPackMeasured?: boolean
  hostPressure?: "observe" | "on"
  /** Internal-only wiring, mirroring cmd-run.ts's CmdRunArgs — never parsed
   * from argv directly; cli.ts builds these the same way it does for
   * `run`/`ab` and sets them on CmdScreenArgs before calling cmdScreen. */
  canLaunch?: () => boolean
  pressureGate?: () => boolean
  /** Where each candidate's `<vN>.json` results file (and the swept
   * `ranking.json` + `screen-meta.json`) lands. Default:
   * `<termBenchDir>/results/screens/<layer>` (or `<layer>-<agent>` for role
   * layers) — LAYER-SCOPED because vN names are only unique per layer store:
   * an unscoped shared dir would let layer B's screen silently skip-resume
   * off layer A's complete `v1.json` (review CRITICAL). Overridable for
   * tests / operators; the screen-meta.json stamp below still guards a
   * hand-shared dir. */
  outDir?: string
}

/** The `<outDir>/screen-meta.json` provenance stamp — which (layer, agent)
 * identity the per-candidate results files in this directory belong to.
 * Written at sweep start; checked before any skip-if-complete reuse, so
 * even an explicitly shared outDir across layers can never silently rank
 * another layer's data (defense-in-depth behind the layer-scoped default
 * path above). `agent` is "" for global layers. */
interface ScreenMeta {
  layer: string
  agent: string
}

/** Read a candidate's results file iff it is BOTH parseable AND stamped
 * `status: "complete"` (results.ts's writeRunResults — the only field that
 * distinguishes a finished sweep from a crashed/partial `in_progress` one).
 * Returns null for anything else (missing file, corrupt JSON, incomplete
 * status) — the caller treats null as "needs a fresh cmdRun call". */
function readCompleteResults(file: string): ScreenResultsLike | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as ScreenResultsLike
    if (parsed.status === "complete") return parsed
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Interruption/resume granularity note (reviewer sign-off): skip-if-complete
 * is WHOLE-CANDIDATE granularity by design (per the task brief) — a screen
 * interrupted mid-candidate leaves that candidate's results file stamped
 * `in_progress` (or absent), so the next invocation re-runs that ENTIRE
 * candidate from scratch. Intentional: a k=1 sweep per candidate is the
 * cheap unit here, and per-task resume-within-a-candidate would need
 * --resume threading through cmdRun for marginal savings.
 */
export async function cmdScreen(
  paths: BenchPaths,
  args: CmdScreenArgs,
  runFn: (paths: BenchPaths, args: CmdRunArgs) => Promise<void> = cmdRun,
): Promise<void> {
  const layer = args.layer
  if (!layer || !(LAYER_CHOICES as string[]).includes(layer)) {
    die(`screen: --layer must be one of ${LAYER_CHOICES.join(", ")}`)
  }
  if ((layer === "account-role" || layer === "project-role") && !args.agent) {
    die(`screen: --layer ${layer} requires --agent`)
  }
  const candidates = args.candidates ?? []
  if (candidates.length === 0) die("screen: --candidates requires at least one vN")
  for (const c of candidates) {
    if (!/^v\d+$/.test(c)) die(`screen: --candidates must look like vN, got '${c}'`)
  }

  // Same 3600s floor as the follow-up ab's own --min-agent-timeout default
  // usage, so screen ordering isn't budget-confounded (task-7-brief.md).
  const minAgentTimeout = args.minAgentTimeout ?? 3600
  const agent = args.agent ?? ""
  // LAYER-SCOPED default (review CRITICAL): vN names are only unique per
  // layer store, so an unscoped shared dir would let a later layer's screen
  // silently skip-resume off an earlier layer's complete <vN>.json.
  const outDir = args.outDir ?? join(paths.termBenchDir, "results", "screens", agent ? `${layer}-${agent}` : layer)

  // screen-meta.json provenance guard (defense-in-depth behind the scoped
  // default path — covers an explicitly shared --out-dir too): reuse of a
  // pre-existing complete results file is allowed ONLY when the directory's
  // stamp matches this sweep's (layer, agent) identity. A mismatched or
  // absent stamp disables reuse for the whole sweep (cmdRun simply
  // overwrites the stale files) — never silently ranks another layer's data.
  const metaFile = join(outDir, "screen-meta.json")
  let reuseAllowed = false
  if (existsSync(metaFile)) {
    try {
      const prev = JSON.parse(readFileSync(metaFile, "utf-8")) as Partial<ScreenMeta>
      if (prev.layer === layer && (prev.agent ?? "") === agent) {
        reuseAllowed = true
      } else {
        log(
          `screen: ${metaFile} says layer=${prev.layer}${prev.agent ? ` agent=${prev.agent}` : ""} but this sweep is ` +
            `layer=${layer}${agent ? ` agent=${agent}` : ""} — existing results files belong to a DIFFERENT identity, ` +
            `re-running every candidate (no reuse)`,
        )
      }
    } catch {
      log(`screen: ${metaFile} unreadable — re-running every candidate (no reuse)`)
    }
  }
  writeJsonAtomic(metaFile, { layer, agent } satisfies ScreenMeta)

  log(
    `screen: ${layer} — ${candidates.length} candidate(s): ${candidates.join(", ")}  min-agent-timeout=${minAgentTimeout}s`,
  )

  const entries: ScreenEntry[] = []
  for (const candidate of candidates) {
    const resultsFile = join(outDir, `${candidate}.json`)
    const existing = reuseAllowed ? readCompleteResults(resultsFile) : undefined
    if (existing) {
      log(`screen: ${candidate} — already complete at ${resultsFile}, skipping (free resume)`)
      entries.push({ candidate, results: existing })
      continue
    }
    try {
      await runFn(paths, {
        tasks: args.tasks,
        taskFile: args.taskFile,
        all: args.all,
        model: args.model,
        variant: args.variant,
        agent: args.agent,
        layers: args.layers,
        pin: [`${layer}=${candidate}`],
        k: 1,
        resultsFile,
        minAgentTimeout,
        maxAgentTimeout: args.maxAgentTimeout,
        maxVerifierTimeout: args.maxVerifierTimeout,
        staging: args.staging,
        driver: args.driver,
        parallel: args.parallel,
        enforceResources: args.enforceResources,
        minCpus: args.minCpus,
        minMemMb: args.minMemMb,
        cpuBudget: args.cpuBudget,
        memBudget: args.memBudget,
        noPackMeasured: args.noPackMeasured,
        hostPressure: args.hostPressure,
        canLaunch: args.canLaunch,
        pressureGate: args.pressureGate,
      })
      const results = readCompleteResults(resultsFile)
      if (results) {
        entries.push({ candidate, results })
      } else {
        entries.push({ candidate, error: `${resultsFile} missing or not status:"complete" after cmdRun returned` })
      }
    } catch (e) {
      // Error isolation (architect MAJOR): a BenchError from one candidate's
      // cmdRun call (podman failure, bad pin, ...) must not abort the whole
      // sweep — record it and keep screening the rest. Any OTHER error class
      // (a real bug) still propagates.
      if (!(e instanceof BenchError)) throw e
      log(`screen: ${candidate} failed: ${e.message}`)
      entries.push({ candidate, error: e.message })
    }
  }

  const ranked = rankScreens(entries)
  writeJsonAtomic(join(outDir, "ranking.json"), {
    layer,
    candidates,
    minAgentTimeout,
    timestamp: new Date().toISOString(),
    ranking: ranked,
  })

  console.log("\n" + "=".repeat(60))
  console.log(`${"candidate".padEnd(12)} ${"nPass".padStart(7)} ${"nTotal".padStart(7)} ${"passElapsed".padStart(12)}`)
  console.log("-".repeat(60))
  for (const r of ranked) {
    if (r.error) {
      console.log(`${r.candidate.padEnd(12)} ${"—".padStart(7)} ${"—".padStart(7)} ${("error: " + r.error).slice(0, 30)}`)
      continue
    }
    console.log(
      `${r.candidate.padEnd(12)} ${String(r.nPass).padStart(7)} ${String(r.nTotal).padStart(7)} ${pyFixed(r.passElapsed, 1).padStart(12)}`,
    )
  }
  console.log("=".repeat(60))

  const top = ranked.find((r) => !r.error)
  if (!top) {
    log("screen: no candidate produced a usable result — nothing to advance")
    return
  }
  // Screen NEVER writes the store and NEVER emits a verdict — acceptance
  // authority stays with the k=5 ab. This is guidance only.
  console.log(
    `\nADVANCE: ${top.candidate} → bench ab ${layer} ${top.candidate} --split-file ${paths.splitsFile} ` +
      `--k 5 --min-agent-timeout ${minAgentTimeout}`,
  )
}
