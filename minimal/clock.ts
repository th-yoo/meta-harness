/**
 * minimal/clock.ts — clock-skew PREFLIGHT for the podman VM.
 *
 * On darwin the containers run inside a podman machine VM whose clock does
 * not track the host across sleep: after a mac sleep the VM woke ~17 HOURS
 * behind. Every container then failed TLS to api.anthropic.com with
 * "certificate is not yet valid" and the agent died 0-turn — two trials
 * lost before the cause was found (2026-07-25). This module assesses the
 * host↔VM skew before any trial launches, attempts one resync, and blocks
 * the run if the skew persists (a blocked run is one message; a skewed run
 * is k silent zero-turn corpses).
 *
 * Pure logic only — clock reads and the resync command are injected, so
 * tests never spawn podman. On linux (rootless podman = host, no VM) the
 * vmEpoch read fails and the check fails OPEN: skew is a darwin-VM-specific
 * failure mode.
 */

export interface ClockCheck {
  /** vm - host, seconds, signed (negative = VM behind). */
  skewSec: number
  ok: boolean
  action: "none" | "resynced" | "blocked"
}

export function assessSkew(
  hostEpochSec: number,
  vmEpochSec: number,
  maxSkewSec = 60,
): { skewSec: number; ok: boolean } {
  const skewSec = vmEpochSec - hostEpochSec
  return { skewSec, ok: Math.abs(skewSec) <= maxSkewSec }
}

export async function clockPreflight(
  io: {
    hostEpoch: () => number
    vmEpoch: () => Promise<number | null>
    resync: () => Promise<boolean>
  },
  maxSkewSec = 60,
): Promise<ClockCheck> {
  const vm = await io.vmEpoch()
  // Unreadable VM clock = no VM (linux) or machine not running — fail open.
  if (vm === null) return { skewSec: 0, ok: true, action: "none" }
  const first = assessSkew(io.hostEpoch(), vm, maxSkewSec)
  if (first.ok) return { ...first, action: "none" }
  if (await io.resync()) {
    const vm2 = await io.vmEpoch()
    if (vm2 !== null && assessSkew(io.hostEpoch(), vm2, maxSkewSec).ok)
      // Report the skew that WAS corrected, not the post-resync residue.
      return { skewSec: first.skewSec, ok: true, action: "resynced" }
  }
  return { skewSec: first.skewSec, ok: false, action: "blocked" }
}
