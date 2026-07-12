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
 *  2. An agent phase (runOpencode) runs between staging and copy-tests.
 */
import { randomBytes } from "node:crypto"
import { join, parse as parsePath } from "node:path"
import { podman } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { buildCreateArgv, buildStartArgv, buildExecArgv, buildRmArgv } from "./sandbox.ts"
import { BENCH_IMAGE, apiKeyEnv, containerName, type BenchPaths } from "./paths.ts"
import { prepareAgentAuthMounts, type AgentAuthMounts } from "./agent-auth.ts"
import { selectTasks, taskTimeouts } from "./tasks.ts"
import { stageTaskRuntime } from "./staging.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { copyTests, runVerifier } from "./verifier.ts"
import { runOpencode } from "./opencode-run.ts"
import { assembleAgentsMd, envBlock, harnessMeta, parsePins, recordToStores } from "./record.ts"
import { resumeCarryForward, writeRunResults, aggTotals } from "./results.ts"
import { BenchError, die, log, pyFixed } from "./util.ts"
import type { ToolUsage, TrajEvent } from "../harness-store.ts"

// ── run_task_once ───────────────────────────────────────────────────────

export interface RunTaskResult {
  sessionId: string
  reward: number
  elapsed: number
  turns: number
  toolUsage: ToolUsage
  events: TrajEvent[]
  error: "" | "setup_failed" | "agent_no_output"
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
) => Promise<RunTaskResult>

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/**
 * The opencode version actually baked into the bench image — via a
 * throwaway container (create+start+exec+rm, no mounts, network off), since
 * envBlock's provenance must record what's INSIDE the container the agent
 * phase runs in, not the host's own opencode install (see record.ts's
 * envBlock header for why these differ under podman). Called once per
 * `run`/`ab` invocation, matching Python's env_block being computed once
 * before the per-task loop. "unknown" on any failure (never throws — a
 * provenance field must not abort a run).
 */
export async function inContainerOpencodeVersion(paths: BenchPaths, execFn: ExecFn = podman): Promise<string> {
  const name = containerName("provenance", "ocver")
  try {
    const createResult = await execFn(
      buildCreateArgv({ image: BENCH_IMAGE, name, network: false, workdir: "/app" }),
    )
    if (createResult.rc !== 0) return "unknown"
    const startResult = await execFn(buildStartArgv(name))
    if (startResult.rc !== 0) return "unknown"
    const verResult = await execFn(buildExecArgv(name, ["opencode", "--version"]))
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
  execFn: ExecFn = podman,
  prepareAuth: () => AgentAuthMounts = prepareAgentAuthMounts,
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
          // paths.ts's apiKeyEnv doc comment). No explicit env is set on
          // this create call otherwise, so there's nothing for apiKeyEnv()
          // to collide with; spread order still puts apiKeyEnv() first so
          // any future explicit entry here would win on key collision.
          env: { ...apiKeyEnv() },
          network: true,
          workdir: "/app",
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

    const { turnCount, toolUsage, events } = await runOpencode(
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
    const elapsed = (Date.now() - taskStart) / 1000
    log(`  reward=${reward}  elapsed=${pyFixed(elapsed, 1)}s`)
    return {
      sessionId,
      reward,
      elapsed: round1(elapsed),
      turns: turnCount,
      toolUsage,
      events,
      error: turnCount === 0 ? "agent_no_output" : "",
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
  resume?: boolean
  agent?: string
  pin?: string[]
  staging?: StagingMode
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

  const model = args.model || "anthropic/claude-sonnet-4-6"
  const variant = args.variant || ""
  const k = args.k ?? 1
  const layers = args.layers ?? "global"
  const agent = args.agent || ""
  const staging = args.staging ?? "runtime"
  const maxAgentTimeout = args.maxAgentTimeout ?? 0

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
    harnessMd = assembleAgentsMd(layers, paths.metaRoot, agent, pins)
    if (harnessMd) log(`Harness assembled (${harnessMd.length} chars)`)
    else log("No active harness content found — running without AGENTS.md")
  }

  const harnessMetaVal = layers !== "none" ? harnessMeta(layers, paths.metaRoot, agent, pins) : { layers: "none" }
  const ocVersion = await inContainerOpencodeVersion(paths, execFn)
  const runEnv = await envBlock(harnessMd, maxAgentTimeout, model, paths.metaRoot, undefined, ocVersion)

  const { taskAgg, doneTasks } = resumeCarryForward(resultsFile, Boolean(args.resume))
  const results: { task: string; k: number; reward: number; elapsed: number }[] = []

  const runStartTs = new Date().toISOString()

  for (const task of tasks) {
    if (doneTasks.has(task)) {
      log(`\n=== Task: ${task} (skipped — already done) ===`)
      continue
    }
    log(`\n=== Task: ${task} ===`)
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, maxAgentTimeout)

    taskAgg[task] = { rewards: [], elapsed: [], turns: [], errors: [] }

    for (let ki = 0; ki < k; ki++) {
      if (k > 1) log(`  -- run ${ki + 1}/${k} --`)

      const res = await runOneTask(paths, task, model, variant, harnessMd, agentTimeout, verifierTimeout, staging)

      if (res.error === "setup_failed") {
        results.push({ task, k: ki + 1, reward: 0, elapsed: 0.0 })
        taskAgg[task]!.rewards.push(0)
        taskAgg[task]!.elapsed.push(0.0)
        taskAgg[task]!.turns.push(0)
        taskAgg[task]!.errors.push("setup_failed")
        continue
      }

      const passed = res.reward === 1
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
      )

      results.push({ task, k: ki + 1, reward: res.reward, elapsed: res.elapsed })
      taskAgg[task]!.rewards.push(res.reward)
      taskAgg[task]!.elapsed.push(round1(res.elapsed))
      taskAgg[task]!.turns.push(res.turns)

      if (resultsFile) {
        writeRunResults(resultsFile, {
          label,
          model,
          variant,
          harness: harnessMetaVal,
          k,
          timestamp: runStartTs,
          taskAgg,
          status: "in_progress",
        })
      }
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
    })
    const [np, nt] = aggTotals(taskAgg)
    log(nt ? `FINAL: ${np}/${nt} passed (${pyFixed((100 * np) / nt, 1)}%)` : "FINAL: no tasks")
  }
}
