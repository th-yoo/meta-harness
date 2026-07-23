#!/usr/bin/env bun
/**
 * minimal/gate.ts — Gate-as-code: the loop's DECIDING seat, no LLM.
 *
 * Encodes the three verdict rules that were previously applied by hand
 * (docs/loop-roadmap.md standing rules 3+4; TB2 had only the lift-stats half
 * as code — guard non-regression and forensics classification were manual
 * everywhere until this file):
 *
 *   1. Forensics classification — a trial is VOID (excluded from all math)
 *      when the agent never engaged (turns=0 / suspect flag from run.ts);
 *      a genuine timeout with turns>0 is a REAL failure and stays.
 *   2. Lift gate — Fisher exact (two-sided) on pooled valid trials,
 *      candidate arm vs baseline arm. Provenance guard: arms must share
 *      task/host/model/driver, and every record within an arm must share the
 *      same system+harness identity (no silent mixed pooling).
 *   3. Guard gate — a guard HOLDS iff every VALID candidate trial passes,
 *      against a baseline screen that itself passed (an unscreened guard is
 *      an input error, not a hold).
 *
 * ADOPT requires: lift-certified AND every guard holds. Anything else is
 * REJECT, with the blocking reasons listed.
 *
 * CLI:
 *   bun minimal/gate.ts --base <r.json>[,r2.json] --cand <r.json>[,r2.json]
 *                       [--guard <baseline.json>=<cand.json>]... [--alpha 0.05]
 * Prints a human summary + one JSON verdict line (machine surface, ledgerable).
 */
import { readFileSync } from "node:fs"

export interface Trial {
  attempt: number
  reward: number
  turns: number
  elapsedSec: number
  timedOut: boolean
  suspect: boolean
}

export interface RunRecord {
  task: string
  host: string
  model: string
  driver: string
  system: string | null
  harness: string | null
  rewards: number[]
  trials: Trial[]
}

export interface VoidTrial {
  attempt: number
  reason: string
}

/** Rule 1 — forensics. Mirrors the manual protocol: turns=0 (agent never
 * engaged: auth race / provider error / staging artifact) = VOID; everything
 * else — including genuine timeouts — is a real, countable trial. */
export function classifyTrials(rec: RunRecord): { valid: Trial[]; voids: VoidTrial[] } {
  const valid: Trial[] = []
  const voids: VoidTrial[] = []
  for (const t of rec.trials) {
    if (t.turns === 0 || t.suspect) {
      voids.push({ attempt: t.attempt, reason: `0 turns (suspect=${t.suspect}, elapsed=${t.elapsedSec}s) — agent never engaged` })
    } else {
      valid.push(t)
    }
  }
  return { valid, voids }
}

function logFact(n: number): number {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

function hyper(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  return Math.exp(
    logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d) -
    logFact(n) - logFact(a) - logFact(b) - logFact(c) - logFact(d),
  )
}

/** Two-sided Fisher exact on the 2x2 [[a,b],[c,d]] (a,c = passes). */
export function fisherTwoSided(a: number, b: number, c: number, d: number): number {
  const r1 = a + b
  const c1 = a + c
  const n = a + b + c + d
  const lo = Math.max(0, c1 - (n - r1))
  const hi = Math.min(r1, c1)
  const pObs = hyper(a, b, c, d)
  let p = 0
  for (let x = lo; x <= hi; x++) {
    const px = hyper(x, r1 - x, c1 - x, n - r1 - (c1 - x))
    if (px <= pObs + 1e-12) p += px
  }
  return Math.min(1, p)
}

function armIdentity(r: RunRecord): string {
  return JSON.stringify({ system: r.system, harness: r.harness })
}

function checkProvenance(base: RunRecord[], cand: RunRecord[]): void {
  const all = [...base, ...cand]
  const first = all[0]!
  for (const r of all) {
    if (r.task !== first.task) throw new Error(`provenance: mixed task (${r.task} vs ${first.task}) — arms must share one task`)
    if (r.host !== first.host) throw new Error(`provenance: mixed host (${r.host} vs ${first.host}) — same-host arms only (loop-2 rule)`)
    if (r.model !== first.model) throw new Error(`provenance: mixed model (${r.model} vs ${first.model})`)
    if (r.driver !== first.driver) throw new Error(`provenance: mixed driver`)
  }
  for (const arm of [base, cand]) {
    const id = armIdentity(arm[0]!)
    for (const r of arm) {
      if (armIdentity(r) !== id) throw new Error(`provenance: mixed system/harness identity WITHIN one arm — no silent pooling`)
    }
  }
}

export interface LiftResult {
  basePass: number
  baseN: number
  candPass: number
  candN: number
  p: number
  alpha: number
  verdict: "lift-certified" | "directional" | "null"
  voids: number
}

/** Rule 2 — lift gate on pooled valid trials. */
export function gateLift(base: RunRecord[], cand: RunRecord[], alpha = 0.05): LiftResult {
  if (base.length === 0 || cand.length === 0) throw new Error("gateLift: both arms need >=1 record")
  checkProvenance(base, cand)
  let basePass = 0, baseN = 0, candPass = 0, candN = 0, voids = 0
  for (const r of base) {
    const c = classifyTrials(r)
    voids += c.voids.length
    baseN += c.valid.length
    basePass += c.valid.filter((t) => t.reward === 1).length
  }
  for (const r of cand) {
    const c = classifyTrials(r)
    voids += c.voids.length
    candN += c.valid.length
    candPass += c.valid.filter((t) => t.reward === 1).length
  }
  const p = fisherTwoSided(candPass, candN - candPass, basePass, baseN - basePass)
  const candRate = candN > 0 ? candPass / candN : 0
  const baseRate = baseN > 0 ? basePass / baseN : 0
  const verdict = candRate > baseRate ? (p < alpha ? "lift-certified" : "directional") : "null"
  return { basePass, baseN, candPass, candN, p, alpha, verdict, voids }
}

export interface GuardResult {
  task: string
  basePass: number
  baseN: number
  candPass: number
  candN: number
  voids: number
  verdict: "hold" | "regressed"
}

/** Rule 3 — guard gate: every VALID candidate trial must pass. */
export function gateGuard(baseline: RunRecord, cand: RunRecord): GuardResult {
  if (baseline.task !== cand.task) throw new Error(`gateGuard: task mismatch (${baseline.task} vs ${cand.task})`)
  if (baseline.host !== cand.host) throw new Error(`gateGuard: host mismatch — same-host rule`)
  const b = classifyTrials(baseline)
  const basePass = b.valid.filter((t) => t.reward === 1).length
  if (basePass === 0) throw new Error(`gateGuard: baseline screen for ${baseline.task} has no valid pass — not a guard (screen it first)`)
  const c = classifyTrials(cand)
  const candPass = c.valid.filter((t) => t.reward === 1).length
  const verdict = candPass === c.valid.length && c.valid.length > 0 ? "hold" : "regressed"
  return { task: cand.task, basePass, baseN: b.valid.length, candPass, candN: c.valid.length, voids: c.voids.length, verdict }
}

export interface Verdict {
  decision: "ADOPT" | "REJECT"
  reasons: string[]
}

/** ADOPT iff lift certified AND >=1 guard measured AND all guards hold.
 * Zero guards = REJECT: a certified lift with unmeasured cost is exactly how
 * v9 would have been wrongly adopted (TB2 loop-2). */
export function gateVerdict(lift: LiftResult, guards: GuardResult[]): Verdict {
  const reasons: string[] = []
  if (lift.verdict !== "lift-certified") reasons.push(`lift not certified (${lift.verdict}, p=${lift.p?.toFixed?.(4) ?? "?"})`)
  if (guards.length === 0) reasons.push("no guard measured — guard-less adoption forbidden (v9 lesson)")
  for (const g of guards) {
    if (g.verdict !== "hold") reasons.push(`guard ${g.task} regressed (${g.candPass}/${g.candN} valid)`)
  }
  return { decision: reasons.length === 0 ? "ADOPT" : "REJECT", reasons }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function loadRecords(csv: string): RunRecord[] {
  return csv.split(",").map((p) => JSON.parse(readFileSync(p.trim(), "utf-8")) as RunRecord)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const baseCsv = get("--base")
  const candCsv = get("--cand")
  const alpha = Number(get("--alpha") ?? "0.05")
  if (!baseCsv || !candCsv) {
    console.log("usage: bun minimal/gate.ts --base <r.json>[,...] --cand <r.json>[,...] [--guard <baseline.json>=<cand.json>]... [--alpha 0.05]")
    process.exit(2)
  }
  const lift = gateLift(loadRecords(baseCsv), loadRecords(candCsv), alpha)
  const guards: GuardResult[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--guard") {
      const spec = argv[i + 1] ?? ""
      const [bPath, cPath] = spec.split("=")
      if (!bPath || !cPath) { console.error(`bad --guard spec: ${spec}`); process.exit(2) }
      guards.push(gateGuard(loadRecords(bPath)[0]!, loadRecords(cPath)[0]!))
    }
  }
  const verdict = gateVerdict(lift, guards)
  console.log(`lift: ${lift.candPass}/${lift.candN} vs base ${lift.basePass}/${lift.baseN}  p=${lift.p.toFixed(5)}  → ${lift.verdict}${lift.voids ? `  (${lift.voids} void trial(s) excluded)` : ""}`)
  for (const g of guards) console.log(`guard ${g.task}: ${g.candPass}/${g.candN} valid (baseline ${g.basePass}/${g.baseN}) → ${g.verdict}${g.voids ? ` (${g.voids} void)` : ""}`)
  console.log(`decision: ${verdict.decision}${verdict.reasons.length ? " — " + verdict.reasons.join("; ") : ""}`)
  console.log(JSON.stringify({ lift, guards, verdict }))
  process.exit(verdict.decision === "ADOPT" ? 0 : 1)
}
