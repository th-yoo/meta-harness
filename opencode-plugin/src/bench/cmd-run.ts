/**
 * cmd-run.ts — `run` subcommand: spend tokens running tasks through opencode.
 * Mirrors term-bench2/runner.py's run_task_once (:1460-1499, adapted to
 * podman) and cmd_run (:1502-1673).
 *
 * Container lifecycle per (task, k-repeat) mirrors cmd-oracle.ts's
 * runOneOracleTask (create/start/exec-steps/rm), with two differences:
 *  1. CC-oauth + opencode-binary mounts are added at create time (see
 *     agent-auth.ts's `prepareAgentAuthMounts`): a minimal opencode config
 *     that loads the `opencode-claude-auth` plugin (ro), the source
 *     `.credentials.json` the plugin reads (ro — real `~/.claude` on linux,
 *     a per-run Keychain export on darwin), and the opencode data dir
 *     (rw — auth.json; credential rotation writes back through the same
 *     host dir the interactive plugin uses, matching the Python bwrap
 *     sandbox's shared $HOME). `apiKeyEnv()` (below) coexists as the durable
 *     API-key alternative to this oauth path. opencode itself is NOT mounted
 *     from the host (darwin/linux mismatch) — it must be baked into the
 *     bench image (see term-bench2/Containerfile's opencode layer, added in
 *     this same commit).
 *  2. An agent phase (runAgent, bound to the selected AgentDriver — task-
 *     B3-brief.md) runs between staging and copy-tests.
 */
import { randomBytes } from "node:crypto"
import { join, parse as parsePath } from "node:path"
import { podman } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { buildCreateArgv, buildStartArgv, buildExecArgv, buildRmArgv } from "./sandbox.ts"
import { BENCH_IMAGE, apiKeyEnv, containerName, DEFAULT_BENCH_MODEL, useKeyOnlyForParallel, type BenchPaths } from "./paths.ts"
import type { AgentAuthMounts } from "./agent-auth.ts"
import { selectTasks, taskTimeouts, enforcedResources } from "./tasks.ts"
import { stageTaskRuntime } from "./staging.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { copyTests, runVerifier } from "./verifier.ts"
import { readSelfScore, SELF_CHECK_INSTRUCTION, SELF_CHECK_MARKER } from "./self-score.ts"
import { readCgroupStats } from "./cgroup.ts"
import { updateResourceProfile } from "./resource-profile.ts"
import { runAgent } from "./agent-run.ts"
import { getDriver } from "./drivers/index.ts"
import { opencodeDriver } from "./drivers/opencode.ts"
import type { AgentDriver } from "./drivers/types.ts"
import { assembleAgentsMd, envBlock, harnessMeta, parsePins, recordToStores } from "./record.ts"
import { resumeCarryForward, writeRunResults, aggTotals } from "./results.ts"
import { schedule, DEFAULT_BUDGET, AsyncMutex, type Budget, type ScheduledItem } from "./scheduler.ts"
import { BenchError, die, log, pyFixed } from "./util.ts"
import { readMhConfig, type ToolUsage, type TrajEvent } from "../harness-store.ts"

// ── run_task_once ───────────────────────────────────────────────────────

export interface RunTaskResult {
  sessionId: string
  reward: number
  elapsed: number
  turns: number
  toolUsage: ToolUsage
  events: TrajEvent[]
  /** True iff the agent phase hit its wall-clock timeout (agent-run.ts's
   * runAgent) — propagated from AgentRunOutput.timedOut (Loop-3 T1),
   * defaulting to false when unset (auth-fail/transient/normal paths never
   * set it). Distinguishes a timeout's 0-turn result from a genuine 0-turn
   * no-output below (see `error`'s split — Loop-3 T2). */
  timedOut: boolean
  error: "" | "setup_failed" | "agent_no_output" | "timeout"
  /** Phase-0 self-check: the agent's own passed/total fraction (harness-
   * controlled transport of a self-report, NOT verified — see self-score.ts).
   * null when self-check is off or the agent wrote no/invalid score.txt. */
  selfScore?: number | null
  /** MEASURED container-cgroup footprint (cgroup.ts), read just before teardown
   * — cumulative CPU-seconds + peak RSS (MiB) the whole container burned.
   * undefined when the read failed or the run never reached the agent phase
   * (setup/bring-up failure). Feeds the memorized resource profile. */
  cpuSeconds?: number
  peakRssMb?: number
}

export type RunOneTaskFn = (
  paths: BenchPaths,
  task: string,
  model: string,
  variant: string,
  harnessMd: string,
  agentTimeout: number,
  verifierTimeout: number,
  staging?: StagingMode,
  driver?: AgentDriver,
  /** undefined = unenforced (default). Set only when --enforce-resources is
   * on (tasks.ts's enforcedResources). */
  resources?: { cpus: number; memoryMb: number },
  /** Optional podman funnel + auth-prep overrides — mirror runTaskOnce's own
   * trailing params so cmdRun can thread `--parallel`'s keyOnly prepareAuth
   * (task-6-brief.md) without reordering the positional signature the many
   * runTaskOnce unit tests pass execFn/prepareAuth into. Default runs use the
   * real podman + the driver's default (non-keyOnly) prepareAuth. */
  execFn?: ExecFn,
  prepareAuth?: () => AgentAuthMounts,
) => Promise<RunTaskResult>

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/**
 * The agent CLI version actually baked into the bench image — via a
 * throwaway container (create+start+exec+rm, no mounts, network off), since
 * envBlock's provenance must record what's INSIDE the container the agent
 * phase runs in, not the host's own install (see record.ts's envBlock
 * header for why these differ under podman). Uses `driver.versionArgv`
 * (task-B3-brief.md) so this generalizes across drivers instead of
 * hardcoding `opencode --version`. Called once per `run`/`ab` invocation,
 * matching Python's env_block being computed once before the per-task loop.
 * "unknown" on any failure (never throws — a provenance field must not
 * abort a run).
 */
export async function inContainerAgentVersion(
  paths: BenchPaths,
  driver: AgentDriver,
  execFn: ExecFn = podman,
): Promise<string> {
  const name = containerName("provenance", "ocver")
  try {
    const createResult = await execFn(
      buildCreateArgv({ image: BENCH_IMAGE, name, network: false, workdir: "/app" }),
    )
    if (createResult.rc !== 0) return "unknown"
    const startResult = await execFn(buildStartArgv(name))
    if (startResult.rc !== 0) return "unknown"
    const verResult = await execFn(buildExecArgv(name, driver.versionArgv))
    // rc!=0 -> "unknown" unconditionally (final-review fix 3): a stale image
    // missing the agent binary can still print SOMETHING to stdout/stderr
    // (e.g. a shell's "command not found"), and treating that text as a real
    // version would record garbage provenance while letting the run proceed
    // to silently score 0.
    if (verResult.rc !== 0) return "unknown"
    const combined = (verResult.stdout || verResult.stderr || "").trim()
    const firstLine = combined.split("\n")[0] ?? ""
    return firstLine.slice(0, 40) || "unknown"
  } catch {
    return "unknown"
  } finally {
    await execFn(buildRmArgv(name))
  }
}

/**
 * One clean-room container lifecycle: create+start (with credential mounts)
 * -> mkdir -> staging -> opencode agent phase -> copy-tests -> verify -> rm.
 * No store/results side effects — matches run_task_once's docstring exactly.
 */
export async function runTaskOnce(
  paths: BenchPaths,
  task: string,
  model: string,
  variant: string,
  harnessMd: string,
  agentTimeout: number,
  verifierTimeout: number,
  staging: StagingMode = "runtime",
  driver: AgentDriver = opencodeDriver,
  resources?: { cpus: number; memoryMb: number },
  execFn: ExecFn = podman,
  prepareAuth: () => AgentAuthMounts = () => driver.prepareAuth(),
): Promise<RunTaskResult> {
  const sessionId = `bench-${task}-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`
  const taskStart = Date.now()
  const name = containerName(task, "run")
  const failResult = (error: RunTaskResult["error"]): RunTaskResult => ({
    sessionId,
    reward: 0,
    elapsed: round1((Date.now() - taskStart) / 1000),
    turns: 0,
    toolUsage: {},
    events: [],
    timedOut: false,
    error,
  })

  // CC-oauth mounts (config + credentials + opencode data dir) are prepared
  // fresh per container lifecycle and torn down in the outer `finally` below,
  // alongside `podman rm` — see agent-auth.ts's module header for what each
  // mount is and why cleanup must run even when a later step throws. A
  // missing-credential BenchError from `prepareAuth()` is deliberately
  // caught by the SAME bring-up catch as create/start failures (fail-fast,
  // no retry, matches the auth-error handling in opencode-run.ts) rather
  // than crashing the whole multi-task `run`/`ab` invocation.
  let auth: AgentAuthMounts | undefined
  try {
    try {
      auth = prepareAuth()
      const createResult = await execFn(
        buildCreateArgv({
          image: BENCH_IMAGE,
          name,
          mounts: [
            { host: paths.tbRoot, container: "/tb", ro: true },
            { host: paths.termBenchDir, container: "/mh", ro: true },
            ...auth.mounts,
          ],
          // Provider API key passthrough (additive to auth.json — see
          // paths.ts's apiKeyEnv doc comment), THEN the driver's own auth env
          // (task-B3-brief.md — e.g. a claude-code driver's ANTHROPIC_API_KEY
          // mounted alongside its credential files) spread last so it wins on
          // any key collision with apiKeyEnv(). opencode's own driver never
          // returns env (auth flows entirely through mounts), so this is a
          // no-op for the default driver.
          env: { ...apiKeyEnv(), ...(auth.env ?? {}) },
          network: true,
          workdir: "/app",
          resources,
        }),
      )
      if (createResult.rc !== 0) {
        throw new BenchError(
          `runTaskOnce(${task}): podman create failed: exit ${createResult.rc}` +
            (createResult.stderr.trim() ? ` — ${createResult.stderr.trim()}` : ""),
        )
      }
      const startResult = await execFn(buildStartArgv(name))
      if (startResult.rc !== 0) {
        throw new BenchError(
          `runTaskOnce(${task}): podman start failed: exit ${startResult.rc}` +
            (startResult.stderr.trim() ? ` — ${startResult.stderr.trim()}` : ""),
        )
      }
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  container bring-up failed: ${msg}`)
      return failResult("setup_failed")
    }
    await execFn(buildExecArgv(name, ["mkdir", "-p", "/app", "/tests", "/logs/verifier"]))

    if (staging === "scripts") {
      log(`  setup_deps.sh (${task})...`)
      const setupResult = await execFn(
        buildExecArgv(name, ["bash", `/mh/tasks/${task}/setup_deps.sh`], {
          // no SKIP_APT (Option A, 2026-07-11): podman containers have real
          // root + network, so setup_deps.sh's own SKIP_APT-guarded apt
          // section now genuinely runs (see term-bench2/Containerfile's
          // header for the retired bwrap-era apt-shim rationale).
          env: { TB_ROOT: "/tb", WORKDIR: "/app", EXTRAS_ROOT: "" },
          workdir: "/app",
        }),
      )
      if (setupResult.rc !== 0) {
        log(`  setup_deps.sh failed (exit ${setupResult.rc})`)
        return failResult("setup_failed")
      }
    } else {
      log(`  staging (runtime): ${task}...`)
      try {
        await stageTaskRuntime(paths, name, task, execFn)
      } catch (e) {
        const msg = e instanceof BenchError ? e.message : (e as Error).message
        log(`  staging (runtime) failed: ${msg}`)
        return failResult("setup_failed")
      }
    }

    const { turnCount, toolUsage, events, timedOut } = await runAgent(
      driver,
      paths,
      name,
      task,
      model,
      variant,
      agentTimeout,
      harnessMd,
      execFn,
    )

    await copyTests(paths, name, task)
    const reward = await runVerifier(paths, name, task, verifierTimeout)
    // Phase-0 self-check: only when the harness carries the instruction (else
    // zero overhead + byte-identical behavior). Read BEFORE the container is
    // removed in `finally`.
    const selfScore = harnessMd.includes(SELF_CHECK_MARKER)
      ? await readSelfScore(name, execFn)
      : null
    // Measured cgroup footprint — read here for the same reason as selfScore:
    // the container must still be up (it's `podman rm`'d in the finally). Best-
    // effort: null on any read failure, never blocks the result.
    const cgroup = await readCgroupStats(name, execFn)
    const elapsed = (Date.now() - taskStart) / 1000
    log(`  reward=${reward}${selfScore !== null ? `  self=${round1(selfScore)}` : ""}  elapsed=${pyFixed(elapsed, 1)}s`)
    return {
      sessionId,
      reward,
      elapsed: round1(elapsed),
      turns: turnCount,
      toolUsage,
      events,
      timedOut: timedOut ?? false,
      error: timedOut ? "timeout" : turnCount === 0 ? "agent_no_output" : "",
      selfScore,
      ...(cgroup ? { cpuSeconds: cgroup.cpuSeconds, peakRssMb: cgroup.peakRssMb } : {}),
    }
  } finally {
    // auth?.cleanup() shreds the darwin Keychain-exported .credentials.json (a
    // live refresh token) — it MUST run even if `podman rm` throws (Bun.spawn
    // throws synchronously on a missing binary), so guard the rm in its own
    // try/finally rather than letting a teardown throw skip the credential shred.
    try {
      await execFn(buildRmArgv(name))
    } finally {
      auth?.cleanup()
    }
  }
}

// ── cmd_run ────────────────────────────────────────────────────────────

export interface CmdRunArgs {
  tasks?: string[]
  taskFile?: string
  all?: boolean
  model?: string
  variant?: string
  k?: number
  layers?: "global" | "account" | "project" | "none"
  noStore?: boolean
  saveAllTraj?: boolean
  noHarness?: boolean
  resultsFile?: string
  label?: string
  maxAgentTimeout?: number
  maxVerifierTimeout?: number
  resume?: boolean
  agent?: string
  pin?: string[]
  staging?: StagingMode
  driver?: string
  /** Phase-0 (best-of-k): append the self-check instruction to the harness so
   * each attempt records the agent's own passed/total for the correlation gate.
   * Default off → byte-identical to a normal run. */
  selfCheck?: boolean
  /** podman create gets --cpus/--memory from the task's declared task.toml
   * [environment] (tasks.ts's enforcedResources). Default OFF — unconstrained,
   * byte-identical to before this flag existed. */
  enforceResources?: boolean
  /** Budget-packed concurrent task execution (spec D3/D4, scheduler.ts).
   * Default OFF → the existing serial for-loop, byte-identical. Requires
   * --enforce-resources (each task's declared footprint is what the budget
   * packs against) and a provider API key in the env (the CLI gate — the
   * shared-oauth-credential mount races under concurrency). */
  parallel?: boolean
  /** Concurrency budget overrides (only meaningful with --parallel); default
   * DEFAULT_BUDGET (scheduler.ts). */
  cpuBudget?: number
  memBudget?: number
  /** Per-task resource FLOOR (--min-cpus/--min-mem-mb): a generous minimum
   * cgroup cap under --enforce-resources, raising (never lowering) each
   * task's declared task.toml [environment] footprint via tasks.ts's
   * enforcedResources — sized for the ORACLE, which can starve a heavier
   * agent approach under --parallel's tight per-task cap. Only meaningful
   * with --enforce-resources (a floor with no enforcement is a no-op, not
   * an error). Default undefined → floors undefined → the declared
   * footprint unchanged, byte-identical to before these flags existed. */
  minCpus?: number
  minMemMb?: number
  /** Disable measured-informed resources: pack on declared/floored footprints
   * and skip the measured cap raise (default: measured used when a
   * trustworthy profile exists). */
  noPackMeasured?: boolean
  /** Internal-only wiring — NOT a CLI flag, never parsed from argv (see
   * cli.ts's parseRunArgs, which has no `--` case setting it). The
   * oauth-parallel freshness gate's scheduler launch-guard (Task 2 of the
   * oauth-parallel design, cli.ts's `buildOauthParallelCanLaunch`), threaded
   * straight through into scheduler.ts's `schedule()` `canLaunch` param
   * below. cli.ts's main() sets this AFTER validateParallel (Task 1's
   * pre-flight check) has already allowed the run. Every other caller
   * (direct unit tests, or any caller that never sets it) leaves it
   * undefined — unbounded scheduling, byte-identical to before this gate
   * existed. */
  canLaunch?: () => boolean
}

export async function cmdRun(
  paths: BenchPaths,
  args: CmdRunArgs,
  runOneTask: RunOneTaskFn = runTaskOnce,
  execFn: ExecFn = podman,
): Promise<void> {
  const tasks = args.all
    ? selectTasks(paths, { all: true })
    : args.taskFile
      ? selectTasks(paths, { taskFile: args.taskFile })
      : selectTasks(paths, { tasks: args.tasks })

  const model = args.model || DEFAULT_BENCH_MODEL
  const variant = args.variant || ""
  const k = args.k ?? 1
  const layers = args.layers ?? "global"
  const agent = args.agent || ""
  const staging = args.staging ?? "runtime"
  const maxAgentTimeout = args.maxAgentTimeout ?? 0
  const maxVerifierTimeout = args.maxVerifierTimeout ?? 0
  const driver = getDriver(args.driver ?? "opencode")

  if (args.pin && args.pin.length > 0 && (args.noHarness || layers === "none")) {
    die("--pin cannot be combined with --no-harness / --layers none")
  }
  const pins = parsePins(args.pin ?? [], layers, agent, paths.metaRoot)

  const resultsFile = args.resultsFile
  const label = args.label || (resultsFile ? parsePath(resultsFile).name : "run")
  const noStore = Boolean(args.noStore || resultsFile)

  log(`Running ${tasks.length} task(s) × k=${k}, model=${model}${variant ? `+${variant}` : ""}`)
  log(`TB_ROOT=${paths.tbRoot}  META_ROOT=${paths.metaRoot}`)
  if (agent) log(`Agent role layers: ${agent}`)
  if (Object.keys(pins).length > 0) {
    log(`Pinned: ${Object.entries(pins)
      .map(([n, v]) => `${n}=${v}`)
      .join(", ")}`)
  }
  if (resultsFile) log(`Results file: ${resultsFile}  (store writes disabled)`)

  let harnessMd = ""
  if (!(args.noHarness || layers === "none")) {
    harnessMd = assembleAgentsMd(layers, paths.metaRoot, agent, pins, model)
    if (harnessMd) log(`Harness assembled (${harnessMd.length} chars)`)
    else log("No active harness content found — running without AGENTS.md")
  }
  // Phase-0 (best-of-k correlation gate): append the self-check instruction so
  // each attempt records the agent's own passed/total. Default off.
  const selfCheckOn = Boolean(args.selfCheck)
  if (selfCheckOn) {
    harnessMd = harnessMd ? `${harnessMd}\n\n${SELF_CHECK_INSTRUCTION}` : SELF_CHECK_INSTRUCTION
    log("Self-check ON — agents will record passed/total to score.txt")
  }

  const harnessMetaVal = layers !== "none" ? harnessMeta(layers, paths.metaRoot, agent, pins) : { layers: "none" }
  const agentVersion = await inContainerAgentVersion(paths, driver, execFn)
  // A NON-default driver probing as "unknown" means the bench image doesn't
  // actually have that driver's binary baked in — die loudly rather than
  // silently proceeding to score every task 0 (final-review fix 3). The
  // default driver (opencode) keeps the pre-existing lenient behavior
  // (proceed, "unknown" recorded as provenance) so existing flows/tests are
  // unaffected — opencode is baked into every bench image unconditionally,
  // so an "unknown" probe for it is far more likely a throwaway-container
  // hiccup than a genuinely missing binary.
  if (agentVersion === "unknown" && driver.id !== "opencode") {
    die(`bench image missing ${driver.id} — rebuild with prep --apply`)
  }
  const runEnv = await envBlock(
    harnessMd,
    maxAgentTimeout,
    model,
    paths.metaRoot,
    undefined,
    agentVersion,
    driver.id,
    args.enforceResources ?? false,
  )

  const { taskAgg, doneTasks } = resumeCarryForward(
    resultsFile,
    Boolean(args.resume),
    driver.id,
    args.enforceResources ?? false,
  )
  const results: { task: string; k: number; reward: number; elapsed: number }[] = []
  // Loop-3 T3: whether a wall-clock agent-phase timeout gets recorded as a
  // genuine stored fail (default OFF — see recordToStores's guard doc).
  // Read once per run, not per task, so a mid-run config edit can't produce
  // an inconsistent run.
  const { recordTimeouts } = readMhConfig()

  const runStartTs = new Date().toISOString()

  // --parallel auth mount: keyOnly (no shared rw credential mount) ONLY when an
  // API key is present. With no key, the oauth path (enabled by the freshness
  // gate — validateParallel pre-flight + scheduler canLaunch launch-guard) uses
  // the DEFAULT oauth prepareAuth (the shared rw mount serial uses) — SAFE: the
  // gate guarantees no task runs across the token refresh, so auth.json is
  // read-only during the parallel window (no refresh-token race). Serial →
  // undefined → default oauth. (Residual: cold plugin-cache concurrent write on
  // a first-ever parallel fetch — benign; none on a warm cache.)
  const parallelPrepareAuth: (() => AgentAuthMounts) | undefined = useKeyOnlyForParallel(
    args.parallel ?? false,
    model,
  )
    ? () => driver.prepareAuth({ keyOnly: true })
    : undefined

  // One task's full pipeline (init agg → k serial attempts → record+write),
  // shared by both paths so serial/parallel can't drift. `prefix` tags log
  // lines with the task id under interleaving; `withLock` guards every shared
  // mutation site (results/taskAgg + store write). Serial passes prefix="" and
  // a pass-through lock → byte-identical to the original inline loop; parallel
  // passes `[task] ` and an AsyncMutex-backed lock. `resourcesOverride` lets
  // the parallel path reuse the footprint already computed for budget packing
  // (avoids a second enforcedResources call + its "no [environment]" log).
  const runOneTaskPipeline = async (
    task: string,
    prefix: string,
    withLock: <T>(fn: () => T | Promise<T>) => Promise<T>,
    resourcesOverride: { cpus: number; memoryMb: number } | undefined,
  ): Promise<void> => {
    if (doneTasks.has(task)) {
      log(`\n${prefix}=== Task: ${task} (skipped — already done) ===`)
      return
    }
    log(`\n${prefix}=== Task: ${task} ===`)
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, maxAgentTimeout, maxVerifierTimeout)
    const resources =
      resourcesOverride ??
      (args.enforceResources
        ? enforcedResources(paths, task, { minCpus: args.minCpus, minMemoryMb: args.minMemMb })
        : undefined)

    taskAgg[task] = { rewards: [], elapsed: [], turns: [], errors: [], ...(selfCheckOn ? { selfScores: [] } : {}) }

    for (let ki = 0; ki < k; ki++) {
      if (k > 1) log(`${prefix}  -- run ${ki + 1}/${k} --`)

      const res = await runOneTask(
        paths,
        task,
        model,
        variant,
        harnessMd,
        agentTimeout,
        verifierTimeout,
        staging,
        driver,
        resources,
        undefined,
        parallelPrepareAuth,
      )

      if (res.error === "setup_failed") {
        await withLock(() => {
          results.push({ task, k: ki + 1, reward: 0, elapsed: 0.0 })
          taskAgg[task]!.rewards.push(0)
          taskAgg[task]!.elapsed.push(0.0)
          taskAgg[task]!.turns.push(0)
          taskAgg[task]!.errors.push("setup_failed")
          if (selfCheckOn) taskAgg[task]!.selfScores!.push(null)
        })
        continue
      }

      const passed = res.reward === 1
      // Leaf-level lock #1 (store write) — kept separate from the results/agg
      // lock below; AsyncMutex is non-reentrant, so no critical section may
      // ever take the lock again (reviewer carry-forward #2).
      await withLock(() =>
        recordToStores(
          task,
          res.sessionId,
          passed,
          res.turns,
          res.toolUsage,
          model,
          variant,
          layers,
          paths.metaRoot,
          noStore,
          agent,
          pins,
          runEnv as unknown as Record<string, unknown>,
          res.events,
          Boolean(args.saveAllTraj),
          res.timedOut,
          recordTimeouts,
          res.elapsed,
          agentTimeout,
          res.cpuSeconds,
          res.peakRssMb,
        ),
      )

      // Memorize the measured footprint so the scheduler reuses it instead of
      // re-measuring (resource-profile.ts). Independent of the prompt store
      // (noStore only gates prompt-candidate scores; a footprint is env
      // telemetry) — but only for a REAL run: turns>0 with a cgroup reading.
      // A setup-fail / auth-transient 0-turn is mostly idle wait and would skew
      // avgCpu low. Own lock (NOT nested in the store lock — AsyncMutex is
      // non-reentrant) since parallel tasks share one host-profile file.
      if (res.cpuSeconds !== undefined && res.turns > 0) {
        const cpuSeconds = res.cpuSeconds
        const peakRssMb = res.peakRssMb ?? 0
        await withLock(() => updateResourceProfile(paths.metaRoot, task, { cpuSeconds, peakRssMb, wall: res.elapsed }))
      }

      // Leaf-level lock #2 (results-file + task_agg): the agg pushes happen
      // synchronously first, then the file write reads that consistent
      // snapshot — all inside one lock so a concurrent task can't observe or
      // race a half-updated agg. `return writeRunResults(...)` so an async
      // writer (were one ever swapped in) stays chained under the lock.
      await withLock(() => {
        results.push({ task, k: ki + 1, reward: res.reward, elapsed: res.elapsed })
        taskAgg[task]!.rewards.push(res.reward)
        taskAgg[task]!.elapsed.push(round1(res.elapsed))
        taskAgg[task]!.turns.push(res.turns)
        if (selfCheckOn) taskAgg[task]!.selfScores!.push(res.selfScore ?? null)
        if (resultsFile) {
          return writeRunResults(resultsFile, {
            label,
            model,
            variant,
            harness: harnessMetaVal,
            k,
            timestamp: runStartTs,
            taskAgg,
            status: "in_progress",
            driver: driver.id,
            resourceEnforcement: args.enforceResources || undefined,
            maxAgentTimeout,
            timeoutRecording: recordTimeouts,
          })
        }
        return undefined
      })
    }
  }

  if (args.parallel) {
    const budget: Budget = {
      cpus: args.cpuBudget ?? DEFAULT_BUDGET.cpus,
      memoryMb: args.memBudget ?? DEFAULT_BUDGET.memoryMb,
    }
    const mutex = new AsyncMutex()
    const pending = tasks.filter((t) => !doneTasks.has(t))
    // Compute each pending task's footprint ONCE, before scheduling: a
    // gpu-declaring task throws here (enforcedResources) and dies the run
    // before any container lifecycle, matching --enforce-resources' own guard.
    const footprints = new Map<string, { cpus: number; memoryMb: number }>()
    for (const t of pending) footprints.set(t, enforcedResources(paths, t, { minCpus: args.minCpus, minMemoryMb: args.minMemMb }))
    // Still surface the skip lines for already-done tasks (they're excluded
    // from scheduling, so the shared pipeline never logs them in this path).
    for (const t of tasks) if (doneTasks.has(t)) log(`\n=== Task: ${t} (skipped — already done) ===`)
    const items: ScheduledItem[] = pending.map((t) => ({ key: t, ...footprints.get(t)! }))
    await schedule(
      items,
      budget,
      (it) => runOneTaskPipeline(it.key, `[${it.key}] `, (fn) => mutex.withLock(fn), footprints.get(it.key)),
      args.canLaunch,
    )
  } else {
    // Serial: pass-through lock (runs fn immediately) + empty prefix →
    // byte-identical to the original inline for-loop.
    const noopLock = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn)
    for (const task of tasks) {
      await runOneTaskPipeline(task, "", noopLock, undefined)
    }
  }

  console.log("\n" + "=".repeat(60))
  console.log(`${"Task".padEnd(40)} ${"K".padStart(2)}  ${"Reward".padStart(6)}  ${"Elapsed".padStart(8)}`)
  console.log("-".repeat(60))
  let totalPass = 0
  let totalRuns = 0
  for (const r of results) {
    const name = r.task.slice(0, 39)
    totalPass += r.reward
    totalRuns += 1
    console.log(`${name.padEnd(40)} ${String(r.k).padStart(2)}  ${String(r.reward).padStart(6)}  ${pyFixed(r.elapsed, 1).padStart(7)}s`)
  }
  console.log("=".repeat(60))
  if (totalRuns > 0) {
    const pct = (100 * totalPass) / totalRuns
    console.log(`pass@${k}: ${totalPass}/${totalRuns}  (${pyFixed(pct, 1)}%)`)
  }

  if (resultsFile) {
    writeRunResults(resultsFile, {
      label,
      model,
      variant,
      harness: harnessMetaVal,
      k,
      timestamp: runStartTs,
      taskAgg,
      status: "complete",
      driver: driver.id,
      resourceEnforcement: args.enforceResources || undefined,
      maxAgentTimeout,
      timeoutRecording: recordTimeouts,
    })
    const [np, nt] = aggTotals(taskAgg)
    log(nt ? `FINAL: ${np}/${nt} passed (${pyFixed((100 * np) / nt, 1)}%)` : "FINAL: no tasks")
  }
}
