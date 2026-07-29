#!/usr/bin/env bun
/**
 * score-cli.ts — print the kkamak scorecard.
 *
 *   bun src/score-cli.ts [sensor.ndjson ...] [--pool] [--min-n N] [--json]
 *
 * With no file arguments, reads `.km/gate-outcomes.ndjson` under $PWD.
 * READ-ONLY: never writes, never adopts. Pre-registration:
 * docs/superpowers/specs/2026-07-28-kkamak-scorecard-preregistration.md
 */
import fs from "node:fs"
import path from "node:path"
import { classifyCycle, scoreLines, type ScoreResult, type SensorLineIn } from "./score.ts"

const DEFAULT_MIN_N = 20

// ── §4.3 trial block (§11 item 7) ───────────────────────────────────────
//
// This CLI is a leaf reporting tool: it must NOT import km-crank (the
// verdict engine) or take on cross-package build/runtime coupling for a
// read-only print. cc-gate-plugin does not import from opencode-plugin
// anywhere else in this package either, so — rather than establish a new
// cross-package import direction for one CLI's convenience — this is a
// deliberately minimal, LOCAL re-read of the exposure log.
//
// Canonical shape: `ExposureRow` / `readExposureRows` in
// opencode-plugin/src/trial-arm.ts. If that shape ever changes, this local
// mirror must be updated by hand — SINGLE-SOURCE risk accepted here in
// exchange for not adding an import edge this package doesn't otherwise
// have. (Flagged in the TM7 report for anyone reconsidering the tradeoff.)

type TrialArm = "baseline" | "trial"

interface ExposureRow {
  ts: number
  sessionID: string
  trialId: string
  layer: string
  arm: TrialArm
  forced: boolean
}

function isExposureRow(v: unknown): v is ExposureRow {
  if (v === null || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return (
    typeof r.ts === "number" &&
    typeof r.sessionID === "string" &&
    typeof r.trialId === "string" &&
    typeof r.layer === "string" &&
    (r.arm === "baseline" || r.arm === "trial") &&
    typeof r.forced === "boolean"
  )
}

/** Tolerant parse, mirroring opencode-plugin/src/trial-arm.ts's
 * readExposureRows: missing file -> [], corrupt/malformed lines skipped. */
function readExposureRowsLocal(file: string): ExposureRow[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const rows: ExposureRow[] = []
  for (const l of raw.split("\n")) {
    const s = l.trim()
    if (!s) continue
    try {
      const parsed = JSON.parse(s)
      if (isExposureRow(parsed)) rows.push(parsed)
    } catch {
      // corrupt line — skip
    }
  }
  return rows
}

/** `.km/trial-arms.ndjson` files found beside each target sensor file
 * (same directory), deduped. Absence for every target means the §4.3 block
 * is omitted entirely — the byte-identical-output regression contract. */
function exposureFilesFor(targets: string[]): string[] {
  const dirs = new Set(targets.map((t) => path.dirname(t)))
  const files: string[] = []
  for (const d of dirs) {
    const p = path.join(d, "trial-arms.ndjson")
    if (fs.existsSync(p)) files.push(p)
  }
  return files
}

function isJoinableSensorLine(l: unknown): l is SensorLineIn {
  return (
    typeof l === "object" && l !== null &&
    Array.isArray((l as SensorLineIn).rounds) &&
    typeof (l as SensorLineIn).sessionID === "string"
  )
}

interface TrialArmSummary {
  /** Metric-eligible cycles for this arm (gauge-only excluded) — §3 N_eff. */
  cycleCount: number
  /** Distinct sessions with ≥1 density-eligible line (gauge-only INCLUDED)
   * — §3 N_eff; also the exposure-density denominator. */
  sessionCount: number
  /** Distinct sessions with ≥1 clean/catch/exhausted line — §3 N_eff, the
   * quantity the §5 session floor checks. */
  sessionsWithGateCycle: number
  /** density-eligible line count / sessionCount (0 when no sessions) —
   * mirrors km-crank/src/trial-verdict.ts's densityOf. */
  density: number
}

interface TrialBlock {
  baseline: TrialArmSummary
  trial: TrialArmSummary
  /** Sensor lines whose matched exposure row was forced — excluded from
   * both arms' metrics/density above, counted here instead. */
  forcedCount: number
}

/**
 * Joins the read sensor lines against the exposure log by sessionID, mirroring
 * km-crank/src/trial-verdict.ts's join semantics where they apply to a plain
 * scorecard read (no trial state here, so no trialId/time-window/kkamak-dev
 * exclusions — those are the verdict engine's job, not this CLI's):
 *   - no exposure row for the session -> unmatched, attributed to neither arm;
 *   - row.forced -> excluded from all per-arm metrics/density, counted only
 *     in forcedCount;
 *   - otherwise -> attributed to the row's arm; gauge-only lines count
 *     toward density but not metrics (classifyCycle(l) !== "gauge-only").
 * First exposure row per sessionID wins on duplicates (same dedupe rule as
 * the canonical reader).
 */
function joinTrialArms(lines: SensorLineIn[], rows: ExposureRow[]): TrialBlock {
  const rowBySession = new Map<string, ExposureRow>()
  for (const r of rows) if (!rowBySession.has(r.sessionID)) rowBySession.set(r.sessionID, r)

  const density: Record<TrialArm, SensorLineIn[]> = { baseline: [], trial: [] }
  const metrics: Record<TrialArm, SensorLineIn[]> = { baseline: [], trial: [] }
  let forcedCount = 0

  for (const raw of lines) {
    if (!isJoinableSensorLine(raw)) continue
    const row = rowBySession.get(raw.sessionID)
    if (!row) continue // unmatched: no exposure row at all
    if (row.forced) {
      forcedCount++
      continue
    }
    density[row.arm].push(raw)
    if (classifyCycle(raw) !== "gauge-only") metrics[row.arm].push(raw)
  }

  const summarize = (arm: TrialArm): TrialArmSummary => {
    const d = density[arm]
    const m = metrics[arm]
    const sessionCount = new Set(d.map((l) => l.sessionID)).size
    const gateSessionIds = new Set<string>()
    for (const l of m) {
      const c = classifyCycle(l)
      if (c === "clean" || c === "catch" || c === "exhausted") gateSessionIds.add(l.sessionID)
    }
    return {
      cycleCount: m.length,
      sessionCount,
      sessionsWithGateCycle: gateSessionIds.size,
      density: sessionCount > 0 ? d.length / sessionCount : 0,
    }
  }

  return { baseline: summarize("baseline"), trial: summarize("trial"), forcedCount }
}

function readLines(files: string[]): { lines: SensorLineIn[]; unreadable: string[] } {
  const lines: SensorLineIn[] = []
  const unreadable: string[] = []
  for (const f of files) {
    let raw: string
    try {
      raw = fs.readFileSync(f, "utf-8")
    } catch {
      unreadable.push(f)
      continue
    }
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue
      try {
        lines.push(JSON.parse(l))
      } catch {
        lines.push(null as unknown as SensorLineIn) // counted as skipped downstream
      }
    }
  }
  return { lines, unreadable }
}

const pct = (x: number | null): string => (x === null ? "  n/a" : `${(x * 100).toFixed(1)}%`)
const ms = (x: number | null): string => (x === null ? "n/a" : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`)

function render(r: ScoreResult, minN: number, trial?: TrialBlock): string {
  const out: string[] = []
  out.push("kkamak scorecard — read-only; see the pre-registration before quoting any number.")
  out.push("")

  if (!r.groups.length) {
    out.push("No sensor lines found.")
    return out.join("\n")
  }

  for (const g of r.groups.sort((a, b) => b.gateCycles - a.gateCycles)) {
    const c = g.counts
    out.push(`── ${g.host} · ${g.check}`)
    out.push(
      `   cycles ${g.gateCycles}` +
      `  (clean ${c.clean}, catch ${c.catch}, exhausted ${c.exhausted}` +
      `, interrupted ${c.interrupted}${c.gaugeOnly ? `, gauge-only ${c.gaugeOnly}` : ""})`,
    )
    out.push(
      `   M-catch ${pct(g.mCatch)}   M-exhaust ${pct(g.mExhaust)}` +
      `   M-interrupt ${pct(g.mInterrupt)}   M-tax ${ms(g.mTaxMedianMs)}`,
    )
    if (g.mRounds.length) out.push(`   rounds-to-accept: ${g.mRounds.join(", ")}`)
    if (g.underpowered) {
      out.push(`   ⚠ under ${minN} cycles — rates suppressed (a rate over a handful of cycles is noise)`)
    }
    out.push("")
  }

  const { v0, v1 } = r.arms
  if (v0.gateCycles + v1.gateCycles + v0.counts.interrupted + v1.counts.interrupted > 0) {
    out.push(`── §4.4 reinject wording (within-workload randomised by session)`)
    for (const [name, a] of [["v0 control ", v0], ["v1 candidate", v1]] as const) {
      out.push(
        `   ${name}  cycles ${String(a.gateCycles).padStart(4)}` +
        `   M-catch ${pct(a.mCatch)}   M-exhaust ${pct(a.mExhaust)}   M-interrupt ${pct(a.mInterrupt)}`,
      )
    }
    if (v0.underpowered || v1.underpowered) {
      out.push(`   ⚠ an arm is under ${minN} cycles — no comparison yet`)
    } else if (v1.mInterrupt !== null && v0.mInterrupt !== null && v1.mCatch !== null && v0.mCatch !== null) {
      const wins = v1.mInterrupt <= v0.mInterrupt && v1.mCatch >= v0.mCatch
      out.push(`   pre-registered rule: adopt v1 iff M-interrupt(v1) ≤ v0 AND M-catch(v1) ≥ v0 → ${wins ? "ADOPT v1" : "KEEP v0"}`)
    }
    out.push("")
  }

  if (trial) {
    out.push(`── §4.3 trial (per-arm N_eff + exposure guard; pre-registration: docs/superpowers/specs/2026-07-29-trial-mode-gate-outcomes-preregistration.md)`)
    for (const [name, a] of [["baseline", trial.baseline], ["trial   ", trial.trial]] as const) {
      out.push(
        `   ${name}  cycles ${String(a.cycleCount).padStart(4)}` +
        `   sessions ${String(a.sessionCount).padStart(3)}` +
        `   sessions-w-cycle ${String(a.sessionsWithGateCycle).padStart(3)}` +
        `   density ${a.density.toFixed(2)}`,
      )
    }
    out.push(`   forced (excluded): ${trial.forcedCount}`)
    out.push("")
  }

  const gg = r.gauge
  if (gg.present) {
    out.push(`── km-gauge (shadow)`)
    out.push(
      `   present ${gg.present}, executable ${gg.executable}, refused ${gg.refused}` +
      `, would-have-blocked ${gg.wouldBlock}, disagreed-with-floor ${gg.disagreedWithFloor}`,
    )
    const bc = gg.byClass
    out.push(
      `   classes A1 ${bc.A1} · A2 ${bc.A2} · B ${bc.B} · C ${bc.C} · D ${bc.D} · downgraded ${gg.downgraded}`,
    )
    out.push("")
  }

  if (r.skipped) out.push(`(${r.skipped} malformed line(s) skipped)`)

  out.push("Claimable: a fall in M-exhaust or M-interrupt at non-decreasing M-catch.")
  out.push("NOT claimable: M-catch alone, or kkamak's value — both need the §4.3 counterfactual.")
  return out.join("\n")
}

function main(): void {
  const argv = process.argv.slice(2)
  const pool = argv.includes("--pool")
  const asJson = argv.includes("--json")
  const minNIdx = argv.indexOf("--min-n")
  const minN = minNIdx >= 0 ? Number(argv[minNIdx + 1]) : DEFAULT_MIN_N
  if (!Number.isFinite(minN) || minN < 1) {
    console.error("score-cli: --min-n needs a positive number")
    process.exit(2)
  }

  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--min-n")
  const targets = files.length ? files : [path.join(process.cwd(), ".km", "gate-outcomes.ndjson")]

  const { lines, unreadable } = readLines(targets)
  for (const f of unreadable) console.error(`score-cli: cannot read ${f}`)

  const result = scoreLines(lines, { minN, pool })

  const exposureFiles = exposureFilesFor(targets)
  const trial = exposureFiles.length
    ? joinTrialArms(lines, exposureFiles.flatMap(readExposureRowsLocal))
    : undefined

  console.log(asJson ? JSON.stringify(result, null, 2) : render(result, minN, trial))
}

if (import.meta.main) main()
