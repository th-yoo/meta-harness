/**
 * cgroup.ts — MEASURE a task container's real resource footprint from its own
 * cgroup v2 accounting, so the scheduler can pack on measured load instead of a
 * static declared `cpus` int (the P/E-core / heterogeneous-host problem: a
 * declared count means different things per machine — only in-env measurement
 * is ground truth).
 *
 * Mechanism mirrors self-score.ts:readSelfScore — a `podman exec cat` against a
 * fixed-format file — but reads the kernel's cgroup files instead of an
 * agent-written one:
 *   - cpu.stat    → `usage_usec` = cumulative CPU-microseconds the WHOLE
 *                   container (agent + verifier + apt + compiles) consumed.
 *   - memory.peak → high-water RSS in bytes (cgroup v2, kernel ≥5.19).
 *
 * Read the container's OWN cgroup (`/sys/fs/cgroup/…` from inside — podman puts
 * each container in its own cgroup, so these are container-scoped, verified on
 * the target host). MUST be called while the container is still up — i.e.
 * BEFORE `podman rm` in runTaskOnce's finally — exactly where readSelfScore is
 * read (cmd-run.ts).
 *
 * Best-effort telemetry: ANY read/parse failure returns null (older kernel, no
 * memory.peak, container already gone). Capture NEVER fails a run.
 */
import { podman, type ExecResult } from "./exec.ts"
import { buildExecArgv } from "./sandbox.ts"

type ExecArgvFn = (argv: string[]) => Promise<ExecResult>

export interface CgroupStats {
  /** Cumulative container CPU-seconds (cpu.stat usage_usec / 1e6). */
  cpuSeconds: number
  /** Peak container RSS in MiB (memory.peak / 1024²); 0 when unavailable. */
  peakRssMb: number
  /** Cumulative OOM-kill count from memory.events' `oom_kill` field.
   * 0 when memory.events is absent (older kernel) — graceful degrade, same as
   * peakRssMb. The counter is CUMULATIVE over the container's lifetime: the
   * agent harness retries execs inside the same container, so nonzero means
   * "an OOM kill happened at some point in this container", NOT "the final
   * attempt was killed". Callers must combine it with the result outcome
   * before acting. */
  oomKills: number
}

/** One `podman exec` reads three files: cpu.stat verbatim, then a `PEAK <bytes>`
 * line appended for memory.peak (which is a bare number, so it needs a label to
 * disambiguate from cpu.stat's numbers), then an `OOMK <n>` line for the
 * cumulative oom_kill counter from memory.events. `2>/dev/null` + the `$()`
 * fallback keep a missing memory.peak/memory.events (older kernel) from
 * failing the whole read. */
export const READ_CMD =
  "cat /sys/fs/cgroup/cpu.stat 2>/dev/null; " +
  "printf 'PEAK %s\\n' \"$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)\"; " +
  "printf 'OOMK %s\\n' \"$(awk '$1==\"oom_kill\"{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)\""

/** Read the container's cgroup accounting. Returns null on any failure (rc≠0 or
 * no parseable usage_usec) — the caller treats null as "unmeasured". Injectable
 * execFn for tests. */
export async function readCgroupStats(name: string, execFn: ExecArgvFn = podman): Promise<CgroupStats | null> {
  let res: ExecResult
  try {
    res = await execFn(buildExecArgv(name, ["sh", "-c", READ_CMD]))
  } catch {
    return null
  }
  if (res.rc !== 0) return null
  return parseCgroupStats(res.stdout)
}

/** Pure parser (separately testable). `usage_usec` is required — without it we
 * have no CPU signal, so return null. `PEAK` is optional — 0 when absent. */
export function parseCgroupStats(stdout: string): CgroupStats | null {
  const usage = /(?:^|\n)usage_usec\s+(\d+)/.exec(stdout)
  if (!usage) return null
  const peak = /(?:^|\n)PEAK\s+(\d+)/.exec(stdout)
  const oomk = /(?:^|\n)OOMK\s+(\d+)/.exec(stdout)
  return {
    cpuSeconds: round1(Number(usage[1]) / 1e6),
    peakRssMb: peak ? Math.round(Number(peak[1]) / (1024 * 1024)) : 0,
    oomKills: oomk ? Number(oomk[1]) : 0,
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
