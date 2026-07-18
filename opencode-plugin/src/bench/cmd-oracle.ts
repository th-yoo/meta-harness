/**
 * cmd-oracle.ts — `oracle` subcommand: validate the pipeline using each
 * task's solution/solve.sh, no LLM tokens spent. Mirrors term-bench2/
 * runner.py's cmd_oracle (:1678-1798) — log wording, summary table, and
 * results-file JSON shape are Python-parity; the per-task execution itself
 * is a fresh podman container per the task brief's binding "Design" section
 * (one create+start, several `podman exec` steps, one final `podman rm -f`),
 * replacing bwrap's clean_dir/task_extra_mounts/localbin machinery — the
 * container filesystem is already a clean room, so none of that host-side
 * reset bookkeeping is needed.
 *
 * The per-task container lifecycle (`runOneOracleTask`) is injectable so
 * `cmdOracle`'s looping/logging/results-file logic can be unit tested without
 * ever spawning podman (see test/bench-oracle-unit.test.ts).
 *
 * Staging happens one of two ways, selected by `--staging scripts|runtime`
 * (default runtime — see the task brief for P4):
 *  - "scripts": the ORIGINAL behavior — exec the committed, pre-generated
 *    `/mh/tasks/<task>/setup_deps.sh` (term-bench2/gen_setup_deps.py's
 *    output). Kept side-by-side, verbatim, purely so Gate B can compare it
 *    against runtime staging for equivalence before scripts mode is retired.
 *  - "runtime": staging.ts parses `<tbRoot>/<task>/environment/Dockerfile`
 *    straight from the upstream checkout and executes the derived steps via
 *    podman exec — no vendored per-task script involved at all.
 * Both modes log a step header, but with deliberately DIFFERENT wording
 * (`setup_deps.sh (<task>)...` vs `staging (runtime): <task>...`) so Gate B
 * logs are attributable to whichever mode actually ran.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { podman, withTimeout } from "./exec.ts"
import {
  buildCreateArgv,
  buildStartArgv,
  buildExecArgv,
  buildRmArgv,
} from "./sandbox.ts"
import { BENCH_IMAGE, containerName, type BenchPaths } from "./paths.ts"
import { selectTasks, taskTimeouts, enforcedResources } from "./tasks.ts"
import { stageTaskRuntime, type ExecFn } from "./staging.ts"
import { copyTests, runVerifier } from "./verifier.ts"
import { BenchError, log, pyFixed, writeJsonAtomic } from "./util.ts"

export interface OracleTaskResult {
  reward: number
  elapsed: number
  error: string
}

export type StagingMode = "scripts" | "runtime"

export type RunOneOracleTask = (
  paths: BenchPaths,
  task: string,
  staging?: StagingMode,
) => Promise<OracleTaskResult>

/** One clean-room container lifecycle for a single oracle task — see the
 * task brief's binding "Design" section for the exact step-by-step contract. */
export async function runOneOracleTask(
  paths: BenchPaths,
  task: string,
  staging: StagingMode = "runtime",
  execFn: ExecFn = podman,
  /** undefined = unenforced (default). Set only when --enforce-resources is
   * on — NOT part of the injectable RunOneOracleTask type (kept 3-arg-shaped,
   * spec D2/finding 6); the flag reaches this concrete function via
   * cmdOracle's default-parameter closure below. */
  resources?: { cpus: number; memoryMb: number },
): Promise<OracleTaskResult> {
  const name = containerName(task, "oracle")
  const taskStart = Date.now()
  try {
    try {
      const createResult = await execFn(
        buildCreateArgv({
          image: BENCH_IMAGE,
          name,
          mounts: [
            { host: paths.tbRoot, container: "/tb", ro: true },
            { host: paths.termBenchDir, container: "/mh", ro: true },
          ],
          network: true,
          workdir: "/app",
          resources,
        }),
      )
      if (createResult.rc !== 0) {
        throw new BenchError(
          `runOneOracleTask(${task}): podman create failed: exit ${createResult.rc}` +
            (createResult.stderr.trim() ? ` — ${createResult.stderr.trim()}` : ""),
        )
      }
      const startResult = await execFn(buildStartArgv(name))
      if (startResult.rc !== 0) {
        throw new BenchError(
          `runOneOracleTask(${task}): podman start failed: exit ${startResult.rc}` +
            (startResult.stderr.trim() ? ` — ${startResult.stderr.trim()}` : ""),
        )
      }
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  container bring-up failed: ${msg}`)
      return { reward: 0, elapsed: 0.0, error: "setup_failed" }
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
        return { reward: 0, elapsed: 0.0, error: "setup_failed" }
      }
    } else {
      log(`  staging (runtime): ${task}...`)
      try {
        await stageTaskRuntime(paths, name, task, execFn)
      } catch (e) {
        const msg = e instanceof BenchError ? e.message : (e as Error).message
        log(`  staging (runtime) failed: ${msg}`)
        return { reward: 0, elapsed: 0.0, error: "setup_failed" }
      }
    }

    // Oracle never caps the agent (solve.sh) timeout — Python's cmd_oracle
    // reads task.toml directly with no max_agent_timeout concept at all.
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, 0)

    const solveShHost = join(paths.tbRoot, task, "solution", "solve.sh")
    if (!existsSync(solveShHost)) {
      log("  WARNING: no solution/solve.sh — skipping agent step")
    } else {
      log(`  Running solution/solve.sh (timeout=${pyFixed(agentTimeout, 0)}s)...`)
      const solveResult = await execFn(
        buildExecArgv(name, withTimeout(["bash", `/tb/${task}/solution/solve.sh`], agentTimeout), {
          workdir: "/app",
        }),
      )
      if (solveResult.timedOut) {
        log("  solve.sh timed out")
      }
    }

    // copyTests throws BenchError on a failed /tests reset / tests cp /
    // patches-overlay cp (see verifier.ts's rc-discipline note) — surface it
    // as an INFRA failure (setup_failed), never a silent reward=0.
    try {
      await copyTests(paths, name, task, execFn)
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  copy-tests failed: ${msg}`)
      return { reward: 0, elapsed: 0.0, error: "setup_failed" }
    }
    const reward = await runVerifier(paths, name, task, verifierTimeout)
    const elapsed = Math.round(((Date.now() - taskStart) / 1000) * 10) / 10
    return { reward, elapsed, error: "" }
  } finally {
    await execFn(buildRmArgv(name))
  }
}

function resolveOracleTasks(
  paths: BenchPaths,
  args: { tasks?: string[]; taskFile?: string },
): string[] {
  if (args.tasks && args.tasks.length > 0) return selectTasks(paths, { tasks: args.tasks })
  if (args.taskFile) return selectTasks(paths, { taskFile: args.taskFile })
  return selectTasks(paths, { all: true })
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

interface OracleResultRow {
  task: string
  reward: number
  elapsed: number
  error: string
}

function tasksDict(results: OracleResultRow[]): Record<string, { reward: number; elapsed: number; error: string }> {
  const out: Record<string, { reward: number; elapsed: number; error: string }> = {}
  for (const r of results) out[r.task] = { reward: r.reward, elapsed: r.elapsed, error: r.error }
  return out
}

function writeOracleResults(
  resultsFile: string,
  runStartTs: string,
  results: OracleResultRow[],
  status: "in_progress" | "complete",
): void {
  const nPass = results.reduce((s, r) => s + r.reward, 0)
  const nTotal = results.length
  writeJsonAtomic(resultsFile, {
    label: "oracle",
    timestamp: runStartTs,
    n_pass: nPass,
    n_total: nTotal,
    pass_rate: nTotal ? round4(nPass / nTotal) : 0.0,
    tasks: tasksDict(results),
    status,
  })
  log(`Results written → ${resultsFile}`)
}

export async function cmdOracle(
  paths: BenchPaths,
  args: {
    tasks?: string[]
    taskFile?: string
    resultsFile?: string
    staging?: StagingMode
    /** podman create gets --cpus/--memory from the task's declared task.toml
     * [environment]. Default OFF — unconstrained, byte-identical to before
     * this flag existed. Threaded to runOneOracleTask via the default
     * parameter closure below (its injectable type stays 3-arg-shaped). */
    enforceResources?: boolean
  },
  runOneTask: RunOneOracleTask = (p, t, s) =>
    runOneOracleTask(p, t, s, undefined, args.enforceResources ? enforcedResources(p, t) : undefined),
): Promise<void> {
  const tasks = resolveOracleTasks(paths, args)
  const resultsFile = args.resultsFile
  const staging = args.staging ?? "runtime"

  log(`Oracle validation: ${tasks.length} task(s)`)
  if (resultsFile) log(`Results file: ${resultsFile}`)

  const results: OracleResultRow[] = []
  const runStartTs = new Date().toISOString()

  for (const task of tasks) {
    log(`\n=== Oracle: ${task} ===`)
    const result = await runOneTask(paths, task, staging)
    results.push({ task, reward: result.reward, elapsed: result.elapsed, error: result.error })

    if (result.error !== "setup_failed") {
      const status = result.reward === 1 ? "PASS" : "FAIL"
      log(`  [${status}] reward=${result.reward}  elapsed=${pyFixed(result.elapsed, 1)}s`)
    }

    if (resultsFile) {
      writeOracleResults(resultsFile, runStartTs, results, "in_progress")
    }
  }

  console.log("\n" + "=".repeat(60))
  console.log(`${"Task".padEnd(40)}  ${"Result".padStart(6)}  ${"Elapsed".padStart(8)}`)
  console.log("-".repeat(60))
  let totalPass = 0
  for (const r of results) {
    const name = r.task.slice(0, 39)
    totalPass += r.reward
    const status = r.reward === 1 ? "PASS" : "FAIL"
    console.log(`${name.padEnd(40)}  ${status.padStart(6)}  ${pyFixed(r.elapsed, 1).padStart(7)}s`)
  }
  console.log("=".repeat(60))
  const n = results.length
  if (n) {
    const pct = (100 * totalPass) / n
    console.log(`Oracle pass rate: ${totalPass}/${n}  (${pyFixed(pct, 1)}%)`)
    if (totalPass < n) {
      const failing = results.filter((r) => r.reward === 0).map((r) => r.task)
      console.log(`Failing tasks (${failing.length}): ${failing.join(", ")}`)
    }
  }

  if (resultsFile) {
    writeOracleResults(resultsFile, runStartTs, results, "complete")
  }
}
