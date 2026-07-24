/**
 * minimal/schedule.ts — the RESERVATION layer of the scheduler.
 *
 * The measurement-based admission loop in run.ts is commitment-blind: it
 * reads load at admission time, but each admitted container ramps to full
 * cost (~600MB+ agent RSS) tens of seconds AFTER passing the gate, so at
 * large --parallel a burst of admissions outruns the signal and OOMs the
 * box. TB2's scheduler was two-layer (static budget-derived width + live
 * pacing); the minimal port had dropped the static half. This module
 * restores it: capacity is reserved by construction, measurement then only
 * paces WITHIN the reserved width.
 *
 * Also home to pidAlive(): the stale-container reap used
 * existsSync(/proc/pid), which on darwin (no /proc) declared every runner
 * dead and reaped concurrent LIVE runs' containers. kill(pid, 0) is the
 * portable liveness probe.
 */

export interface Capacity {
  cpus: number
  memTotalMb: number
}

export interface ReservePolicy {
  /** cpus reserved per concurrent attempt (TB2 --min-cpus parity). */
  minCpusPer: number
  /** memory reserved per concurrent attempt (agent RSS + headroom). */
  reserveMbPer: number
  /** host memory kept free of attempts entirely. */
  memFloorMb: number
}

export interface ClampResult {
  effective: number
  /** null when the request passed unclamped; else which bound bit. */
  reason: string | null
}

export function clampParallel(requested: number, cap: Capacity, pol: ReservePolicy): ClampResult {
  const cpuBound = Math.max(1, Math.floor(cap.cpus / pol.minCpusPer))
  const memBound = Math.max(1, Math.floor(Math.max(0, cap.memTotalMb - pol.memFloorMb) / pol.reserveMbPer))
  const effective = Math.max(1, Math.min(requested, cpuBound, memBound))
  if (effective === requested) return { effective, reason: null }
  const binding = cpuBound <= memBound ? `cpu bound ${cpuBound} (${cap.cpus} cpus / ${pol.minCpusPer} per attempt)` : `mem bound ${memBound} ((${cap.memTotalMb}MB - ${pol.memFloorMb}MB floor) / ${pol.reserveMbPer}MB per attempt)`
  return { effective, reason: binding }
}

/** Portable process-liveness probe: signal 0 delivers nothing but checks
 * existence/permission. EPERM = alive under another uid. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}
