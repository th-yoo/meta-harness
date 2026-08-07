/**
 * bench/p2/cmd-p2.ts — the `p2-run` subcommand: execute one arm (A1/A3/A4)
 * of the P2 actuator-binding probe across a task set, k repeats each
 * (docs/superpowers/plans/2026-08-06-p2-actuator-binding.md §Task 4).
 *
 * This module reuses the EXISTING bench primitives directly (sandbox.ts's
 * podman argv builders, agent-run.ts's runAgent, staging.ts's
 * stageTaskRuntime, verifier.ts's copyTests/runVerifier, record.ts's
 * assembleAgentsMd, results.ts's writeRunResults, drivers/claude-code.ts's
 * claudeCodeDriver) — it NEVER calls cmd-run.ts's cmdRun/runTaskOnce (the
 * stock `run` path). F1: cc-gate-plugin and the stock run path are
 * untouched by this task.
 *
 * Two injection layers, matching this module's two levels of testability
 * (task-4-brief.md Step 1's test list spans both):
 *  - `cmdP2`'s own `deps.runOneAttempt` lets orchestration tests (fences,
 *    --go arithmetic, results-file writing, per-attempt annotation
 *    encoding) run with a fake per-attempt function — no execFn/driver
 *    ever touched.
 *  - `runOneP2Attempt`'s own default parameters (execFn/driver/sleepFn/env/
 *    runReview) let dispatch-behavior tests (a1's appended bullet, a3's
 *    settings copy-in, a4's review + bounded re-pass) call the REAL
 *    per-attempt container lifecycle directly with fake execFn/driver/
 *    runReview — no podman, no model call, per agent-run.ts's own
 *    injectable-seam pattern (test/bench-agent-run.test.ts).
 *
 * Store isolation + cost fence (plan §Global Constraints, brief bullet 1):
 * `--results-file` is REQUIRED and must resolve under
 * `<metaRoot>/docs/loop-probes/p2/` — p2-run never writes
 * `term-bench2/store/**`, and never calls record.ts's `recordToStores` at
 * all. `--go` must equal the EXACT planned max container-execution count
 * (`expectedGoCount`) — a mismatch is a hard refusal before any container
 * work (zero effect on mismatch, per the plan's "channel-run discipline").
 *
 * Per-attempt annotation (brief bullet 3, "extends the results-file row
 * via the label field, no schema change" — DEVIATION RECORDED, see this
 * task's report): results.ts's `TaskAgg` interface is NOT touched (no
 * schema change to results.ts). Instead this module reuses TaskAgg's
 * EXISTING `errors: string[]` field — already the per-attempt string slot
 * parallel to `rewards`/`elapsed`/`turns` — as the compact per-attempt
 * "label" (annotation) channel: a JSON string encoding
 * `{arm, ruleSha, compliant, reprompted, reviewFailed, error}` for every
 * attempt (unlike cmd-run.ts's sparse use of `errors`, which only pushes
 * "setup_failed" and otherwise leaves it unpushed — p2-run pushes exactly
 * one entry per attempt, keeping `errors.length === rewards.length`
 * strictly, so Task 5's tally can zip the two arrays 1:1). F2 holds: only
 * counts/booleans/a content-hash/an error-classification string, never
 * transcript or finding text.
 */
import { dirname, join, resolve, sep } from "node:path"
import { podman, withTimeout } from "../exec.ts"
import type { ExecFn } from "../staging.ts"
import { stageTaskRuntime } from "../staging.ts"
import { buildCreateArgv, buildStartArgv, buildExecArgv, buildCpToArgv, buildRmArgv } from "../sandbox.ts"
import { BENCH_IMAGE, DEFAULT_BENCH_MODEL, apiKeyEnv, containerName, type BenchPaths } from "../paths.ts"
import { selectTasks, taskTimeouts } from "../tasks.ts"
import { copyTests, runVerifier } from "../verifier.ts"
import { runAgent, defaultSleep, type SleepFn } from "../agent-run.ts"
import { assembleAgentsMd, harnessMeta } from "../record.ts"
import { writeRunResults, type TaskAgg } from "../results.ts"
import { claudeCodeDriver } from "../drivers/claude-code.ts"
import type { AgentDriver } from "../drivers/types.ts"
import type { TrajEvent } from "../../harness-store.ts"
import { BenchError, die, log, pyFixed } from "../util.ts"
import { P2_RULE_TEXT, ruleSha, isCompliant, bashCommandsFromEvents } from "./rule.ts"
import { runA4Review, buildReinjectInstruction, A4_TURN_CAP, type A4Evidence, type A4ReviewResult } from "./a4-review.ts"

export type P2Arm = "a1" | "a3" | "a4"

/** The A3 in-container Stop-gate settings asset (per Task 1's probe
 * verdict — Stop hooks DO fire under one-shot `claude -p`). Resolved
 * relative to THIS file, mirroring paths.ts's `makeBenchPaths`'s own
 * `import.meta.url`-based lookup (no bun-types dep in this project — see
 * that file's header). */
const STOP_GATE_SETTINGS_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "assets",
  "stop-gate-settings.json",
)

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/** `--go` must equal this EXACT count (brief bullet 1): tasks × k, doubled
 * for a4 (its potential one bounded re-pass — unfired re-passes are
 * unspent budget, never re-allocated elsewhere). */
export function expectedGoCount(numTasks: number, k: number, arm: P2Arm): number {
  return numTasks * k * (arm === "a4" ? 2 : 1)
}

/** Store-isolation fence: `--results-file` must resolve under
 * `<metaRoot>/docs/loop-probes/p2/` — dies otherwise. Resolution mirrors
 * ordinary CLI path handling (relative to cwd via `path.resolve`) so an
 * ALREADY-absolute path (as tests pass) is compared unchanged. */
export function resolveP2ResultsFile(paths: BenchPaths, resultsFile: string): string {
  const resolved = resolve(resultsFile)
  const p2Root = resolve(paths.metaRoot, "docs", "loop-probes", "p2")
  if (resolved !== p2Root && !resolved.startsWith(p2Root + sep)) {
    die(
      `p2-run: --results-file must resolve under ${p2Root} (store isolation — p2 never touches ` +
        `term-bench2/store/**) — got ${resolved}`,
    )
  }
  return resolved
}

/** A1's harness delta: the stock harness markdown plus ONE appended bullet
 * carrying the frozen rule verbatim (brief bullet 2). a3/a4 use the stock
 * harness unchanged — their delivery mechanism is the in-container
 * Stop-gate (a3) or the post-attempt review (a4), not the harness text. */
export function buildA1HarnessMd(stockHarnessMd: string): string {
  return `${stockHarnessMd}\n\n- ${P2_RULE_TEXT}`
}

// ── per-attempt evidence gathering ──────────────────────────────────────

/** Gather the SAME evidence shape A4's review needs (brief: "podman exec
 * cat /app/DONE-CHECK.txt tolerant, bashCommandsFromEvents(output.events),
 * podman exec ls /app") — reused for a1/a3 too (only `doneCheck` +
 * `bashCommands` are consulted there; `workspaceFiles` is extra but
 * harmless, and keeping ONE evidence-gathering helper for all three arms
 * avoids duplicating the tolerant-cat/ls logic three times). */
async function gatherEvidence(name: string, events: TrajEvent[], execFn: ExecFn): Promise<A4Evidence> {
  const catResult = await execFn(buildExecArgv(name, ["cat", "/app/DONE-CHECK.txt"]))
  const doneCheck = catResult.rc === 0 ? catResult.stdout : undefined
  const lsResult = await execFn(buildExecArgv(name, ["ls", "/app"]))
  const workspaceFiles =
    lsResult.rc === 0
      ? lsResult.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []
  return { doneCheck, bashCommands: bashCommandsFromEvents(events), workspaceFiles }
}

// ── one attempt (full container lifecycle) ──────────────────────────────

export interface P2AttemptResult {
  reward: number
  elapsed: number
  turns: number
  error: "" | "setup_failed" | "agent_no_output" | "timeout"
  /** Task 2's mechanical compliance predicate, evaluated post-attempt —
   * post-re-pass for a4 (brief bullet 3). */
  compliant: boolean
  /** True iff a4's one bounded re-pass actually fired (review returned
   * `complied: false`). Always false for a1/a3. */
  reprompted: boolean
  /** True iff a4's review call itself failed (runA4Review returned
   * undefined) — no re-pass fires in that case (brief bullet 2's a4 spec).
   * Always false for a1/a3. */
  reviewFailed: boolean
}

export type RunA4ReviewFn = typeof runA4Review

export type RunOneP2AttemptFn = (
  paths: BenchPaths,
  task: string,
  arm: P2Arm,
  model: string,
  harnessMd: string,
  agentTimeout: number,
  verifierTimeout: number,
  driver: AgentDriver,
  execFn: ExecFn,
  sleepFn: SleepFn,
  env: Record<string, string | undefined>,
  runReview: RunA4ReviewFn,
) => Promise<P2AttemptResult>

/**
 * One clean-room container lifecycle for a single (arm, task, k-repeat)
 * attempt — create+start -> mkdir -> stage -> [a3: settings copy-in] ->
 * runAgent -> [a4: evidence -> review -> optional ONE re-pass] -> evidence
 * (a1/a3) -> copy-tests -> verify -> rm. Mirrors cmd-run.ts's
 * `runTaskOnce`/cmd-oracle.ts's `runOneOracleTask` shape (create/start/
 * exec-steps/rm), NOT cmd-run.ts's own function (F1 — never call the stock
 * run path itself).
 */
export async function runOneP2Attempt(
  paths: BenchPaths,
  task: string,
  arm: P2Arm,
  model: string,
  harnessMd: string,
  agentTimeout: number,
  verifierTimeout: number,
  driver: AgentDriver = claudeCodeDriver,
  execFn: ExecFn = podman,
  sleepFn: SleepFn = defaultSleep,
  env: Record<string, string | undefined> = process.env,
  runReview: RunA4ReviewFn = runA4Review,
): Promise<P2AttemptResult> {
  const name = containerName(task, `p2-${arm}`)
  const taskStart = Date.now()
  const fail = (error: P2AttemptResult["error"]): P2AttemptResult => ({
    reward: 0,
    elapsed: round1((Date.now() - taskStart) / 1000),
    turns: 0,
    error,
    compliant: false,
    reprompted: false,
    reviewFailed: false,
  })

  try {
    try {
      const createResult = await execFn(
        buildCreateArgv({
          image: BENCH_IMAGE,
          name,
          // No /tb or /mh mount (env-fidelity fix, mirrors cmd-run.ts's own
          // agent containers) — everything an attempt needs arrives via
          // `podman cp` (stageTaskRuntime, the a3 settings copy-in below,
          // verifier.ts's copyTests).
          mounts: [],
          env: apiKeyEnv(),
          network: true,
          workdir: "/app",
        }),
      )
      if (createResult.rc !== 0) {
        throw new BenchError(
          `runOneP2Attempt(${arm}, ${task}): podman create failed: exit ${createResult.rc}` +
            (createResult.stderr.trim() ? ` — ${createResult.stderr.trim()}` : ""),
        )
      }
      const startResult = await execFn(buildStartArgv(name))
      if (startResult.rc !== 0) {
        throw new BenchError(
          `runOneP2Attempt(${arm}, ${task}): podman start failed: exit ${startResult.rc}` +
            (startResult.stderr.trim() ? ` — ${startResult.stderr.trim()}` : ""),
        )
      }
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  container bring-up failed: ${msg}`)
      return fail("setup_failed")
    }

    await execFn(buildExecArgv(name, ["mkdir", "-p", "/app", "/tests", "/logs/verifier"]))

    log(`  staging (runtime): ${task}...`)
    try {
      await stageTaskRuntime(paths, name, task, execFn, sleepFn)
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  staging (runtime) failed: ${msg}`)
      return fail("setup_failed")
    }

    if (arm === "a3") {
      // A3 containers ONLY (brief bullet 2) — never the shared image, never
      // a1/a4 containers.
      const mkdirClaude = await execFn(buildExecArgv(name, ["mkdir", "-p", "/app/.claude"]))
      if (mkdirClaude.rc !== 0) {
        log(`  a3 settings copy-in: mkdir /app/.claude failed: exit ${mkdirClaude.rc}`)
        return fail("setup_failed")
      }
      const cpResult = await execFn(buildCpToArgv(name, STOP_GATE_SETTINGS_PATH, "/app/.claude/settings.json"))
      if (cpResult.rc !== 0) {
        log(`  a3 settings copy-in failed: exit ${cpResult.rc}`)
        return fail("setup_failed")
      }
    }

    const output = await runAgent(driver, paths, name, task, model, "", agentTimeout, harnessMd, execFn, sleepFn)

    let compliant = false
    let reprompted = false
    let reviewFailed = false

    if (arm === "a4") {
      const evidence1 = await gatherEvidence(name, output.events, execFn)
      const review: A4ReviewResult | undefined = await runReview(evidence1, env)
      if (review === undefined) {
        reviewFailed = true
        compliant = isCompliant(evidence1.doneCheck, evidence1.bashCommands)
      } else if (review.complied) {
        compliant = isCompliant(evidence1.doneCheck, evidence1.bashCommands)
      } else {
        reprompted = true
        // Double-carrier turn cap (Task 1 probe deviation note: --max-turns
        // is ACCEPTED by the CLI parser but its ENFORCEMENT was not
        // verified) — belt: the cap is ALSO stated in the reinject
        // instruction text, not just carried via --max-turns argv below.
        const reinjectInstruction =
          `${buildReinjectInstruction(review.requiredEdits)}\n\n` +
          `You have at most ${A4_TURN_CAP} turns remaining for this re-pass.`
        const rePassArgv = [
          ...driver.buildArgv({ model: driver.modelArg(model), variant: "", instruction: reinjectInstruction }),
          "--max-turns",
          String(A4_TURN_CAP),
        ]
        const rePassResult = await execFn(buildExecArgv(name, withTimeout(rePassArgv, agentTimeout), { workdir: "/app" }))
        const rePassParsed = driver.parseOutput(rePassResult.stdout || "")
        // Post-re-pass compliance (brief bullet 3): re-gather DONE-CHECK
        // content from the FINAL container state, union bash commands from
        // BOTH passes (the check command satisfying the rule may have run
        // in either pass).
        const evidence2 = await gatherEvidence(name, [...output.events, ...rePassParsed.events], execFn)
        compliant = isCompliant(evidence2.doneCheck, evidence2.bashCommands)
      }
    } else {
      const evidence = await gatherEvidence(name, output.events, execFn)
      compliant = isCompliant(evidence.doneCheck, evidence.bashCommands)
    }

    try {
      await copyTests(paths, name, task, execFn)
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  copy-tests failed: ${msg}`)
      return { ...fail("setup_failed"), compliant, reprompted, reviewFailed }
    }
    const reward = await runVerifier(paths, name, task, verifierTimeout)
    const elapsed = round1((Date.now() - taskStart) / 1000)
    log(`  [${arm}] reward=${reward}  compliant=${compliant}  elapsed=${pyFixed(elapsed, 1)}s`)
    return {
      reward,
      elapsed,
      turns: output.turnCount,
      error: output.timedOut ? "timeout" : output.turnCount === 0 ? "agent_no_output" : "",
      compliant,
      reprompted,
      reviewFailed,
    }
  } finally {
    await execFn(buildRmArgv(name))
  }
}

// ── cmdP2 ──────────────────────────────────────────────────────────────

export interface CmdP2Args {
  arm?: P2Arm
  tasks?: string[]
  taskFile?: string
  k?: number
  resultsFile?: string
  go?: number
  model?: string
}

export interface CmdP2Deps {
  runOneAttempt?: RunOneP2AttemptFn
  driver?: AgentDriver
  execFn?: ExecFn
  sleepFn?: SleepFn
  env?: Record<string, string | undefined>
  runReview?: RunA4ReviewFn
}

/** Compact per-attempt annotation (this file's header — the `errors[]`
 * reuse). JSON so Task 5's tally can parse it without a bespoke format. */
function attemptLabel(
  arm: P2Arm,
  result: Pick<P2AttemptResult, "compliant" | "reprompted" | "reviewFailed" | "error">,
): string {
  return JSON.stringify({
    arm,
    ruleSha: ruleSha(),
    compliant: result.compliant,
    reprompted: result.reprompted,
    reviewFailed: result.reviewFailed,
    error: result.error,
  })
}

/**
 * `p2-run` — execute one arm across a task set, k repeats each. Fences
 * first (brief bullet 1): `--results-file` required + must resolve under
 * `docs/loop-probes/p2/`, `--go` must equal `expectedGoCount`. Never calls
 * record.ts's `recordToStores` (store isolation is absolute — p2 has no
 * `--no-store`-style escape hatch because it never has a store path to
 * begin with).
 */
export async function cmdP2(paths: BenchPaths, args: CmdP2Args, deps: CmdP2Deps = {}): Promise<void> {
  const arm = args.arm
  if (arm !== "a1" && arm !== "a3" && arm !== "a4") {
    die(`p2-run: --arm must be a1, a3, or a4 (got ${args.arm === undefined ? "(missing)" : `"${args.arm}"`})`)
  }

  if (!args.resultsFile) {
    die("p2-run: --results-file is required (store isolation — p2 never writes term-bench2/store/**)")
  }
  const resultsFile = resolveP2ResultsFile(paths, args.resultsFile)

  const tasks = selectTasks(paths, { tasks: args.tasks, taskFile: args.taskFile })

  const k = args.k
  if (!k || !Number.isFinite(k) || k < 1) {
    die(`p2-run: --k N is required (N >= 1), got ${args.k === undefined ? "(missing)" : args.k}`)
  }

  const expectedGo = expectedGoCount(tasks.length, k, arm)
  if (args.go !== expectedGo) {
    die(
      `p2-run: --go ${args.go === undefined ? "(missing)" : args.go} does not match the planned execution count ` +
        `for ${tasks.length} task(s) × k=${k} on arm ${arm} — expected --go ${expectedGo}. Refusing (zero effect).`,
    )
  }

  const model = args.model || DEFAULT_BENCH_MODEL
  const driver = deps.driver ?? claudeCodeDriver
  const execFn = deps.execFn ?? podman
  const sleepFn = deps.sleepFn ?? defaultSleep
  const env = deps.env ?? process.env
  const runReview = deps.runReview ?? runA4Review
  const runOneAttempt = deps.runOneAttempt ?? runOneP2Attempt

  log(`P2 ${arm}: ${tasks.length} task(s) × k=${k}, model=${model} (--go ${expectedGo})`)
  log(`Results file: ${resultsFile}  (store writes disabled — p2 never touches term-bench2/store/**)`)

  const stockHarnessMd = assembleAgentsMd("global", paths.metaRoot, "", {}, model)
  const harnessMd = arm === "a1" ? buildA1HarnessMd(stockHarnessMd) : stockHarnessMd

  const taskAgg: Record<string, TaskAgg> = {}
  const runStartTs = new Date().toISOString()
  const harnessMetaVal = { ...harnessMeta("global", paths.metaRoot), arm, ruleSha: ruleSha() }

  const flush = (status: "in_progress" | "complete"): void => {
    writeRunResults(resultsFile, {
      label: `p2-${arm}`,
      model,
      variant: "",
      harness: harnessMetaVal,
      k,
      timestamp: runStartTs,
      taskAgg,
      status,
      driver: driver.id,
      maxAgentTimeout: 0,
      timeoutRecording: false,
    })
  }

  for (const task of tasks) {
    log(`\n=== P2 ${arm}: ${task} ===`)
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, 0)
    taskAgg[task] = { rewards: [], elapsed: [], turns: [], errors: [] }

    for (let ki = 0; ki < k; ki++) {
      if (k > 1) log(`  -- run ${ki + 1}/${k} --`)
      const result = await runOneAttempt(
        paths,
        task,
        arm,
        model,
        harnessMd,
        agentTimeout,
        verifierTimeout,
        driver,
        execFn,
        sleepFn,
        env,
        runReview,
      )
      taskAgg[task]!.rewards.push(result.reward)
      taskAgg[task]!.elapsed.push(result.elapsed)
      taskAgg[task]!.turns.push(result.turns)
      taskAgg[task]!.errors.push(attemptLabel(arm, result))
      flush("in_progress")
    }
  }

  flush("complete")
  log(`\nP2 ${arm}: done — results at ${resultsFile}`)
}
