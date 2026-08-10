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
 * `{arm, ruleSha, compliant, reprompted, reviewFailed, error, judgeComplied,
 * rulePreReview}` for every
 * attempt (unlike cmd-run.ts's sparse use of `errors`, which only pushes
 * "setup_failed" and otherwise leaves it unpushed — p2-run pushes exactly
 * one entry per attempt, keeping `errors.length === rewards.length`
 * strictly, so Task 5's tally can zip the two arrays 1:1). F2 holds for the
 * results file: only counts/booleans/a content-hash/an error-classification
 * string, never transcript or finding text.
 *
 * PRE-DATA AMENDMENT 2026-08-08 — judge-audit logging. `judgeComplied` (the
 * a4 judge's verdict) and `rulePreReview` (`isCompliant` on the SAME
 * evidence, pre-re-pass) join the annotation; both are booleans, F2
 * unaffected. Scope, stated precisely:
 *  - `judgeComplied` is DERIVABLE from (reprompted, reviewFailed) — it is
 *    recorded to be explicit rather than reconstructed, not because it is
 *    new information.
 *  - `rulePreReview` IS new, and only in the re-pass branch: once a re-pass
 *    fires, `compliant` becomes the POST-re-pass verdict and the pre-review
 *    value was previously overwritten. Without it a DESERVED re-pass and a
 *    SPURIOUS one (the judge flagging work the rule accepted, spending up
 *    to A4_TURN_CAP turns) are indistinguishable — and a4's cost model is
 *    entirely "one bounded re-pass per attempt".
 *
 * These two do NOT establish that the judge is right. `isCompliant` is a
 * mechanical proxy (>=8-char substring overlap) with failure modes in both
 * directions — it was already fooled once, hence the 2026-08-06 anti-gaming
 * amendment. Judge-vs-rule is therefore agreement between two fallible
 * proxies, not judge accuracy.
 *
 * The evidence SIDECAR (`judgeEvidencePath`) is what makes judge accuracy
 * answerable AT ALL: re-judging the retained evidence with a stronger tier
 * across the full set, then human adjudication only where the tiers
 * disagree. A hash cannot be replayed, so nothing weaker substitutes. It is
 * the F2 exception (bounded evidence struct: DONE-CHECK content,
 * bash-command list, workspace file names) — agent-authored container
 * output, explicitly not a transcript (a4-review.ts: "The reviewer sees
 * only this bounded evidence, never the whole transcript") and not finding
 * text, written ONLY for a4, only under docs/loop-probes/p2/, never
 * entering term-bench2/store/**. See the plan's amendment block; it needs a
 * user ruling.
 */
import { dirname, join, resolve, sep } from "node:path"
import { podman, withTimeout } from "../exec.ts"
import type { ExecFn } from "../staging.ts"
import { stageTaskRuntime } from "../staging.ts"
import { buildCreateArgv, buildStartArgv, buildExecArgv, buildCpToArgv, buildRmArgv } from "../sandbox.ts"
import { appendFileSync } from "node:fs"
import { BENCH_IMAGE, DEFAULT_BENCH_MODEL, apiKeyEnv, containerName, type BenchPaths } from "../paths.ts"
import { selectTasks, taskTimeouts } from "../tasks.ts"
import { copyTests, runVerifier } from "../verifier.ts"
import { runAgent, defaultSleep, type SleepFn } from "../agent-run.ts"
import type { AgentAuthMounts } from "../agent-auth.ts"
import { assembleAgentsMd, harnessMeta } from "../record.ts"
import { writeRunResults, type TaskAgg } from "../results.ts"
import { claudeCodeDriver } from "../drivers/claude-code.ts"
import type { AgentDriver } from "../drivers/types.ts"
import type { TrajEvent } from "../../harness-store.ts"
import { BenchError, die, log, pyFixed, writeTextAtomic } from "../util.ts"
import { P2_RULE_TEXT, ruleSha, isCompliant, bashCommandsFromEvents } from "./rule.ts"
import {
  runA4Review,
  buildReinjectInstruction,
  isA4ReviewTruncated,
  A4_TURN_CAP,
  type A4Evidence,
} from "./a4-review.ts"

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
   * something other than a parsed A4ReviewResult) — no re-pass fires in
   * that case (brief bullet 2's a4 spec). Always false for a1/a3. */
  reviewFailed: boolean
  /** PRE-DATA AMENDMENT 2026-08-08 — judge-vs-rule logging. The a4 judge's
   * verdict as returned by `runReview`: `null` when no judge ran (a1/a3) or
   * the call failed. NOT the same construct as `compliant`, which is the
   * deterministic `isCompliant` rule — the judge only gates the re-pass. */
  judgeComplied: boolean | null
  /** The rule verdict on `evidence1` — the SAME evidence the judge saw,
   * evaluated BEFORE any re-pass. `null` for a1/a3. Distinct from
   * `compliant`, which for a fired re-pass is the POST-re-pass verdict; in
   * that branch the pre-review value is otherwise discarded, which is
   * exactly the branch the 2x2 needs. */
  rulePreReview: boolean | null
  /** The bounded evidence handed to the judge, retained so a stronger judge
   * tier can be scored against the same inputs offline — zero containers,
   * zero re-runs. `undefined` for a1/a3. Never written to the results
   * `errors[]` label (see `attemptLabel`); the sidecar carries it. */
  judgeEvidence: A4Evidence | undefined
  /** True iff `reviewFailed` was specifically a truncation
   * (`runA4Review`/`isA4ReviewTruncated` — a4-review.ts's header,
   * surface-truncation v0.5.0): the api lane's fixed maxTokens cap cut the
   * reviewer's own reply off (`stopReason === "max_tokens"`), never a
   * proxy for "the model returned junk". Always implies `reviewFailed`;
   * always false for a1/a3 and whenever `reviewFailed` is false. Recorded
   * distinctly so P2's results don't fold an instrumentation failure into
   * a real one — see a4-review.ts's header for why that matters for a
   * carrier comparison. */
  reviewTruncated: boolean
  /** Silent-done hardening (P2 launches 0-2, minimal/HISTORY.md): true iff
   * a4's fired re-pass exec itself hard-failed — timed out, or classified
   * auth/transient (which since the same hardening includes rc!=0 with an
   * EMPTY stdout). The compliance verdict still reads the FINAL container
   * state (a dead re-pass leaves pass-1 state, so `compliant` degrades to
   * the pass-1 verdict naturally) — this flag keeps that row from being
   * read as "the re-pass ran and changed nothing". Always false for a1/a3
   * and for unfired re-passes. */
  rePassHardFail: boolean
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
  prepareAuthFn?: () => AgentAuthMounts,
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
  prepareAuthFn: () => AgentAuthMounts = () => driver.prepareAuth(),
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
    judgeComplied: null,
    rulePreReview: null,
    judgeEvidence: undefined,
    reviewTruncated: false,
    rePassHardFail: false,
  })

  // Driver auth material (2026-08-09, post-first-launch fix): prepared fresh
  // per container lifecycle and torn down in the outer `finally` below,
  // exactly cmd-run.ts's runTaskOnce pattern. The original `mounts: []` +
  // `apiKeyEnv()` create dropped everything prepareAuth() provides — oauth
  // credential mounts, the onboarding claude.json, and IS_SANDBOX=1, without
  // which the CC CLI refuses --dangerously-skip-permissions as root and
  // exits rc=1 with an EMPTY stdout that classifyAttempt can only read as
  // "done" (turns=0) — which silently burned the entire first a1 arm as
  // `agent_no_output`. A missing-credential BenchError from prepareAuth()
  // is caught by the same bring-up catch as create/start failures
  // (fail-fast setup_failed, no container work).
  let auth: AgentAuthMounts | undefined
  try {
    try {
      auth = prepareAuthFn()
      const createResult = await execFn(
        buildCreateArgv({
          image: BENCH_IMAGE,
          name,
          // No /tb or /mh mount (env-fidelity fix, mirrors cmd-run.ts's own
          // agent containers) — everything an attempt needs arrives via
          // `podman cp` (stageTaskRuntime, the a3 settings copy-in below,
          // verifier.ts's copyTests). The ONLY mounts are the driver's own
          // auth mounts (credentials + onboarding file).
          mounts: [...auth.mounts],
          // apiKeyEnv() passthrough first, the driver's auth env spread last
          // so it wins on collision (cmd-run.ts:237 precedent).
          env: { ...apiKeyEnv(), ...(auth.env ?? {}) },
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
    // PRE-DATA AMENDMENT 2026-08-08 (judge-vs-rule logging): null until an
    // a4 judge actually runs.
    let judgeComplied: boolean | null = null
    let rulePreReview: boolean | null = null
    let judgeEvidence: A4Evidence | undefined
    let reviewTruncated = false
    let rePassHardFail = false

    if (arm === "a4") {
      const evidence1 = await gatherEvidence(name, output.events, execFn)
      judgeEvidence = evidence1
      // Evaluated ONCE, before the branch, so the re-pass path records the
      // pre-review verdict instead of silently dropping it.
      rulePreReview = isCompliant(evidence1.doneCheck, evidence1.bashCommands)
      const review = await runReview(evidence1, env)
      // A TRUNCATED reply carries no usable verdict — A4ReviewTruncated has
      // no `complied` at all — so it records null exactly like the
      // undefined failure. Recording a verdict parsed from a cut-off reply
      // would put a fabricated row in the judge-vs-rule table.
      judgeComplied = review === undefined || isA4ReviewTruncated(review) ? null : review.complied
      if (review === undefined) {
        reviewFailed = true
        compliant = rulePreReview
      } else if (isA4ReviewTruncated(review)) {
        // The reviewer's own reply was cut off by the api lane's maxTokens
        // cap (a4-review.ts's header) — this is STILL a review failure (no
        // re-pass fires, same as the undefined branch), but recorded
        // distinctly so it doesn't get folded into "the model returned
        // junk" when P2's results are read.
        reviewFailed = true
        reviewTruncated = true
        compliant = rulePreReview
      } else if (review.complied) {
        compliant = rulePreReview
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
        // Silent-done hardening: the original code read rePassResult.stdout
        // and NOTHING else — a re-pass that died before producing anything
        // (rc!=0/empty stdout, timeout) parsed to zero events and its
        // silence was laundered into the compliance verdict. Classify it
        // like any attempt and record the death loudly.
        const rePassClass = rePassResult.timedOut ? "transient" : driver.classifyAttempt(rePassResult)
        if (rePassClass !== "done") {
          rePassHardFail = true
          log(`  [a4] re-pass HARD-FAILED (${rePassResult.timedOut ? "timeout" : rePassClass}, rc=${rePassResult.rc}) — compliance falls back to final container state`)
        }
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
      return {
        ...fail("setup_failed"),
        compliant,
        reprompted,
        reviewFailed,
        reviewTruncated,
        rePassHardFail,
        judgeComplied,
        rulePreReview,
        judgeEvidence,
      }
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
      reviewTruncated,
      rePassHardFail,
      judgeComplied,
      rulePreReview,
      judgeEvidence,
    }
  } finally {
    // rm guarded in its own try/finally (cmd-run.ts:380-389 precedent):
    // Bun.spawn throws synchronously on a missing binary, and a teardown
    // throw must never skip the credential shred below.
    try {
      await execFn(buildRmArgv(name))
    } finally {
      // Auth teardown last (cmd-run.ts precedent): shreds the exported
      // credential copy + removes the temp dir; must run whether the
      // attempt succeeded, failed, or threw — and even when prepareAuth
      // succeeded but create/start/rm did not.
      try {
        auth?.cleanup()
      } catch {
        // best-effort — teardown failure must never mask the attempt result.
      }
    }
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
 * reuse). JSON so Task 5's tally can parse it without a bespoke format.
 * `reviewTruncated` (surface-truncation v0.5.0, a4-review.ts's header) is
 * an ADDITIVE field alongside the original four — any existing reader
 * that only checks `compliant`/`reprompted`/`reviewFailed`/`error` (e.g.
 * scripts/p2-tally.ts's `parseAttemptAnnotation`, which validates via a
 * `typeof` check on each of exactly those four keys) is unaffected by an
 * extra key it doesn't look for. */
function attemptLabel(
  arm: P2Arm,
  result: Pick<
    P2AttemptResult,
    | "compliant"
    | "reprompted"
    | "reviewFailed"
    | "reviewTruncated"
    | "rePassHardFail"
    | "error"
    | "judgeComplied"
    | "rulePreReview"
  >,
): string {
  return JSON.stringify({
    arm,
    ruleSha: ruleSha(),
    compliant: result.compliant,
    reprompted: result.reprompted,
    reviewFailed: result.reviewFailed,
    reviewTruncated: result.reviewTruncated,
    rePassHardFail: result.rePassHardFail,
    error: result.error,
    // PRE-DATA AMENDMENT 2026-08-08 — judge-vs-rule 2x2. Verdicts only; the
    // evidence rides the sidecar so errors[] stays a compact annotation.
    judgeComplied: result.judgeComplied,
    rulePreReview: result.rulePreReview,
  })
}

/** PRE-DATA AMENDMENT 2026-08-08 — sidecar beside the arm's results file
 * holding, per a4 attempt, the bounded evidence the judge saw plus both
 * verdicts. Exists so a stronger judge tier can be scored against identical
 * inputs offline: zero containers, zero re-runs. Written ONLY when a judge
 * actually ran (a4); a1/a3 produce no file.
 *
 * DEFECT FIX: `resolveP2ResultsFile` only enforces that `--results-file`
 * resolves UNDER `docs/loop-probes/p2/`, never that it ends in
 * `-results.json`. The old code did `resultsFile.replace(/-results\.json$/,
 * ...)` unconditionally — on a non-conforming name the regex simply doesn't
 * match, `.replace()` no-ops, and this function silently returns the
 * RESULTS file's own path. Every "sidecar" write then lands inside the
 * results JSON instead, and the next `writeRunResults` (atomic temp+rename,
 * full overwrite) destroys it — total, silent evidence loss with no error
 * anywhere. Fail loudly instead, naming the offending path, matching this
 * file's other `die()` fences (`resolveP2ResultsFile`, the `--go`/`--arm`/
 * `--k` checks in `cmdP2` below). */
export function judgeEvidencePath(resultsFile: string): string {
  const sidecar = resultsFile.replace(/-results\.json$/, "-judge-evidence.ndjson")
  if (sidecar === resultsFile) {
    die(
      `p2-run: --results-file "${resultsFile}" does not end in "-results.json" — cannot derive the judge-` +
        `evidence sidecar path safely from it. Left as-is, evidence rows would silently land inside the ` +
        `results file itself and be destroyed by the next atomic overwrite. Use the documented convention: ` +
        `<hostname>-p2-<arm>-results.json.`,
    )
  }
  return sidecar
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

  // DEFECT FIX (sidecar lifecycle): the results file is fully OVERWRITTEN
  // every run (writeRunResults -> writeJsonAtomic's temp+rename), and there
  // is no `--resume` — cmdP2 always starts `taskAgg` empty. So re-running
  // against the same `--results-file` after a crash yields a clean, correct
  // results.json. The evidence sidecar did NOT get that treatment: it was
  // opened with `appendFileSync` and never reset, so a killed-and-restarted
  // invocation against the SAME `--results-file` would silently interleave
  // stale rows from the aborted run with the new run's rows, with no run-id
  // to tell them apart. READINESS.md documents a FIXED per-host/per-arm
  // filename and estimates a4 at up to ~7.8h serial wall-clock, so an
  // operator restart against that same name is the expected case, not an
  // exotic one. Truncate the sidecar fresh here, once, before any attempt
  // runs — mirroring the results file's own overwrite semantics rather than
  // stamping a run-id, since the sidecar's field schema is a pending-ruling
  // F2 exception this fix must not widen.
  //
  // Scoped to a4 ONLY: only a4 attempts ever produce judge evidence
  // (`result.judgeEvidence !== undefined` below is a4-exclusive), so a1/a3
  // never write this file at all today. An UNCONDITIONAL truncate-at-start
  // would create a stray empty `-judge-evidence.ndjson` file for every a1/a3
  // run — an artifact that never existed before this fix, for arms that
  // have no evidence to reset. Gating on `arm === "a4"` keeps that absence
  // intact. `judgeEvidencePath` also fails loudly here (see its own doc
  // comment) on a non-conforming `--results-file`, so that failure now
  // surfaces BEFORE any container work, like every other cmdP2 fence.
  if (arm === "a4") {
    writeTextAtomic(judgeEvidencePath(resultsFile), "")
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
      // PRE-DATA AMENDMENT 2026-08-08 — append-per-attempt so a killed run
      // still leaves every completed attempt's evidence on disk (same
      // durability reasoning as `flush("in_progress")` directly below). The
      // sidecar file itself was already truncated fresh above (a4-only), so
      // no per-attempt mkdir is needed here.
      if (result.judgeEvidence !== undefined) {
        const sidecar = judgeEvidencePath(resultsFile)
        appendFileSync(
          sidecar,
          JSON.stringify({
            arm,
            task,
            k: ki,
            ruleSha: ruleSha(),
            judgeComplied: result.judgeComplied,
            rulePreReview: result.rulePreReview,
            reprompted: result.reprompted,
            reviewFailed: result.reviewFailed,
            // DEFECT FIX: the committed results file carries both
            // `judgeComplied` and `reviewTruncated` (attemptLabel above), so
            // a reader can tell "the judge said no" from "the judge's own
            // reply was cut off mid-object by the api lane's token cap". The
            // sidecar carried `reviewFailed` but not this distinction, so a
            // consumer treating the sidecar as self-contained (its stated
            // purpose — offline re-judging without the results file) lost
            // it. Boolean, so it stays inside F2's letter.
            reviewTruncated: result.reviewTruncated,
            rePassHardFail: result.rePassHardFail,
            evidence: result.judgeEvidence,
          }) + "\n",
        )
      }
      flush("in_progress")
    }
  }

  flush("complete")
  log(`\nP2 ${arm}: done — results at ${resultsFile}`)
}
