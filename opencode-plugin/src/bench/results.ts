/**
 * results.ts — shared run-results / --resume plumbing, factored out for
 * reuse by cmd-run/cmd-ab (P6). Mirrors term-bench2/runner.py's per-task
 * results-file bookkeeping used by cmd_run/cmd_ab:
 *   - the run-results JSON shape written at runner.py:1623 (incremental,
 *     status "in_progress") and :1659 (final, status "complete") —
 *     {label, model, variant, harness, k, timestamp, n_pass, n_total,
 *      pass_rate, tasks: {task: {rewards, elapsed, turns, errors}}, status}.
 *   - `_agg_totals` (runner.py:1417).
 *   - the --resume carry-forward block (runner.py:1558-1568).
 * `resumeIdentCheck` is re-exported from splits.ts as the single import
 * point cmd-run/cmd-ab need for both split-composition and resume-carry
 * concerns.
 *
 * cmd-oracle.ts's writer (a different, simpler schema: no model/variant/
 * harness/k, per-task {reward, elapsed, error} not {rewards[], elapsed[],
 * turns[], errors[]}) is untouched — this module is exclusively the
 * run/ab-results schema.
 */
import { existsSync, readFileSync } from "node:fs"
import { BenchError, die, log, writeJsonAtomic } from "./util.ts"

export { resumeIdentCheck } from "./splits.ts"

/** Per-task aggregate across k repeats — runner.py's `task_agg[task]` entry. */
export interface TaskAgg {
  rewards: number[]
  elapsed: number[]
  turns: number[]
  errors: string[]
  /** Phase-0 self-check (best-of-k): per-attempt agent self-reported
   * passed/total fraction, parallel to `rewards`. Absent unless --self-check
   * (keeps normal-run results.json byte-identical). null = agent wrote no/
   * invalid score.txt for that attempt. */
  selfScores?: (number | null)[]
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

/** Return [nPass, nTotal] over tasks that have results (pass@k = any reward==1). */
export function aggTotals(taskAgg: Record<string, TaskAgg>): [number, number] {
  let nTotal = 0
  let nPass = 0
  for (const agg of Object.values(taskAgg)) {
    const rewards = agg.rewards ?? []
    if (rewards.length === 0) continue
    nTotal += 1
    if (Math.max(...rewards) === 1) nPass += 1
  }
  return [nPass, nTotal]
}

export interface ResumeCarryForward {
  taskAgg: Record<string, TaskAgg>
  doneTasks: Set<string>
}

/**
 * --resume: carry over already-completed tasks from an existing results
 * file so a restarted baseline doesn't re-run them. A task counts as "done"
 * iff its carried-forward `rewards` array is non-empty (mirrors Python's
 * `if agg.get("rewards")`). Any read/parse failure degrades to "start
 * fresh" (empty taskAgg/doneTasks) with a log line, never throws.
 *
 * `expectedDriver` guards against forged provenance (final whole-branch
 * review): the FINAL `writeRunResults` call stamps the CURRENT driver id
 * (results.ts's `driver` field), so blindly carrying forward tasks from a
 * prior results file produced by a DIFFERENT driver would silently claim
 * those tasks were run by `expectedDriver` when they weren't. A prior file
 * with a `driver` field that disagrees with `expectedDriver` is a hard die
 * (never silently degrades — this is a correctness/provenance bug, not a
 * missing/corrupt file). A prior file with NO `driver` field at all is a
 * legacy pre-driver-abstraction results file (drivers didn't exist yet, so
 * there is nothing to mismatch) — that case only warns and proceeds.
 *
 * `expectedResourceEnforcement` (task-3-brief.md) is the same class of guard
 * for the --enforce-resources regime: a prior file's `resourceEnforcement`
 * (absent == false, pre-feature files never had this key) is compared
 * against the CURRENT run's flag via a coalescing `?? false` — mismatched
 * regimes (e.g. resuming an unconstrained partial run under enforcement, or
 * vice versa) is a hard die, since mixing rewards measured under different
 * resource ceilings in one results file would silently corrupt the
 * aggregate. Unlike the driver guard above, there is no "legacy warn and
 * proceed" case here: false is a real, meaningful value (not "unknown"), so
 * an absent key coalesces to false and is compared exactly like a present
 * `false`.
 */
export function resumeCarryForward(
  resultsFile: string | undefined,
  resume: boolean,
  expectedDriver: string,
  expectedResourceEnforcement = false,
): ResumeCarryForward {
  const taskAgg: Record<string, TaskAgg> = {}
  const doneTasks = new Set<string>()
  if (resume && resultsFile && existsSync(resultsFile)) {
    try {
      const prev = JSON.parse(readFileSync(resultsFile, "utf-8")) as {
        tasks?: Record<string, TaskAgg>
        driver?: string
        resourceEnforcement?: boolean
      }
      if (prev.driver !== undefined && prev.driver !== expectedDriver) {
        die(
          `--resume: ${resultsFile} was produced by driver "${prev.driver}", but this run is using ` +
            `driver "${expectedDriver}" — refusing to carry its tasks forward (that would forge ` +
            `provenance). Use a per-driver --results-file, or re-run with --driver ${prev.driver}.`,
        )
      }
      if (prev.driver === undefined) {
        log(`  --resume: prior results file has no driver field (legacy, pre-driver) — assuming it matches, proceeding`)
      }
      const prevEnforce = prev.resourceEnforcement ?? false
      if (prevEnforce !== expectedResourceEnforcement) {
        die(
          `--resume: ${resultsFile} was produced with resourceEnforcement=${prevEnforce}, this run uses ` +
            `${expectedResourceEnforcement} — refusing to mix measurement regimes in one results file.`,
        )
      }
      for (const [t, agg] of Object.entries(prev.tasks ?? {})) {
        if (agg.rewards && agg.rewards.length > 0) {
          taskAgg[t] = agg
          doneTasks.add(t)
        }
      }
      if (doneTasks.size > 0) {
        log(`Resuming: ${doneTasks.size} task(s) already done, will skip them`)
      }
    } catch (e) {
      if (e instanceof BenchError) throw e
      log(`  --resume: could not read prior results (${(e as Error).message}); starting fresh`)
    }
  }
  return { taskAgg, doneTasks }
}

export interface RunResultsMeta {
  label: string
  model: string
  variant: string
  harness: unknown
  k: number
  timestamp: string
  taskAgg: Record<string, TaskAgg>
  status: "in_progress" | "complete"
  /** Driver-id provenance (task-B3-brief.md) — which AgentDriver produced
   * these results (drivers/index.ts's DRIVER_IDS). */
  driver: string
  /** Resource-enforcement provenance (task-3-brief.md). Callers pass
   * `args.enforceResources || undefined` — i.e. OMITTED (not `false`) when
   * the flag is off, so a flag-off results file's JSON shape is byte-
   * identical to every pre-feature file. `resumeCarryForward` reads it back
   * via a `?? false` coalesce, so an absent key and an explicit `false`
   * mean the same thing on the read side. */
  resourceEnforcement?: boolean
  /** Budget-identity provenance (Loop-3 T6) — the wall-clock agent-phase
   * budget this run used (args.maxAgentTimeout ?? 0), mirroring the same
   * field cmd-ab.ts stamps into ab-verdict.json. Always present (unlike
   * resourceEnforcement above) — every call site already has a concrete
   * number in scope, so there is no "omit when off" case to preserve. */
  maxAgentTimeout: number
  /** Loosest-envelope agent-timeout FLOOR (--min-agent-timeout) this run used.
   * OMITTED (not 0) when no floor — mirrors resourceEnforcement's "omit when
   * off" so a flag-off results file is byte-identical to every pre-feature
   * file (JSON.stringify drops the undefined key). */
  minAgentTimeout?: number
  /** Whether a wall-clock agent-phase timeout was recorded as a genuine
   * stored fail for this run (Loop-3 T3's recordTimeouts flag). Always
   * present, same rationale as maxAgentTimeout above. */
  timeoutRecording: boolean
}

/**
 * Write the run/ab-results JSON (runner.py:1623/1659 shape), atomically.
 * n_pass/n_total/pass_rate are computed from taskAgg via aggTotals, not
 * passed in — a single source of truth so incremental and final writes
 * can't drift.
 */
export function writeRunResults(resultsFile: string, meta: RunResultsMeta): void {
  const [nPass, nTotal] = aggTotals(meta.taskAgg)
  writeJsonAtomic(resultsFile, {
    label: meta.label,
    model: meta.model,
    variant: meta.variant,
    harness: meta.harness,
    k: meta.k,
    timestamp: meta.timestamp,
    n_pass: nPass,
    n_total: nTotal,
    pass_rate: nTotal ? round4(nPass / nTotal) : 0.0,
    tasks: meta.taskAgg,
    status: meta.status,
    driver: meta.driver,
    resourceEnforcement: meta.resourceEnforcement,
    maxAgentTimeout: meta.maxAgentTimeout,
    minAgentTimeout: meta.minAgentTimeout,
    timeoutRecording: meta.timeoutRecording,
  })
  log(`Results written → ${resultsFile}`)
}
