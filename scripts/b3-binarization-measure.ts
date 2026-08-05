#!/usr/bin/env bun
/**
 * B3 binarization measurement — zero model calls. Basis for the B3 ruling
 * (D vs rest) recorded in
 * docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md.
 *
 * For each candidate binarization of the gauge class distribution
 * (P0 json b3 counts): viability floors (minority >=3 count AND >=0.1
 * rate) + nPerArmBinomial at effects {0.10,0.20,0.30,0.40} +
 * daysToVerdict on the P1 sources AND the MEASURED gauge-emission
 * cadence — b3.live's true carrier is gauge derivations
 * (`gauge.present === true` lines in gate-outcomes.ndjson, trailing
 * 7-day window per P1 convention), not Stops: s1's rate overstates it.
 *
 * Formulas imported from km-crank/src/loop-probes.ts — never reimplement.
 * Run from repo root: bun scripts/b3-binarization-measure.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nPerArmBinomial, daysToVerdict } from "../km-crank/src/loop-probes.ts"

const EFFECTS = [0.10, 0.20, 0.30, 0.40]
const MIN_N = 20
const BAR_DAYS = 14

const p0Path = process.env.KKAMAK_PROBE_P0_JSON
  ?? path.join(process.cwd(), "docs", "loop-probes", `${os.hostname()}-p0-signal-variance.json`)
const p1Path = process.env.KKAMAK_PROBE_P1_JSON
  ?? path.join(process.cwd(), "docs", "loop-probes", `${os.hostname()}-p1-event-density.json`)
const p0 = JSON.parse(fs.readFileSync(p0Path, "utf8"))
const p1 = JSON.parse(fs.readFileSync(p1Path, "utf8"))

const live: Record<string, number> = p0.b3?.provenance?.live?.stats?.classes ?? {}
const corpus: Record<string, number> = p0.b3?.provenance?.corpusTranscript?.stats?.classes ?? {}

const sources: Record<string, number> = {}
if (typeof p1.s1?.eventsPerDay === "number") sources.s1 = p1.s1.eventsPerDay
for (const r of p1.s2?.repos ?? []) {
  if (typeof r.label === "string" && typeof r.commitsPerDay === "number") sources[`s2:${r.label}`] = r.commitsPerDay
}
if (typeof p1.s3?.addsPerDay === "number") sources.s3 = p1.s3.addsPerDay

// Measured gauge-emission cadence (the true b3.live carrier).
const ndPath = path.join(process.cwd(), ".km", "gate-outcomes.ndjson")
const nd = fs.readFileSync(ndPath, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((r): r is { ts: number; gauge?: { present?: boolean } } => r !== null && typeof r.ts === "number")
const nowTs = Math.max(...nd.map((r) => r.ts))
const winLo = nowTs - 7 * 86400_000
const win = nd.filter((r) => r.ts >= winLo)
const gaugePresent = win.filter((r) => r.gauge?.present === true)
const spanDays = (nowTs - Math.max(winLo, Math.min(...win.map((r) => r.ts)))) / 86400_000
const gaugePerDay = gaugePresent.length / spanDays
sources["s-gauge(measured)"] = gaugePerDay

const candidates: Array<{ name: string; pick: (c: Record<string, number>) => number }> = [
  { name: "D vs rest", pick: (c) => c.D ?? 0 },
  { name: "C vs not-C", pick: (c) => c.C ?? 0 },
  { name: "B+C vs rest", pick: (c) => (c.B ?? 0) + (c.C ?? 0) },
  { name: "A1 vs rest", pick: (c) => c.A1 ?? 0 },
  { name: "A1+A2 vs rest", pick: (c) => (c.A1 ?? 0) + (c.A2 ?? 0) },
]

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0)

console.log(`gauge-emission cadence: ${gaugePresent.length} gauge.present / ${spanDays.toFixed(2)}d = ${gaugePerDay.toFixed(2)}/day (${win.length} Stops in window)`)

for (const prov of [{ label: "live", c: live }, { label: "corpusTranscript", c: corpus }]) {
  const n = sum(prov.c)
  if (n === 0) { console.log(`\n=== provenance ${prov.label}: no counts ===`); continue }
  console.log(`\n=== provenance ${prov.label} (n=${n}) ===`)
  for (const cand of candidates) {
    const positive = cand.pick(prov.c)
    const p = positive / n
    const minorityCount = Math.min(positive, n - positive)
    const minorityRate = minorityCount / n
    const floorPass = minorityCount >= 3 && minorityRate >= 0.1
    const rows = EFFECTS.map((e) => ({ e, nArm: Math.max(nPerArmBinomial(p, e), MIN_N) }))
    console.log(`\n${cand.name}: p=${p.toFixed(3)} minority=${minorityCount} (${(minorityRate * 100).toFixed(1)}%) floor=${floorPass ? "PASS" : "FAIL"}`)
    console.log(`  ${rows.map((r) => `d=${r.e}: n/arm=${r.nArm}`).join("  ")}`)
    for (const [src, rate] of Object.entries(sources)) {
      const days = rows.map((r) => {
        const d = daysToVerdict(r.nArm, rate)
        return d === null ? "inf" : String(d)
      })
      const bar = daysToVerdict(rows.find((r) => r.e === 0.30)!.nArm, rate)
      const pass = bar !== null && bar <= BAR_DAYS
      console.log(`  x ${src.padEnd(18)} (${rate.toFixed(2)}/d): days@{.10,.20,.30,.40} = {${days.join(", ")}}  bar@.30 ${pass ? "PASS" : "FAIL"}`)
    }
  }
}
