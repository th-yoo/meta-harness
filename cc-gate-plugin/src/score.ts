// kkamak scorecard — pure aggregation over the sensor stream.
// Pre-registration: docs/superpowers/specs/
//   2026-07-28-kkamak-scorecard-preregistration.md
//
// Answers "is kkamak getting less wrong and less annoying?" — NOT "is kkamak
// worth running?", which needs a counterfactual the sensor cannot observe.
//
// PURE: no fs, no process. score-cli.ts owns the IO.
import type { GaugePromptClass, GaugeSensorField, SensorLine } from "./types.ts"

/** A sensor line as read back from ndjson — same shape, but untrusted. */
export type SensorLineIn = SensorLine & { gauge?: GaugeSensorField }

export type CycleClass = "interrupted" | "exhausted" | "catch" | "clean" | "gauge-only" | "skipped-stop"

/**
 * Pre-reg §1 taxonomy, in precedence order. `accepted` is true on BOTH catch
 * and exhausted lines (schema parity with the opencode plugin), so it must
 * never be read as success on its own.
 *
 * `skipped-stop` MUST be checked before the empty-rounds `gauge-only`
 * branch below (Task 1, fix-them-serialized-teacup plan, round-1 review
 * Critical 1) — a skipped-stop line also carries `rounds: []`, so checking
 * gauge-only first would swallow every skipped-stop line into gauge-only
 * and defeat the whole fix.
 */
export function classifyCycle(l: SensorLineIn): CycleClass {
  if (l.interrupted) return "interrupted"
  if (l.skippedStop) return "skipped-stop"
  if (l.rounds.length === 0) return "gauge-only" // fabricated on a fast-path Stop
  if (l.gateExhausted) return "exhausted"
  const last = l.rounds[l.rounds.length - 1]
  if (last === "accepted" && l.rounds.length > 1) return "catch"
  if (last === "accepted") return "clean"
  return "exhausted" // non-accepted terminal outcome without the flag: treat as failure to converge
}

export interface GroupScore {
  check: string
  host: string
  counts: {
    clean: number
    catch: number
    exhausted: number
    interrupted: number
    gaugeOnly: number
    /** Task 1 (fix-them-serialized-teacup plan): populated by scoreGroup's
     * switch below; excluded from every rate denominator, same as
     * gaugeOnly. */
    skippedStop: number
  }
  /** Converged cycles: clean + catch + exhausted (the rate denominator). */
  gateCycles: number
  /** True when gateCycles < minN — every rate is suppressed to null. */
  underpowered: boolean
  mCatch: number | null
  mExhaust: number | null
  mInterrupt: number | null
  mTaxMedianMs: number | null
  /** rounds.length distribution over catch cycles, ascending. */
  mRounds: number[]
}

/** km-gauge v2 prompt-class counts (pre-reg §2.1/§2.2 extension). */
export type GaugeByClass = Record<GaugePromptClass, number>

export interface GaugeScore {
  present: number
  executable: number
  refused: number
  wouldBlock: number
  disagreedWithFloor: number
  /** Count per class (v2-window lines only — class presence is the filter). */
  byClass: GaugeByClass
  /** Count of lines whose gauge carries a `downgraded` record. */
  downgraded: number
}

export interface ScoreResult {
  groups: GroupScore[]
  /** §4.4 reinject experiment, split by arm (pre-reg §4b). */
  arms: { v0: GroupScore; v1: GroupScore }
  gauge: GaugeScore
  /** Lines that were not usable at all (malformed ndjson rows). */
  skipped: number
}

export interface ScoreOpts {
  /** Rates below this many converged cycles are suppressed (pre-reg §4). */
  minN: number
  /** Explicit opt-in to merge every (check, host) group — must be stated in any claim. */
  pool?: boolean
}

function isUsable(l: unknown): l is SensorLineIn {
  return (
    typeof l === "object" && l !== null &&
    Array.isArray((l as SensorLineIn).rounds) &&
    typeof (l as SensorLineIn).check === "string"
  )
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export function scoreLines(lines: SensorLineIn[], opts: ScoreOpts): ScoreResult {
  const gauge: GaugeScore = {
    present: 0,
    executable: 0,
    refused: 0,
    wouldBlock: 0,
    disagreedWithFloor: 0,
    byClass: { A1: 0, A2: 0, B: 0, C: 0, D: 0 },
    downgraded: 0,
  }
  let skipped = 0

  const buckets = new Map<string, { check: string; host: string; lines: SensorLineIn[] }>()

  for (const raw of lines) {
    if (!isUsable(raw)) {
      skipped++
      continue
    }
    const check = opts.pool ? "(pooled)" : raw.check
    const host = opts.pool ? "(pooled)" : (raw.host ?? "unknown")
    // Group key: `check` is an arbitrary shell command string (from
    // gate.json) with an unconstrained domain -- any single-character
    // separator (tab, section-sign, ...) is a gamble that it never shows up
    // inside a check string on some host. JSON.stringify of the pair is
    // unambiguous by construction (quotes/backslashes inside check or host
    // are escaped by JSON itself, so two different (check, host) pairs can
    // never serialize to the same key) and stays plain printable UTF-8,
    // unlike the previous NUL-joined key, which put a raw \0 byte in this
    // SOURCE FILE and made git treat score.ts as binary (recorded nuisance).
    const key = JSON.stringify([check, host])
    let b = buckets.get(key)
    if (!b) {
      b = { check, host, lines: [] }
      buckets.set(key, b)
    }
    b.lines.push(raw)

    // Gauge counters span ALL lines, gate cycle or not — but are RE-SCOPED
    // to the v2 window: class presence is the filter (only the v2 refiner
    // stamps `class`), so a class-less v1 PoC line contributes ZERO here —
    // else v1's 9/10 false-block data would silently blend into v2's
    // M1v2/M2 headline numbers.
    const g = raw.gauge
    if (g?.present && g.class !== undefined) {
      gauge.present++
      if (g.executable) gauge.executable++
      if (g.refused) gauge.refused++
      if (g.wouldBlock) gauge.wouldBlock++
      if (g.agreesWithFloor === false) gauge.disagreedWithFloor++
      if (g.class in gauge.byClass) gauge.byClass[g.class]++ // membership guard: corrupted class strings must not create NaN keys
      if (g.downgraded) gauge.downgraded++
    }
  }

  const groups: GroupScore[] = []
  for (const b of buckets.values()) groups.push(scoreGroup(b.check, b.host, b.lines, opts))

  // Arm split: only lines that actually recorded an arm participate. A line
  // without one predates the experiment and belongs to neither arm.
  const usable = lines.filter(isUsable)
  const arms = {
    v0: scoreGroup("v0", "arm", usable.filter((l) => l.reinject === "v0"), opts),
    v1: scoreGroup("v1", "arm", usable.filter((l) => l.reinject === "v1"), opts),
  }

  return { groups, arms, gauge, skipped }
}

function scoreGroup(check: string, host: string, lines: SensorLineIn[], opts: ScoreOpts): GroupScore {
  {
    const b = { check, host, lines }
    const counts = { clean: 0, catch: 0, exhausted: 0, interrupted: 0, gaugeOnly: 0, skippedStop: 0 }
    const cleanDurations: number[] = []
    const catchRounds: number[] = []

    for (const l of b.lines) {
      switch (classifyCycle(l)) {
        case "clean":
          counts.clean++
          if (typeof l.durationMs === "number") cleanDurations.push(l.durationMs)
          break
        case "catch":
          counts.catch++
          catchRounds.push(l.rounds.length)
          break
        case "exhausted": counts.exhausted++; break
        case "interrupted": counts.interrupted++; break
        case "gauge-only": counts.gaugeOnly++; break
        case "skipped-stop": counts.skippedStop++; break
      }
    }

    const gateCycles = counts.clean + counts.catch + counts.exhausted
    const allCycles = gateCycles + counts.interrupted

    // Each rate is suppressed on ITS OWN denominator — M-interrupt is scored
    // over all cycles, so a group can be too thin for M-catch yet fine for it.
    const enough = (denom: number) => denom >= opts.minN && denom > 0

    return {
      check: b.check,
      host: b.host,
      counts,
      gateCycles,
      underpowered: gateCycles < opts.minN,
      mCatch: enough(gateCycles) ? counts.catch / gateCycles : null,
      mExhaust: enough(gateCycles) ? counts.exhausted / gateCycles : null,
      mInterrupt: enough(allCycles) ? counts.interrupted / allCycles : null,
      mTaxMedianMs: enough(cleanDurations.length) ? median(cleanDurations) : null,
      mRounds: catchRounds.sort((a, b2) => a - b2),
    }
  }
}
