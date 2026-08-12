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
import { die, BenchError } from "./util.ts"

/** Where the podman bench image is tagged once built (see Containerfile / P3
 * cmd-prep). Always `localhost/...` — podman never pushes this anywhere. */
export const BENCH_IMAGE = "localhost/mh-bench:latest"

/** The model used when `--model` is omitted. ONE shared constant (final-
 * review fix) — this literal used to be duplicated at cli.ts's
 * validateParallel call sites (deriving the required provider API key var
 * for `run`/`ab`'s `--parallel` gate) AND cmd-run.ts's/cmd-ab.ts's own
 * default-model fallback; a drift between those copies would silently make
 * the CLI gate check the wrong key var for whichever site didn't get
 * updated. Import this everywhere a default model is needed instead of
 * inlining the literal again. */
export const DEFAULT_BENCH_MODEL = "anthropic/claude-sonnet-5"

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

/**
 * Provider API keys to pass through into the agent-phase container as `-e
 * KEY=val` (see cmd-run.ts's runTaskOnce). auth.json (bind-mounted from
 * `~/.local/share/opencode`) stays the primary, documented credential path;
 * this is an additive convenience so a bare env-var-only setup (CI/headless)
 * also works inside containers — today it silently doesn't (research
 * finding, docs/usage-manual.md "Configuring providers").
 *
 * Matches ANY host env var whose name ends in `_API_KEY` (generic and
 * future-proof: OPENROUTER_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
 * ANTHROPIC_API_KEY, GROQ_API_KEY, ...), excluding unset/empty values.
 * Deliberately NOT wired into the oracle container (cmd-oracle.ts) — oracle
 * runs solve.sh, never the LLM, so it needs no provider keys, and keeping it
 * key-free avoids leaking keys into token-free runs.
 */
export function apiKeyEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (/_API_KEY$/.test(k) && v) out[k] = v
  }
  return out
}

/** Provider-specific key env var for a model string like "anthropic/claude-…" (spec D4).
 * Mirrors record.ts's provider-prefix convention (model.split("/")[0]). */
export function requiredApiKeyVar(model: string): string {
  const provider = model.split("/")[0]
  if (!provider || provider === model) throw new BenchError(`cannot derive provider from model "${model}" — --parallel needs a provider-prefixed model (e.g. anthropic/…)`)
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
}

/**
 * keyOnly-vs-oauth mount decision under `--parallel`. Use keyOnly (no shared rw
 * credential mount) ONLY when an API key is present. With NO key, the oauth path
 * enabled by the freshness gate (validateParallel's pre-flight + the scheduler
 * `canLaunch` launch-guard, agent-auth.ts's OAUTH_PARALLEL_MARGIN_MS) uses the
 * DEFAULT oauth prepareAuth — the same shared rw mount serial uses. SAFE: the
 * freshness gate guarantees no task runs across the ~8h token refresh, so
 * `auth.json` is only READ during the parallel window, never written → no
 * refresh-token race. Serial (`parallel=false`) short-circuits to false →
 * default oauth, byte-identical to before this feature. */
export function useKeyOnlyForParallel(
  parallel: boolean,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parallel && Boolean(env[requiredApiKeyVar(model)])
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
