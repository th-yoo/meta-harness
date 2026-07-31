/**
 * check-runner.ts — the timeout-guarded check runner extracted from
 * hook-cli.ts (Phase 3 Task 1: moved verbatim, PLUS one additive change —
 * an `ms` elapsed-time field on the resolved result).
 */
export const MAX_OUTPUT_BYTES = 64 * 1024

export function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(0, MAX_OUTPUT_BYTES) : s
}

export function runCheck(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now() // T1 ADDITIVE: elapsed-time basis for the new `ms` field
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
    } catch (e) {
      reject(e)
      return
    }

    // Read stdout/stderr concurrently; these resolve once each stream
    // closes, which happens on normal exit OR after proc.kill() below.
    const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => "")
    const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "")

    // A killed `bash -c` compound command (e.g. `cmd & cmd`) can leave
    // forked grandchildren holding the stdout/stderr pipe fds open —
    // bash does not forward signals to background jobs — so the text
    // promises above may never settle even after the process "exits".
    // Race each against a short grace timer so we never hang the hook.
    const GRACE_MS = 2000
    const withGrace = (p: Promise<string>): Promise<string> =>
      Promise.race([p, new Promise<string>((res) => setTimeout(() => res(""), GRACE_MS))])

    let timedOut = false
    let hasExited = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill() // SIGTERM
      } catch {
        // best-effort kill only
      }
      // Escalate to SIGKILL if the process (group) hasn't actually
      // exited shortly after — SIGTERM alone won't reach grandchildren
      // left behind by a `bash -c 'a & b'` style compound command.
      setTimeout(() => {
        if (!hasExited) {
          try {
            proc.kill("SIGKILL")
          } catch {
            // best-effort only
          }
        }
      }, 1500)
    }, timeoutMs)

    proc.exited
      .then(async (code) => {
        hasExited = true
        clearTimeout(timer)
        const [so, se] = await Promise.all([withGrace(stdoutP), withGrace(stderrP)])
        const combined = capOutput(so + se)
        const ms = Date.now() - startedAt // T1 ADDITIVE: `ms` field, not present pre-extraction
        if (timedOut) {
          // A timeout is a FAILED CHECK, not an internal error: resolve
          // (never reject) so the core folds it into the round outcome.
          resolve({ code: 124, out: combined + "\n[kkamak: check timed out]", ms })
        } else {
          resolve({ code, out: combined, ms })
        }
      })
      .catch((err) => {
        hasExited = true
        clearTimeout(timer)
        reject(err)
      })
  })
}
