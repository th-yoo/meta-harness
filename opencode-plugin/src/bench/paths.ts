/**
 * paths.ts — repo/task-layout path resolution + podman container naming for
 * the bench runner port.
 *
 * Mirrors term-bench2/runner.py's "Paths" section (runner.py:40-82), minus
 * everything that existed only to support the bwrap sandbox (BENCH_WORK,
 * MH_BENCH_WORK, the /usr/local/bin symlink farm, ...) — the podman design
 * (see sandbox.ts) uses a fresh container per task attempt instead, so none
 * of that per-run host-side state is needed.
 */
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { die } from "./util.ts"

/** Where the podman bench image is tagged once built (see Containerfile / P3
 * cmd-prep). Always `localhost/...` — podman never pushes this anywhere. */
export const BENCH_IMAGE = "localhost/mh-bench:latest"

export interface BenchPaths {
  /** repo root — the dir containing both "term-bench2" and ".git" */
  metaRoot: string
  /** metaRoot + "/term-bench2" */
  termBenchDir: string
  /** TB2 clone; default sibling of metaRoot, overridable via --tb-root */
  tbRoot: string
  /** termBenchDir + "/results" */
  resultsDir: string
  /** termBenchDir + "/patches" */
  patchesDir: string
  /** termBenchDir + "/baseline-tasks.txt" */
  baselineTasksFile: string
  /** termBenchDir + "/splits.json" */
  splitsFile: string
}

/** Walk up from `startDir` until a directory containing both "term-bench2"
 * and ".git" is found. Throws BenchError (via die) if the filesystem root is
 * reached first — this module must live under the meta-harness repo. */
function findMetaRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, "term-bench2")) && existsSync(join(dir, ".git"))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      die(
        `makeBenchPaths: could not locate the meta-harness repo root (a directory ` +
          `containing both "term-bench2" and ".git") walking up from ${startDir}`,
      )
    }
    dir = parent
  }
}

export function makeBenchPaths(opts?: { tbRoot?: string }): BenchPaths {
  // path.dirname(new URL(import.meta.url).pathname), not import.meta.dir:
  // import.meta.dir is Bun-only and untyped under this project's tsconfig
  // (no bun-types dep) — see judge.ts for the same pattern.
  const here = dirname(new URL(import.meta.url).pathname)
  const metaRoot = findMetaRoot(here)
  const termBenchDir = join(metaRoot, "term-bench2")
  const tbRoot = opts?.tbRoot ?? join(dirname(metaRoot), "terminal-bench-2")
  return {
    metaRoot,
    termBenchDir,
    tbRoot,
    resultsDir: join(termBenchDir, "results"),
    patchesDir: join(termBenchDir, "patches"),
    baselineTasksFile: join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: join(termBenchDir, "splits.json"),
  }
}

const MAX_TASK_LEN = 40

/**
 * A podman container name unique across concurrent invocations:
 * `mh-<task>-<tag or "run">-<epochms>-<4 hex>`, matching podman's name rules
 * (`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`). Task names are already restricted to that
 * charset (TB2 task IDs); this only truncates to bound total length.
 */
export function containerName(task: string, tag?: string): string {
  const safeTask = task.slice(0, MAX_TASK_LEN)
  const safeTag = tag ?? "run"
  const epochMs = Date.now()
  const hex = randomBytes(2).toString("hex")
  return `mh-${safeTask}-${safeTag}-${epochMs}-${hex}`
}
