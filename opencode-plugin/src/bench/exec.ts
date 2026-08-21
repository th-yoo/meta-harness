/**
 * exec.ts — the single spawn funnel for the bench runner port.
 *
 * Every podman invocation (create/start/exec/cp/rm/build) goes through
 * `runHost` (or its `podman` alias) — nothing else in this codebase calls
 * `Bun.spawn` directly. Two host-side subtleties this funnel exists to get
 * right once, in one place:
 *
 *  1. Backpressure deadlock (parity trap #4): a child process that writes
 *     enough to stdout/stderr to fill the OS pipe buffer will block on write()
 *     until something reads it. Draining the two streams *sequentially*
 *     (`await stdout; await stderr`) can deadlock if the child is blocked
 *     writing to the stream you haven't started draining yet. We always
 *     drain both concurrently via `Promise.all` + `new Response(...).text()`.
 *
 *  1b. The same trap from the input side: `opts.stdin` (opt-in, used by the
 *     judge transport to hand `opencode run` a prompt too large for one argv
 *     element). Bun's `end()` settles when the CHILD exits, not when the
 *     payload is buffered, so a child that never reads stdin blocks the write
 *     for as long as it lives — the write therefore belongs inside the same
 *     concurrent await as the drains AND after the host timer is armed.
 *
 *  2. Two different kinds of "timeout":
 *     - A *host*-side timeout (`opts.timeoutSec`) kills the podman CLI
 *       process itself from the outside (a timer + `proc.kill()`). This is
 *       for host-side operations, not in-container step limits.
 *     - An *in-container* step timeout (setup/solve/verify) must bound the
 *       process running *inside* the container, not the local `podman exec`
 *       client. `withTimeout` wraps the in-container command with coreutils
 *       `timeout`, whose well-known exit code 124 signals "timed out" — the
 *       exec funnel maps that rc to `timedOut: true` unconditionally (rc 124
 *       is not a code any of our in-container commands produce on their own).
 */

// Bun.spawn is untyped here on purpose: this project has no `bun-types`
// dependency (strict TS, no new deps — see paths.ts's import.meta.url note
// for the same constraint), so we declare only the slice of the Bun global
// this module actually uses. Scoped to this module (no `declare global`), so
// it can't collide with any other file's own minimal Bun ambient decl.
declare const Bun: {
  spawn(
    cmd: string[],
    opts: {
      stdin: "pipe" | "ignore"
      stdout: "pipe"
      stderr: "pipe"
      env?: Record<string, string | undefined>
    },
  ): {
    /** only a writable sink when `stdin: "pipe"` was requested */
    readonly stdin: { write(chunk: string): number; end(): number | Promise<number> }
    readonly stdout: ReadableStream<Uint8Array>
    readonly stderr: ReadableStream<Uint8Array>
    readonly exited: Promise<number>
    readonly exitCode: number | null
    kill(signal?: number | string): void
  }
}

export interface ExecResult {
  rc: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run `argv` on the host, draining stdout/stderr concurrently. `opts.timeoutSec`
 * is a *host*-side timer (kills the spawned process itself) — see module
 * header for why in-container step limits use `withTimeout` instead.
 */
export async function runHost(
  argv: string[],
  opts?: { timeoutSec?: number; env?: Record<string, string>; stdin?: string },
): Promise<ExecResult> {
  const payload = opts?.stdin
  // `stdin`: OPT-IN, and "ignore" (Bun's own default) when absent. NOT
  // "inherit": that would let every child of this funnel — podman
  // create/start/exec/cp/build, fleet/run.ts, squad-propose.ts — consume the
  // runner's terminal input, and a child that reads stdin would block until
  // the runner's own stdin hit EOF. Measured both ways: review ecde549 clocked
  // ignore at 3ms against a hang for inherit, and flipping this line to
  // "inherit" makes test 6 of test/bench-exec-stdin.test.ts (a probe whose own
  // stdin is a pipe the test never closes) time out instead of pass.
  const proc = Bun.spawn(argv, {
    stdin: payload === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts?.env ?? {}) },
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeoutSec) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutSec * 1000)
  }

  // `end()` does NOT return once the payload is buffered — it settles when the
  // child exits (measured 2026-08-21: 220,000 bytes into `sleep 4` resolved at
  // 4001ms, i.e. at child exit, not at write time). So a payload to a child
  // that never reads stdin waits for that child, and the ONLY thing that bounds
  // it is the host timer above — which is why the write is created AFTER the
  // timer is armed and awaited INSIDE the same Promise.all as both drains,
  // never before them. The reverted first attempt wrote before the timer and
  // hung with timeoutSec ignored (review record ecde549, blocker 2).
  //
  // The catch is crash insurance, not a tested path: Bun's FileSink swallows
  // EPIPE (measured: 500 KB into an already-exited child resolves), so no probe
  // here produced a rejection — but an unhandled one would kill a batch runner
  // mid-run, and this promise is not awaited by anyone else.
  const written =
    payload === undefined
      ? Promise.resolve()
      : (async () => {
          proc.stdin.write(payload)
          await proc.stdin.end()
        })().catch(() => {})

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
    written,
  ])
  if (timer !== undefined) clearTimeout(timer)

  // proc.exited (the promise) resolves to a raw wait-status-derived number
  // even on signal death (e.g. 143 = 128+SIGTERM) — the reliable "was this a
  // signal death" signal is the exitCode *property*, which Bun sets to null
  // in that case. Signal deaths normalize to rc -1, per the brief.
  const rc = proc.exitCode === null ? -1 : proc.exitCode
  // podman-exec rc 124 ⇒ a withTimeout-wrapped in-container command hit its
  // coreutils `timeout` limit — mark it regardless of the host timer.
  if (rc === 124) timedOut = true

  return { rc, stdout, stderr, timedOut }
}

/** Thin alias of `runHost` for readability at call sites — argv already
 * starts with "podman" from the P2 sandbox.ts builders. */
export async function podman(
  argv: string[],
  opts?: { timeoutSec?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return runHost(argv, opts)
}

/**
 * Wrap an in-container command with coreutils `timeout` so a step (setup /
 * solve / verify) can't run forever inside the container. `-k 5` sends
 * SIGKILL 5s after the initial SIGTERM if the process ignores it. Exit code
 * 124 on timeout is coreutils' own convention — see module header.
 */
export function withTimeout(cmd: string[], timeoutSec: number): string[] {
  return ["timeout", "-k", "5", String(Math.ceil(timeoutSec)), ...cmd]
}
