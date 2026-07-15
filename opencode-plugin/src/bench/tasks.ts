/**
 * tasks.ts — task-list resolution + per-task timeouts.
 *
 * Mirrors term-bench2/runner.py's load_manifest/all_task_names (:212-220),
 * select_tasks (:1431-1446), and task_timeouts (:1449-1457), with two
 * intentional swaps:
 *  - timeouts are read from task.toml via `Bun.TOML.parse` instead of
 *    Python's hand-rolled `read_toml_value` minimal regex reader.
 *    `test/bench-toml-audit.test.ts` audits that swap against every
 *    task.toml in a real terminal-bench-2 checkout — see that file for the
 *    exact minimal-reader semantics ported as a comparison oracle.
 *  - `selectTasks`'s validity check no longer consults manifest.json (which
 *    only ever covered the 59 non-excluded tasks gen_setup_deps.py
 *    generated scripts for — see term-bench2/gen_setup_deps.py's
 *    EXCLUDED_TASKS). Now that P4's runtime staging (staging.ts) parses
 *    Dockerfiles straight from tbRoot with no vendored per-task script, a
 *    task is valid iff `<tbRoot>/<task>/task.toml` exists — all 91 upstream
 *    tasks become addressable, not just the 59 the generator covered.
 *    `loadManifest` stays exported (other callers may still want the
 *    generator's aggregated metadata later) but selectTasks no longer calls it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BenchError, die, log, pyFixed } from "./util.ts"
import type { BenchPaths } from "./paths.ts"
import type { Dirent } from "node:fs"

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

/** True iff `<tbRoot>/<task>/task.toml` exists — the sole validity source
 * for selectTasks (see this module's header for why manifest.json is no
 * longer consulted). */
function isValidTask(paths: BenchPaths, task: string): boolean {
  return existsSync(join(paths.tbRoot, task, "task.toml"))
}

/** All `<tbRoot>/<dir>` entries with a `task.toml`, sorted — the --all
 * enumeration source, replacing `Object.keys(manifest)`. Dies (BenchError)
 * if tbRoot itself can't be read, naming tbRoot rather than manifest.json. */
function allTaskNames(paths: BenchPaths): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(paths.tbRoot, { withFileTypes: true })
  } catch (e) {
    die(`Cannot read tbRoot (${paths.tbRoot}): ${(e as Error).message}`)
  }
  return entries
    .filter((e) => e.isDirectory() && isValidTask(paths, e.name))
    .map((e) => e.name)
    .sort()
}

/**
 * Resolve --all / --task-file / --tasks into a tbRoot-validated task list,
 * in that priority order — matching Python's select_tasks resolution order
 * exactly (runner.py:1431-1446). Validity source: `<tbRoot>/<task>/task.toml`
 * existence (see this module's header) — REPLACES the old manifest.json check.
 */
export function selectTasks(
  paths: BenchPaths,
  opts: { all?: boolean; taskFile?: string; tasks?: string[] },
): string[] {
  let tasks: string[]
  if (opts.all) {
    tasks = allTaskNames(paths)
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
    if (!isValidTask(paths, t)) {
      die(`Unknown task: '${t}'. Check tbRoot (${paths.tbRoot}) for a matching task.toml.`)
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
  maxVerifierTimeout = 0,
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
  let verifierTimeout = typeof verifierRaw === "number" && verifierRaw ? verifierRaw : 300

  if (maxAgentTimeout && agentTimeout > maxAgentTimeout) {
    log(`  capping agent timeout ${pyFixed(agentTimeout, 0)}s → ${pyFixed(maxAgentTimeout, 0)}s`)
    agentTimeout = maxAgentTimeout
  }
  if (maxVerifierTimeout && verifierTimeout > maxVerifierTimeout) {
    log(`  capping verifier timeout ${pyFixed(verifierTimeout, 0)}s → ${pyFixed(maxVerifierTimeout, 0)}s`)
    verifierTimeout = maxVerifierTimeout
  }
  return { agentTimeout, verifierTimeout }
}

export interface TaskResources {
  cpus: number
  memoryMb: number
  gpus: number
  /** false when task.toml was missing/unparseable OR had no [environment] table. */
  declared: boolean
}

/** Declared container footprint from task.toml [environment] (spec D1).
 * Fallback = the modal TB2 footprint (1 cpu / 2048 MB). Never throws. */
export function taskResources(paths: BenchPaths, task: string): TaskResources {
  const tomlPath = join(paths.tbRoot, task, "task.toml")
  let env: Record<string, unknown> | undefined
  if (existsSync(tomlPath)) {
    try {
      const doc = Bun.TOML.parse(readFileSync(tomlPath, "utf-8")) as { environment?: Record<string, unknown> }
      env = doc.environment
    } catch {
      env = undefined
    }
  }
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 ? v : fallback)
  return {
    cpus: num(env?.["cpus"], 1),
    memoryMb: num(env?.["memory_mb"], 2048),
    gpus: typeof env?.["gpus"] === "number" ? (env["gpus"] as number) : 0,
    declared: env !== undefined,
  }
}

/** taskResources + spec-D1 warning + spec Non-goals GPU refusal. Call only
 * when --enforce-resources is on (undefined resources = unenforced elsewhere).
 * Consumed by cmd-run.ts's outer loop and cmd-oracle.ts's runOneOracleTask. */
export function enforcedResources(paths: BenchPaths, task: string): { cpus: number; memoryMb: number } {
  // taskResources.num()'s fallback also fires for an explicit 0/negative
  // cpus or memory_mb in task.toml (not just a missing key) — `declared`
  // stays true in that case, so this silently substitutes the modal
  // footprint rather than erroring on a malformed declaration.
  const r = taskResources(paths, task)
  if (r.gpus > 0) {
    throw new BenchError(
      `${task}: declares gpus=${r.gpus}; VM has none — refusing to run it unconstrained under --enforce-resources`,
    )
  }
  if (!r.declared) log(`  ${task}: no [environment] in task.toml — assuming 1 cpu / 2048 MB`)
  return { cpus: r.cpus, memoryMb: r.memoryMb }
}
