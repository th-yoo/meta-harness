/**
 * resource-profile.ts — MEMORIZE measured per-task resource footprints so the
 * scheduler reuses them instead of re-measuring every time.
 *
 * The problem (why not just declare `cpus` in task.toml): a static core count is
 * a portability fiction — P/E cores, big.LITTLE, and per-host clock/IPC mean
 * "4 cpus" is a different amount of compute on every machine, and inside WSL2 we
 * can't even see the P/E topology. Ground truth is what a task ACTUALLY burned
 * in THIS environment (cgroup.ts). So we measure once, then remember it.
 *
 * Profiles are keyed BY HOST-CLASS (this file stores one JSON per host-class) —
 * the same task legitimately profiles differently on a WSL2-8core box vs a
 * MacBook vs a server, and that env-specificity is the whole point.
 *
 * `avgCpu` = median(cpuSeconds / wallClock) across a rolling sample window = the
 * task's SUSTAINED core-demand. That — not the declared int, and not the peak
 * burst — is what a budget packer should size on: a task that burns 0.5 cores
 * on average over its wall-clock can pack 16-wide even if one verify phase
 * briefly spikes to 4.
 *
 * This module CAPTURES + PERSISTS the profile (and exposes a reader), and also
 * exposes the pure decision helpers (`packingWeight`, `raiseCapMeasured`) the
 * scheduler consumes to flip from the declared int to a measured profile once
 * one exists. The declared task.toml value remains the cold-start prior (used
 * until a profile is trustworthy) and the base of the container memory cap,
 * which these helpers only ever raise, never shrink.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { cpus, arch } from "node:os"

/** One measured run of a task. */
export interface ResourceSample {
  /** Cumulative container CPU-seconds (cgroup.ts CgroupStats.cpuSeconds). */
  cpuSeconds: number
  /** Peak container RSS in MiB. */
  peakRssMb: number
  /** Wall-clock seconds the run took (RunResult.elapsed) — the avgCpu divisor. */
  wall: number
}

/** A task's memorized profile: a rolling window of recent samples plus derived
 * aggregates the scheduler consumes. */
export interface TaskProfile {
  /** Most-recent-last, capped at WINDOW. */
  samples: ResourceSample[]
  /** median(cpuSeconds/wall) over `samples` — sustained core-demand. */
  avgCpu: number
  /** max(peakRssMb) over `samples` — the memory the packer must reserve. */
  peakRssMb: number
  /** Total samples ever folded in (not just the windowed count) — a confidence
   * signal: n=1 is a guess, n≥3 is trustworthy. */
  n: number
}

/** task -> profile, for one host-class. */
export type HostProfiles = Record<string, TaskProfile>

/** How many recent samples to keep + aggregate over. A small window tracks
 * drift (a task that got heavier) without an unbounded file. */
export const PROFILE_WINDOW = 5

/**
 * A stable fingerprint of the running environment's compute character:
 * `<arch>-<Ncpu>c-<cpu-model-slug>`. Same box → same key → its measurements
 * accumulate; a different box gets its own file. os.cpus() gives the host CPU
 * model even inside WSL2. Model slug is truncated so the key stays filename-safe
 * and bounded.
 */
export function hostClass(): string {
  const c = cpus()
  const model = (c[0]?.model ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `${arch()}-${c.length}c-${model || "unknown"}`
}

/** `<metaRoot>/resource-profiles/<hostClass>.json` — a store sibling of
 * `global/`, NOT under any candidate version: a footprint is a property of the
 * task × host, not of a prompt candidate. */
export function profilePath(metaRoot: string, hc: string): string {
  return join(metaRoot, "resource-profiles", `${hc}.json`)
}

/** Read all task profiles for a host-class ({} when the file is absent or
 * unparseable — never throws). */
export function readHostProfiles(metaRoot: string, hc: string = hostClass()): HostProfiles {
  const p = profilePath(metaRoot, hc)
  if (!existsSync(p)) return {}
  try {
    const o = JSON.parse(readFileSync(p, "utf8"))
    return o && typeof o === "object" && !Array.isArray(o) ? (o as HostProfiles) : {}
  } catch {
    return {}
  }
}

/** The memorized profile for one task on this host, or null if never measured
 * (the scheduler's cold-start signal → fall back to the declared prior). */
export function readResourceProfile(metaRoot: string, task: string, hc: string = hostClass()): TaskProfile | null {
  return readHostProfiles(metaRoot, hc)[task] ?? null
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * Fold one measured run into a task's profile and persist it. Read-modify-write
 * of the whole host file — callers MUST serialize concurrent invocations (the
 * bench run loop wraps this in the same AsyncMutex as the store write) since
 * parallel tasks share one host file.
 *
 * Returns the updated profile. Injectable-free (real fs) — tests point metaRoot
 * at a tmp dir.
 */
export function updateResourceProfile(
  metaRoot: string,
  task: string,
  sample: ResourceSample,
  hc: string = hostClass(),
): TaskProfile {
  const all = readHostProfiles(metaRoot, hc)
  const prev = all[task]
  const samples = [...(prev?.samples ?? []), sample].slice(-PROFILE_WINDOW)
  const avgCpu = round2(median(samples.map((s) => (s.wall > 0 ? s.cpuSeconds / s.wall : 0))))
  const peakRssMb = samples.reduce((mx, s) => Math.max(mx, s.peakRssMb), 0)
  const prof: TaskProfile = { samples, avgCpu, peakRssMb, n: (prev?.n ?? 0) + 1 }

  all[task] = prof
  const p = profilePath(metaRoot, hc)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(all, null, 2) + "\n")
  return prof
}

// --- packing / cap decision helpers ----------------------------------------
//
// Pure functions the scheduler consumes to go from "declared task.toml prior"
// to "measured profile" once one exists and is trustworthy. Kept in this file
// (rather than the scheduler) because they're the direct consumers of
// `TaskProfile`'s shape and thresholds.

/** A profile is used for packing/cap decisions only once it has this many
 * folded samples — matches `TaskProfile.n`'s own doc: "n=1 is a guess, n≥3 is
 * trustworthy". Below this, callers fall back to the declared prior. */
export const PACK_MIN_SAMPLES = 3

/** Floor on the measured CPU packing weight. `avgCpu` is a whole-run median
 * and underestimates burst phases — simultaneous verifier bursts on an
 * overpacked host risk contention timeouts, which recordTimeouts would record
 * as genuine fails. 0.5 halves worst-case overpack vs a 0.25 floor while still
 * packing far wider than the typical declared int. */
export const PACK_MIN_CPUS = 0.5

/** Floor on the measured memory packing weight, in MiB. */
export const PACK_MIN_MEM_MB = 256

/** Headroom multiplier applied to `peakRssMb` for the packing weight.
 * `peakRssMb` is already a max-over-window statistic; ×1.2 covers
 * window-to-window variance on top of that. */
export const PACK_MEM_HEADROOM = 1.2

/** Headroom multiplier applied to `peakRssMb` for the raise-only container
 * memory cap lift (see `raiseCapMeasured`). */
export const CAP_MEM_HEADROOM = 1.5

/** What the scheduler packs a task as: measured when trustworthy, else the
 * declared task.toml prior verbatim. */
export interface PackWeight {
  cpus: number
  memoryMb: number
  /** false when this is the declared prior (no/immature/zero profile). */
  measured: boolean
}

/**
 * The packing weight the parallel scheduler should use for one task: the
 * measured profile once it's trustworthy (`n >= PACK_MIN_SAMPLES` and
 * `avgCpu > 0`), else the declared prior verbatim.
 *
 * Deliberately NOT clamped at the declared prior — a task measured hotter
 * than declared packs bigger (an honest signal); the scheduler's existing
 * exceedsTotalBudget solo-run path handles items that don't fit even alone.
 */
export function packingWeight(
  prior: { cpus: number; memoryMb: number },
  profile: TaskProfile | null,
): PackWeight {
  const measured = profile !== null && profile.n >= PACK_MIN_SAMPLES && profile.avgCpu > 0
  if (!measured) return { ...prior, measured: false }
  return {
    cpus: Math.max(profile!.avgCpu, PACK_MIN_CPUS),
    memoryMb: Math.max(Math.ceil(profile!.peakRssMb * PACK_MEM_HEADROOM), PACK_MIN_MEM_MB),
    measured: true,
  }
}

/**
 * Raise a container's memory cap when a measured profile proves the declared
 * cap too small. Without this, a task whose true memory demand exceeds its
 * declared cap OOM-kills every run forever; this closes that loop.
 *
 * Raise-only, memory only: `cpus` never changes, and `memoryMb` can only grow
 * above whatever was passed in (declared/floored) — never shrink. No/immature
 * profile → cap returned verbatim.
 */
export function raiseCapMeasured(
  cap: { cpus: number; memoryMb: number },
  profile: TaskProfile | null,
): { cpus: number; memoryMb: number } {
  if (profile === null || profile.n < PACK_MIN_SAMPLES) return cap
  return { cpus: cap.cpus, memoryMb: Math.max(cap.memoryMb, Math.ceil(profile.peakRssMb * CAP_MEM_HEADROOM)) }
}
