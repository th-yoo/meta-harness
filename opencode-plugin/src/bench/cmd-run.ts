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
 *  3. NO /tb or /mh mount, ever (env-fidelity fix, docs/env-fidelity-
 *     spotcheck.md) — unlike cmd-oracle.ts's own container, which keeps
 *     both. An agent container must not get whole-lifetime read access to
 *     the task-source repo (answer keys, other tasks' fixtures) or
 *     termBenchDir (results/logs/store snapshot/patches). Everything a
 *     pipeline step needs from either tree arrives via `podman cp` instead:
 *     staging.ts's stageTaskRuntime (runtime mode), this file's own
 *     scripts-mode staging block, and verifier.ts's copyTests.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, parse as parsePath } from "node:path"
import { podman } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { buildCreateArgv, buildStartArgv, buildExecArgv, buildRmArgv, buildCpToArgv } from "./sandbox.ts"
import { BENCH_IMAGE, apiKeyEnv, containerName, DEFAULT_BENCH_MODEL, useKeyOnlyForParallel, type BenchPaths } from "./paths.ts"
import type { AgentAuthMounts } from "./agent-auth.ts"
import { selectTasks, taskTimeouts, enforcedResources, packingFootprints, escalateResources } from "./tasks.ts"
import { stageTaskRuntime, taskWorkdir } from "./staging.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { copyTests, runVerifier } from "./verifier.ts"
import { readSelfScore, SELF_CHECK_INSTRUCTION, SELF_CHECK_MARKER } from "./self-score.ts"
import { readCgroupStats } from "./cgroup.ts"
import { updateResourceProfile, readResourceProfile, raiseCapMeasured, PACK_MIN_SAMPLES } from "./resource-profile.ts"
import { runAgent } from "./agent-run.ts"
import { getDriver } from "./drivers/index.ts"
import { opencodeDriver } from "./drivers/opencode.ts"
import type { AgentDriver } from "./drivers/types.ts"
import { assembleAgentsMd, envBlock, harnessMeta, parsePins, recordToStores, layerStoreRoots } from "./record.ts"
import { resumeCarryForward, writeRunResults, aggTotals } from "./results.ts"
import { schedule, DEFAULT_BUDGET, AsyncMutex, type Budget, type ScheduledItem } from "./scheduler.ts"
import { PRESSURE_POLL_SEC } from "./host-pressure.ts"
import { BenchError, die, log, pyFixed } from "./util.ts"
import { readMhConfig, activeChecks, checksHashOfList, readPlaybook, type ToolUsage, type TrajEvent } from "../harness-store.ts"
import {
  RULE_GATE_DIR,
  buildRuleGateScript,
  buildRuleGateSettings,
  readRuleGateStateArgs,
  type RuleGateCheck,
} from "./rule-gate.ts"

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
  /** True iff the container's cumulative cgroup oom_kill counter was nonzero at
   * teardown ((cgroup.oomKills ?? 0) > 0). CUMULATIVE over the container's
   * lifetime — the in-container agent retry loop (agent-run.ts:189-230) can OOM
   * once and recover — so nonzero does NOT mean the final attempt was killed.
   * Callers MUST combine it with the run outcome (see runWithOomRetry).
   * undefined-falsy when the cgroup read failed or the run never reached the
   * agent phase. */
  oomKilled?: boolean
  /** Agent-phase wall-clock seconds (AgentRunOutput.agentElapsedSec, agent-
   * run.ts's runAgent — W1a: time-to-resolve). Candidate-independent except
   * for the agent phase itself, unlike the full-lifecycle `elapsed` above
   * (container create + staging + agent + verifier + cgroup read), which
   * dilutes the speed signal with infra noise — this is the preferred field
   * for pairing run-pair speed. undefined when the agent phase never ran
   * (setup_failed) or returned no elapsed reading (e.g. an auth-fail
   * fast-return — see AgentRunOutput's doc comment); callers fall back to
   * `elapsed` as a safety net for exotic drivers. */
  agentElapsedSec?: number
  /** a3 routing T7: post-attempt in-container rule-gate state readback
   * (rule-gate.ts's `readRuleGateStateArgs`, `state.json`'s shape minus
   * `perRule[*].lastFail` — outcomes only, F2). Absent when this arm carried
   * no checked bullets (`checks` was empty — no gate was ever injected), OR
   * when a checked arm's readback came back rc!=0 (the COMMON case for an
   * all-pass attempt: rule-gate.ts's buildRuleGateScript only ever WRITES
   * state.json on a block) or failed to parse — a missing/unreadable state
   * read on an already-completed attempt is fail-open (never reclassifies
   * the attempt as dead), just omits this field with a loud log line. */
  ruleChecks?: { rounds: number; exhausted: boolean; perRule: Record<string, { blocked: number }> }
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
  /** a3 routing T7: THIS ARM'S OWN enforced check set (spec §3's INJECTION
   * SYMMETRY — cmd-ab passes the active arm's active-playbook checks here,
   * the candidate arm its own candidate-playbook checks; cmd-run's
   * single-harness degenerate case passes the one assembled union). Trailing
   * + defaulted (empty) so every existing 12-arg caller/fake in this file's
   * many unit tests keeps compiling unchanged — checkless is the default. */
  checks?: RuleGateCheck[],
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
  checks: RuleGateCheck[] = [],
): Promise<RunTaskResult> {
  const sessionId = `bench-${task}-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`
  const taskStart = Date.now()
  const name = containerName(task, "run")
  // Task Dockerfile's WORKDIR (default /app) — the agent's container cwd AND
  // the verifier's exec cwd, so relative-path graders resolve where the task
  // image would put them (2026-08-12 prove-plus-comm fix, staging.ts).
  const workdir = taskWorkdir(paths, task)
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
          // Env-fidelity fix (docs/env-fidelity-spotcheck.md): NO /tb, NO
          // /mh mount here — agent containers must not get whole-lifetime
          // read access to the task-source repo (answer keys, other tasks'
          // fixtures) or termBenchDir (results/logs/store snapshot/patches).
          // cmd-oracle.ts's OWN container keeps both mounts, unchanged — it
          // legitimately needs live access (solution/solve.sh, scripts-mode
          // setup_deps.sh) and is test-pinned. Everything an agent-container
          // pipeline step needs from either tree now arrives via `podman cp`
          // (staging.ts's stageTaskRuntime, this file's own scripts-mode
          // staging below, verifier.ts's copyTests) instead of a mount.
          mounts: [...auth.mounts],
          // Provider API key passthrough (additive to auth.json — see
          // paths.ts's apiKeyEnv doc comment), THEN the driver's own auth env
          // (task-B3-brief.md — e.g. a claude-code driver's ANTHROPIC_API_KEY
          // mounted alongside its credential files) spread last so it wins on
          // any key collision with apiKeyEnv(). opencode's own driver never
          // returns env (auth flows entirely through mounts), so this is a
          // no-op for the default driver.
          env: { ...apiKeyEnv(), ...(auth.env ?? {}) },
          network: true,
          workdir,
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
    await execFn(buildExecArgv(name, ["mkdir", "-p", "/app", "/tests", "/logs/verifier", workdir]))

    if (staging === "scripts") {
      log(`  setup_deps.sh (${task})...`)
      // Env-fidelity fix: no /tb or /mh mount on this container (see the
      // create-argv comment above), so setup_deps.sh's own inputs — itself,
      // setup_base.sh (its SCRIPT_DIR/../../setup_base.sh lookup), and the
      // task's environment/ fixtures it `cp`s from $TB_ROOT — are staged in
      // via `podman cp` under SCRIPTS_STAGE_DIR, mirroring the SAME relative
      // layout the real termBenchDir checkout has (tasks/<task>/setup_deps.sh
      // two levels under termBenchDir, so the script's own SCRIPT_DIR-
      // relative BASE_SCRIPT resolution keeps working unmodified), then
      // purged as the final step — see staging.ts's stageTaskRuntime for the
      // same stage-then-purge pattern applied to runtime-mode staging.
      const stageDir = "/.mh-stage"
      await execFn(buildExecArgv(name, ["mkdir", "-p", `${stageDir}/tasks`, `${stageDir}/${task}`]))
      const stageCopies: [string, string][] = [
        [join(paths.termBenchDir, "tasks", task), `${stageDir}/tasks/${task}`],
        [join(paths.termBenchDir, "setup_base.sh"), `${stageDir}/setup_base.sh`],
        [join(paths.tbRoot, task, "environment"), `${stageDir}/${task}/environment`],
      ]
      let stageCpFailed = false
      for (const [hostPath, containerPath] of stageCopies) {
        const cpResult = await execFn(buildCpToArgv(name, hostPath, containerPath))
        if (cpResult.rc !== 0) {
          log(`  scripts-mode staging failed: podman cp ${hostPath} -> ${containerPath}: exit ${cpResult.rc}`)
          stageCpFailed = true
          break
        }
      }
      if (stageCpFailed) return failResult("setup_failed")

      const setupResult = await execFn(
        buildExecArgv(name, ["bash", `${stageDir}/tasks/${task}/setup_deps.sh`], {
          // no SKIP_APT (Option A, 2026-07-11): podman containers have real
          // root + network, so setup_deps.sh's own SKIP_APT-guarded apt
          // section now genuinely runs (see term-bench2/Containerfile's
          // header for the retired bwrap-era apt-shim rationale).
          env: { TB_ROOT: stageDir, WORKDIR: "/app", EXTRAS_ROOT: "" },
          workdir: "/app",
        }),
      )
      if (setupResult.rc !== 0) {
        log(`  setup_deps.sh failed (exit ${setupResult.rc})`)
        return failResult("setup_failed")
      }
      // Purge the staged copy as the FINAL staging action — the agent must
      // not find a pristine copy of the task's fixtures (or termBenchDir's
      // tasks/ tree) sitting at stageDir either (env-fidelity fix). Fatal on
      // failure, matching staging.ts's stageTaskRuntime's own STAGE_DIR
      // purge: this is our own security boundary, not an upstream Dockerfile
      // line whose target might legitimately already be gone.
      const rmResult = await execFn(buildExecArgv(name, ["rm", "-rf", stageDir]))
      if (rmResult.rc !== 0) {
        log(`  scripts-mode staging: failed to remove ${stageDir}: exit ${rmResult.rc}`)
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

    // a3 routing T7: per-attempt rule-gate injection — only when THIS ARM's
    // own enforced set is non-empty (spec §3's INJECTION SYMMETRY: this
    // function has no driver opinion of its own — cmd-run.ts/cmd-ab.ts
    // already refused a non-claude-code driver upstream whenever `checks`
    // could be non-empty; a direct/unit-test caller passing `checks` with
    // another driver is untouched by that gate, so this stays keyed purely
    // on `checks.length`, matching "injection only when the set is
    // non-empty"). The generated script/settings are STRINGS, so this
    // mirrors agent-run.ts:174-178's mkdtempSync+writeFileSync+
    // buildCpToArgv pattern (review round-1 F8) — a fresh host scratch dir
    // per attempt, copied in via `podman cp`, then discarded; NEVER baked
    // into the shared bench image (P2 fresh-review Important 2). The mkdir
    // shape mirrors cmd-p2.ts's own a3 settings copy-in
    // (STOP_GATE_SETTINGS_PATH precedent) — same failure discipline too: a
    // failed mkdir/cp means this arm cannot actually be enforced, so (like
    // that precedent) the attempt fails setup_failed rather than silently
    // running unguarded.
    if (checks.length > 0) {
      const mkdirGate = await execFn(buildExecArgv(name, ["mkdir", "-p", "/app/.claude", RULE_GATE_DIR]))
      if (mkdirGate.rc !== 0) {
        log(`  rule-gate: mkdir failed: exit ${mkdirGate.rc}`)
        return failResult("setup_failed")
      }
      const scratch = mkdtempSync(join(tmpdir(), "mh-rule-gate-"))
      try {
        const settingsHost = join(scratch, "settings.json")
        const checkHost = join(scratch, "check.sh")
        writeFileSync(settingsHost, buildRuleGateSettings())
        writeFileSync(checkHost, buildRuleGateScript(checks))
        const cpSettings = await execFn(buildCpToArgv(name, settingsHost, "/app/.claude/settings.json"))
        if (cpSettings.rc !== 0) {
          log(`  rule-gate: settings.json copy-in failed: exit ${cpSettings.rc}`)
          return failResult("setup_failed")
        }
        const cpScript = await execFn(buildCpToArgv(name, checkHost, `${RULE_GATE_DIR}/check.sh`))
        if (cpScript.rc !== 0) {
          log(`  rule-gate: check.sh copy-in failed: exit ${cpScript.rc}`)
          return failResult("setup_failed")
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }

    const { turnCount, toolUsage, events, timedOut, agentElapsedSec } = await runAgent(
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

    // copyTests throws BenchError on a failed /tests reset / tests cp /
    // patches-overlay cp (see verifier.ts's rc-discipline note) — surface it
    // as an INFRA failure (setup_failed), never let it degrade to a silent
    // reward=0 (indistinguishable from a genuine task fail), and never let
    // it crash the whole multi-task invocation.
    try {
      await copyTests(paths, name, task, execFn)
    } catch (e) {
      const msg = e instanceof BenchError ? e.message : (e as Error).message
      log(`  copy-tests failed: ${msg}`)
      return failResult("setup_failed")
    }
    const reward = await runVerifier(paths, name, task, verifierTimeout, execFn, workdir)
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
    // a3 routing T7 readback: post-attempt rule-gate state.json
    // (rule-gate.ts's readRuleGateStateArgs), read while the container is
    // still up — same reason as selfScore/cgroup above (`podman rm` runs in
    // `finally`). FAIL-OPEN (task-7-brief.md note d): state.json is only
    // ever WRITTEN on a block (rule-gate.ts's buildRuleGateScript header —
    // an all-pass attempt writes nothing at all), so an rc!=0 read is the
    // COMMON case for a clean checked attempt, not a failure signal — and
    // even a genuinely unreadable/corrupt state must never reclassify an
    // attempt that already completed as dead. Both cases just omit
    // `ruleChecks` with a loud log line; nothing here can turn a pass into
    // a setup_failed.
    let ruleChecks: RunTaskResult["ruleChecks"]
    if (checks.length > 0) {
      const stateResult = await execFn(buildExecArgv(name, readRuleGateStateArgs()))
      if (stateResult.rc === 0) {
        try {
          const parsed = JSON.parse(stateResult.stdout) as {
            rounds: number
            exhausted: boolean
            perRule: Record<string, { blocked: number }>
          }
          ruleChecks = {
            rounds: parsed.rounds,
            exhausted: parsed.exhausted,
            perRule: Object.fromEntries(
              Object.entries(parsed.perRule ?? {}).map(([id, v]) => [id, { blocked: v.blocked }]),
            ),
          }
        } catch {
          log("  rule-gate: state.json unreadable (parse failure) — ruleChecks omitted (fail-open)")
        }
      } else {
        log("  rule-gate: state read rc!=0 (no block this attempt, or state unreadable) — ruleChecks omitted")
      }
    }
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
      oomKilled: (cgroup?.oomKills ?? 0) > 0,
      ...(cgroup ? { cpuSeconds: cgroup.cpuSeconds, peakRssMb: cgroup.peakRssMb } : {}),
      ...(agentElapsedSec !== undefined ? { agentElapsedSec } : {}),
      ...(ruleChecks ? { ruleChecks } : {}),
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

// ── OOM-escalation retry ──────────────────────────────────────────────────

/**
 * Run one task attempt, retrying ONCE in a fresh container at double memory iff
 * the attempt FAILED because it was OOM-killed. A killed run is infra noise, not
 * a real signal, so its result is discarded and replaced by the escalated
 * retry's. No third attempt ever; the killed attempt is never recorded (the
 * caller records only the returned `result`).
 *
 * Retry fires ONLY when ALL hold: `result.oomKilled`, the attempt failed
 * (`result.reward !== 1`), `resources !== undefined` (unenforced runs have no
 * cap to raise), and `escalateResources(resources, ceilingMb)` returns non-null
 * (there is headroom below the ceiling). Otherwise the first result + the
 * original resources are returned unchanged.
 *
 * Design notes:
 *  (a) The `reward !== 1` check exists because oomKills is CUMULATIVE over the
 *      container lifetime (cgroup.ts): the in-container agent retry loop can OOM
 *      once and still recover to a genuine PASS. We keep such a pass — only a
 *      FAILED oomKilled attempt is retried.
 *  (b) Residual accepted: a fail that is unrelated to an already-recovered
 *      internal OOM still reads as `oomKilled` (cumulative counter) and can
 *      trigger one unwarranted retry. Bounded by the single-retry cap — worst
 *      case one extra container lifecycle, never a loop.
 *  (c) The retry runs in-place inside the SAME schedule() slot that still holds
 *      the original packing weight (there is no requeue primitive), so the
 *      escalated container transiently overcommits vs. what the budget packed
 *      for. Bounded (single retry) transient overcommit, accepted — see plan
 *      risk 1b.
 *  (d) In `ab`, an OOM'd arm reruns at 2× while the other arm ran at 1× — an
 *      accepted asymmetry: OOM is infra noise, and recording the starved fail is
 *      worse for the loop signal than the transient cap difference between arms.
 */
export async function runWithOomRetry(
  attempt: (res: { cpus: number; memoryMb: number } | undefined) => Promise<RunTaskResult>,
  resources: { cpus: number; memoryMb: number } | undefined,
  ceilingMb: number | undefined,
  logPrefix: string,
): Promise<{ result: RunTaskResult; resources: typeof resources }> {
  const result = await attempt(resources)
  if (result.oomKilled && result.reward !== 1 && resources !== undefined) {
    const escalated = escalateResources(resources, ceilingMb)
    if (escalated !== null) {
      log(`  [oom] ${logPrefix}OOM-killed at ${resources.memoryMb}MB — retrying once at ${escalated.memoryMb}MB`)
      const retry = await attempt(escalated)
      return { result: retry, resources: escalated }
    }
  }
  return { result, resources }
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
  /** loosest-envelope floor — raises per-task agent time above the TB2-declared
   * budget; the load-aware scheduler compensates. The time-domain mirror of
   * --min-cpus/--min-mem-mb (tasks.ts's taskTimeouts): effective agent timeout
   * = min(max(TB2-declared, floor), --max-agent-timeout). Default undefined →
   * no floor, byte-identical to before this flag existed. */
  minAgentTimeout?: number
  /** Disable measured-informed resources: pack on declared/floored footprints
   * and skip the measured cap raise (default: measured used when a
   * trustworthy profile exists). */
  noPackMeasured?: boolean
  /** Operator assertion that the host keeps the oauth token fresh (active
   * CC/opencode sessions auto-rotate it near expiry): skip the oauth+parallel
   * freshness pre-flight and launch-guard entirely — oauth gates like
   * key-auth. The container-copy divergence risk is accepted by the operator. */
  noOauthGate?: boolean
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
  /** `--host-pressure observe|on` (plan S3): the load-aware launch gate.
   * `on` pauses NEW task launches while the host is under CPU/memory pressure
   * (width shrinks by attrition, recovers when pressure clears);
   * `observe` samples + logs pressure state changes for threshold calibration
   * but never pauses. Default (undefined) = off, byte-identical to before this
   * flag existed. Legal serial or parallel, but only the parallel path's
   * schedule() consults it (a serial run is width-1 by construction). */
  hostPressure?: "observe" | "on"
  /** Internal-only wiring — NOT a CLI flag, never parsed from argv (see
   * cli.ts's parseRunArgs). The host-pressure launch gate cli.ts's main()
   * builds (`buildPressureGate`) from `hostPressure` above and sets AFTER
   * validateParallel, threaded straight through as scheduler.ts's `schedule()`
   * `pauseGate` param below — the transient companion to `canLaunch`. Every
   * other caller (direct unit tests, or any that never sets it) leaves it
   * undefined — no pause gate, byte-identical to before this flag existed.
   * Mirrors `canLaunch`'s internal-wiring stance. */
  pressureGate?: () => boolean
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
  // Loosest-envelope floor (--min-agent-timeout): undefined when unset → no
  // floor (taskTimeouts leaves the declared timeout alone), byte-identical.
  const minAgentTimeout = args.minAgentTimeout
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
  // a3 routing T7: this run's enforced check set — the UNION of every
  // composed layer's active-or-pinned playbook's checked bullets (cmd-run's
  // single-harness degenerate case, spec §3: no arm split, so "the one
  // assembled playbook's checked bullets are the enforced set"). Reads the
  // SAME layer/pin resolution assembleAgentsMd just used above, so this can
  // never disagree with what actually got assembled. Empty when harness
  // assembly itself was skipped (--no-harness / --layers none) — there is no
  // playbook to enforce, and prose-only harnesses are unaffected either way.
  //
  // Refusal runs HERE, right after this read — BEFORE inContainerAgentVersion()
  // below — so a non-claude-code driver dies loudly before burning a
  // throwaway container (spec §3's DRIVER SCOPE rule: the opencode driver's
  // batch `opencode run` has no Stop-hook chokepoint to carry the gate).
  const runChecks: RuleGateCheck[] =
    args.noHarness || layers === "none"
      ? []
      : layerStoreRoots(layers, agent, paths.metaRoot).flatMap(([scope, root]) =>
          activeChecks(readPlaybook(root, pins[scope])),
        )
  if (runChecks.length > 0 && driver.id !== "claude-code") {
    // Finding 5 (a3 routing review): cmd-run has no "candidate"/arm split at
    // all (that's cmd-ab's concept) — this is the union of whichever
    // layers' resolved (pinned-or-active) playbooks are enforced, so name it
    // as the assembled run's own checked bullets, not a "candidate"'s.
    die(
      `run: assembled harness carries checked bullets (${runChecks.map((c) => c.bulletId).join(", ")}) — requires --driver claude-code; the opencode driver has no hook chokepoint (spec §3)`,
    )
  }
  const runChecksHash = checksHashOfList(runChecks)
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
    minAgentTimeout,
    // a3 routing T7: the real hash of `runChecks` above (a `run` composes/
    // pins MULTIPLE layers at once — unlike cmd-ab.ts's single pinned
    // layer+candidate — so this is `checksHashOfList` over the union rather
    // than `checksHashOf` of one playbook; coalesces to EMPTY_CHECKS_HASH on
    // its own when `runChecks` is empty).
    runChecksHash,
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
    capRaisedOverride: boolean,
  ): Promise<void> => {
    if (doneTasks.has(task)) {
      log(`\n${prefix}=== Task: ${task} (skipped — already done) ===`)
      return
    }
    log(`\n${prefix}=== Task: ${task} ===`)
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, maxAgentTimeout, maxVerifierTimeout, minAgentTimeout)
    // `let`: the OOM-retry wrapper carries an escalated cap forward across this
    // task's remaining k-repeats (within-invocation carry-forward, below).
    // B5: the SERIAL path (resourcesOverride undefined) applies the same
    // raise-only measured memory lift the parallel path already gets inside
    // packingFootprints (raiseCapMeasured) — without it a task whose true
    // demand exceeds its declared cap OOM-kills every serial run. The escape
    // hatch --no-pack-measured disables the raise, collapsing back to the
    // declared/floored cap. `capRaised` records (telemetry only) whether the
    // INITIAL cap was lifted above declared/floored; the parallel path computes
    // it up-front (capRaisedOverride) since its cap is raised in packingFootprints.
    let capRaised = false
    let resources: { cpus: number; memoryMb: number } | undefined
    if (resourcesOverride !== undefined) {
      resources = resourcesOverride
      capRaised = capRaisedOverride
    } else if (args.enforceResources) {
      const declared = enforcedResources(paths, task, { minCpus: args.minCpus, minMemoryMb: args.minMemMb })
      if (args.noPackMeasured) {
        resources = declared
      } else {
        resources = raiseCapMeasured(declared, readResourceProfile(paths.metaRoot, task))
        capRaised = resources.memoryMb > declared.memoryMb
      }
    } else {
      resources = undefined
    }
    // OOM-escalation ceiling: only meaningful under --parallel (each task has a
    // per-task cap packed against the budget). Derived from args/DEFAULT_BUDGET
    // — NOT the `budget` local, which is scoped inside the `if (args.parallel)`
    // branch below (out of scope here). Serial → undefined (no cap ceiling).
    const oomCeilingMb = args.parallel ? (args.memBudget ?? DEFAULT_BUDGET.memoryMb) : undefined

    taskAgg[task] = { rewards: [], elapsed: [], turns: [], errors: [], ...(selfCheckOn ? { selfScores: [] } : {}) }

    for (let ki = 0; ki < k; ki++) {
      if (k > 1) log(`${prefix}  -- run ${ki + 1}/${k} --`)

      // OOM-killed fails retry ONCE at 2× memory in a fresh container; the
      // killed attempt is discarded (never recorded below) and replaced by the
      // retry. An escalated cap carries forward to this task's later repeats.
      const { result: res, resources: nextResources } = await runWithOomRetry(
        (r) =>
          runOneTask(
            paths,
            task,
            model,
            variant,
            harnessMd,
            agentTimeout,
            verifierTimeout,
            staging,
            driver,
            r,
            undefined,
            parallelPrepareAuth,
            runChecks,
          ),
        resources,
        oomCeilingMb,
        prefix,
      )
      resources = nextResources

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
          // Per-session cap provenance (B5): the FINAL applied cap (post
          // OOM-escalation carry-forward via `resources`) + whether the initial
          // cap was measured-raised. Only meaningful under --enforce-resources
          // (in --parallel a footprint cap is applied even without it, but the
          // provenance is the enforce-mode envelope) — undefined otherwise.
          args.enforceResources ? resources?.memoryMb : undefined,
          args.enforceResources ? capRaised : undefined,
        ),
      )

      // Memorize the measured footprint so the scheduler reuses it instead of
      // re-measuring (resource-profile.ts). Independent of the prompt store
      // (noStore only gates prompt-candidate scores; a footprint is env
      // telemetry) — but only for a REAL run: turns>0 with a cgroup reading.
      // A setup-fail / auth-transient 0-turn is mostly idle wait and would skew
      // avgCpu low. Own lock (NOT nested in the store lock — AsyncMutex is
      // non-reentrant) since parallel tasks share one host-profile file.
      // Also skip any oomKilled sample: it's contaminated — a killed-and-replaced
      // attempt has skewed avgCpu + a cap-clipped peak (dominated by the clean
      // retry sample), and a kept pass whose container OOM'd-then-recovered
      // internally accumulates killed+recovery cpuSeconds with a still cap-clipped
      // peak. Neither is a faithful footprint sample.
      if (res.cpuSeconds !== undefined && res.turns > 0 && !res.oomKilled) {
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
            minAgentTimeout,
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
    // gpu-declaring task throws here (via enforcedResources, packingFootprints'
    // first step) and dies the run before any container lifecycle, matching
    // --enforce-resources' own guard. Each footprint carries TWO deliberately
    // different objects (task-6 split): `pack` = the measured-or-prior packing
    // weight the scheduler budgets against (measured once a profile is
    // trustworthy, else the declared/floored prior); `cap` = the declared/
    // floored container cgroup envelope, raised only by the measured memory lift
    // (raiseCapMeasured) — never shrunk. --no-pack-measured collapses both back
    // to the declared/floored value, byte-identical to pre-packing behavior.
    const floors = { minCpus: args.minCpus, minMemoryMb: args.minMemMb }
    const footprints = packingFootprints(paths, pending, floors, !args.noPackMeasured)
    // Whether packingFootprints' raiseCapMeasured actually lifted a task's cap
    // above declared/floored (per-session cap provenance, B5). Gated on a
    // trustworthy profile so we only re-derive declared (via enforcedResources)
    // when a raise could have fired — declared tasks never re-log, and the
    // common cold-start path skips the lookup entirely.
    const capRaisedFor = (task: string, cap: { cpus: number; memoryMb: number }): boolean => {
      if (args.noPackMeasured) return false
      const profile = readResourceProfile(paths.metaRoot, task)
      if (profile === null || profile.n < PACK_MIN_SAMPLES) return false
      return cap.memoryMb > enforcedResources(paths, task, floors).memoryMb
    }
    // Still surface the skip lines for already-done tasks (they're excluded
    // from scheduling, so the shared pipeline never logs them in this path).
    for (const t of tasks) if (doneTasks.has(t)) log(`\n=== Task: ${t} (skipped — already done) ===`)
    // items pack against `pack`; the container gets `cap`. Built explicitly
    // (not `...pack`) so PackWeight's `measured` flag never leaks into a
    // ScheduledItem.
    const items: ScheduledItem[] = pending.map((t) => {
      const f = footprints.get(t)!
      return { key: t, cpus: f.pack.cpus, memoryMb: f.pack.memoryMb }
    })
    await schedule(
      items,
      budget,
      (it) => {
        const cap = footprints.get(it.key)!.cap
        return runOneTaskPipeline(it.key, `[${it.key}] `, (fn) => mutex.withLock(fn), cap, capRaisedFor(it.key, cap))
      },
      args.canLaunch,
      // Transient host-pressure gate (plan S3). PRESSURE_POLL_SEC*1000 is
      // passed explicitly as the re-scan cadence — the scheduler's own local
      // default is deliberately decoupled from the sensor module, so this
      // threading is what keeps the re-scan aligned with the sensor's sampling.
      args.pressureGate,
      PRESSURE_POLL_SEC * 1000,
    )
  } else {
    // Serial: pass-through lock (runs fn immediately) + empty prefix →
    // byte-identical to the original inline for-loop.
    const noopLock = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn)
    for (const task of tasks) {
      // Serial path: the pipeline itself resolves the (possibly raised) cap and
      // capRaised from the task's declared footprint + measured profile.
      await runOneTaskPipeline(task, "", noopLock, undefined, false)
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
    // Two distinct metrics, labeled apart: the per-attempt tally is NOT
    // pass@k (mislabeling it once contaminated a harvest read); pass@k is
    // task-level any-of-k.
    const taskPassed = new Map<string, boolean>()
    for (const r of results) taskPassed.set(r.task, (taskPassed.get(r.task) ?? false) || r.reward === 1)
    const nTasks = taskPassed.size
    const nTasksPassed = [...taskPassed.values()].filter(Boolean).length
    const attemptPct = (100 * totalPass) / totalRuns
    const taskPct = (100 * nTasksPassed) / nTasks
    console.log(
      `attempts: ${totalPass}/${totalRuns} pass (${pyFixed(attemptPct, 1)}%) · pass@${k}: ${nTasksPassed}/${nTasks} tasks (${pyFixed(taskPct, 1)}%)`,
    )
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
      minAgentTimeout,
      timeoutRecording: recordTimeouts,
    })
    const [np, nt] = aggTotals(taskAgg)
    log(nt ? `FINAL: ${np}/${nt} passed (${pyFixed((100 * np) / nt, 1)}%)` : "FINAL: no tasks")
  }
}
