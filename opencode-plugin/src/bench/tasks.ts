/**
 * tasks.ts — task-list resolution + per-task timeouts.
 *
 * Mirrors term-bench2/runner.py's load_manifest/all_task_names (:212-220),
 * select_tasks (:1431-1446), and task_timeouts (:1449-1457), with one
 * intentional swap: timeouts are read from task.toml via `Bun.TOML.parse`
 * instead of Python's hand-rolled `read_toml_value` minimal regex reader.
 * `test/bench-toml-audit.test.ts` audits that swap against every task.toml in
 * a real terminal-bench-2 checkout — see that file for the exact
 * minimal-reader semantics ported as a comparison oracle.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { die, log, pyFixed } from "./util.ts"
import type { BenchPaths } from "./paths.ts"

// See exec.ts's header note on why Bun globals are declared locally instead
// of depending on `bun-types` (no new deps).
declare const Bun: {
  TOML: { parse(text: string): unknown }
}

interface TaskToml {
  agent?: { timeout_sec?: unknown }
  verifier?: { timeout_sec?: unknown }
}

/** `<termBenchDir>/manifest.json` — dies (BenchError) if missing/unparseable. */
export function loadManifest(paths: BenchPaths): Record<string, unknown> {
  const manifestPath = join(paths.termBenchDir, "manifest.json")
  let text: string
  try {
    text = readFileSync(manifestPath, "utf-8")
  } catch (e) {
    die(`Cannot read manifest: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch (e) {
    die(`Cannot read manifest: ${(e as Error).message}`)
  }
}

/**
 * Resolve --all / --task-file / --tasks into a manifest-validated task list,
 * in that priority order — matching Python's select_tasks resolution order
 * exactly (runner.py:1431-1446).
 */
export function selectTasks(
  paths: BenchPaths,
  opts: { all?: boolean; taskFile?: string; tasks?: string[] },
): string[] {
  const manifest = loadManifest(paths)
  let tasks: string[]
  if (opts.all) {
    tasks = Object.keys(manifest).sort()
  } else if (opts.taskFile) {
    const text = readFileSync(opts.taskFile, "utf-8")
    tasks = text
      .split(/\r?\n/)
      .map((ln) => ln.trim())
      .filter((ln) => ln.length > 0 && !ln.startsWith("#"))
  } else if (opts.tasks && opts.tasks.length > 0) {
    tasks = opts.tasks
  } else {
    die("Specify --tasks TASK [TASK...], --task-file PATH, or --all")
  }
  for (const t of tasks) {
    if (!(t in manifest)) {
      die(`Unknown task: '${t}'. Check manifest.json.`)
    }
  }
  return tasks
}

/**
 * (agentTimeout, verifierTimeout) from `<tbRoot>/<task>/task.toml`, defaults
 * 900/300 when the file is missing, unparseable, or the key is absent —
 * matching Python's `read_toml_value(...) or <default>` falsy-fallback
 * (runner.py:1452,1456), including the edge case of an explicit `0` value
 * also falling back to the default (rare, but that's Python's behavior too).
 * When maxAgentTimeout is truthy and agentTimeout exceeds it, the agent
 * timeout is capped and a Python-parity log line is emitted
 * (runner.py:1454).
 */
export function taskTimeouts(
  paths: BenchPaths,
  task: string,
  maxAgentTimeout: number,
): { agentTimeout: number; verifierTimeout: number } {
  const tomlPath = join(paths.tbRoot, task, "task.toml")
  let doc: TaskToml | undefined
  if (existsSync(tomlPath)) {
    try {
      doc = Bun.TOML.parse(readFileSync(tomlPath, "utf-8")) as TaskToml
    } catch {
      doc = undefined
    }
  }
  const agentRaw = doc?.agent?.timeout_sec
  const verifierRaw = doc?.verifier?.timeout_sec
  let agentTimeout = typeof agentRaw === "number" && agentRaw ? agentRaw : 900
  const verifierTimeout = typeof verifierRaw === "number" && verifierRaw ? verifierRaw : 300

  if (maxAgentTimeout && agentTimeout > maxAgentTimeout) {
    log(`  capping agent timeout ${pyFixed(agentTimeout, 0)}s → ${pyFixed(maxAgentTimeout, 0)}s`)
    agentTimeout = maxAgentTimeout
  }
  return { agentTimeout, verifierTimeout }
}
