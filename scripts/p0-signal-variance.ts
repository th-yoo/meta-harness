#!/usr/bin/env bun
/**
 * P0 signal-variance audit — thin CLI
 * (spec docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md
 * §1; plan docs/superpowers/plans/2026-08-05-loop-probes.md Task 2). Zero
 * model calls: every number here comes from EXISTING data — the
 * gate-outcomes ndjson stream, committed review docs, a read-only gauge
 * replay-cli report, and a committed TB2 ab-verdict.json.
 *
 * Every decision (parsing, boundary split, stats, viability floors) lives
 * in km-crank/src/loop-probes.ts (pure, unit-tested there); this file only
 * binds real files/processes and shapes JSON. F1: read-only over its
 * sources. F2: this file writes ONLY its own output json — counts/stats/
 * dates/keys, never prompt or note text.
 *
 * PRODUCTION DEFAULT PATHS (all overridable via env — test seam, see
 * below; production omits every override):
 *   - MAIN_GATE_NDJSON_DEFAULT points at the MAIN CHECKOUT's
 *     .km/gate-outcomes.ndjson (~/z2/meta-harness/.km/gate-outcomes.ndjson)
 *     — deliberately NOT process.cwd()-relative. This probe is designed to
 *     run from worktrees whose own .km/ holds only a handful of lines from
 *     gate runs INSIDE that worktree; the office host's real stream lives
 *     in the main checkout, so the default is host-homedir-anchored, not
 *     cwd-anchored.
 *   - FOREIGN_GATE_NDJSON_DEFAULT is the sibling kkamak repo's stream
 *     (read-only, descriptive contrast only, never pooled with this
 *     repo's data — spec §1 B1 bullet).
 *   - REVIEWS_DIR_DEFAULT and TB2_VERDICT_DEFAULT ARE process.cwd()
 *     -relative: both are committed, git-tracked, and identical across
 *     hosts/worktrees (task-2 brief), so cwd-relative is correct there —
 *     unlike the host-local .km stream above.
 *
 * Env overrides (test seam ONLY — production omits all of these):
 *   KKAMAK_PROBE_GATE_NDJSON, KKAMAK_PROBE_FOREIGN_NDJSON,
 *   KKAMAK_PROBE_REVIEWS_DIR, KKAMAK_PROBE_TB2_VERDICT,
 *   KKAMAK_PROBE_SKIP_B3=1 (skip the replay-cli subprocess entirely).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import {
  parseGateLine, splitAtBoundaries, regimeKey,
  boolStats, countStats, viability,
  type GateLine, type Family, type ViabilityVerdict,
  type BoolStats, type CountStats, type CatStats, type RateStats,
} from "../km-crank/src/loop-probes.ts"

export const SPEC_PATH = "docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md"

/** Live boundary set for the office streams (plan Global Constraints, spec
 * §6 worked example) — source (a), the adoption ledger. Source (b)
 * (in-stream pluginVersion stamp changes) is derived from the actual data
 * at run time by deriveStampBoundaries() below and UNIONED with this
 * constant list — never used alone (plan post-plan note: a new 0.3.0 stamp
 * landing between runs must become a boundary without a code change). */
export const OFFICE_BOUNDARIES: number[] = [
  1785711630125, 1785727963349, 1785847012141,
  1785856371528, 1785888548054, 1785892022908,
]

/** kkamak foreign stream's 0.2.1 split point (spec §1 B1-foreign bullet). */
export const FOREIGN_0_2_1_SPLIT = 1785711630125

export const MAIN_GATE_NDJSON_DEFAULT = path.join(os.homedir(), "z2", "meta-harness", ".km", "gate-outcomes.ndjson")
export const FOREIGN_GATE_NDJSON_DEFAULT = path.join(os.homedir(), "z2", "kkamak", ".km", "gate-outcomes.ndjson")
export const REVIEWS_DIR_DEFAULT = path.join(process.cwd(), "docs", "reviews")
export const TB2_VERDICT_DEFAULT = path.join(process.cwd(), "term-bench2", "store", "global", "candidates", "v1", "ab-verdict.json")

export function gateNdjsonPath(): string {
  return process.env.KKAMAK_PROBE_GATE_NDJSON ?? MAIN_GATE_NDJSON_DEFAULT
}
export function foreignNdjsonPath(): string {
  return process.env.KKAMAK_PROBE_FOREIGN_NDJSON ?? FOREIGN_GATE_NDJSON_DEFAULT
}
export function reviewsDirPath(): string {
  return process.env.KKAMAK_PROBE_REVIEWS_DIR ?? REVIEWS_DIR_DEFAULT
}
export function tb2VerdictPath(): string {
  return process.env.KKAMAK_PROBE_TB2_VERDICT ?? TB2_VERDICT_DEFAULT
}

/** Tolerant ndjson read: missing file -> []; each line via the pure
 * parseGateLine (malformed lines silently dropped, matching its contract). */
export function readGateLines(file: string): GateLine[] {
  let raw: string
  try { raw = fs.readFileSync(file, "utf8") } catch { return [] }
  const out: GateLine[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const parsed = parseGateLine(line)
    if (parsed) out.push(parsed)
  }
  return out
}

/** In-stream pluginVersion stamp-change boundary derivation (spec §6
 * source (b) — "every pluginVersion stamp change observed in the stream
 * being read"). ts-sorted scan; a "change" is any line whose
 * pluginVersion (missing treated as the sentinel "unknown") differs from
 * the immediately preceding line's. Returns the CHANGE-POINT timestamps
 * only — the first line's own value is not itself a transition. */
export function deriveStampBoundaries(lines: { ts: number; pluginVersion?: string }[]): number[] {
  const sorted = [...lines].sort((a, b) => a.ts - b.ts)
  const out: number[] = []
  let prev: string | undefined
  let seen = false
  for (const l of sorted) {
    const v = l.pluginVersion ?? "unknown"
    if (seen && v !== prev) out.push(l.ts)
    prev = v
    seen = true
  }
  return out
}

export interface SegmentBound { lo: number | null; hi: number | null }
/** [-Infinity, b0), [b0, b1), ..., [bn, +Infinity) bounds, aligned index-for
 * -index with splitAtBoundaries' segments (Infinity represented as null —
 * JSON has no Infinity literal). */
export function segmentBounds(bs: number[]): SegmentBound[] {
  const sorted = [...new Set(bs)].sort((a, b) => a - b)
  const out: SegmentBound[] = []
  for (let i = 0; i <= sorted.length; i++) {
    out.push({ lo: i === 0 ? null : sorted[i - 1]!, hi: i === sorted.length ? null : sorted[i]! })
  }
  return out
}

/** Oldest "add" commit's author date for a committed file (spec B2/S3 rule:
 * `git log --follow --diff-filter=A --format=%aI -- <f> | tail -1` — git
 * log itself lists newest-first, so "tail -1" = the LAST line of our own
 * output array; tail pins the oldest add when rename/re-add chains emit
 * several lines). `dir` must be inside a git working tree; `fileName` is
 * resolved relative to `dir`. undefined on any git failure. */
export function gitAddedDateIso(dir: string, fileName: string): string | undefined {
  try {
    const out = execFileSync(
      "git", ["-C", dir, "log", "--follow", "--diff-filter=A", "--format=%aI", "--", fileName],
      { encoding: "utf8" },
    )
    const lines = out.split("\n").map(s => s.trim()).filter(Boolean)
    return lines.length > 0 ? lines[lines.length - 1] : undefined
  } catch {
    return undefined
  }
}

export interface ReviewFileEntry { file: string; addedDateIso: string | undefined; findingsCount: number | undefined }

/** Committed docs/reviews/*.md — findings-count (B2's `findings-count:`
 * field grep) + oldest-add date per file. Missing dir -> []. */
export function findReviewFiles(reviewsDir: string): ReviewFileEntry[] {
  let names: string[]
  try { names = fs.readdirSync(reviewsDir).filter(n => n.endsWith(".md")).sort() } catch { return [] }
  return names.map(name => {
    const text = fs.readFileSync(path.join(reviewsDir, name), "utf8")
    const m = text.match(/findings-count:\s*(\d+)/)
    return {
      file: name,
      addedDateIso: gitAddedDateIso(reviewsDir, name),
      findingsCount: m ? Number(m[1]) : undefined,
    }
  })
}

// ---------------------------------------------------------------------
// B1 — gate-outcomes signals (this repo), boundary-segmented
// ---------------------------------------------------------------------

export interface SegmentOut<S> { index: number; boundaryLo: number | null; boundaryHi: number | null; n: number; stats: S }
export interface SignalOut<S> { family: Family; n: number; stats: S; segments: SegmentOut<S>[]; viability: ViabilityVerdict }

function buildBoolSignal(
  segs: GateLine[][], bounds: SegmentBound[], extractor: (l: GateLine) => boolean | undefined,
): SignalOut<BoolStats> {
  const segments: SegmentOut<BoolStats>[] = segs.map((seg, i) => {
    const xs = seg.map(extractor).filter((x): x is boolean => typeof x === "boolean")
    const stats = boolStats(xs)
    return { index: i, boundaryLo: bounds[i]!.lo, boundaryHi: bounds[i]!.hi, n: stats.n, stats }
  })
  const last = segments[segments.length - 1]!
  return { family: "boolean", n: last.n, stats: last.stats, segments, viability: viability("boolean", last.stats) }
}

function buildCountSignal(
  segs: GateLine[][], bounds: SegmentBound[], extractor: (l: GateLine) => number | undefined,
): SignalOut<CountStats> {
  const segments: SegmentOut<CountStats>[] = segs.map((seg, i) => {
    const xs = seg.map(extractor).filter((x): x is number => typeof x === "number")
    const stats = countStats(xs)
    return { index: i, boundaryLo: bounds[i]!.lo, boundaryHi: bounds[i]!.hi, n: stats.n, stats }
  })
  const last = segments[segments.length - 1]!
  return { family: "count", n: last.n, stats: last.stats, segments, viability: viability("count", last.stats) }
}

const roundsLengthOf = (l: GateLine): number | undefined => Array.isArray(l.rounds) ? l.rounds.length : undefined
const durationMsOf = (l: GateLine): number | undefined => typeof l.durationMs === "number" ? l.durationMs : undefined

export function buildB1(lines: GateLine[]) {
  const boundaries = [...new Set([...OFFICE_BOUNDARIES, ...deriveStampBoundaries(lines)])].sort((a, b) => a - b)
  const bounds = segmentBounds(boundaries)
  const segs = splitAtBoundaries(lines, boundaries)
  return {
    linesTotal: lines.length,
    boundaries,
    accepted: buildBoolSignal(segs, bounds, l => l.accepted),
    gateExhausted: buildBoolSignal(segs, bounds, l => l.gateExhausted),
    roundsLength: buildCountSignal(segs, bounds, roundsLengthOf),
    durationMs: buildCountSignal(segs, bounds, durationMsOf),
  }
}

// ---------------------------------------------------------------------
// B1-foreign — kkamak stream, grouped by pluginVersion (0.2.1 further
// split at FOREIGN_0_2_1_SPLIT). regimeKey already encodes exactly this
// "<pluginVersion>@<segment index>" grouping. NO viability verdicts.
// ---------------------------------------------------------------------

export interface ForeignRegimeOut {
  key: string; n: number
  accepted: BoolStats; gateExhausted: BoolStats; roundsLength: CountStats; durationMs: CountStats
}

export function buildForeignRegimes(lines: GateLine[]): ForeignRegimeOut[] {
  const groups = new Map<string, GateLine[]>()
  for (const l of lines) {
    const key = regimeKey(l, [FOREIGN_0_2_1_SPLIT])
    const arr = groups.get(key) ?? []
    arr.push(l)
    groups.set(key, arr)
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, seg]) => ({
    key,
    n: seg.length,
    accepted: boolStats(seg.map(l => l.accepted).filter((x): x is boolean => typeof x === "boolean")),
    gateExhausted: boolStats(seg.map(l => l.gateExhausted).filter((x): x is boolean => typeof x === "boolean")),
    roundsLength: countStats(seg.map(roundsLengthOf).filter((x): x is number => typeof x === "number")),
    durationMs: countStats(seg.map(durationMsOf).filter((x): x is number => typeof x === "number")),
  }))
}

// ---------------------------------------------------------------------
// B2 — review findings-count (count family)
// ---------------------------------------------------------------------

export function buildB2(reviewsDir: string) {
  const files = findReviewFiles(reviewsDir)
  const findingsCounts = files.map(f => f.findingsCount).filter((x): x is number => typeof x === "number")
  const stats = countStats(findingsCounts)
  return { family: "count" as Family, n: stats.n, stats, files, viability: viability("count", stats) }
}

// ---------------------------------------------------------------------
// B3 — gauge class/channel distribution (categorical, undeclared
// binarization -> spec-mandated UNKNOWN string verdict, not the pure
// viability() function's output)
// ---------------------------------------------------------------------

export interface ClassCounts { A1: number; A2: number; B: number; C: number; D: number; total: number }
const CLASS_LINE_RE = /^\s*(live|corpus-transcript)\s+A1\s+(\d+)\s+A2\s+(\d+)\s+B\s+(\d+)\s+C\s+(\d+)\s+D\s+(\d+)\s+\(total\s+(\d+)\)/gm

export function parseClassRateLines(stdout: string): { live?: ClassCounts; corpusTranscript?: ClassCounts } {
  const out: { live?: ClassCounts; corpusTranscript?: ClassCounts } = {}
  for (const m of stdout.matchAll(CLASS_LINE_RE)) {
    const counts: ClassCounts = {
      A1: Number(m[2]), A2: Number(m[3]), B: Number(m[4]), C: Number(m[5]), D: Number(m[6]), total: Number(m[7]),
    }
    if (m[1] === "live") out.live = counts
    else out.corpusTranscript = counts
  }
  return out
}

function classCatStats(c: ClassCounts): CatStats {
  return { n: c.total, classes: { A1: c.A1, A2: c.A2, B: c.B, C: c.C, D: c.D } }
}

export function buildB3(): unknown {
  if (process.env.KKAMAK_PROBE_SKIP_B3 === "1") {
    return { family: "categorical", skipped: true, binarization: "undeclared" }
  }
  let stdout: string
  try {
    stdout = execFileSync("bun", ["cc-gate-plugin/src/gauge/replay-cli.ts", "report"], { cwd: process.cwd(), encoding: "utf8" })
  } catch {
    return { family: "categorical", skipped: false, error: "replay-cli report failed", binarization: "undeclared" }
  }
  const parsed = parseClassRateLines(stdout)
  const provenance: Record<string, { n: number; stats: CatStats; viability: string }> = {}
  if (parsed.live) {
    const stats = classCatStats(parsed.live)
    provenance.live = { n: stats.n, stats, viability: "UNKNOWN (binarization undeclared)" }
  }
  if (parsed.corpusTranscript) {
    const stats = classCatStats(parsed.corpusTranscript)
    provenance.corpusTranscript = { n: stats.n, stats, viability: "UNKNOWN (binarization undeclared)" }
  }
  return { family: "categorical", skipped: false, binarization: "undeclared", provenance }
}

// ---------------------------------------------------------------------
// B4 — TB2 v1 ab-verdict per-task repeat arrays (rate family). Per
// task-2 brief: trials = every array entry across tasks for the
// "candidate" arm (the arm under audit — "active" is the baseline
// comparator, reported nowhere here to avoid conflating the two);
// successes = entries === 1 (the file's own encoding: plain 0/1 ints,
// confirmed by inspection — matches candidateRate = 13/17 pass@k when
// computed any-of-k, but B4 per the brief pools every entry, not pass@k).
// ---------------------------------------------------------------------

interface TaskResultEntry { candidate?: number[] }
interface AbVerdictDoc { taskResults?: Record<string, TaskResultEntry> }

export function buildB4(verdictPath: string) {
  let raw: string
  try { raw = fs.readFileSync(verdictPath, "utf8") } catch {
    const stats: RateStats = { successes: 0, failures: 0 }
    return { family: "rate" as Family, arm: "candidate", source: verdictPath, n: 0, stats, viability: "UNKNOWN" as ViabilityVerdict, error: "file not found" }
  }
  const doc = JSON.parse(raw) as AbVerdictDoc
  const taskResults = doc.taskResults ?? {}
  let successes = 0, failures = 0
  for (const t of Object.values(taskResults)) {
    for (const entry of t.candidate ?? []) {
      if (entry === 1) successes++
      else failures++
    }
  }
  const stats: RateStats = { successes, failures }
  return {
    family: "rate" as Family, arm: "candidate", source: verdictPath,
    n: successes + failures, stats, viability: viability("rate", stats),
  }
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

function main(): void {
  const gateFile = gateNdjsonPath()
  const b1 = { source: gateFile, ...buildB1(readGateLines(gateFile)) }

  const foreignFile = foreignNdjsonPath()
  const foreignLines = readGateLines(foreignFile)
  const b1Foreign = {
    source: foreignFile,
    linesTotal: foreignLines.length,
    splitBoundary: FOREIGN_0_2_1_SPLIT,
    regimes: buildForeignRegimes(foreignLines),
    viability: null, // NO viability verdicts (foreign) — spec §1 B1-foreign
  }

  const b2 = buildB2(reviewsDirPath())
  const b3 = buildB3()
  const b4 = buildB4(tb2VerdictPath())

  const output = {
    spec: SPEC_PATH,
    generatedAtTs: Date.now(),
    hostname: os.hostname(),
    b1, b1Foreign, b2, b3, b4,
  }

  const outDir = path.join(process.cwd(), "docs", "loop-probes")
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${os.hostname()}-p0-signal-variance.json`)
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n")
  console.log(`p0-signal-variance: wrote ${outFile}`)
}

if (import.meta.main) main()
