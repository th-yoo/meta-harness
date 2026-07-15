/**
 * cmd-task-load.ts — `task-load` subcommand: read-only inspection of each
 * selected task's declared resource footprint, its agent/verifier timeouts,
 * and (optionally) its historical mean elapsed time — plus a preview of how
 * `schedule()` (scheduler.ts, spec D3) would co-run these tasks under a
 * budget. No podman work: this never touches a container, so it's safe to
 * run at any time, including before `prep --apply`.
 *
 * The packing preview reuses `packPreview` (scheduler.ts) — the SAME fit
 * rule `schedule()` runs against at execution time — rather than
 * re-implementing the greedy walk here, so the preview and the real
 * `--parallel` packing can't drift apart.
 */
import { readFileSync } from "node:fs"
import type { BenchPaths } from "./paths.ts"
import { selectTasks, taskResources, taskTimeouts } from "./tasks.ts"
import { packPreview, DEFAULT_BUDGET, type Budget, type ScheduledItem } from "./scheduler.ts"
import { log, pyFixed } from "./util.ts"

export interface CmdTaskLoadArgs {
  tasks?: string[]
  taskFile?: string
  all?: boolean
  /** A run/ab results file (results.ts's schema) — when given, its
   * `tasks[t].elapsed` arrays feed a MeanElapsed column. Any read/parse
   * failure degrades to "no data" (every row shows the placeholder), never
   * throws — this is a read-only inspection command. */
  resultsFile?: string
  /** Budget the co-run-groups preview packs against. Defaults to
   * DEFAULT_BUDGET (scheduler.ts) — the same default `run --parallel` uses. */
  cpuBudget?: number
  memBudget?: number
}

const NO_DATA = "-"

/** Mean of `tasks[t].elapsed` per task from a results-file JSON blob.
 * Missing file / bad JSON / no `tasks` object → empty map (every task shows
 * the placeholder) rather than throwing. */
function readMeanElapsed(resultsFile: string): Map<string, number> {
  const means = new Map<string, number>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(resultsFile, "utf-8"))
  } catch (e) {
    log(`  --results-file: could not read/parse '${resultsFile}' (${(e as Error).message}) — MeanElapsed will show '${NO_DATA}'`)
    return means
  }
  const tasksObj = (raw as { tasks?: Record<string, { elapsed?: unknown }> } | null)?.tasks
  if (!tasksObj || typeof tasksObj !== "object") return means
  for (const [t, agg] of Object.entries(tasksObj)) {
    const elapsed = Array.isArray(agg?.elapsed) ? (agg.elapsed as unknown[]).filter((x): x is number => typeof x === "number") : []
    if (elapsed.length > 0) means.set(t, elapsed.reduce((a, b) => a + b, 0) / elapsed.length)
  }
  return means
}

export function cmdTaskLoad(paths: BenchPaths, args: CmdTaskLoadArgs): void {
  const tasks = args.all
    ? selectTasks(paths, { all: true })
    : args.taskFile
      ? selectTasks(paths, { taskFile: args.taskFile })
      : selectTasks(paths, { tasks: args.tasks })

  const budget: Budget = {
    cpus: args.cpuBudget ?? DEFAULT_BUDGET.cpus,
    memoryMb: args.memBudget ?? DEFAULT_BUDGET.memoryMb,
  }

  const meanElapsed = args.resultsFile ? readMeanElapsed(args.resultsFile) : undefined

  const rows = tasks.map((t) => {
    const res = taskResources(paths, t)
    // maxAgentTimeout/maxVerifierTimeout=0 (falsy) → report the RAW declared
    // timeouts, uncapped — task-load is an inspection command, not a run,
    // so there is no --max-agent-timeout in scope to cap against.
    const { agentTimeout, verifierTimeout } = taskTimeouts(paths, t, 0, 0)
    return { task: t, ...res, agentTimeout, verifierTimeout }
  })

  console.log(`task-load: ${tasks.length} task(s), budget cpu=${budget.cpus} mem=${budget.memoryMb}MB`)
  console.log()

  const headerCells = ["Task".padEnd(40), "CPU".padStart(4), "MemMB".padStart(7), "Decl".padStart(5), "AgentTO".padStart(8), "VerifTO".padStart(8)]
  if (meanElapsed) headerCells.push("MeanElapsed".padStart(12))
  const header = headerCells.join("  ")
  console.log(header)
  console.log("-".repeat(header.length))

  for (const r of rows) {
    const cells = [
      r.task.slice(0, 39).padEnd(40),
      String(r.cpus).padStart(4),
      String(r.memoryMb).padStart(7),
      (r.declared ? "yes" : "no").padStart(5),
      String(r.agentTimeout).padStart(8),
      String(r.verifierTimeout).padStart(8),
    ]
    if (meanElapsed) {
      const m = meanElapsed.get(r.task)
      cells.push((m !== undefined ? pyFixed(m, 1) : NO_DATA).padStart(12))
    }
    console.log(cells.join("  "))
  }
  console.log("-".repeat(header.length))
  console.log()

  const items: ScheduledItem[] = rows.map((r) => ({ key: r.task, cpus: r.cpus, memoryMb: r.memoryMb }))
  const groups = packPreview(items, budget)
  console.log(`co-run groups (preview — see packPreview's doc comment for its wave-model caveat):`)
  if (groups.length === 0) {
    console.log("  (no tasks)")
  } else {
    for (const g of groups) console.log(`  [${g.join(", ")}]`)
  }
}
