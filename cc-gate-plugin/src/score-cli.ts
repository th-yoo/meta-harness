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
import { scoreLines, type ScoreResult, type SensorLineIn } from "./score.ts"

const DEFAULT_MIN_N = 20

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

function render(r: ScoreResult, minN: number): string {
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
  console.log(asJson ? JSON.stringify(result, null, 2) : render(result, minN))
}

if (import.meta.main) main()
