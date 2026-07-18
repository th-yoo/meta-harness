/**
 * splits.ts — held-in/held-out task split management (splits.json) + the
 * stratified A/B decision gate wiring.
 *
 * Mirrors term-bench2/runner.py's "held-out split" section: task_pass_rates
 * (:1803), band_partition (:1827), load_active_split (:1853), _split_hash
 * (:1872), _resume_ident_check (:1882), filter_task_results (:1893),
 * sentinel_regression_reject (:1906), ab_decision (:1918), cmd_split (:1960).
 *
 * PRNG / shuffle parity note: band_partition's sentinel pick and cmd_split's
 * pool shuffle both port Python's `random.Random(seed).shuffle` — a
 * back-to-front Fisher-Yates using `_randbelow` — with the SAME algorithm
 * structure (see `seededShuffle` below), but driven by the vendored
 * mulberry32 PRNG (util.ts) instead of CPython's MT19937, which is
 * irreproducible outside CPython. Consequence: a splits.json produced by
 * this TS `cmd_split` at a given seed is internally consistent (same-seed
 * reruns reproduce it) but WILL differ task-for-task from a Python-produced
 * split at the same seed — sanctioned by the task brief. `load_active_split`,
 * `_split_hash`, `_resume_ident_check`, `filter_task_results`,
 * `sentinel_regression_reject`, and `ab_decision` have NO Python-vs-TS
 * divergence risk: they only ever READ a splits.json (whoever wrote it), so
 * they must and do read Python-written files byte-compatibly — see
 * test/bench-splits-band.test.ts's real-fixture hash check.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { createHash } from "node:crypto"
import { appendMetaMetric } from "../harness-store.ts"
import type { BenchPaths } from "./paths.ts"
import { die, log, mulberry32, pyFixed, writeJsonAtomic } from "./util.ts"
import { decide, pairedRunStats, pairedSpeedStats, type DecisionConfig, type PairStats } from "./ab-stats.ts"

// ── task_pass_rates ──────────────────────────────────────────────────────

/**
 * PURE (aside from the reads). Merge per-task pass rates from result files.
 * Handles BOTH shapes: agent-run ({"rewards":[...]}) and oracle/scalar
 * ({"reward":0|1}). Multiple files: pool all rewards per task (sum passes /
 * sum runs). Unreadable/unparseable file -> die() with a clear message;
 * unknown task shape -> skip.
 */
export function taskPassRates(resultsPaths: string[]): Record<string, number> {
  const passes: Record<string, number> = {}
  const runs: Record<string, number> = {}
  for (const p of resultsPaths) {
    let data: { tasks?: Record<string, { rewards?: number[]; reward?: number }> }
    try {
      data = JSON.parse(readFileSync(p, "utf-8"))
    } catch (e) {
      die(`task_pass_rates: cannot read ${p}: ${(e as Error).message}`)
    }
    for (const [task, entry] of Object.entries(data.tasks ?? {})) {
      let rs: number[]
      if (entry.rewards !== undefined) rs = entry.rewards
      else if (entry.reward !== undefined) rs = [entry.reward]
      else continue // unknown shape -> skip
      passes[task] = (passes[task] ?? 0) + rs.reduce((a, b) => a + b, 0)
      runs[task] = (runs[task] ?? 0) + rs.length
    }
  }
  const rates: Record<string, number> = {}
  for (const t of Object.keys(runs)) {
    if (runs[t]! > 0) rates[t] = passes[t]! / runs[t]!
  }
  return rates
}

// ── seeded shuffle (see file header PRNG note) ──────────────────────────────

/**
 * Fisher-Yates shuffle, back-to-front — same loop structure as CPython's
 * `random.Random(seed).shuffle` (`for i in reversed(range(1, len(x))): j =
 * randbelow(i+1); swap`), driven by the vendored mulberry32 PRNG. Returns a
 * new array; does not mutate `arr`.
 */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice()
  const rand = mulberry32(seed)
  for (let i = out.length - 1; i >= 1; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** Python `seq[start::step]` — elements at start, start+step, start+2*step, ... */
function sliceStep<T>(arr: T[], start: number, step: number): T[] {
  const out: T[] = []
  for (let i = start; i < arr.length; i += step) out.push(arr[i]!)
  return out
}

// ── band_partition ───────────────────────────────────────────────────────

/**
 * PURE. Returns [pool, sentinels, excluded]:
 *   pool      = tasks with rate in [lo, hi] OR no rate data (unknown stays in)
 *   sentinels = up to nSentinels tasks with rate >= sentinelHi, seeded-random pick
 *   excluded  = the rest (too easy beyond sentinel quota, or rate < lo = out of reach)
 */
export function bandPartition(
  tasks: string[],
  rates: Record<string, number>,
  lo: number,
  hi: number,
  sentinelHi: number,
  nSentinels: number,
  seed: number,
): [string[], string[], string[]] {
  const pool: string[] = []
  const easyCandidates: string[] = []
  let excluded: string[] = []
  for (const t of tasks) {
    const r = rates[t]
    if (r === undefined) {
      pool.push(t)
    } else if (r >= sentinelHi) {
      easyCandidates.push(t)
    } else if (r >= lo && r <= hi) {
      pool.push(t)
    } else {
      excluded.push(t)
    }
  }
  const shuffledEasy = seededShuffle(easyCandidates, seed)
  const sentinels = shuffledEasy.slice(0, nSentinels)
  excluded = excluded.concat(shuffledEasy.slice(nSentinels))
  return [pool, sentinels, excluded]
}

// ── load_active_split ────────────────────────────────────────────────────

export interface SplitMeta {
  file: string
  activeFold: number
  heldIn: string[]
  heldOut: string[]
  sentinels: string[]
}

interface SplitsFile {
  folds: string[][]
  activeFold?: number
  sentinels?: string[]
  [k: string]: unknown
}

/**
 * Return {heldIn, heldOut, meta} from splits.json. heldOut = folds[activeFold]
 * + sentinels (easy-task regression canaries from `split make --results`; []
 * for schemaVersion 1 files), fold tasks first, deduped so a sentinel already
 * in the active fold isn't appended twice. heldIn = all other folds
 * concatenated — sentinels NEVER appear in heldIn.
 */
export function loadActiveSplit(splitsPath: string): { heldIn: string[]; heldOut: string[]; meta: SplitMeta } {
  const data = JSON.parse(readFileSync(splitsPath, "utf-8")) as SplitsFile
  const folds = data.folds
  const active = Number(data.activeFold ?? 0)
  const foldHeldOut = folds[active]!.slice()
  const heldIn = folds.flatMap((f, i) => (i === active ? [] : f))
  const sentinels = (data.sentinels ?? []).slice()
  const extraSentinels = sentinels.filter((t) => !foldHeldOut.includes(t))
  const heldOut = foldHeldOut.concat(extraSentinels)
  const meta: SplitMeta = { file: basename(splitsPath), activeFold: active, heldIn, heldOut, sentinels }
  return { heldIn, heldOut, meta }
}

// ── _split_hash ──────────────────────────────────────────────────────────

/**
 * PURE. A short fingerprint of a task-set composition, used to detect a
 * splits.json (or --tasks list) that changed underneath an in-progress
 * --resume. splitHash must read PYTHON-written splits.json byte-compatibly:
 * the payload is `sorted(heldIn) + ["|"] + sorted(heldOut)` serialized as
 * JSON exactly like Python's `json.dumps(list)` — default `", "` item
 * separator, no space after `[`. (Python's default `ensure_ascii=True` would
 * escape non-ASCII characters as \uXXXX where JSON.stringify would not; task
 * IDs are ASCII-only in practice, so this never bites — see
 * test/bench-splits-band.test.ts's real-fixture check, hand-verified against
 * a Python hand-computation of this exact serialization.)
 */
export function splitHash(heldIn: string[], heldOut: string[]): string {
  const combined = [...heldIn].sort().concat(["|"]).concat([...heldOut].sort())
  const payload = "[" + combined.map((s) => JSON.stringify(s)).join(", ") + "]"
  return createHash("sha256").update(payload).digest("hex").slice(0, 12)
}

// ── _resume_ident_check ──────────────────────────────────────────────────

/**
 * Die if any run_ident field doesn't match the prior partial file's recorded
 * value — guards --resume against silently continuing a run under a
 * different composition (model swap, re-rotated fold, regenerated
 * splits.json, etc).
 */
export function resumeIdentCheck(prev: Record<string, unknown>, runIdent: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(runIdent)) {
    if (prev[k] !== v) {
      die(`--resume: prior partial ${k}=${JSON.stringify(prev[k])} != ${JSON.stringify(v)}; delete the partial to restart`)
    }
  }
}

// ── filter_task_results ──────────────────────────────────────────────────

export interface PhaseTaggedResult {
  phase?: string
  sentinel?: boolean
  candidate?: number[]
  active?: number[]
  error?: string
  // W1a (time-to-resolve, type-only widening — see ab-stats.ts's TaskResults
  // for the same fields): per-run agent-phase elapsed seconds.
  candidateElapsed?: number[]
  activeElapsed?: number[]
}
export type PhaseTaggedTaskResults = Record<string, PhaseTaggedResult>

/**
 * PURE. Subset of task_results for a given phase, optionally further
 * filtered by the 'sentinel' tag cmd_ab attaches to each held-out result.
 * This is the stratification fix: a sentinel both arms pass inflates n_pairs
 * without moving b/c, which can dilute a marginal fold regression's delta
 * below --nonregress-margin — so the held-out gate must be computed from
 * fold-only results, with sentinels scored separately.
 */
export function filterTaskResults(
  taskResults: PhaseTaggedTaskResults,
  phase: string,
  sentinel?: boolean,
): PhaseTaggedTaskResults {
  const out: PhaseTaggedTaskResults = {}
  for (const [t, tr] of Object.entries(taskResults)) {
    if (tr.phase !== phase) continue
    if (sentinel !== undefined && Boolean(tr.sentinel) !== sentinel) continue
    out[t] = tr
  }
  return out
}

// ── sentinel_regression_reject ───────────────────────────────────────────

/**
 * PURE. Sentinels are easy tasks both arms are expected to pass; if the
 * sentinel-only paired stats show a regression beyond `margin`, force a
 * reject regardless of the (fold-only) held-out gate's own decision — a
 * correctness signal independent of the fold sample size.
 */
export function sentinelRegressionReject(
  decision: string,
  reasons: string[],
  hoSentinel: PairStats | null,
  margin: number,
): [string, string[]] {
  if (hoSentinel !== null && hoSentinel.delta < -margin) {
    return ["reject", [...reasons, "sentinel regression"]]
  }
  return [decision, reasons]
}

// ── ab_decision ──────────────────────────────────────────────────────────

/**
 * PURE. Compute the A/B verdict from task_results + config — this is the
 * single place that wires the stratified held-out gate:
 *   - held-in stats are pooled as usual.
 *   - held-out stats fed to decide() are FOLD-ONLY (filterTaskResults with
 *     sentinel=false) — sentinels are excluded so a sentinel-both-arms-pass
 *     can never dilute a marginal fold regression under cfg.nonregressMargin.
 *   - an early-stopped run is always forced to reject, regardless of what
 *     decide() would otherwise say.
 *   - sentinel-only results are checked separately via
 *     sentinelRegressionReject, which can force a reject independently of the
 *     fold gate's own decision.
 * Returns [decision, reasons, heldIn, heldOut, heldOutSentinel] where the
 * last two are PairStats or null — null iff there were no fold / sentinel
 * held-out tasks in this split respectively.
 *
 * Phase 3 W1c (speed tiebreaker, opt-in via `cfg.speedTiebreak`): after
 * decide() but before the earlyStopped/sentinel overrides below, an
 * `inconclusive` verdict may be upgraded to `accept` when the candidate is
 * significantly faster on held-in both-pass pairs — behind STRUCTURAL guards
 * only (no parsing of `reasons` strings, which are display text, not a
 * contract):
 *   1. decision === "inconclusive" && !earlyStopped;
 *   2. ho !== null — the held-out PairStats computed above. This structurally
 *      excludes LEGACY mode (--tasks/--task-file/--all => no held-out split
 *      => decide() can never accept, cmd-ab.ts's explicit-mode branch) — the
 *      speed tiebreak must never manufacture an accept that reward-mode
 *      itself could not reach;
 *   3. hi.delta >= 0 — decide() can say "inconclusive" with a (non-
 *      significantly) negative held-in delta too; the tiebreak must not
 *      upgrade a candidate that's behind on reward, even a little;
 *   4. pairedSpeedStats(held-in) meets nPairs >= minBothPassPairs &&
 *      signTestP <= alpha && medianRatio <= maxMedianRatio.
 * The earlyStopped-forced-reject and sentinelRegressionReject overrides below
 * still run AFTER this block and can override an accept the tiebreak just
 * produced — sentinel-regression reject always has the last word.
 */
export function abDecision(
  taskResults: PhaseTaggedTaskResults,
  cfg: DecisionConfig,
  earlyStopped: boolean,
  foldOutTasks: string[],
  sentinelOutTasks: string[],
): [string, string[], PairStats, PairStats | null, PairStats | null] {
  const hi = pairedRunStats(filterTaskResults(taskResults, "held-in"))
  const ho = foldOutTasks.length > 0 ? pairedRunStats(filterTaskResults(taskResults, "held-out", false)) : null
  const hoSentinel =
    sentinelOutTasks.length > 0 ? pairedRunStats(filterTaskResults(taskResults, "held-out", true)) : null

  const decided = decide(hi, ho, cfg)
  let decision: string = decided.decision
  let reasons: string[] = decided.reasons

  if (cfg.speedTiebreak && decision === "inconclusive" && !earlyStopped && ho !== null && hi.delta >= 0) {
    const speedHi = pairedSpeedStats(filterTaskResults(taskResults, "held-in"))
    if (
      speedHi !== null &&
      speedHi.nPairs >= cfg.speedTiebreak.minBothPassPairs &&
      speedHi.signTestP <= cfg.speedTiebreak.alpha &&
      speedHi.medianRatio <= cfg.speedTiebreak.maxMedianRatio
    ) {
      decision = "accept"
      reasons = [
        ...reasons,
        `speed tiebreak: candidate significantly faster on held-in ` +
          `(medianRatio=${pyFixed(speedHi.medianRatio, 3)} p=${pyFixed(speedHi.signTestP, 3)} n=${speedHi.nPairs})`,
      ]
    }
  }

  if (earlyStopped && decision !== "reject") {
    decision = "reject"
    reasons = [...reasons, "early-stopped on futility"]
  }
  ;[decision, reasons] = sentinelRegressionReject(decision, reasons, hoSentinel, cfg.nonregressMargin)
  return [decision, reasons, hi, ho, hoSentinel]
}

// ── cmd_split ────────────────────────────────────────────────────────────

export interface SplitArgs {
  splitCmd: "make" | "rotate" | "show"
  seed?: number
  folds?: number
  source?: string
  splitFile?: string
  results?: string[]
  band?: string
  sentinels?: number
  sentinelHi?: number
}

/**
 * `split make|rotate|show` — manage splits.json. Mirrors runner.py's
 * cmd_split (:1960). `rotate`'s meta-metric append is a DOCUMENTED deviation
 * from Python parity: Python appends the rotate event to the bench sink
 * (term-bench2/results/meta-metrics.jsonl, bench_store.DEFAULT_METRICS_SINK).
 * This TS port reuses harness-store.ts's `appendMetaMetric` per the task
 * brief's reuse mandate rather than hand-rolling a second appender; that
 * helper resolves its sink by walking up from storeRoot to the nearest
 * ".meta-harness" ancestor, which the flat bench sink path has none of — so
 * the event instead lands in the PROJECT sink (metaRoot/.meta-harness/
 * meta-metrics.jsonl, the same file `appendMetaMetric` already uses
 * elsewhere in this codebase). report-loop's 3-sink merge still picks it up
 * either way; only the physical file (and hence its `_sink` tag) differs.
 */
export function cmdSplit(paths: BenchPaths, args: SplitArgs): void {
  const splitsPath = args.splitFile ?? paths.splitsFile

  if (args.splitCmd === "make") {
    const seed = args.seed ?? 42
    const folds = args.folds ?? 4
    const sourceName = args.source ?? "baseline-tasks.txt"
    const sourcePath = join(paths.termBenchDir, sourceName)
    const text = readFileSync(sourcePath, "utf-8")
    const tasks = text
      .split(/\r?\n/)
      .map((ln) => ln.trim())
      .filter((ln) => ln.length > 0 && !ln.startsWith("#"))
    if (tasks.length === 0) die(`split make: no tasks in ${sourcePath}`)

    let poolTasks = tasks
    let band: [number, number] | null = null
    let sentinels: string[] = []
    let excluded: string[] = []
    let rates: Record<string, number> = {}
    const hasResults = args.results !== undefined && args.results.length > 0

    if (hasResults) {
      const bandStr = args.band ?? "0.2,0.8"
      const parts = bandStr.split(",")
      if (parts.length !== 2) die(`--band must be LO,HI (two floats), got ${JSON.stringify(bandStr)}`)
      const bandLo = Number(parts[0])
      const bandHi = Number(parts[1])
      if (Number.isNaN(bandLo) || Number.isNaN(bandHi)) {
        die(`--band must be LO,HI (two floats), got ${JSON.stringify(bandStr)}`)
      }
      if (bandLo > bandHi) die(`--band LO must be <= HI, got ${JSON.stringify(bandStr)}`)
      band = [bandLo, bandHi]
      rates = taskPassRates(args.results!)
      const sentinelHi = args.sentinelHi ?? 0.9
      const nSentinels = args.sentinels ?? 3
      ;[poolTasks, sentinels, excluded] = bandPartition(tasks, rates, bandLo, bandHi, sentinelHi, nSentinels, seed)
    }

    const shuffled = seededShuffle(poolTasks, seed)
    const foldsArr: string[][] = []
    for (let i = 0; i < folds; i++) foldsArr.push(sliceStep(shuffled, i, folds))

    const data: Record<string, unknown> = {
      schemaVersion: 1,
      seed,
      source: basename(sourcePath),
      folds: foldsArr,
      activeFold: 0,
      rotatedAt: null,
    }
    if (hasResults) {
      data.schemaVersion = 2
      data.band = band
      data.sentinels = sentinels
      data.passRates = rates
      data.excluded = excluded
    }
    writeJsonAtomic(splitsPath, data)
    log(
      `split: wrote ${splitsPath} — ${poolTasks.length} tasks, ${folds} folds ` +
        `(sizes [${foldsArr.map((f) => f.length).join(", ")}])`,
    )
  } else if (args.splitCmd === "rotate") {
    if (!existsSync(splitsPath)) die(`split rotate: ${splitsPath} not found — run 'split make' first`)
    const data = JSON.parse(readFileSync(splitsPath, "utf-8")) as SplitsFile
    const n = data.folds.length
    const nextFold = (Number(data.activeFold ?? 0) + 1) % n
    data.activeFold = nextFold
    data.rotatedAt = new Date().toISOString()
    writeJsonAtomic(splitsPath, data)
    appendMetaMetric(join(paths.metaRoot, ".meta-harness"), {
      event: "rotate",
      splitFold: nextFold,
      ts: data.rotatedAt,
    })
    log(`split: rotated → activeFold=${nextFold} of ${n}`)
  } else {
    // show
    if (!existsSync(splitsPath)) die(`split show: ${splitsPath} not found — run 'split make' first`)
    const data = JSON.parse(readFileSync(splitsPath, "utf-8")) as SplitsFile
    const { heldIn, heldOut, meta } = loadActiveSplit(splitsPath)
    console.log(
      `splits: ${splitsPath}  seed=${data.seed}  folds=${data.folds.length}  ` +
        `activeFold=${meta.activeFold}  sizes=[${data.folds.map((f) => f.length).join(", ")}]`,
    )
    console.log(`  held-out (${heldOut.length}): ${heldOut.join(", ")}`)
    console.log(`  held-in  (${heldIn.length}): ${heldIn.join(", ")}`)
    if (meta.sentinels.length > 0) {
      console.log(`  sentinels (${meta.sentinels.length}): ${meta.sentinels.join(", ")}`)
    }
  }
}
