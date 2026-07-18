/**
 * host-pressure.ts — host CPU/memory pressure sensor for the load-aware
 * launch gate (spec `docs/superpowers/specs/2026-07-18-load-aware-3-host-pressure.md`,
 * plan `plan-to-flip-2-tidy-aurora.md` S1). Problem: measured-packing width
 * sizes off task demand alone and never senses the actual host — live
 * evidence in the plan's Context (a width-3 run drove loadavg to 149 / 19GB
 * swap while the user was working, run had to be killed). This module is
 * PURELY the sensor: it samples CPU load/core and a memory-pressure signal,
 * runs each through its own hysteresis state machine, and exposes a single
 * combined boolean. It does not gate anything itself — S2 (scheduler.ts's
 * `pauseGate`) and S3 (cli.ts wiring) consume `underPressure()`.
 *
 * Sampling cadence: `underPressure()` is meant to be polled frequently (once
 * per scheduler scan) but only actually SAMPLES the host at most once per
 * `PRESSURE_POLL_SEC`, via a timestamp cache — this module owns no timer of
 * its own (there are zero timers in src/ outside scheduler.ts's re-scan).
 *
 * Observe-mode sampling-lag caveat: in `--host-pressure observe` (S3), the
 * sensor is polled only when something already calls it (a scheduler scan
 * event), and scans happen on launches/completions, not on a fixed clock.
 * During a sparse period (nothing launching or finishing) a state change on
 * the host can sit un-sampled — and therefore un-logged — until the next
 * scan event happens to land after a full `PRESSURE_POLL_SEC` has elapsed.
 * That lag is acceptable for calibration (the point of observe mode is to
 * eyeball thresholds over a whole run, not to catch every transition to the
 * second); it would NOT be acceptable if this module grew its own timer to
 * close the gap, which is deliberately out of scope here (S2 owns the only
 * timer, driven by `pauseGate`, not by this sensor).
 *
 * Memory signal, per platform:
 *  - darwin: `memory_pressure -Q`'s "System-wide memory free percentage"
 *    (`parseMemoryPressureQ`), read via the injectable sync `execFn`.
 *    Calibration alternative worth evaluating later: `sysctl
 *    kern.memorystatus_vm_pressure_level` is a near-free (no subprocess),
 *    PSI-analogous read of the same jetsam pressure levels `memory_pressure
 *    -Q` derives its percentage from. NOT suitable as a substitute today:
 *    `vm.page_free_count` / raw free-page counts — macOS deliberately keeps
 *    free RAM near zero (unused RAM is used for file-cache/compression), so
 *    "free pages" alone doesn't distinguish a healthy loaded system from one
 *    actually under memory pressure; the jetsam level (what `memory_pressure
 *    -Q` and the sysctl above both expose) is the signal that means what we
 *    want it to mean.
 *  - linux: `/proc/pressure/memory`'s `some avg10=` (`parsePsiMemory`) is
 *    preferred (PSI captures actual stall time, not just headroom); when PSI
 *    is unreadable (no cgroup2 PSI support, permissions, etc.) this falls
 *    back to `/proc/meminfo`'s MemAvailable/MemTotal (`parseMemAvailablePct`)
 *    for the same "free%" semantics as the darwin signal.
 *
 * CPU signal (both platforms, no exec): `loadavg()[0] / ncpus` — 1-minute
 * load average per core, the same node:os primitives `resource-profile.ts`
 * already uses with no subprocess cost.
 *
 * Hysteresis: PER-SIGNAL, not combined — see `sampleHysteresis` below for
 * the shared level-triggered + dwell-guard mechanics, and each signal's own
 * HI/LO/direction. `underPressure()`'s combined result is the boolean OR of
 * the two signals' committed states (worst-of: pressure while ANY signal is
 * tripped, clears only once ALL have recovered past their LO with dwell).
 *
 * Fail-safe: `underPressure()`'s try/catch spans its ENTIRE body — every
 * sensor read AND all hysteresis bookkeeping. Any error (exec throws, file
 * read throws, unexpected shape) is treated as no-pressure for that call,
 * logged once, and the per-signal state machines are left untouched (a
 * transient failure doesn't corrupt dwell counters or fabricate a
 * transition) so a later successful sample picks back up cleanly. The
 * returned closure is therefore structurally unable to throw.
 */
import { execFileSync } from "node:child_process"
import { readFileSync as nodeReadFileSync } from "node:fs"
import * as os from "node:os"

// ── constants (spec values — do not retune here; observe mode exists for
//    calibration, see the plan's Risks §3) ─────────────────────────────────

/** Sensor samples the host at most this often. Bounds the cost of the
 * darwin `memory_pressure -Q` exec (~100ms, plan Risks §2) and the linux
 * `/proc` reads to one hit per window no matter how often `underPressure()`
 * is polled (scheduler scans can be much more frequent than this). */
export const PRESSURE_POLL_SEC = 20

/** Load-average-per-core enter/exit thresholds. >=2.0/core means more
 * runnable work than cores to run it on (queueing, not just busy); <=1.2
 * leaves headroom before re-admitting new launches. */
export const LOAD_HI = 2.0
export const LOAD_LO = 1.2

/** Memory free-percentage enter/exit thresholds (darwin `memory_pressure
 * -Q`, and the linux PSI-unavailable fallback). INVERTED direction: LOW
 * free% is the bad state, so HI (the enter-pressure threshold) is
 * numerically LESS than LO (the exit threshold) — `sampleHysteresis` below
 * special-cases this; it is not a typo. */
export const MEMFREE_HI_PCT = 10
export const MEMFREE_LO_PCT = 20

/** linux PSI `some avg10=` (percent of the last 10s some task stalled on
 * memory) enter/exit thresholds — same direction as load (higher = worse). */
export const PSI_HI = 25
export const PSI_LO = 10

/** Flap guard: consecutive samples a signal's desired state must hold before
 * a transition commits. At the default `PRESSURE_POLL_SEC=20`, `2` ticks is
 * a ~40s dwell — long enough to ignore a one-sample blip, short enough to
 * still react to a real sustained spike. A "tick" is a sample actually
 * taken; a cache-hit `underPressure()` call (see `PRESSURE_POLL_SEC`) never
 * advances this counter. */
export const MIN_STATE_TICKS = 2

// ── pure parsers (exported for fixture tests) ───────────────────────────────

/** darwin `memory_pressure -Q` stdout → free-percentage, or `null` if the
 * expected line is missing/malformed. Real captured shape (this host,
 * macOS 24.6.0):
 * ```
 * The system has 17179869184 (4194304 pages with a page size of 4096).
 * System-wide memory free percentage: 60%
 * ```
 */
export function parseMemoryPressureQ(stdout: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)%/.exec(stdout)
  if (!m) return null
  const pct = Number(m[1])
  return Number.isFinite(pct) ? pct : null
}

/** linux `/proc/pressure/memory`'s `some avg10=` line → percentage, or
 * `null` if missing/malformed. Format (kernel PSI docs):
 * ```
 * some avg10=0.00 avg60=0.00 avg300=0.00 total=0
 * full avg10=0.00 avg60=0.00 avg300=0.00 total=0
 * ```
 */
export function parsePsiMemory(text: string): number | null {
  const m = /^some\s+.*\bavg10=([\d.]+)/m.exec(text)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

/** linux `/proc/meminfo` MemTotal + MemAvailable → free-percentage, or
 * `null` if either field is missing/malformed/zero. Format:
 * ```
 * MemTotal:       16384000 kB
 * MemAvailable:    5000000 kB
 * ```
 */
export function parseMemAvailablePct(meminfo: string): number | null {
  const total = /^MemTotal:\s*(\d+)/m.exec(meminfo)
  const avail = /^MemAvailable:\s*(\d+)/m.exec(meminfo)
  if (!total || !avail) return null
  const totalKb = Number(total[1])
  const availKb = Number(avail[1])
  if (!Number.isFinite(totalKb) || totalKb <= 0 || !Number.isFinite(availKb)) return null
  return (availKb / totalKb) * 100
}

// ── per-signal hysteresis ────────────────────────────────────────────────

type Direction = "normal" | "inverted"

interface SignalState {
  committed: boolean
  pendingDesired: boolean | null
  ticks: number
}

function newSignalState(): SignalState {
  return { committed: false, pendingDesired: null, ticks: 0 }
}

/**
 * One signal's level-triggered hysteresis + flap-guard dwell.
 *
 * `direction: "normal"` (load/core, PSI): enter at `value >= hi`, exit at
 * `value <= lo`. `direction: "inverted"` (mem free%): enter at
 * `value <= hi`, exit at `value >= lo` — LOW is bad, so `hi` (the
 * enter-pressure threshold) is the numerically smaller of the pair.
 *
 * The desired state is recomputed from `value` on every call (level-
 * triggered, not edge-triggered) and only COMMITS to `state.committed` once
 * it has been the desired value for `MIN_STATE_TICKS` consecutive samples —
 * the guard delays a transition, it never loses one (a value that flickers
 * back before committing simply resets the streak, and the next sustained
 * run starts counting again).
 *
 * `value === null` (parser saw malformed/missing data this sample) freezes
 * the state entirely — neither advances the dwell counter nor changes
 * `committed` — so a transient bad read can't fabricate a transition in
 * either direction.
 */
function sampleHysteresis(state: SignalState, value: number | null, hi: number, lo: number, direction: Direction): boolean {
  if (value === null) return state.committed

  const desired =
    direction === "normal"
      ? state.committed
        ? value > lo // stay pressured until it drops to <= lo
        : value >= hi // enter pressure at >= hi
      : state.committed
        ? value < lo // stay pressured until it rises to >= lo
        : value <= hi // enter pressure at <= hi

  if (desired === state.committed) {
    // Reading agrees with the committed state — no streak to track.
    state.pendingDesired = null
    state.ticks = 0
    return state.committed
  }

  if (state.pendingDesired === desired) {
    state.ticks += 1
  } else {
    state.pendingDesired = desired
    state.ticks = 1
  }

  if (state.ticks >= MIN_STATE_TICKS) {
    state.committed = desired
    state.pendingDesired = null
    state.ticks = 0
  }

  return state.committed
}

// ── createHostPressure ───────────────────────────────────────────────────

/** Runs `memory_pressure -Q` and returns its stdout — injectable so tests
 * never shell out on darwin. Sync (not the async exec.ts machinery) because
 * this is a single cheap, bounded probe the sensor calls inline. */
export type PressureExecFn = (argv: string[]) => string

function defaultExec(argv: string[]): string {
  const [bin, ...rest] = argv
  return execFileSync(bin!, rest, { encoding: "utf-8" })
}

/** Reads a linux `/proc` file — injectable so tests never touch the real
 * filesystem. */
export type PressureReadFileFn = (path: string) => string

function defaultReadFile(path: string): string {
  return nodeReadFileSync(path, "utf-8")
}

export interface CreateHostPressureOpts {
  /** default: process.platform */
  platform?: NodeJS.Platform
  /** default: os.cpus().length */
  ncpus?: number
  /** default: os.loadavg */
  loadavg?: () => number[]
  /** default: a wrapper around node:child_process's execFileSync (darwin
   * `memory_pressure -Q` only — never called on other platforms). */
  execFn?: PressureExecFn
  /** default: a wrapper around node:fs's readFileSync (linux /proc reads
   * only — never called on other platforms). */
  readFile?: PressureReadFileFn
  /** default: Date.now */
  now?: () => number
  /** default: console.log. One call per emitted line (combined-state
   * changes, and the single fail-safe error line) — never called more than
   * once per `underPressure()` invocation. */
  log?: (line: string) => void
}

export interface HostPressure {
  /** Samples the host (at most once per PRESSURE_POLL_SEC, see the module
   * header) and returns the current combined pressure state. Structurally
   * cannot throw — see this module's fail-safe doc comment. */
  underPressure(): boolean
  /** Cheap, side-effect-free accessor for the last combined state computed
   * by `underPressure()` ("pressured" | "normal") — never samples, never
   * throws. */
  state(): string
}

function memPartLabel(reading: { value: number; kind: "psi" | "free" } | null): string {
  if (!reading) return ""
  return reading.kind === "free" ? `, mem ${Math.round(reading.value)}% free` : `, mem psi ${reading.value.toFixed(1)}%`
}

export function createHostPressure(opts: CreateHostPressureOpts = {}): HostPressure {
  const platform = opts.platform ?? process.platform
  const ncpus = opts.ncpus ?? os.cpus().length
  const loadavgFn = opts.loadavg ?? os.loadavg
  const execFn = opts.execFn ?? defaultExec
  const readFile = opts.readFile ?? defaultReadFile
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.log(line))

  const cpuState = newSignalState()
  const memState = newSignalState()

  let lastSampleMs: number | null = null
  let combined = false

  function readMemSignal(): { value: number; kind: "psi" | "free" } | null {
    if (platform === "darwin") {
      const stdout = execFn(["memory_pressure", "-Q"])
      const pct = parseMemoryPressureQ(stdout)
      return pct === null ? null : { value: pct, kind: "free" }
    }
    if (platform === "linux") {
      // PSI preferred; fall back to MemAvailable% when PSI is unreadable
      // (missing cgroup2 PSI support, permissions, etc. — a NORMAL,
      // designed fallback, not a failure) — a nested try/catch so a PSI
      // read failure doesn't abort the whole sample, only that source.
      // Deliberately narrow: this nested catch recovers ONLY the
      // PSI→MemAvailable fallback path. If the MemAvailable read below also
      // throws (both /proc sources genuinely gone), that's a real
      // environment failure, not a designed fallback — it propagates
      // uncaught out of this function, into underPressure()'s whole-body
      // try/catch (the module header's fail-safe boundary), which is the
      // intended place a real read failure gets swept into "no pressure,
      // log once" for the WHOLE sample (CPU signal included) rather than
      // silently degrading to "just skip memory". A malformed-but-readable
      // file (parser returns `null`) is different and handled locally right
      // below: that's not a read failure, so it just means "no memory
      // signal this sample" without touching the CPU signal at all.
      try {
        const psiText = readFile("/proc/pressure/memory")
        const psi = parsePsiMemory(psiText)
        if (psi !== null) return { value: psi, kind: "psi" }
      } catch {
        // fall through to MemAvailable
      }
      const meminfo = readFile("/proc/meminfo")
      const pct = parseMemAvailablePct(meminfo)
      return pct === null ? null : { value: pct, kind: "free" }
    }
    // Unknown platform: no memory source, CPU signal alone still applies.
    return null
  }

  function underPressure(): boolean {
    try {
      const nowMs = now()
      if (lastSampleMs !== null && nowMs - lastSampleMs < PRESSURE_POLL_SEC * 1000) {
        // Cache hit: a sample was NOT taken — advances no tick counter,
        // reads nothing, logs nothing.
        return combined
      }
      // Mark the sample attempt BEFORE the risky reads below so a
      // persistently-throwing exec/readFile still only retries once per
      // window (rather than re-attempting, and re-logging, on every call).
      lastSampleMs = nowMs

      const loadPerCore = loadavgFn()[0]! / ncpus
      const cpuCommitted = sampleHysteresis(cpuState, loadPerCore, LOAD_HI, LOAD_LO, "normal")

      const memReading = readMemSignal()
      const memCommitted =
        memReading === null
          ? memState.committed
          : sampleHysteresis(
              memState,
              memReading.value,
              memReading.kind === "psi" ? PSI_HI : MEMFREE_HI_PCT,
              memReading.kind === "psi" ? PSI_LO : MEMFREE_LO_PCT,
              memReading.kind === "psi" ? "normal" : "inverted",
            )

      const newCombined = cpuCommitted || memCommitted
      if (newCombined !== combined) {
        if (newCombined) {
          log(`  [pressure] paused launches (load/core ${loadPerCore.toFixed(1)}${memPartLabel(memReading)})`)
        } else {
          log(`  [pressure] resumed (load/core ${loadPerCore.toFixed(1)})`)
        }
      }
      combined = newCombined
      return combined
    } catch {
      // Fail-safe (module header): treat as no-pressure, log exactly once
      // for this call, leave every per-signal state machine untouched.
      log("  [pressure] sensor read failed — treating as no pressure")
      return false
    }
  }

  function state(): string {
    return combined ? "pressured" : "normal"
  }

  return { underPressure, state }
}
