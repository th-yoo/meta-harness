#!/usr/bin/env bun
/**
 * replay-cli.ts — km-gauge corpus-replay CLI (plan 2026-07-31). Thin
 * `import.meta.main`-guarded entry; subcommands accrete task-by-task (T2:
 * `mine`; T3: `derive`; T4: `resolve`; T5 adds `report` below).
 *
 * `bun replay-cli.ts mine [cwd]` scans `~/.claude/projects/<slug>/*.jsonl`
 * (override `KKAMAK_CLAUDE_PROJECTS_DIR` — test seam), skipping any nested
 * subdirectory (e.g. `subagents/`) so only top-level session files are ever
 * read, mines each file with corpus-mine.ts's pure `mineJsonl`, dedupes
 * `(repo, promptSha256)` keep-earliest across the whole scan, and upserts
 * the result into the store rooted at `cwd` (`process.cwd()` if omitted).
 * Model-free — mine never spends.
 *
 * `bun replay-cli.ts derive [cwd] --go <n>` batch-derives every pending
 * ("mined" stage) record via corpus-replay.ts's `runDerive` — cost-fenced:
 * `n` must exactly equal the current pending count or the call refuses with
 * zero effect (no model calls, no store write); omitting `--go` also
 * refuses, printing the pending count so the operator can size the next
 * call. This is the ONLY subcommand that spends against a real model.
 *
 * `bun replay-cli.ts resolve [cwd]` batch-resolves every "derived"-stage
 * record via state-resolve.ts's `runResolve` — locates a real repo
 * snapshot (fixture-ref or commit join), materializes it, and runs the
 * derived check against it. Model-free (no cost fence needed): resolve only
 * evaluates an ALREADY-derived check.
 *
 * `bun replay-cli.ts report [cwd]` — READ-ONLY, model-free, zero writes (no
 * corpus lock is ever taken: report never calls writeCorpus). Prints the
 * provenance-split M1v2 tally per the pre-verdict amendment
 * (`d869660`, docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor
 * -preregistration.md lines 168-250) — see the "report (Task 5)" section
 * below for the full design rationale.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseGateConfig } from "../config.ts"
import type { GaugePromptClass, GaugeSensorField, SensorLine } from "../types.ts"
import {
  readCorpus,
  writeCorpus,
  upsertRecords,
  acquireCorpusLock,
  releaseCorpusLock,
  type CorpusProvenance,
  type CorpusRecord,
} from "./corpus-store.ts"
import { mineJsonl, dedupeEarliest } from "./corpus-mine.ts"
import { runDerive } from "./corpus-replay.ts"
import { runResolve, readSensorLines } from "./state-resolve.ts"
import { runPvSample, parsePvSampleArgs, runPvCompare, parsePvCompareArgs } from "./paired-validation.ts"
import { runClsSample, parseClsSampleArgs } from "./cls-ab.ts"

/** `~/.claude/projects`, or `KKAMAK_CLAUDE_PROJECTS_DIR` override. */
export function projectsDir(): string {
  return process.env.KKAMAK_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects")
}

/** Top-level `*.jsonl` files directly under each project slug dir only — a
 * `subagents/` subdirectory (or any other nested dir) is never descended
 * into, per the plan's "only top-level session files" scope pin. Missing/
 * unreadable dirs -> []. */
export function findTranscriptFiles(dir: string): string[] {
  let slugDirs: fs.Dirent[]
  try {
    slugDirs = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const slug of slugDirs) {
    if (!slug.isDirectory()) continue
    const slugPath = path.join(dir, slug.name)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(slugPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path.join(slugPath, e.name))
    }
  }
  return out
}

/** repo gate.json `.check`, "" if absent/unreadable/malformed — memoized
 * per repo within one mine run since many transcript lines share a repo. */
function makeFloorCheckLookup(): (repo: string) => string {
  const cache = new Map<string, string>()
  return (repo: string) => {
    const cached = cache.get(repo)
    if (cached !== undefined) return cached
    let value = ""
    try {
      const raw = fs.readFileSync(path.join(repo, "gate.json"), "utf-8")
      value = parseGateConfig(raw)?.check ?? ""
    } catch {
      value = ""
    }
    cache.set(repo, value)
    return value
  }
}

/** mine is model-free — no derive-sized spend to protect — but its
 * store-side read (`readCorpus`) -> merge -> write (`writeCorpus`) is still
 * a real read-modify-write against a store another process can rewrite in
 * between. Task 3 review mirror check (finding 1's shape, applied here):
 * rather than argue the gap is "probably fine" because it's synchronous
 * JS with no other await point in between, hold the corpus lock across the
 * whole read -> merge -> write sequence — same acquire/write(lockHeld)/
 * release pattern as runDerive, just without any per-record refresh since
 * there's no multi-minute batch to guard against going stale. */
export function runMine(cwd: string, log: (m: string) => void): void {
  const files = findTranscriptFiles(projectsDir())
  const floorCheckFor = makeFloorCheckLookup()
  const now = Date.now()

  const mined = files.flatMap((f) => {
    let text: string
    try {
      text = fs.readFileSync(f, "utf-8")
    } catch {
      return []
    }
    return mineJsonl(text, { floorCheckFor, now })
  })

  const deduped = dedupeEarliest(mined)

  if (!acquireCorpusLock(cwd, log)) return
  try {
    const merged = upsertRecords(readCorpus(cwd), deduped)
    const ok = writeCorpus(cwd, merged, log, { lockHeld: true })
    if (ok) {
      log(
        `mine: scanned ${files.length} transcript file(s), mined ${deduped.length} record(s) ` +
          `(pre-dedupe ${mined.length}); store now ${merged.length} record(s)`,
      )
    }
  } finally {
    releaseCorpusLock(cwd)
  }
}

/** `--go <n>` extracted; everything else is a positional arg (cwd). Absent
 * `--go` -> `go` stays undefined (runDerive's own missing-go refusal path);
 * a non-numeric value becomes NaN, which likewise never equals a real
 * pending count and refuses via the same mismatch path — no special-casing
 * needed here. */
function parseDeriveArgs(args: string[]): { cwd: string; go: number | undefined } {
  let go: number | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), go }
}

// ── report (Task 5) ─────────────────────────────────────────────────────
//
// docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
// PRE-VERDICT AMENDMENT (`d869660`, lines 168-250) registered the offline
// corpus-replay channel; this subcommand implements its point-8(iii)
// "provenance-split report" build item. READ-ONLY by construction: every
// function below only ever calls readCorpus/readSensorLines, never
// writeCorpus/writeGaugeFile/upsertRecords — verified by
// replay-cli.test.ts's byte-identical-store-and-stream-after-report check.
//
// --- Live a/b tally (spec's OWN amended M1v2 definition) ---
//
// A naive per-LINE count of class-C sensor lines violates the spec's own
// build-review amendment (lineage clause (c), spec lines 115-119): "M1v2
// ... [is] computed PER DERIVATION, not per line — dedupe by
// `(sessionID, n)` using the terminal line ... so one derivation is one
// M1v2 ... unit; passthrough-only lines ... are excluded from M1v2's
// denominator." Two reasons a naive line count over-reports:
//
//  1. Two-strike (shadow.ts:45-70): a multi-turn-C derivation that fails
//     its first floor-gated Stop emits ONE sensor line deferring the
//     verdict (strike:1, wouldBlock damped false, pending KEPT — same
//     `gauge.n`), then a SECOND sensor line at the next floor-gated Stop
//     that actually resolves it (strike:2 or pass, pending consumed). Both
//     lines share `(sessionID, gauge.n)` — counting both would double the
//     derivation. The TERMINAL line (max `ts` within the group — the
//     consuming line always lands strictly after any deferring/passthrough
//     line for the same pending, since a consumed pending can never be
//     re-picked) is the one real verdict.
//  2. Passthrough-only lines (shadow.ts:82-100 `passthroughOnly`, emitted
//     by shadowEvaluateAtStop:161-163 whenever an open multi-turn-C pending
//     hits a Stop with NO floor cycle): the derived check NEVER RAN
//     (`executable:false`, no `pass`/`wouldBlock` field at all) — these are
//     shape-detected structurally (`horizon === "multi-turn" &&
//     rounds.length === 0 && gauge.pass === undefined`, see
//     `isPassthroughOnly` below) and excluded from the denominator, exactly
//     as a still-open (never-yet-resolved) pending should be.
//
// a = deduped class-C derivations whose terminal line has `executable:true`
// b = deduped non-passthrough class-C derivations (the denominator)
//
// score.ts's existing GaugeScore has this SAME gap today (raw per-line
// counting, no dedup, no passthrough exclusion) — this report fixes its own
// tally only; score.ts is untouched (plan Global Constraints).
//
// Guardrail (pinned, plan + task brief): the `(sessionID, gauge.n)` dedup
// key is LIVE-STREAM-ONLY by construction — every function below that
// builds this key takes `SensorLine[]`, never `CorpusRecord[]`. Corpus
// identity stays `(repo, promptSha256)` (corpus-store.ts); reusing the live
// key on corpus records would collide session-wide, since every corpus
// derivation is persisted with `n` pinned to `1` (corpus-store.ts:80-84 doc
// comment — no session ordinal exists in the corpus).

/** shadow.ts:82-100's `passthroughOnly` shape, detected structurally (never
 * a stored flag): `horizon === "multi-turn"` + the fabricated `rounds:[]`
 * envelope (fabricateLine, shadow.ts:102-122) + no `pass` field. This is
 * the ONE shape evaluateGauge (evaluate.ts) can never itself produce for a
 * multi-turn-C line — every other multi-turn-C path either attaches to a
 * real floor line (rounds.length >= 1, a real gate cycle ran) or actually
 * calls evaluateGauge and gets a `pass` field whenever `executable:true`;
 * when `executable:false` there's no `pass` field either, but that path
 * (refused / unrunnable / IO-failure) only ever runs with `floorRan:true`
 * for multi-turn-C (shadowEvaluateAtStop:161-163 — the ONLY branch that
 * skips evaluateGauge entirely requires `!floorRan`, i.e. `sensor ===
 * undefined`, i.e. the fabricated path with `rounds:[]`), so a genuine
 * refused/unrunnable multi-turn-C result is never `rounds.length === 0`. */
function isPassthroughOnly(l: SensorLine): boolean {
  return l.gauge?.horizon === "multi-turn" && l.rounds.length === 0 && l.gauge?.pass === undefined
}

/** `(sessionID, gauge.n)` -> terminal (max-`ts`) line, restricted to lines
 * whose `gauge.n` is a real number (defensive: a malformed/legacy line
 * without `n` can never be deduped safely, so it's dropped rather than
 * silently colliding with every other n-less line). Ties (identical `ts`)
 * resolve to the LAST-encountered line — a reasonable deterministic
 * tie-break given real streams are append-ordered. */
function terminalLinesByDerivation(lines: SensorLine[], filter: (l: SensorLine) => boolean): SensorLine[] {
  const groups = new Map<string, SensorLine>()
  for (const l of lines) {
    if (!filter(l)) continue
    if (typeof l.gauge?.n !== "number") continue
    const key = JSON.stringify([l.sessionID, l.gauge.n])
    const prev = groups.get(key)
    if (!prev || l.ts >= prev.ts) groups.set(key, l)
  }
  return Array.from(groups.values())
}

export interface LiveClassCTally {
  /** deduped class-C derivations whose terminal line has `executable:true` */
  a: number
  /** deduped non-passthrough class-C derivations (denominator) */
  b: number
}

/** Live a/b per the amended M1v2 definition (module doc above). */
export function computeLiveClassCTally(lines: SensorLine[]): LiveClassCTally {
  const terminals = terminalLinesByDerivation(lines, (l) => l.gauge?.present === true && l.gauge.class === "C")
  let a = 0
  let b = 0
  for (const terminal of terminals) {
    if (isPassthroughOnly(terminal)) continue // never executed — excluded from the denominator
    b++
    if (terminal.gauge!.executable === true) a++
  }
  return { a, b }
}

export interface CorpusClassCTally {
  /** pool-eligible class-C corpus records with `exec.executable:true` */
  c: number
  /** total pool-eligible class-C corpus records (denominator) */
  d: number
}

/** Corpus c/d — amendment point 3: M1v2 pools over "pool-eligible
 * corpus-transcript class-C derivations" specifically, so both fields are
 * filtered to `poolEligible && derivation.class === "C"`, not just
 * poolEligible alone (a poolEligible non-C record — e.g. class A1/D, which
 * ordinarily carries no derived check at all — must never dilute the
 * class-C-only M1v2 pool). */
export function computeCorpusClassCTally(records: CorpusRecord[]): CorpusClassCTally {
  let c = 0
  let d = 0
  for (const r of records) {
    if (!r.poolEligible) continue
    if (r.derivation?.class !== "C") continue
    // amendment point 3: only corpus-transcript pools; corpus-bench is descriptive-only
    if (r.provenance !== "corpus-transcript") continue
    d++
    if (r.exec?.executable === true) c++
  }
  return { c, d }
}

export const POOLED_FLOOR_MIN = 5
export const POOLED_M1V2_BAR = 0.9

export interface PooledVerdict {
  /** pooled denominator: live b + corpus d */
  n: number
  /** (live a + corpus c) / n >= 0.9 — false (never true) when n === 0 */
  meetsBar: boolean
  /** ≥5 pool, ≥1 live -> "met"; ≥5 pool, 0 live -> "all-corpus" (amendment
   * point 3: "an all-corpus M1v2 is reportable but cannot alone satisfy
   * §3's M1v2 leg"); <5 pool -> "not-met" regardless of live count. */
  floor: "met" | "not-met" | "all-corpus"
}

export function computePooledVerdict(live: LiveClassCTally, corpus: CorpusClassCTally): PooledVerdict {
  const n = live.b + corpus.d
  const numer = live.a + corpus.c
  const meetsBar = n > 0 && numer / n >= POOLED_M1V2_BAR
  const floor: PooledVerdict["floor"] = n < POOLED_FLOOR_MIN ? "not-met" : live.b < 1 ? "all-corpus" : "met"
  return { n, meetsBar, floor }
}

/** EXACT amendment point-4 form: "pooled M1v2 must be reported as `live
 * a/b · corpus c/d · pooled ≥90%?`, never as one number." `a/b/c/d` are the
 * real counts; `≥90%?` is kept literal (the bar being asked about, not a
 * computed percentage — the provenance-split a/b/c/d already make the
 * pooled fraction fully recoverable as `(a+c)/(b+d)`, so restating it as a
 * bare number here would be exactly the collapse point 4 forbids) with the
 * yes/no/n-a answer appended. */
export function renderPooledLine(
  live: LiveClassCTally,
  corpus: CorpusClassCTally,
  verdict: PooledVerdict,
): string {
  const answer = verdict.n > 0 ? (verdict.meetsBar ? "yes" : "no") : "n/a"
  return `live ${live.a}/${live.b} · corpus ${corpus.c}/${corpus.d} · pooled ≥90%? ${answer}`
}

/** Floor verdict — task brief: "floor verdict (≥5 pool, ≥1 live; all-corpus
 * pool = 'reportable, cannot satisfy §3 M1v2 leg')". A separate line from
 * `renderPooledLine`: the pooled line is the raw descriptive tally, this
 * states whether that reading is even a valid §3 M1v2 floor read. */
export function renderFloorVerdict(
  live: LiveClassCTally,
  _corpus: CorpusClassCTally,
  verdict: PooledVerdict,
): string {
  switch (verdict.floor) {
    case "not-met":
      return `floor: NOT MET (pooled n=${verdict.n} < ${POOLED_FLOOR_MIN}; live n=${live.b})`
    case "all-corpus":
      return (
        `floor: reportable, cannot satisfy §3 M1v2 leg ` +
        `(all-corpus pool, 0 live; pooled n=${verdict.n})`
      )
    case "met":
      return `floor: MET (pooled n=${verdict.n} ≥ ${POOLED_FLOOR_MIN}, live n=${live.b} ≥ 1)`
  }
}

export type ClassCounts = Record<GaugePromptClass, number>

function emptyClassCounts(): ClassCounts {
  return { A1: 0, A2: 0, B: 0, C: 0, D: 0 }
}

export interface ClassCountSummary {
  counts: ClassCounts
  total: number
}

/** Descriptive class-rate breakdown across ALL gauge prompt classes (not
 * just C) — same dedup-by-`(sessionID, gauge.n)`-terminal-line + passthrough
 * -exclusion mechanics as computeLiveClassCTally, generalized. No bar: this
 * table is purely descriptive (task brief). */
export function computeLiveClassCounts(lines: SensorLine[]): ClassCountSummary {
  const terminals = terminalLinesByDerivation(
    lines,
    (l) => l.gauge?.present === true && l.gauge.class !== undefined,
  )
  const counts = emptyClassCounts()
  let total = 0
  for (const terminal of terminals) {
    if (isPassthroughOnly(terminal)) continue
    const cls = terminal.gauge!.class as GaugePromptClass
    if (cls in counts) {
      counts[cls]++
      total++
    }
  }
  return { counts, total }
}

/** Corpus-side class-rate breakdown for one provenance lane — every stored
 * record that reached at least "derived" stage (has a `derivation.class`),
 * regardless of pool eligibility (the class-rate table is descriptive, not
 * the M1v2 pool). */
export function computeCorpusClassCounts(
  records: CorpusRecord[],
  provenance: CorpusProvenance,
): ClassCountSummary {
  const counts = emptyClassCounts()
  let total = 0
  for (const r of records) {
    if (r.provenance !== provenance) continue
    const cls = r.derivation?.class
    if (cls === undefined || !(cls in counts)) continue
    counts[cls]++
    total++
  }
  return { counts, total }
}

function renderClassRow(label: string, s: ClassCountSummary): string {
  return `  ${label.padEnd(18)} A1 ${s.counts.A1}  A2 ${s.counts.A2}  B ${s.counts.B}  C ${s.counts.C}  D ${s.counts.D}  (total ${s.total})`
}

/** corpus-bench is deferred (schema reserves the value only, plan Context)
 * — its row is shown only when non-empty, so an unused lane doesn't clutter
 * every report with a permanent all-zero row. */
export function renderClassTable(
  live: ClassCountSummary,
  corpusTranscript: ClassCountSummary,
  corpusBench: ClassCountSummary,
): string {
  const lines = [
    "class-rate (descriptive, no bar — by provenance):",
    renderClassRow("live", live),
    renderClassRow("corpus-transcript", corpusTranscript),
  ]
  if (corpusBench.total > 0) lines.push(renderClassRow("corpus-bench", corpusBench))
  return lines.join("\n")
}

/** Banner restating amendment points 5 + 7 (task brief: "banner restating
 * points 5/7 — report never consumes §3; pooled pass = pilot design may be
 * WRITTEN only"). Exported so tests can pin its exact wording. */
export const REPORT_BANNER = [
  "NOTE (amendment d869660, points 5 + 7 — restated here, not just linked):",
  "  This report is READ-ONLY / descriptive only and never consumes §3's",
  "  decision rule. A pooled M1v2 pass permits the blocking-pilot design to",
  "  be WRITTEN (cheap, reversible doc work) ONLY — §3 CONSUMPTION still",
  "  requires live-only class-C n>=5 confirming >=90% first (point 5a); a",
  "  live-only contradiction later VOIDS a pooled pass and shelves any",
  "  design written under it un-actioned (point 5c).",
  "  Corpus replay cannot unshadow the gauge, cannot substitute for M2/M3,",
  "  cannot lower any bar, and does not count toward the §3 window's >=30",
  "  -prompt accumulation nor the 60-prompt over-refusal checkpoint (both",
  "  live-only), and does not extend the two-strike kill rule (point 7).",
].join("\n")

/** Footnotes documenting data provenance and drift caveats. Exported so
 * tests can pin exact wording. */
export const REPORT_FOOTNOTES = [
  "footnotes:",
  "- floorCheck is captured at mine time (per-record floorCheckMinedAt) and may",
  "  have drifted from the repo's current gate.json check — audit",
  "  floorCheckMinedAt before trusting any pooled reading.",
  "- corpus checks run against a synthetic commit of the captured tree",
  "  (mechanical property only — git-history-dependent checks carry a",
  "  comparability caveat).",
  "- live a/b tallies THIS repo's sensor stream only ([cwd]); the §3 window is",
  "  the union across armed repos/hosts — a 0-live reading here does not mean",
  "  0 live in the window.",
].join("\n")

export interface ReportResult {
  live: LiveClassCTally
  corpus: CorpusClassCTally
  verdict: PooledVerdict
  text: string
}

/** READ-ONLY: only ever reads (readSensorLines / readCorpus), never writes
 * — no corpus lock is acquired (nothing here can contend with a concurrent
 * mine/derive/resolve writer, and none is needed for a pure read). */
export function computeReport(cwd: string): ReportResult {
  const sensors = readSensorLines(cwd)
  const records = readCorpus(cwd)

  const live = computeLiveClassCTally(sensors)
  const corpus = computeCorpusClassCTally(records)
  const verdict = computePooledVerdict(live, corpus)

  const liveCounts = computeLiveClassCounts(sensors)
  const corpusTranscriptCounts = computeCorpusClassCounts(records, "corpus-transcript")
  const corpusBenchCounts = computeCorpusClassCounts(records, "corpus-bench")

  const text = [
    "km-gauge corpus-replay report — provenance-split M1v2",
    "pre-reg amendment d869660 (spec lines 168-250); live tally per lineage clause (c) (spec lines 115-119)",
    "",
    renderPooledLine(live, corpus, verdict),
    renderFloorVerdict(live, corpus, verdict),
    "",
    renderClassTable(liveCounts, corpusTranscriptCounts, corpusBenchCounts),
    "",
    REPORT_BANNER,
    "",
    REPORT_FOOTNOTES,
  ].join("\n")

  return { live, corpus, verdict, text }
}

/** CLI entry for `report` — logs computeReport's rendered text verbatim. */
export function runReport(cwd: string, log: (m: string) => void): void {
  log(computeReport(cwd).text)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sub = args[0]

  if (sub === "mine") {
    const cwd = args[1] ?? process.cwd()
    runMine(cwd, (m) => console.log(m))
    return
  }

  if (sub === "derive") {
    const { cwd, go } = parseDeriveArgs(args.slice(1))
    const summary = await runDerive(cwd, go, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  if (sub === "resolve") {
    const cwd = args[1] ?? process.cwd()
    const summary = await runResolve(cwd, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  if (sub === "report") {
    const cwd = args[1] ?? process.cwd()
    runReport(cwd, (m) => console.log(m))
    return
  }

  if (sub === "pv-sample") {
    const { cwd, reset } = parsePvSampleArgs(args.slice(1))
    const summary = runPvSample(cwd, { reset }, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  if (sub === "pv-compare") {
    const { cwd, combine } = parsePvCompareArgs(args.slice(1))
    const summary = runPvCompare(cwd, { combine }, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  if (sub === "cls-sample") {
    const { cwd, reset } = parseClsSampleArgs(args.slice(1))
    const summary = runClsSample(cwd, { reset }, (m) => console.log(m))
    if (summary === undefined) process.exitCode = 1
    return
  }

  console.error(
    `unknown subcommand: ${sub ?? "(none)"} — usage: replay-cli.ts mine|derive|resolve|report|pv-sample|pv-compare|cls-sample [cwd] [--go <n>] [--reset] [--combine <pv-counts.json>]`,
  )
  process.exitCode = 1
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e))
    process.exitCode = 1
  })
}
