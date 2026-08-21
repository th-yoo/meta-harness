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
      stdin?: "pipe" | "inherit"
      stdout: "pipe"
      stderr: "pipe"
      env?: Record<string, string | undefined>
    },
  ): {
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
  // `stdin`: deliver a large payload WITHOUT argv. Linux caps a single argv
  // element at MAX_ARG_STRLEN (131,072); a judge prompt carrying a full
  // trajectory exceeds that (measured 2026-08-21: 200,000 -> E2BIG, 131,000 ->
  // OK). Passing it on stdin removes the ceiling entirely — it is not a limit
  // of the child, which reads stdin happily, but of how we invoked it.
  const proc = Bun.spawn(argv, {
    stdin: opts?.stdin === undefined ? "inherit" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts?.env ?? {}) },
  })
  if (opts?.stdin !== undefined) {
    proc.stdin.write(opts.stdin)
    await proc.stdin.end()
  }

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeoutSec) {
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutSec * 1000)
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
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
