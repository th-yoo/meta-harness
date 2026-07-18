/**
 * cmd-ab.ts — `ab` subcommand: statistically-gated A/B of a candidate vs the
 * active version of ONE layer. Verbatim-in-spirit port of term-bench2/
 * runner.py's cmd_ab (:2030-2285).
 *
 * Arm A = all-active composition, arm B = same but the target layer pinned
 * to the candidate; interleaved per run-pair to neutralise drift. By default
 * the task set is the checked-in held-in/held-out split (splits.json):
 * held-in is scored first with a futility early-kill; the held-out fold
 * runs only if the candidate survives, and its arm-B sessions are NEVER
 * written to score.json (the proposer must never see them — see this file's
 * `record_arm_b` wiring and test/bench-ab.test.ts's held-out-never-recorded
 * invariant test). The decision comes from ab-stats.ts's `decide` via
 * splits.ts's `abDecision`, which wires in the stratified held-out gate.
 * Writes candidates/<vN>/ab-verdict.json — the contract harness-store.ts's
 * readAbVerdict/abAccepted read.
 *
 * Task-attempt machinery (container create/start/staging/agent/verify/rm) is
 * NOT duplicated here — both arms of every run-pair go through cmd-run.ts's
 * `runTaskOnce` (injectable as `runOneTask`, matching cmd-run.ts's own
 * RunOneTaskFn contract), per the task brief's reuse mandate.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { StagingMode } from "./cmd-oracle.ts"
import { podman } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { runTaskOnce, inContainerAgentVersion, runWithOomRetry, type RunOneTaskFn } from "./cmd-run.ts"
import { getDriver } from "./drivers/index.ts"
import { assembleAgentsMd, envBlock, sessionRecord } from "./record.ts"
import { layerStoreRoots, type LayerName } from "./record.ts"
import { updateResourceProfile, readResourceProfile, raiseCapMeasured, PACK_MIN_SAMPLES } from "./resource-profile.ts"
import { selectTasks, taskTimeouts, enforcedResources, packingFootprints } from "./tasks.ts"
import { schedule, DEFAULT_BUDGET, AsyncMutex, type Budget, type ScheduledItem } from "./scheduler.ts"
import { PRESSURE_POLL_SEC } from "./host-pressure.ts"
import {
  loadActiveSplit,
  splitHash,
  resumeIdentCheck,
  filterTaskResults,
  abDecision,
  type SplitMeta,
  type PhaseTaggedTaskResults,
} from "./splits.ts"
import {
  pairedRunStats,
  mcnemarExactOneSided,
  bootstrapTaskCi,
  futilityStop,
  pairedSpeedStats,
  DEFAULT_SPEED_TIEBREAK_CONFIG,
  type DecisionConfig,
  type PairStats,
  type SpeedStats,
} from "./ab-stats.ts"
import { die, log, pyFixed, pySigned, writeJsonAtomic } from "./util.ts"
import { DEFAULT_BENCH_MODEL, useKeyOnlyForParallel, type BenchPaths } from "./paths.ts"
import {
  candidateExists,
  listVersions,
  activeVersion,
  candidatePath,
  recordSession,
  writeTrajectory,
  pruneTrajectories,
  appendMetaMetric,
  readMhConfig,
  type AbSetStats,
  type AbSpeedStats,
} from "../harness-store.ts"

interface AbTaskResult {
  candidate: number[]
  active: number[]
  phase: "held-in" | "held-out"
  sentinel: boolean
  error?: string
  /** W1a (time-to-resolve): per-run agent-phase elapsed seconds, index-
   * aligned with candidate/active (parallel arrays, pushed alongside the
   * reward arrays in runTaskPairs). Absent = unknown — a pre-W1a --resume
   * partial's entries simply lack these keys and drop out of
   * pairedSpeedStats, never crashing or backfilling. */
  candidateElapsed?: number[]
  activeElapsed?: number[]
  /** --parallel canonical-order early-stop tag (spec D5): set on tasks that
   * completed AFTER the futility stop rule fired in canonical order — i.e.
   * tasks the equivalent SERIAL run would never have launched. Excluded from
   * every derived verdict field (nTasks/candidateRate/activeRate + the
   * paired-stats pipeline) so the parallel verdict is byte-identical to the
   * serial one; the FULL map (including these) still serializes under
   * `taskResults`. NEVER set on a serial run. */
  postStop?: true
}
type AbTaskResults = Record<string, AbTaskResult>

export interface CmdAbArgs {
  layer: LayerName
  candidate: string
  tasks?: string[]
  taskFile?: string
  all?: boolean
  splitFile?: string
  model?: string
  variant?: string
  k?: number
  layers?: "global" | "account" | "project"
  agent?: string
  alpha?: number
  nonregressMargin?: number
  minTasksBeforeStop?: number
  noEarlyStop?: boolean
  maxAgentTimeout?: number
  maxVerifierTimeout?: number
  resume?: boolean
  noStore?: boolean
  saveAllTraj?: boolean
  resultsFile?: string
  staging?: StagingMode
  driver?: string
  /** podman create gets --cpus/--memory from each task's declared task.toml
   * [environment] (tasks.ts's enforcedResources). Default OFF — unconstrained,
   * byte-identical to before this flag existed. Plumbing-only in this task
   * (wiring the field so cli.ts can parse it / later tasks can consume it) —
   * NOT yet threaded into this file's runOneTask calls; see the resource-
   * scheduler plan's Task 7. */
  enforceResources?: boolean
  /** Budget-packed concurrent task execution (spec D3/D4/D5, scheduler.ts).
   * Default OFF → the existing serial phase loops, verdict byte-identical.
   * Requires --enforce-resources (each task's declared footprint is what the
   * budget packs against + the container caps) and a provider API key in the
   * env (the CLI gate — the shared-oauth credential mount races under
   * concurrency). A fresh scheduler runs each phase to full drain; completed
   * pairs are consumed in canonical (task-list) order so the early-stop
   * verdict matches serial exactly (see runPhase's parallel branch). */
  parallel?: boolean
  /** Concurrency budget overrides (only meaningful with --parallel); default
   * DEFAULT_BUDGET (scheduler.ts). */
  cpuBudget?: number
  memBudget?: number
  /** Per-task resource FLOOR (--min-cpus/--min-mem-mb): a generous minimum
   * cgroup cap under --enforce-resources, raising (never lowering) each
   * task's declared task.toml [environment] footprint via tasks.ts's
   * enforcedResources — see cmd-run.ts's CmdRunArgs field doc for the full
   * rationale (identical here). Only meaningful with --enforce-resources.
   * Default undefined → floors undefined → the declared footprint
   * unchanged, byte-identical to before these flags existed. */
  minCpus?: number
  minMemMb?: number
  /** loosest-envelope floor — raises per-task agent time above the TB2-declared
   * budget; the load-aware scheduler compensates. The time-domain mirror of
   * --min-cpus/--min-mem-mb (tasks.ts's taskTimeouts): effective agent timeout
   * = min(max(TB2-declared, floor), --max-agent-timeout). Part of the verdict's
   * budget-identity (env stamp + top-level), so a candidate scored under a
   * different floor than the active baseline is refused at /mh-activate.
   * Default undefined → no floor, byte-identical to before this flag existed. */
  minAgentTimeout?: number
  /** Disable measured-informed resources: pack on declared/floored footprints
   * and skip the measured cap raise (default: measured used when a
   * trustworthy profile exists). */
  noPackMeasured?: boolean
  /** Internal-only wiring — NOT a CLI flag, never parsed from argv (see
   * cli.ts's parseAbArgs, which has no `--` case setting it). The
   * oauth-parallel freshness gate's scheduler launch-guard (Task 2 of the
   * oauth-parallel design, cli.ts's `buildOauthParallelCanLaunch`), threaded
   * straight through into scheduler.ts's `schedule()` `canLaunch` param
   * below — reused for BOTH phases (held-in and held-out), since it's
   * computed once at run start in cli.ts's main() and captures the token's
   * expiry, not per-phase state. cli.ts's main() sets this AFTER
   * validateParallel (Task 1's pre-flight check) has already allowed the
   * run. Every other caller (direct unit tests, or any caller that never
   * sets it) leaves it undefined — unbounded scheduling, byte-identical to
   * before this gate existed. */
  canLaunch?: () => boolean
  /** `--host-pressure observe|on` (plan S3): the load-aware launch gate — see
   * cmd-run.ts's CmdRunArgs field doc for the full rationale (identical here).
   * `on` pauses NEW task launches while the host is under pressure; `observe`
   * samples + logs for calibration but never pauses. Default (undefined) =
   * off, byte-identical. Only the parallel path's schedule() consults it. */
  hostPressure?: "observe" | "on"
  /** Internal-only wiring — NOT a CLI flag (see cli.ts's parseAbArgs). The
   * host-pressure launch gate cli.ts's main() builds (`buildPressureGate`)
   * from `hostPressure` above, threaded straight into scheduler.ts's
   * `schedule()` `pauseGate` param below — reused for BOTH phases (held-in and
   * held-out) via the ONE shared per-command sensor closure, so pressure
   * hysteresis state carries across phases (correct: pressure is a property of
   * the machine over wall-clock time). Undefined by default — no pause gate,
   * byte-identical. Mirrors `canLaunch`'s internal-wiring stance. */
  pressureGate?: () => boolean
  /** `--speed-tiebreak` (task-3-brief.md, Phase 3 W1c): opt-in guarded
   * tiebreaker — an `inconclusive` reward verdict may be upgraded to
   * `accept` when the candidate is significantly faster on held-in both-pass
   * pairs, behind splits.ts's abDecision structural guards (ho !== null,
   * held-in delta >= 0, !earlyStopped, speed thresholds). Default OFF ->
   * cfg.speedTiebreak stays undefined -> abDecision's tiebreak block never
   * runs, byte-identical decisions to before this flag existed. When on,
   * stamped `speedTiebreak: true` top-level in the verdict for provenance
   * (a gate-policy change, NOT part of budget-identity or resume-ident). */
  speedTiebreak?: boolean
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

export async function cmdAb(
  paths: BenchPaths,
  args: CmdAbArgs,
  runOneTask: RunOneTaskFn = runTaskOnce,
  execFn: ExecFn = podman,
): Promise<void> {
  const layer = args.layer
  const candidate = args.candidate
  const agent = args.agent || ""
  const layers = args.layers ?? "global"
  const model = args.model || DEFAULT_BENCH_MODEL
  const variant = args.variant || ""
  const k = args.k ?? 2
  const noStore = Boolean(args.noStore)
  const staging = args.staging ?? "runtime"
  const maxAgentTimeout = args.maxAgentTimeout ?? 0
  const maxVerifierTimeout = args.maxVerifierTimeout ?? 0
  // Loosest-envelope floor (--min-agent-timeout): undefined when unset → no
  // floor (taskTimeouts leaves the declared timeout alone), byte-identical.
  const minAgentTimeout = args.minAgentTimeout
  const driver = getDriver(args.driver ?? "opencode")

  if (!/^v\d+$/.test(candidate)) die(`--candidate must look like vN, got '${candidate}'`)
  if ((layer === "account-role" || layer === "project-role") && !agent) {
    die(`--layer ${layer} requires --agent`)
  }

  const roots = new Map(layerStoreRoots(layers, agent, paths.metaRoot))
  if (!roots.has(layer)) {
    die(`--layer ${layer} not included by --layers ${layers}` + (agent ? "" : " (role layers need --agent)"))
  }
  const layerRoot = roots.get(layer)!

  if (!candidateExists(layerRoot, candidate)) {
    const have = listVersions(layerRoot).join(", ") || "none"
    die(`no such candidate ${candidate} under ${layerRoot} (have: ${have})`)
  }

  const baseline = activeVersion(layerRoot)
  if (baseline === candidate) die(`candidate ${candidate} is already the active version — nothing to compare`)

  // ── Task selection: split (default) vs legacy explicit ──────────────────
  const explicit = Boolean((args.tasks && args.tasks.length > 0) || args.taskFile || args.all)
  let heldInTasks: string[]
  let heldOutTasks: string[]
  let splitMeta: SplitMeta | null
  let activeFold: number

  if (explicit) {
    heldInTasks = args.all
      ? selectTasks(paths, { all: true })
      : args.taskFile
        ? selectTasks(paths, { taskFile: args.taskFile })
        : selectTasks(paths, { tasks: args.tasks })
    heldOutTasks = []
    splitMeta = null
    activeFold = -1
    log(
      "ab: LEGACY mode (explicit tasks) — no held-out split; a verdict can be reject/inconclusive only, never accept",
    )
  } else {
    const splitsPath = args.splitFile ?? paths.splitsFile
    if (!existsSync(splitsPath)) {
      die(`no split at ${splitsPath} — run 'runner.ts split make', or pass --tasks/--task-file/--all for legacy mode`)
    }
    const loaded = loadActiveSplit(splitsPath)
    heldInTasks = loaded.heldIn
    heldOutTasks = loaded.heldOut
    splitMeta = loaded.meta
    activeFold = loaded.meta.activeFold
    for (const t of [...heldInTasks, ...heldOutTasks]) {
      if (!existsSync(join(paths.tbRoot, t, "task.toml"))) {
        die(`split task '${t}' not found under tbRoot (${paths.tbRoot})`)
      }
    }
  }

  // Sentinels ride held_out but must never dilute the fold-only regression
  // gate — stratify held-out into fold vs sentinel now.
  const sentinelSet = new Set(splitMeta ? splitMeta.sentinels : [])
  const foldOutTasks = heldOutTasks.filter((t) => !sentinelSet.has(t))
  const sentinelOutTasks = heldOutTasks.filter((t) => sentinelSet.has(t))

  // Compose both arms once (they differ in exactly one layer by construction).
  const harnessA = assembleAgentsMd(layers, paths.metaRoot, agent, {}, model)
  const harnessB = assembleAgentsMd(layers, paths.metaRoot, agent, { [layer]: candidate }, model)
  const agentVersion = await inContainerAgentVersion(paths, driver, execFn)
  // Same non-default-driver-unknown-probe gate as cmd-run.ts's cmdRun
  // (final-review fix 3) — a claude-code (etc) probe coming back "unknown"
  // means the bench image is missing that driver's binary; die before
  // burning an A/B run's worth of container lifecycles on guaranteed-0
  // scores. opencode (the default) keeps its pre-existing lenient behavior.
  if (agentVersion === "unknown" && driver.id !== "opencode") {
    die(`bench image missing ${driver.id} — rebuild with prep --apply`)
  }
  const envB = await envBlock(
    harnessB,
    maxAgentTimeout,
    model,
    paths.metaRoot,
    undefined,
    agentVersion,
    driver.id,
    args.enforceResources ?? false,
    minAgentTimeout,
  )
  // Loop-3 T3: whether a wall-clock agent-phase timeout on arm B gets
  // recorded as a genuine stored fail (default OFF). Read once for the
  // whole ab run — see recordToStores's guard doc in record.ts.
  const { recordTimeouts } = readMhConfig()

  const cfg: DecisionConfig = {
    alpha: args.alpha ?? 0.05,
    nonregressMargin: args.nonregressMargin ?? 0.05,
    hoGuardAlpha: 0.05,
    // --speed-tiebreak (task-3-brief.md, Phase 3 W1c): undefined unless the
    // flag is set -> abDecision's speed-tiebreak block never runs, byte-
    // identical to before this flag existed.
    speedTiebreak: args.speedTiebreak ? DEFAULT_SPEED_TIEBREAK_CONFIG : undefined,
  }
  const earlyStop = !args.noEarlyStop
  const minTasks = args.minTasksBeforeStop ?? 12

  // ── --enforce-resources / --parallel wiring (spec D3/D4/D5) ─────────────
  const enforceRes = Boolean(args.enforceResources)
  const parallel = Boolean(args.parallel)
  const budget: Budget = {
    cpus: args.cpuBudget ?? DEFAULT_BUDGET.cpus,
    memoryMb: args.memBudget ?? DEFAULT_BUDGET.memoryMb,
  }
  // --parallel auth mount: keyOnly (no shared rw credential mount) ONLY when an
  // API key is present. With no key, the oauth path (enabled by the freshness
  // gate — validateParallel pre-flight + scheduler canLaunch launch-guard) uses
  // the DEFAULT oauth prepareAuth (the shared rw mount serial uses) — SAFE: the
  // gate guarantees no task runs across the token refresh, so auth.json is
  // read-only during the parallel window (no refresh-token race). Serial →
  // undefined → default oauth. (Residual: a COLD opencode plugin-cache could see
  // concurrent writes on a first-ever parallel fetch — benign/re-fetchable, and
  // none on a warm cache; not isolated here.)
  const parallelPrepareAuth = useKeyOnlyForParallel(parallel, model)
    ? () => driver.prepareAuth({ keyOnly: true })
    : undefined

  const verdictPath = candidatePath(layerRoot, candidate, "ab-verdict.json")
  const partialPath = candidatePath(layerRoot, candidate, "ab-verdict.partial.json")

  const runIdent: Record<string, unknown> = {
    layer,
    candidate,
    baseline,
    model,
    k,
    activeFold,
    splitHash: splitHash(heldInTasks, heldOutTasks),
    driver: driver.id,
  }

  log(
    `A/B: ${layer} ${candidate} vs active ${baseline}  held-in=${heldInTasks.length} held-out=${heldOutTasks.length}  k=${k}  fold=${activeFold}`,
  )
  if (agent) log(`Agent role layers: ${agent}`)

  const taskResults: AbTaskResults = {}
  let earlyStopped = false

  // Resume-mode-switch caveat: a partial that crashed mid-run WITHOUT ever
  // latching earlyStopped (a genuine parallel in-flight crash, not a
  // completed-and-persisted stop) can be resumed under either mode. If it's
  // resumed SERIALLY, runPhase's serial branch evaluates futilityFires over
  // whatever prefix of `taskResults` happens to already be populated here —
  // which, for a crashed PARALLEL partial, is a canonical-order CONSUMED
  // prefix (see runPhase's parallel branch / task-6's D5 equivalence work),
  // not necessarily a contiguous "first N tasks" prefix the serial futility
  // check was designed around. A resumed PARALLEL run instead only ever
  // consumes in canonical order from the start, so it doesn't hit this case.
  // Net effect: the exact task index at which futility (re-)fires can differ
  // between "resume serially" and "resume in parallel" for the same crashed
  // partial. Only reachable via crash + a resume that switches parallel mode
  // (parallel → serial) between the original run and the resume — not a
  // concern for same-mode resumes, which is the common case.
  if (args.resume && existsSync(partialPath)) {
    let prev: Record<string, unknown> = {}
    try {
      prev = JSON.parse(readFileSync(partialPath, "utf-8")) as Record<string, unknown>
    } catch {
      prev = {}
    }
    resumeIdentCheck(prev, runIdent)
    // Separate, coalescing comparison — deliberately NOT folded into
    // runIdent (task-3-brief.md, D2 / ac0cd18 invariant): resumeIdentCheck
    // does a strict per-key compare over every runIdent field, so adding a
    // key there would kill --resume of every pre-feature partial the
    // instant the flag existed, even with it off everywhere. This guard
    // reads the informational `env.resourceEnforcement` stamp instead, with
    // both sides `?? false`-coalesced so an absent key (pre-feature
    // partial) means the same thing as an explicit `false`.
    const prevEnv = prev["env"] as { resourceEnforcement?: boolean; minAgentTimeout?: number } | undefined
    const prevResourceEnforcement = prevEnv?.resourceEnforcement ?? false
    const expectedResourceEnforcement = args.enforceResources ?? false
    if (prevResourceEnforcement !== expectedResourceEnforcement) {
      die(
        `--resume: ${partialPath} was produced with resourceEnforcement=${prevResourceEnforcement}, this run uses ` +
          `${expectedResourceEnforcement} — refusing to mix measurement regimes in one results file.`,
      )
    }
    // Same distinct-machinery-beside-runIdent guard for the loosest-envelope
    // floor (--min-agent-timeout): it's an informational env.minAgentTimeout
    // stamp, NOT a runIdent key (folding it in would kill --resume of every
    // pre-feature partial the instant the flag existed — the ac0cd18 class).
    // Both sides `?? 0`-coalesced so an absent key (pre-feature partial) means
    // the same as an explicit 0 / no floor; a real floor mismatch REJECTS
    // resume, since the effective per-task envelope differs.
    const prevMinAgentTimeout = prevEnv?.minAgentTimeout ?? 0
    const expectedMinAgentTimeout = args.minAgentTimeout ?? 0
    if (prevMinAgentTimeout !== expectedMinAgentTimeout) {
      die(
        `--resume: ${partialPath} was produced with minAgentTimeout=${prevMinAgentTimeout}s, this run uses ` +
          `${expectedMinAgentTimeout}s — refusing to mix measurement regimes in one results file.`,
      )
    }
    earlyStopped = Boolean(prev["earlyStopped"])
    const prevResults = (prev["taskResults"] as AbTaskResults) || {}
    for (const [t, tr] of Object.entries(prevResults)) {
      if (tr.error === "setup_failed") {
        taskResults[t] = tr
      } else if ((tr.candidate?.length ?? 0) >= k && (tr.active?.length ?? 0) >= k) {
        taskResults[t] = tr
      }
    }
    if (Object.keys(taskResults).length > 0) {
      log(`Resuming ab: ${Object.keys(taskResults).length} task(s) already complete${earlyStopped ? " (early-stopped)" : ""}`)
    }
  }

  const runStartTs = new Date().toISOString()

  function statsBlock(ps: PairStats): AbSetStats {
    return {
      nTasks: ps.nTasks,
      nPairs: ps.nPairs,
      b: ps.b,
      c: ps.c,
      delta: round4(ps.delta),
      mcnemarP: round4(mcnemarExactOneSided(ps.b, ps.c)),
      bootCI90: bootstrapTaskCi(Object.values(ps.taskDeltas)),
    }
  }

  // W1a (time-to-resolve, report-only): mirrors statsBlock above but for
  // pairedSpeedStats' SpeedStats shape.
  function speedStatsBlock(ss: SpeedStats): AbSpeedStats {
    return {
      nTasks: ss.nTasks,
      nPairs: ss.nPairs,
      medianCandidate: round4(ss.medianCandidate),
      medianActive: round4(ss.medianActive),
      medianRatio: round4(ss.medianRatio),
      fasterB: ss.fasterB,
      slowerC: ss.slowerC,
      signTestP: round4(ss.signTestP),
    }
  }

  function verdictDict(status: string): Record<string, unknown> {
    // ONE shared postStop-aware view (spec D5): every derived field — the
    // paired-stats pipeline AND nTasks/candidateRate/activeRate below — draws
    // from the same error-and-postStop-excluded entries, so a parallel
    // early-stop verdict is byte-identical to the serial one. postStop is
    // never set on a serial run, so `counted` there is exactly the old
    // non-error set. The FULL taskResults map (postStop entries included) is
    // still serialized verbatim under `taskResults` further down.
    const includedEntries = Object.entries(taskResults).filter(([, tr]) => !tr.error && !tr.postStop)
    const counted: AbTaskResults = Object.fromEntries(includedEntries)
    const [decision, reasons, hi, ho, hoSentinel] = abDecision(
      counted as PhaseTaggedTaskResults,
      cfg,
      earlyStopped,
      foldOutTasks,
      sentinelOutTasks,
    )
    const winner = decision === "accept" ? "candidate" : decision === "reject" ? "active" : "tie"
    // W1a (time-to-resolve, report-only): drawn from the SAME postStop/error-
    // excluded `counted` view as hi/ho above, so a parallel early-stop
    // verdict's speed block is byte-identical to the serial one too. held-out
    // is fold-only (sentinel=false), matching `ho`'s own filter.
    const speedHi = pairedSpeedStats(filterTaskResults(counted as PhaseTaggedTaskResults, "held-in"))
    const speedHo =
      foldOutTasks.length > 0
        ? pairedSpeedStats(filterTaskResults(counted as PhaseTaggedTaskResults, "held-out", false))
        : null
    const included = includedEntries
    const nAll = included.length
    const candPass = included.filter(([, tr]) => tr.candidate.length > 0 && Math.max(...tr.candidate) === 1).length
    const actPass = included.filter(([, tr]) => tr.active.length > 0 && Math.max(...tr.active) === 1).length
    const d: Record<string, unknown> = {
      schemaVersion: 2,
      layer,
      candidate,
      baseline,
      activeFold,
      splitHash: runIdent["splitHash"],
      driver: runIdent["driver"],
      // Budget-identity provenance (Loop-3 T6): the wall-clock budget and
      // timeout-recording policy this verdict was MEASURED under. Read back
      // by harness-store.ts's budgetIdentityMatches at /mh-activate time so
      // a candidate scored under a different budget than the layer's active
      // baseline is refused rather than silently activated (a candidate that
      // "wins" only because it got a longer timeout — or a different
      // recordTimeouts policy — isn't a fair A/B). resourceEnforcement is
      // deliberately NOT duplicated top-level here — it's already stamped in
      // `env.resourceEnforcement` below (envB), and budgetIdentityMatches
      // sources it from there.
      maxAgentTimeout,
      // Loosest-envelope floor (--min-agent-timeout): stamped alongside
      // maxAgentTimeout as part of the budget-identity tuple. undefined when no
      // floor → omitted from the written JSON (budgetIdentityMatches coalesces
      // an absent key to 0), so a flag-off verdict is byte-identical.
      minAgentTimeout,
      timeoutRecording: recordTimeouts,
      decision,
      winner,
      reasons,
      // Phase 3 W1c provenance: stamped ONLY when --speed-tiebreak was
      // passed (a gate-policy change, NOT part of budget-identity or
      // resume-ident — deliberately absent from `runIdent` above and from
      // harness-store.ts's budgetIdentityMatches tuple). undefined when off
      // -> omitted from the written JSON (JSON.stringify drops undefined
      // keys), so a flag-off verdict is byte-identical to before this flag
      // existed.
      speedTiebreak: args.speedTiebreak ? true : undefined,
      candidateRate: nAll ? round4(candPass / nAll) : 0.0,
      activeRate: nAll ? round4(actPass / nAll) : 0.0,
      nTasks: nAll,
      k,
      heldIn: statsBlock(hi),
      heldOut: ho ? statsBlock(ho) : null,
      sentinels: hoSentinel ? statsBlock(hoSentinel) : null,
      // W1a (time-to-resolve, report-only in this phase — a later phase wires
      // it as a decision tiebreaker on both-pass pairs only).
      speed: { heldIn: speedHi ? speedStatsBlock(speedHi) : null, heldOut: speedHo ? speedStatsBlock(speedHo) : null },
      earlyStopped,
      split: splitMeta,
      env: envB,
      taskResults,
      model,
      variant,
      timestamp: runStartTs,
    }
    if (status) d["status"] = status
    return d
  }

  // One task's full pipeline: k interleaved arm-A/arm-B pairs, arm B recorded
  // for held-in only. Shared by the serial and parallel phase drivers so they
  // can't drift (per the task brief's reuse mandate). `prefix` tags log lines
  // with the task id under interleaving; `withLock` guards the store-mutating
  // record block (parallel passes an AsyncMutex-backed lock, serial a
  // pass-through → byte-identical to the original inline loop). `resources` is
  // the container footprint (undefined = unenforced) — passed to runOneTask so
  // --enforce-resources actually caps the container, AND (in parallel) is the
  // same footprint the budget packed against. `parallelPrepareAuth` (closure)
  // is threaded straight through as runOneTask's keyOnly override.
  async function runTaskPairs(
    task: string,
    phase: "held-in" | "held-out",
    recordArmB: boolean,
    withLock: <T>(fn: () => T | Promise<T>) => Promise<T>,
    resources: { cpus: number; memoryMb: number } | undefined,
    prefix: string,
    // B5 per-session cap provenance: whether the INITIAL `resources` cap was
    // measured-raised above declared/floored (raiseCapMeasured). Only stamped
    // on the recorded arm-B session under --enforce-resources.
    capRaised: boolean,
  ): Promise<AbTaskResult> {
    log(`\n${prefix}=== ab ${task} [${phase}]: ${candidate} vs active ${baseline} ===`)
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, maxAgentTimeout, maxVerifierTimeout, minAgentTimeout)
    const tr: AbTaskResult = {
      candidate: [],
      active: [],
      candidateElapsed: [],
      activeElapsed: [],
      phase,
      sentinel: sentinelSet.has(task),
    }
    // OOM-escalation ceiling (same derivation as cmd-run): under --parallel each
    // task has a per-task cap packed against the mem budget; serial has none.
    const oomCeilingMb = parallel ? (args.memBudget ?? DEFAULT_BUDGET.memoryMb) : undefined

    for (let ki = 0; ki < k; ki++) {
      if (k > 1) log(`${prefix}  -- pair ${ki + 1}/${k} --`)
      log(`${prefix}  [arm A: active]`)
      // Each arm retries its OWN OOM-killed fail independently at 2× memory. The
      // shared per-task `resources` carries an escalated cap forward across BOTH
      // arms AND later repeats — an escalation in EITHER arm bumps both arms'
      // subsequent runs, keeping the container cap identical across arms.
      const armA = await runWithOomRetry(
        (r) => runOneTask(paths, task, model, variant, harnessA, agentTimeout, verifierTimeout, staging, driver, r, undefined, parallelPrepareAuth),
        resources, oomCeilingMb, `${prefix}arm A: `,
      )
      resources = armA.resources
      const resA = armA.result
      log(`${prefix}  [arm B: candidate]`)
      const armB = await runWithOomRetry(
        (r) => runOneTask(paths, task, model, variant, harnessB, agentTimeout, verifierTimeout, staging, driver, r, undefined, parallelPrepareAuth),
        resources, oomCeilingMb, `${prefix}arm B: `,
      )
      resources = armB.resources
      const resB = armB.result

      if (resA.error === "setup_failed" || resB.error === "setup_failed") {
        tr.error = "setup_failed"
        log(`${prefix}  setup_failed — task excluded from rates`)
        break
      }
      tr.active.push(resA.reward)
      tr.candidate.push(resB.reward)
      // W1a: agentElapsedSec-preferred (agent phase only — candidate-
      // independent infra noise from the full lifecycle `elapsed` would
      // dilute the speed signal); falls back to `elapsed` only when the
      // agent phase never returned one (e.g. an auth-fail fast-return).
      tr.activeElapsed!.push(resA.agentElapsedSec ?? resA.elapsed)
      tr.candidateElapsed!.push(resB.agentElapsedSec ?? resB.elapsed)

      // Memorize BOTH arms' measured cgroup footprints (resource-profile.ts).
      // A task's resource load is a task×host property, ~prompt-independent, so
      // the active AND candidate arms are both valid samples of the same task.
      // Gate on turns>0 + a cgroup reading (undefined skips setup-fail / auth-
      // transient 0-turn, which are mostly idle wait and would skew avgCpu low).
      // Own lock, SEQUENTIAL with the arm-B store record below — never nested,
      // since AsyncMutex is non-reentrant. Independent of recordArmB/noStore/
      // phase: a footprint is env telemetry, not prompt-candidate score data.
      // Skip any oomKilled sample — it's contaminated: a killed-and-replaced
      // attempt has skewed avgCpu + a cap-clipped peak (dominated by the clean
      // retry sample), and a kept pass whose container OOM'd-then-recovered
      // internally accumulates killed+recovery cpuSeconds with a still cap-clipped
      // peak. Neither is a faithful footprint sample.
      for (const r of [resA, resB]) {
        if (r.cpuSeconds !== undefined && r.turns > 0 && !r.oomKilled) {
          const cpuSeconds = r.cpuSeconds
          const peakRssMb = r.peakRssMb ?? 0
          const wall = r.elapsed
          await withLock(() => updateResourceProfile(paths.metaRoot, task, { cpuSeconds, peakRssMb, wall }))
        }
      }

      // Record ONLY arm B, and ONLY for held-in (held-out stays invisible
      // to the proposer — evaluator outside the loop). The turns>0 check is
      // the same discriminator as record.ts's recordToStores guard
      // (Loop-3 T3): with recordTimeouts off (default) a 0-turn arm B —
      // timeout or otherwise — is dropped, byte-identical to today; on, a
      // *timeout* 0-turn (resB.timedOut) still falls through and records.
      // The whole store mutation runs under `withLock` (a single leaf-level
      // critical section — AsyncMutex is non-reentrant, so nothing inside may
      // take the lock again).
      //
      // Post-stop stragglers still reach here: in --parallel, tasks that
      // complete AFTER the futility stop fires in canonical order are tagged
      // `postStop` and excluded from the verdict's counted set (see
      // verdictDict's includedEntries filter above) — but this record call
      // runs regardless of that tag, so their arm-B sessions still land in
      // the (now dead-branch, since the verdict already ignores them) score
      // store. Net effect: the on-disk store's session/pass count can exceed
      // the verdict's counted nTasks on an early-stopped parallel phase. Not
      // a correctness bug in the verdict itself (which never reads these
      // extra sessions back for THIS decision), but a latent inconsistency
      // for anything that trusts the store's raw counts in isolation.
      if (recordArmB && !noStore && (resB.turns > 0 || (recordTimeouts && resB.timedOut))) {
        await withLock(() => {
          const rec = sessionRecord(
            task,
            resB.sessionId,
            resB.reward === 1,
            resB.turns,
            resB.toolUsage,
            model,
            variant,
            envB as unknown as Record<string, unknown>,
            resB.elapsed,
            resB.timedOut,
            agentTimeout,
            resB.cpuSeconds,
            resB.peakRssMb,
            // Per-session cap provenance (B5): the FINAL applied cap (post
            // OOM-escalation carry-forward via `resources`) + whether the
            // initial cap was measured-raised. Only meaningful under
            // --enforce-resources — undefined otherwise (in --parallel a
            // footprint cap is applied even without it, but the provenance is
            // the enforce-mode envelope).
            enforceRes ? resources?.memoryMb : undefined,
            enforceRes ? capRaised : undefined,
          )
          const score = recordSession(layerRoot, candidate, rec)
          if (resB.events.length > 0 && (resB.reward !== 1 || args.saveAllTraj)) {
            writeTrajectory(layerRoot, candidate, resB.sessionId, resB.events)
            pruneTrajectories(layerRoot, candidate)
          }
          log(`${prefix}  store ${layer} ${candidate}: nPass=${score.nPass} nFail=${score.nFail}`)
        })
      }
    }
    return tr
  }

  // Held-in futility stop rule over an ordered subset of completed tasks —
  // the same check the serial loop runs, factored out so the parallel
  // canonical-order consumer can evaluate it against the CONSUMED prefix
  // (never the out-of-order full map). Returns true iff it just fired.
  function futilityFires(consumed: AbTaskResults): boolean {
    const hi = pairedRunStats(filterTaskResults(consumed as PhaseTaggedTaskResults, "held-in"))
    if (futilityStop(hi.b, hi.c, hi.nTasks, minTasks)) {
      log(`  FUTILITY: candidate behind (b=${hi.b} c=${hi.c}) after ${hi.nTasks} held-in tasks — early stop`)
      return true
    }
    return false
  }

  async function runPhase(phase: "held-in" | "held-out", taskList: string[], recordArmB: boolean): Promise<void> {
    if (!parallel) {
      // ── Serial: pass-through lock + empty prefix → byte-identical to the
      // original inline loop (postStop never set). ────────────────────────
      const noopLock = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn)
      for (const task of taskList) {
        if (earlyStopped) break
        if (taskResults[task]) {
          log(`\n=== ab ${task} [${phase}] (skipped — already done) ===`)
          continue
        }
        // B5: the SERIAL path applies the same raise-only measured memory lift
        // (raiseCapMeasured) the parallel path gets in packingFootprints —
        // without it a task whose true demand exceeds its declared cap OOM-kills
        // every serial run. --no-pack-measured disables the raise (escape hatch).
        let resources: { cpus: number; memoryMb: number } | undefined
        let capRaised = false
        if (enforceRes) {
          const declared = enforcedResources(paths, task, { minCpus: args.minCpus, minMemoryMb: args.minMemMb })
          if (args.noPackMeasured) {
            resources = declared
          } else {
            resources = raiseCapMeasured(declared, readResourceProfile(paths.metaRoot, task))
            capRaised = resources.memoryMb > declared.memoryMb
          }
        }
        const tr = await runTaskPairs(task, phase, recordArmB, noopLock, resources, "", capRaised)
        taskResults[task] = tr
        writeJsonAtomic(partialPath, verdictDict("in_progress"))
        if (phase === "held-in" && earlyStop) {
          if (futilityFires(taskResults)) earlyStopped = true
        }
      }
      return
    }

    // Resumed-earlyStopped entry guard, mirroring serial's `if (earlyStopped)
    // break`: a partial can carry earlyStopped: true (parallel persists it,
    // unlike serial mid-run) while still holding pending held-in tasks that
    // were never launched (e.g. the process crashed after the stop latched
    // but before full drain). Without this guard, consume() skips the
    // futility re-check for preExisting (resumed) entries, so the first
    // newly-consumed pending task gets counted before stopFired re-latches —
    // over-counting vs serial-resume, which skips the phase entirely (spec
    // D5). The phase must do nothing: no footprint computation, no
    // scheduling, no launches.
    if (earlyStopped) return

    // ── Parallel: a FRESH budget-packed scheduler per phase, run to full
    // drain (spec D3/D5). Completed pairs land in taskResults under the
    // mutex; a consumer advances in strict task-list order, evaluating the
    // futility rule per newly-consumed held-in task exactly as the serial
    // loop would — so the counted set (and every derived verdict field) is
    // byte-identical to serial regardless of completion order. Tasks
    // consumed AFTER the stop fires are tagged postStop (the serial run
    // would never have launched them) and excluded from the verdict. ──────
    const mutex = new AsyncMutex()
    const preExisting = new Set(Object.keys(taskResults))
    for (const t of taskList) {
      if (taskResults[t]) log(`\n=== ab ${t} [${phase}] (skipped — already done) ===`)
    }
    const pending = taskList.filter((t) => !taskResults[t])
    // Footprints computed ONCE per phase (before any container lifecycle): a
    // gpu-declaring task throws here (via enforcedResources, packingFootprints'
    // first step) and dies the run, matching --enforce-resources' own guard.
    // Split cap vs pack (task-6): `pack` = the measured-or-prior packing weight
    // the scheduler budgets against; `cap` = the declared/floored container
    // cgroup envelope (+ raise-only measured memory lift) — deliberately
    // DIFFERENT objects (--no-pack-measured collapses both to declared/floored).
    // Held-in completions of THIS run land in the profile store (runTaskPairs'
    // updateResourceProfile) BEFORE the held-out phase builds its footprints, so
    // held-out packs against fresher measurements — intended.
    const floors = { minCpus: args.minCpus, minMemoryMb: args.minMemMb }
    const footprints = packingFootprints(paths, pending, floors, !args.noPackMeasured)
    // Whether packingFootprints' raiseCapMeasured lifted a task's cap above
    // declared/floored (per-session cap provenance, B5). Gated on a trustworthy
    // profile so declared is only re-derived (via enforcedResources) when a
    // raise could have fired — declared tasks never re-log.
    const capRaisedFor = (task: string, cap: { cpus: number; memoryMb: number }): boolean => {
      if (args.noPackMeasured) return false
      const profile = readResourceProfile(paths.metaRoot, task)
      if (profile === null || profile.n < PACK_MIN_SAMPLES) return false
      return cap.memoryMb > enforcedResources(paths, task, floors).memoryMb
    }

    let consumedIdx = 0
    let stopFired = false
    // Advance over the maximal contiguous completed prefix of taskList,
    // evaluating (and latching) the stop rule in canonical order. Must run
    // under the mutex — mutates consumedIdx/stopFired/earlyStopped and tags
    // postStop.
    const consume = (): void => {
      while (consumedIdx < taskList.length) {
        const t = taskList[consumedIdx]!
        const tr = taskResults[t]
        if (!tr) break
        consumedIdx++
        if (stopFired) {
          // A task consumed after the stop already fired: the serial run
          // would never have launched it. (preExisting = resumed tasks,
          // which the serial loop never re-checks or re-tags.)
          if (!preExisting.has(t)) tr.postStop = true
          continue
        }
        if (phase === "held-in" && earlyStop && !preExisting.has(t)) {
          const consumed: AbTaskResults = {}
          for (let idx = 0; idx < consumedIdx; idx++) {
            const tt = taskList[idx]!
            const r = taskResults[tt]
            if (r) consumed[tt] = r
          }
          if (futilityFires(consumed)) {
            stopFired = true
            earlyStopped = true
          }
        }
      }
    }

    // items pack against `pack`; each arm's container gets `cap`. Built
    // explicitly (not `...pack`) so PackWeight's `measured` flag never leaks
    // into a ScheduledItem.
    const items: ScheduledItem[] = pending.map((t) => {
      const f = footprints.get(t)!
      return { key: t, cpus: f.pack.cpus, memoryMb: f.pack.memoryMb }
    })
    await schedule(
      items,
      budget,
      async (it) => {
        const cap = footprints.get(it.key)!.cap
        const tr = await runTaskPairs(
          it.key,
          phase,
          recordArmB,
          (fn) => mutex.withLock(fn),
          cap,
          `[${it.key}] `,
          capRaisedFor(it.key, cap),
        )
        await mutex.withLock(() => {
          taskResults[it.key] = tr
          consume()
          writeJsonAtomic(partialPath, verdictDict("in_progress"))
        })
      },
      args.canLaunch,
      // Transient host-pressure gate (plan S3). Same gate closure for both
      // phases (one shared per-command sensor); PRESSURE_POLL_SEC*1000 passed
      // explicitly as the re-scan cadence (the scheduler's local default is
      // deliberately decoupled from the sensor module).
      args.pressureGate,
      PRESSURE_POLL_SEC * 1000,
    )
  }

  await runPhase("held-in", heldInTasks, true)
  if (!earlyStopped) await runPhase("held-out", heldOutTasks, false)

  const final = verdictDict("")
  writeJsonAtomic(verdictPath, final)
  const finalHeldIn = final["heldIn"] as AbSetStats
  const finalHeldOut = final["heldOut"] as AbSetStats | null
  const finalEnv = final["env"] as { resourceEnforcement?: boolean } | undefined
  const finalSpeed = final["speed"] as { heldIn: AbSpeedStats | null; heldOut: AbSpeedStats | null } | undefined
  appendMetaMetric(join(paths.metaRoot, ".meta-harness"), {
    event: "ab",
    layer,
    candidate,
    baseline,
    decision: final["decision"],
    heldInDelta: finalHeldIn.delta,
    heldInP: finalHeldIn.mcnemarP,
    nPairs: finalHeldIn.nPairs,
    heldOutDelta: finalHeldOut ? finalHeldOut.delta : null,
    splitFold: splitMeta ? splitMeta.activeFold : null,
    earlyStopped: final["earlyStopped"],
    model,
    // Loop-3 T7 (producer wiring): stamp the SAME budget-identity tuple
    // already written into the verdict (T6's maxAgentTimeout/timeoutRecording/
    // env.resourceEnforcement) onto this meta-metric event too, so
    // report-loop.ts's segmentByCurrentBudgetIdentity has a real signal to
    // segment on instead of every event reading as pre-Loop-3 legacy.
    maxAgentTimeout: final["maxAgentTimeout"],
    minAgentTimeout: final["minAgentTimeout"],
    timeoutRecording: final["timeoutRecording"],
    env: { resourceEnforcement: finalEnv?.resourceEnforcement },
    // W1a (time-to-resolve, report-only): held-in speed, mirroring
    // heldInDelta/heldInP/nPairs above. null/0 when there were no
    // qualifying (both-pass, elapsed-present) run-pairs.
    speedMedianRatio: finalSpeed?.heldIn ? finalSpeed.heldIn.medianRatio : null,
    speedP: finalSpeed?.heldIn ? finalSpeed.heldIn.signTestP : null,
    speedNPairs: finalSpeed?.heldIn ? finalSpeed.heldIn.nPairs : 0,
  })
  rmSync(partialPath, { force: true })

  // Summary
  console.log("\n" + "=".repeat(74))
  console.log(
    `${"Task".padEnd(30)} ${"phase".padStart(9)} ${"candidate".padStart(12)} ${"active".padStart(10)}  ${"verdict".padStart(7)}`,
  )
  console.log("-".repeat(74))
  for (const [t, tr] of Object.entries(taskResults)) {
    const ph = tr.phase ?? "?"
    if (tr.error === "setup_failed") {
      console.log(`${t.slice(0, 29).padEnd(30)} ${ph.padStart(9)} ${"—".padStart(12)} ${"—".padStart(10)}  ${"skip".padStart(7)}`)
      continue
    }
    const cp = Math.max(...tr.candidate)
    const ap = Math.max(...tr.active)
    const v = cp > ap ? "cand" : cp < ap ? "active" : "tie"
    console.log(
      `${t.slice(0, 29).padEnd(30)} ${ph.padStart(9)} ${JSON.stringify(tr.candidate).padStart(12)} ${JSON.stringify(tr.active).padStart(10)}  ${v.padStart(7)}`,
    )
  }
  console.log("=".repeat(74))
  console.log(`DECISION: ${(final["decision"] as string).toUpperCase()}   (winner=${final["winner"]})`)
  console.log(
    `  held-in : delta=${pySigned(finalHeldIn.delta, 3)} McNemar p=${pyFixed(finalHeldIn.mcnemarP, 3)} ` +
      `CI90=[${finalHeldIn.bootCI90.join(", ")}] (n=${finalHeldIn.nPairs} pairs, b=${finalHeldIn.b} c=${finalHeldIn.c})`,
  )
  if (finalHeldOut) {
    console.log(
      `  held-out: delta=${pySigned(finalHeldOut.delta, 3)} McNemar p=${pyFixed(finalHeldOut.mcnemarP, 3)} ` +
        `CI90=[${finalHeldOut.bootCI90.join(", ")}] (n=${finalHeldOut.nPairs} pairs)`,
    )
  }
  const sentBlock = final["sentinels"] as AbSetStats | null
  if (sentBlock) {
    console.log(`  sentinels: delta=${pySigned(sentBlock.delta, 3)} (n=${sentBlock.nPairs} pairs)`)
  }
  // W1a (time-to-resolve, report-only): one summary line, held-in only.
  if (finalSpeed?.heldIn) {
    console.log(
      `  speed   : medianRatio=${pyFixed(finalSpeed.heldIn.medianRatio, 3)} (candidate/active) ` +
        `signP=${pyFixed(finalSpeed.heldIn.signTestP, 3)} (n=${finalSpeed.heldIn.nPairs} pairs)`,
    )
  }
  for (const r of final["reasons"] as string[]) {
    console.log(`  · ${r}`)
  }
  log(`Verdict written → ${verdictPath}`)

  if (args.resultsFile) {
    writeJsonAtomic(args.resultsFile, final)
  }
}
