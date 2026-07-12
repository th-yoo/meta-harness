/**
 * retry-provider.ts — re-run `bun term-bench2/runner.ts <args>` until the
 * model provider is healthy, backing off between attempts. Full port of
 * term-bench2/retry_provider.py (deleted in this commit — this file plus
 * the term-bench2/retry-provider.ts shim are now the only implementation).
 *
 * Why: when the upstream model provider is erroring (opencode emits an
 * error event and does no work — every run reports `turns=0`), a `run`/`ab`
 * produces a meaningless all-fail result. This wrapper detects that state
 * and retries instead of accepting the empty result.
 *
 * Health signal: the provider is "down" only when opencode logged a
 * transient provider error AND nothing in the attempt did real work — i.e.
 * every run failed fast before doing anything. A run that produced turns,
 * hit the agent timeout, or passed all mean the provider is up (even if the
 * task itself failed), so we stop. This deliberately treats a *timeout* as
 * "up" — it is a slow/stuck task, not a provider outage, and retrying it
 * would loop forever.
 *
 * Backoff: the interval doubles each failed attempt and is capped at 10
 * minutes (600s) by default: 30 -> 60 -> 120 -> 240 -> 480 -> 600 -> 600 ...
 *
 * Marker strings: REALWORK_RE / TRANSIENT_MARK are imported (not
 * re-declared) from agent-run.ts, the PRODUCER of the log lines this
 * scans — see that file's header for the shared-constant contract.
 */
import { join } from "node:path"
import { makeBenchPaths } from "./paths.ts"
import { REALWORK_RE, TRANSIENT_MARK } from "./agent-run.ts"
import { pyFixed } from "./util.ts"

// See exec.ts's header note on why Bun globals are declared locally instead
// of depending on `bun-types` (no new deps).
declare const Bun: {
  spawn(
    cmd: string[],
    opts: { stdout: "pipe"; stderr: "pipe"; env?: Record<string, string | undefined> },
  ): {
    readonly stdout: ReadableStream<Uint8Array>
    readonly exited: Promise<number>
  }
}

export interface RetryProviderArgs {
  base: number
  cap: number
  maxAttempts: number
  runnerArgs: string[]
}

/**
 * `[--base SEC] [--cap SEC] [--max-attempts N] -- <runner.ts args...>` —
 * mirrors retry_provider.py's argparse (--base default 30, --cap default
 * 600, --max-attempts default 0 = unlimited). Returns null on any parse
 * error or an empty runner-args tail.
 */
export function parseRetryProviderArgs(argv: string[]): RetryProviderArgs | null {
  let base = 30
  let cap = 600
  let maxAttempts = 0
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--base" || a === "--cap" || a === "--max-attempts") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = Number(v)
      if (Number.isNaN(n)) return null
      if (a === "--base") base = n
      else if (a === "--cap") cap = n
      else maxAttempts = n
      i += 2
      continue
    }
    break
  }
  let rest = argv.slice(i)
  if (rest[0] === "--") rest = rest.slice(1)
  if (rest.length === 0) return null
  return { base, cap, maxAttempts, runnerArgs: rest }
}

export type SleepFn = (seconds: number) => Promise<void>
async function defaultSleep(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/** One attempt's line-merged stdout+stderr stream, plus its exit code. */
export interface SpawnedRun {
  lines: AsyncIterable<string>
  exited: Promise<number>
}

export type SpawnFn = (runnerArgs: string[]) => SpawnedRun

/**
 * Spawn `bun term-bench2/runner.ts <runnerArgs>`, merging stderr into
 * stdout AT THE OS LEVEL (`2>&1` inside a `bash -c` wrapper) so the merged
 * stream preserves true interleaved ordering — matching Python's
 * `subprocess.Popen(..., stderr=subprocess.STDOUT)`, which Bun.spawn has no
 * direct equivalent for (its stdout/stderr are always two separate pipes).
 */
function defaultSpawn(runnerArgs: string[]): SpawnedRun {
  const runnerPath = join(makeBenchPaths().metaRoot, "term-bench2", "runner.ts")
  const proc = Bun.spawn(["bash", "-c", 'exec "$0" "$@" 2>&1', "bun", runnerPath, ...runnerArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  async function* lineGen(): AsyncGenerator<string> {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield buf.slice(0, idx)
        buf = buf.slice(idx + 1)
      }
    }
    if (buf) yield buf
  }

  return { lines: lineGen(), exited: proc.exited }
}

/**
 * The retry loop itself — port of retry_provider.py:68-105's `main` body.
 * `writeLine` defaults to echoing every merged line to the real stdout (so a
 * human watching the wrapper sees everything the wrapped runner printed);
 * injectable so tests can capture output instead.
 */
export async function runRetryProvider(
  args: RetryProviderArgs,
  spawnFn: SpawnFn = defaultSpawn,
  sleepFn: SleepFn = defaultSleep,
  writeLine: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  let attempt = 0
  let delay = args.base
  for (;;) {
    attempt += 1
    writeLine(`\n=== retry_provider attempt ${attempt}: bun term-bench2/runner.ts ${args.runnerArgs.join(" ")} ===`)

    const { lines, exited } = spawnFn(args.runnerArgs)
    let sawTransient = false
    let sawRealwork = false
    for await (const line of lines) {
      writeLine(line)
      if (line.includes(TRANSIENT_MARK)) sawTransient = true
      if (REALWORK_RE.test(line)) sawRealwork = true
    }
    const rc = await exited

    // Down only if the provider errored on every run and nothing ran.
    const providerDown = sawTransient && !sawRealwork
    if (!providerDown) {
      writeLine(`=== provider responding (real work seen / no transient outage) — done, exit=${rc} ===`)
      return rc
    }

    if (args.maxAttempts && attempt >= args.maxAttempts) {
      writeLine(`=== gave up: provider still down after ${attempt} attempt(s) ===`)
      return 2
    }

    writeLine(
      `=== provider down (all runs failed fast with transient errors) — backing off ${pyFixed(delay, 0)}s before attempt ${attempt + 1} ===`,
    )
    await sleepFn(delay)
    delay = Math.min(delay * 2, args.cap)
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseRetryProviderArgs(argv)
  if (args === null) {
    console.error("retry_provider: provide runner.ts args after --")
    return 1
  }
  return runRetryProvider(args)
}
