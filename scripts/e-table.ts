#!/usr/bin/env bun
/**
 * E (effect-size) days-to-verdict table — thin CLI
 * (spec docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md;
 * plan docs/superpowers/plans/2026-08-05-loop-probes.md Task 3). Zero
 * model calls: reads the two already-committed probe outputs (P0
 * signal-variance, P1 event-density) and crosses every P0-VIABLE signal
 * against every P1 source with eventsPerDay > 0. All math (nPerArmCount,
 * nPerArmBinomial, daysToVerdict) is Task-1's pure functions in
 * km-crank/src/loop-probes.ts — this file only wires files, applies the
 * MIN_N=20 floor (the CALLER's job per that module's own doc comment),
 * and shapes JSON/stdout. Never reimplement the formulas here.
 *
 * CONCEPTUAL GUARD (spec-adjacent, task-3 brief): a signal x source
 * pairing is only MEANINGFUL if that source can actually emit that
 * signal today. b2 (review findings-count) arrives via review passes,
 * which is what s3 (review adds/day) measures -> b2 x s3 is the one
 * meaningful pairing. b4 (bench pass@k) arrives via bench runs; no P1
 * source measures bench-run cadence, so every b4 cross is meaningful:
 * false. Every OTHER cross (any signal x any source that isn't b2 x s3)
 * is a CAPACITY row only — "if events arrived on this source at this
 * rate" — not a claim that the pairing exists today. The PASS /
 * NO-CONFIG-PASSES verdict counts ONLY meaningful crosses; capacity-only
 * crosses are context, never inputs to the bar.
 *
 * s4 is EXCLUDED from the P1 side entirely: it's a boundary-split view of
 * s1 (the same gate-outcomes ndjson stream, re-segmented at one more
 * boundary), not an independent event source — pairing it here would
 * double-count s1's rate under a second name.
 *
 * Env overrides (test seam ONLY — production omits both):
 *   KKAMAK_PROBE_P0_JSON, KKAMAK_PROBE_P1_JSON
 * Production defaults: docs/loop-probes/<hostname>-p0-signal-variance.json
 * and docs/loop-probes/<hostname>-p1-event-density.json, both relative to
 * process.cwd() (both are committed and identical across hosts/worktrees,
 * like P0/P1's own REVIEWS_DIR_DEFAULT/TB2_VERDICT_DEFAULT).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nPerArmCount, nPerArmBinomial, daysToVerdict } from "../km-crank/src/loop-probes.ts"

export const SPEC_PATH = "docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md"
export const EFFECTS = [0.10, 0.20, 0.30, 0.40] as const
export const MIN_N = 20
export const BAR_EFFECT = 0.30
export const BAR_DAYS = 14

export function p0JsonPath(): string {
  return process.env.KKAMAK_PROBE_P0_JSON
    ?? path.join(process.cwd(), "docs", "loop-probes", `${os.hostname()}-p0-signal-variance.json`)
}
export function p1JsonPath(): string {
  return process.env.KKAMAK_PROBE_P1_JSON
    ?? path.join(process.cwd(), "docs", "loop-probes", `${os.hostname()}-p1-event-density.json`)
}

// ---------------------------------------------------------------------
// Minimal P0/P1 doc shapes — just enough of Task-2's output jsons to
// locate signals/sources; every field optional (tolerant reads, matching
// p0-signal-variance.ts / p1-event-density.ts's own degrade-not-crash
// style for missing/malformed data).
// ---------------------------------------------------------------------

interface P0SignalStats {
  mean?: number; sd?: number
  successes?: number; failures?: number
  [key: string]: unknown // boolean/categorical stats carry other fields (trueCount, classes, ...) we don't read
}
interface P0SignalDoc { family?: string; viability?: string; stats?: P0SignalStats }
interface P0Doc {
  b1?: { accepted?: P0SignalDoc; gateExhausted?: P0SignalDoc; roundsLength?: P0SignalDoc; durationMs?: P0SignalDoc }
  b2?: P0SignalDoc
  // b3's real shape (Task 2) carries `family`/`binarization` at the b3
  // level, NOT per provenance entry — each entry is just {n, stats,
  // viability}. toSignal needs the family injected (see withFamily
  // below), or a categorical-but-family-less entry silently vanishes
  // instead of landing in `excluded` with a reason.
  b3?: { family?: string; provenance?: { live?: P0SignalDoc; corpusTranscript?: P0SignalDoc } }
  b4?: P0SignalDoc
}

interface P1RepoEntry { label?: string; commitsPerDay?: number }
interface P1Doc {
  s1?: { eventsPerDay?: number }
  s2?: { repos?: P1RepoEntry[] }
  s3?: { addsPerDay?: number }
  s4?: unknown
}

// ---------------------------------------------------------------------
// P0 signal extraction — a fixed, hand-maintained list of every named
// signal P0 (Task 2) can emit, mirroring its own output shape exactly.
// Deliberately not a generic deep-walk: P0's shape is fixed by that CLI,
// so naming each signal explicitly keeps `excluded` reasons legible
// instead of guessing at arbitrary JSON structure.
// ---------------------------------------------------------------------

export interface P0Signal {
  label: string
  family: string
  viability: string
  moments?: { mean: number; sd: number }
  rate?: { successes: number; failures: number }
}

export interface ExcludedEntry {
  type: "p0-signal" | "p1-source"
  label: string
  reason: string
  family?: string
  viability?: string
}

/** `fallbackFamily` covers b3: its provenance entries (live/
 * corpusTranscript) carry no `family` of their own — that lives one
 * level up, at b3.family — so without the fallback they'd silently
 * vanish from allP0Signals instead of surfacing in `excluded`. */
function toSignal(label: string, node: P0SignalDoc | undefined, fallbackFamily?: string): P0Signal | undefined {
  if (!node) return undefined
  const family = typeof node.family === "string" ? node.family : (fallbackFamily ?? "unknown")
  const stats = node.stats
  const moments = stats && typeof stats.mean === "number" && typeof stats.sd === "number"
    ? { mean: stats.mean, sd: stats.sd } : undefined
  const rate = stats && typeof stats.successes === "number" && typeof stats.failures === "number"
    ? { successes: stats.successes, failures: stats.failures } : undefined
  return { label, family, viability: typeof node.viability === "string" ? node.viability : String(node.viability), moments, rate }
}

export function allP0Signals(doc: P0Doc): P0Signal[] {
  const out: P0Signal[] = []
  const maybePush = (label: string, node: P0SignalDoc | undefined, fallbackFamily?: string) => {
    const s = toSignal(label, node, fallbackFamily)
    if (s) out.push(s)
  }
  maybePush("b1.accepted", doc.b1?.accepted)
  maybePush("b1.gateExhausted", doc.b1?.gateExhausted)
  maybePush("b1.roundsLength", doc.b1?.roundsLength)
  maybePush("b1.durationMs", doc.b1?.durationMs)
  maybePush("b2", doc.b2)
  maybePush("b3.live", doc.b3?.provenance?.live, doc.b3?.family)
  maybePush("b3.corpusTranscript", doc.b3?.provenance?.corpusTranscript, doc.b3?.family)
  maybePush("b4", doc.b4)
  return out
}

/** Families this CLI has an E-table formula for (task-3 scope, brief
 * verbatim): count -> nPerArmCount, rate -> nPerArmBinomial. A
 * hypothetical VIABLE boolean/categorical signal (none exist in the
 * current committed P0 json) is excluded with a reason rather than
 * silently coerced into one of these two formulas. */
const SUPPORTED_FAMILIES = new Set(["count", "rate"])

/** VIABLE, formula-supported signals; every excluded candidate (not
 * VIABLE, unsupported family, or missing the stats its family needs)
 * pushed onto `excluded` with a legible reason. */
export function viableSignals(doc: P0Doc, excluded: ExcludedEntry[]): P0Signal[] {
  const out: P0Signal[] = []
  for (const s of allP0Signals(doc)) {
    if (s.viability !== "VIABLE") {
      excluded.push({ type: "p0-signal", label: s.label, family: s.family, viability: s.viability, reason: `viability = ${s.viability}, not VIABLE` })
      continue
    }
    if (!SUPPORTED_FAMILIES.has(s.family)) {
      excluded.push({ type: "p0-signal", label: s.label, family: s.family, viability: s.viability, reason: `family '${s.family}' has no E-table formula (task-3 scope: count, rate only)` })
      continue
    }
    if (s.family === "count" && !s.moments) {
      excluded.push({ type: "p0-signal", label: s.label, family: s.family, viability: s.viability, reason: "VIABLE count signal missing stats.mean/sd" })
      continue
    }
    if (s.family === "rate" && !s.rate) {
      excluded.push({ type: "p0-signal", label: s.label, family: s.family, viability: s.viability, reason: "VIABLE rate signal missing stats.successes/failures" })
      continue
    }
    out.push(s)
  }
  return out
}

// ---------------------------------------------------------------------
// P1 source extraction — s1 (single), s2 (one per repo entry, labeled
// "s2:<label>"), s3 (single). s4 is ALWAYS excluded (see file doc
// comment); any source with eventsPerDay <= 0 is excluded too (a verdict
// is never reachable at zero event rate — mirrors daysToVerdict's own
// null-at-zero contract).
// ---------------------------------------------------------------------

export interface P1Source { label: string; eventsPerDay: number }

export function viableP1Sources(doc: P1Doc, excluded: ExcludedEntry[]): P1Source[] {
  const candidates: P1Source[] = []
  if (typeof doc.s1?.eventsPerDay === "number") candidates.push({ label: "s1", eventsPerDay: doc.s1.eventsPerDay })
  for (const r of doc.s2?.repos ?? []) {
    if (typeof r.label === "string" && typeof r.commitsPerDay === "number") {
      candidates.push({ label: `s2:${r.label}`, eventsPerDay: r.commitsPerDay })
    }
  }
  if (typeof doc.s3?.addsPerDay === "number") candidates.push({ label: "s3", eventsPerDay: doc.s3.addsPerDay })

  excluded.push({
    type: "p1-source", label: "s4",
    reason: "boundary-split view of s1 (same ndjson stream re-segmented), not an independent event source",
  })

  const out: P1Source[] = []
  for (const c of candidates) {
    if (c.eventsPerDay > 0) out.push(c)
    else excluded.push({ type: "p1-source", label: c.label, reason: "eventsPerDay is 0" })
  }
  return out
}

// ---------------------------------------------------------------------
// Crosses — every viable signal x every viable source, effects
// {0.10,0.20,0.30,0.40}, MIN_N=20 floor, days-to-verdict.
// ---------------------------------------------------------------------

export interface EffectRow { effect: number; nPerArm: number; floored: number; daysToVerdict: number | null }
export interface Cross {
  signal: string; source: string; family: string
  p1OrMoments: { p1: number } | { mean: number; sd: number }
  effects: EffectRow[]
  passesBarAt030: boolean
  meaningful: boolean
  reason?: string
}

/** The one pairing where the source can actually carry the signal today
 * (task-3 brief, verbatim): b2 (review findings) rides s3 (review
 * adds/day). Every other pairing is capacity-only. */
function meaningfulPairing(signalLabel: string, sourceLabel: string): { meaningful: boolean; reason?: string } {
  if (signalLabel === "b2" && sourceLabel === "s3") return { meaningful: true }
  return { meaningful: false, reason: "signal does not ride this source today" }
}

export function buildCross(signal: P0Signal, source: P1Source): Cross {
  const p1OrMoments: Cross["p1OrMoments"] = signal.family === "rate"
    ? { p1: signal.rate!.successes / (signal.rate!.successes + signal.rate!.failures) }
    : { mean: signal.moments!.mean, sd: signal.moments!.sd }

  const effects: EffectRow[] = EFFECTS.map(effect => {
    const nPerArm = signal.family === "rate"
      ? nPerArmBinomial((p1OrMoments as { p1: number }).p1, effect)
      : nPerArmCount(effect)
    const floored = Math.max(nPerArm, MIN_N)
    return { effect, nPerArm, floored, daysToVerdict: daysToVerdict(floored, source.eventsPerDay) }
  })

  const barRow = effects.find(e => e.effect === BAR_EFFECT)!
  const passesBarAt030 = barRow.daysToVerdict !== null && barRow.daysToVerdict <= BAR_DAYS

  const { meaningful, reason } = meaningfulPairing(signal.label, source.label)

  return { signal: signal.label, source: source.label, family: signal.family, p1OrMoments, effects, passesBarAt030, meaningful, reason }
}

export function buildCrosses(signals: P0Signal[], sources: P1Source[]): Cross[] {
  const out: Cross[] = []
  for (const s of signals) for (const src of sources) out.push(buildCross(s, src))
  return out
}

// ---------------------------------------------------------------------
// Verdict — counts ONLY meaningful crosses (capacity-only crosses never
// factor into PASS/NO-CONFIG-PASSES, per the conceptual guard above).
// ---------------------------------------------------------------------

export interface Verdict { meaningfulCrosses: number; passing: number; verdict: "PASS" | "NO-CONFIG-PASSES" }

export function buildVerdict(crosses: Cross[]): Verdict {
  const meaningful = crosses.filter(c => c.meaningful)
  const passing = meaningful.filter(c => c.passesBarAt030)
  return { meaningfulCrosses: meaningful.length, passing: passing.length, verdict: passing.length > 0 ? "PASS" : "NO-CONFIG-PASSES" }
}

// ---------------------------------------------------------------------
// Full table
// ---------------------------------------------------------------------

export interface ETableOutput {
  spec: string
  generatedAtTs: number
  hostname: string
  inputs: { p0: string; p1: string }
  crosses: Cross[]
  excluded: ExcludedEntry[]
  verdict: Verdict
}

export function buildETable(
  p0Doc: P0Doc, p1Doc: P1Doc, p0Path: string, p1Path: string, hostname: string, generatedAtTs: number,
): ETableOutput {
  const excluded: ExcludedEntry[] = []
  const signals = viableSignals(p0Doc, excluded)
  const sources = viableP1Sources(p1Doc, excluded)
  const crosses = buildCrosses(signals, sources)
  const verdict = buildVerdict(crosses)
  return { spec: SPEC_PATH, generatedAtTs, hostname, inputs: { p0: p0Path, p1: p1Path }, crosses, excluded, verdict }
}

// ---------------------------------------------------------------------
// Human-readable stdout table
// ---------------------------------------------------------------------

export function renderTable(out: ETableOutput): string {
  const lines: string[] = []
  lines.push(`E days-to-verdict table (${out.hostname})`)
  lines.push(`meaningful crosses: ${out.verdict.meaningfulCrosses}, passing (<=${BAR_DAYS}d @${BAR_EFFECT}): ${out.verdict.passing}, verdict: ${out.verdict.verdict}`)
  lines.push("")
  lines.push("signal           source           family  meaningful  d=.10  d=.20  d=.30  d=.40  passBar@.30")
  for (const c of out.crosses) {
    const days = c.effects.map(e => (e.daysToVerdict === null ? "inf" : String(e.daysToVerdict)))
    lines.push([
      c.signal.padEnd(16), c.source.padEnd(16), c.family.padEnd(7), String(c.meaningful).padEnd(11),
      ...days.map(d => d.padStart(5)), c.passesBarAt030 ? "yes" : "no",
    ].join(" "))
  }
  if (out.excluded.length > 0) {
    lines.push("")
    lines.push("excluded:")
    for (const e of out.excluded) lines.push(`  ${e.type} ${e.label}: ${e.reason}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

function main(): void {
  const p0Path = p0JsonPath()
  const p1Path = p1JsonPath()
  const p0Doc = JSON.parse(fs.readFileSync(p0Path, "utf8")) as P0Doc
  const p1Doc = JSON.parse(fs.readFileSync(p1Path, "utf8")) as P1Doc
  const hostname = os.hostname()

  const output = buildETable(p0Doc, p1Doc, p0Path, p1Path, hostname, Date.now())

  const outDir = path.join(process.cwd(), "docs", "loop-probes")
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${hostname}-e-table.json`)
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n")

  console.log(renderTable(output))
  console.log(`\ne-table: wrote ${outFile}`)
}

if (import.meta.main) main()
