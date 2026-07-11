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
import { log, writeJsonAtomic } from "./util.ts"

export { resumeIdentCheck } from "./splits.ts"

/** Per-task aggregate across k repeats — runner.py's `task_agg[task]` entry. */
export interface TaskAgg {
  rewards: number[]
  elapsed: number[]
  turns: number[]
  errors: string[]
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
 */
export function resumeCarryForward(resultsFile: string | undefined, resume: boolean): ResumeCarryForward {
  const taskAgg: Record<string, TaskAgg> = {}
  const doneTasks = new Set<string>()
  if (resume && resultsFile && existsSync(resultsFile)) {
    try {
      const prev = JSON.parse(readFileSync(resultsFile, "utf-8")) as { tasks?: Record<string, TaskAgg> }
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
  })
  log(`Results written → ${resultsFile}`)
}
