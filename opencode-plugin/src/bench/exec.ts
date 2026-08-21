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
 *  1b. `opts.stdin` (opt-in, used by the judge transport to hand `opencode run`
 *     a prompt too large for one argv element). NOT the same trap as #1 —
 *     Bun eagerly drains a child's piped stdout even when nothing reads the
 *     ReadableStream, so there is no input/output deadlock to prevent here.
 *     The real hazard is one-sided: against a child that never READS its
 *     stdin, `end()` blocks for that child's whole lifetime. So the payload
 *     must not be awaited until the host timer is armed, or `timeoutSec`
 *     stops bounding the call. Against a reading child (the judge's own case)
 *     it settles in milliseconds.
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

// A local ambient decl for the slice of the Bun global this module uses,
// scoped to this module (no `declare global`) so it can't collide with any
// other file's own minimal decl. It SHADOWS the real types — `@types/bun` is
// in devDependencies and `node_modules/bun-types` is installed, so this is a
// deliberate narrowing, not a substitute for absent types. That makes it our
// job to keep it HONEST: a decl that promises more than Bun delivers
// typechecks code that then throws at runtime. Both fields below are written
// from measurement, not from what would be convenient:
//   - `stdin` is undefined unless "pipe" was requested (measured: `Bun.spawn(
//     ["true"], {stdin: "ignore"}).stdin` === undefined), hence optional.
//   - `write()` returns a number for a small chunk (6 B -> 6), a PROMISE once
//     the payload exceeds the pipe buffer (220 KB -> Promise resolving to a
//     short count, the rest queued for `end()`), and a boolean for a child
//     that has already exited (500 KB -> true). All three measured 2026-08-21.
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
    /** present only when `stdin: "pipe"` was requested */
    readonly stdin?: {
      write(chunk: string): number | boolean | Promise<number>
      end(): number | Promise<number>
    }
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

  // THE RULE, stated as narrowly as it was measured: do not AWAIT the write
  // before the host timer is armed. `end()` blocks for as long as the child
  // lives when that child never reads its stdin (measured 2026-08-21: 220,000
  // bytes into `sleep 4` settled at 4001ms, i.e. at child exit), so awaiting it
  // before the timer exists is an unbounded wait with timeoutSec ignored —
  // exactly the shape reverted at blocker 2 of review ecde549, and exactly what
  // test 5 of test/bench-exec-stdin.test.ts reds.
  //
  // Two things this comment used to claim that measurement does NOT support:
  //   - Creation order is immaterial. Moving this statement above the timer
  //     while leaving the await here changes nothing (7 pass) — `write()` never
  //     blocks long enough to matter (220 KB: 0ms, 1 MB: 1ms, 20 MB: 16ms).
  //   - "settles at child exit" is FALSE for the case that actually ships.
  //     `opencode` READS its stdin, and against a reading child `end()` settles
  //     at ~8ms with the child still running. The blocking case is the
  //     non-reading one, which is a podman/agent shape, not the judge's.
  //
  // The await on write() and the catch are both INSURANCE, not covered paths.
  // Bun types write() as `number | Promise<number>` and it does return a
  // promise under backpressure, so an unawaited rejection would escape and kill
  // a batch runner mid-run — but no probe produced one: a child that reads 1 KB
  // then exits, one already dead, and one SIGKILLed mid-stream all RESOLVE
  // (short count, remainder dropped), and EPIPE is swallowed. Awaiting costs
  // nothing and closes the class; delivery itself is proven by tests 1-4, not
  // by these return values (see the note on `end()` in test 7).
  const written =
    payload === undefined
      ? Promise.resolve()
      : (async () => {
          // `!` is load-bearing and earned: this branch runs only when
          // `payload !== undefined`, which is exactly the condition under which
          // "pipe" was requested above. Outside that guard the decl now makes
          // `proc.stdin` possibly-undefined and tsc rejects the use (verified:
          // dropping this assertion yields TS18048 twice).
          const sink = proc.stdin!
          await sink.write(payload)
          await sink.end()
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
