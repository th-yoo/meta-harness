#!/usr/bin/env bun
/**
 * curate-band.ts — Phase 4 W2a driver. Turns the committed matrix.json
 * (built by pull-leaderboard.ts's HF sweep) plus our own local pass-rate
 * data into a curated candidate task band, using the PURE math in
 * opencode-plugin/src/bench/leaderboard.ts.
 *
 * Writes ALL outputs into term-bench2/leaderboard/: band-v2.txt,
 * shortlist.txt, curation-report.md. This exact path/filename set is a
 * contract consumed by Phase 6 (which will pin its own exact invocation
 * flags) — do not relocate them.
 *
 * Usage:
 *   bun curate-band.ts --results FILE [FILE ...] [--band LO,HI] [--max N]
 *     [--min-subs N] [--raw] [--trust-leaderboard-fails]
 * Run with --help for flag details.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  harnessVariance,
  tierVariance,
  curateBand,
  type Matrix,
  type TaskStats,
  type TiersMap,
} from "../../opencode-plugin/src/bench/leaderboard.ts"
import { taskPassRates } from "../../opencode-plugin/src/bench/splits.ts"
import { makeBenchPaths } from "../../opencode-plugin/src/bench/paths.ts"
// tmp+rename writes — a crash mid-write must never leave a torn band-v2.txt/
// shortlist.txt/curation-report.md for the Phase 6 consumer to read.
import { writeTextAtomic } from "../../opencode-plugin/src/bench/util.ts"

const HERE = new URL(".", import.meta.url).pathname
const MATRIX_PATH = join(HERE, "matrix.json")
const TIERS_PATH = join(HERE, "tiers.json")
const BAND_OUT = join(HERE, "band-v2.txt")
const SHORTLIST_OUT = join(HERE, "shortlist.txt")
const REPORT_OUT = join(HERE, "curation-report.md")

interface Args {
  results: string[]
  band: [number, number]
  max: number
  minSubs: number
  useTiers: boolean
  trustLeaderboardFails: boolean
}

function printUsage(): void {
  console.error(
    [
      "usage: bun curate-band.ts --results FILE [FILE ...] [--band LO,HI] [--max N]",
      "         [--min-subs N] [--raw] [--trust-leaderboard-fails]",
      "",
      "  --results    one or more taskPassRates-compatible JSON files (e.g.",
      "               term-bench2/results/*.json) feeding ourRates -- REQUIRED.",
      "               Rewards are pooled across every file given.",
      "  --band       difficulty band on cross-harness MEAN pass rate that a",
      "               task must fall in to qualify, default 0.2,0.8.",
      "  --max        cap on the curated band size (highest-variance kept),",
      "               default 30.",
      "  --min-subs   minimum leaderboard-submission coverage required to",
      "               trust a task's variance, default 4.",
      "  --raw        rank by raw per-submission variance (harnessVariance)",
      "               instead of the default between-tier variance",
      "               (tierVariance, needs tiers.json).",
      "  --trust-leaderboard-fails",
      "               by default, a task where EVERY reporting submission",
      "               scored 0 is excluded before curation -- Phase 5 hasn't",
      "               yet gated whether a unanimous leaderboard fail is a",
      "               genuine difficulty signal or an infra/verifier",
      "               artifact, so it's untrusted until then. Pass this flag",
      "               once that gate says trusted.",
    ].join("\n"),
  )
}

function parseArgs(argv: string[]): Args {
  const args: Args = { results: [], band: [0.2, 0.8], max: 30, minSubs: 4, useTiers: true, trustLeaderboardFails: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--results") {
      while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) args.results.push(argv[++i]!)
    } else if (a === "--band") {
      const parts = (argv[++i] ?? "").split(",").map(Number)
      if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) {
        console.error(`--band expects LO,HI (two numbers), got ${JSON.stringify(argv[i])}`)
        process.exit(1)
      }
      args.band = [parts[0]!, parts[1]!]
    } else if (a === "--max") {
      args.max = Number(argv[++i])
    } else if (a === "--min-subs") {
      args.minSubs = Number(argv[++i])
    } else if (a === "--raw") {
      args.useTiers = false
    } else if (a === "--trust-leaderboard-fails") {
      args.trustLeaderboardFails = true
    } else if (a === "--help" || a === "-h") {
      printUsage()
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      printUsage()
      process.exit(1)
    }
  }
  return args
}

function loadMatrix(): Matrix {
  if (!existsSync(MATRIX_PATH)) {
    console.error(
      `${MATRIX_PATH} not found -- run pull-leaderboard.ts first ` +
        `(--all for the full sweep, or a single <sub> to validate on a couple of submissions)`,
    )
    process.exit(1)
  }
  return JSON.parse(readFileSync(MATRIX_PATH, "utf-8"))
}

/** tiers.json is a flat sub -> tier map with one non-tier "_comment" key
 * documenting the file -- strip any "_"-prefixed key before use. Missing
 * file -> empty map (tierVariance then treats every sub as unmapped, i.e.
 * every task's tier variance is untrusted; use --raw in that case). */
function loadTiers(): TiersMap {
  if (!existsSync(TIERS_PATH)) return {}
  const raw = JSON.parse(readFileSync(TIERS_PATH, "utf-8")) as Record<string, string>
  const out: TiersMap = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue
    out[k] = v
  }
  return out
}

/** Task dirs under the local TB2 checkout (tbRoot — sibling of the meta-
 * harness repo root, see paths.ts), each required to have a task.toml.
 * Derived via readdir every run — NEVER hardcoded, since which tasks are
 * locally available changes as `bench task-load` closes gaps. */
function localTaskList(): string[] {
  const { tbRoot } = makeBenchPaths()
  if (!existsSync(tbRoot)) {
    console.error(`local TB2 checkout not found at ${tbRoot} -- treating localTasks as empty`)
    return []
  }
  return readdirSync(tbRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(tbRoot, e.name, "task.toml")))
    .map((e) => e.name)
    .sort()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.results.length === 0) {
    console.error("--results is required (one or more taskPassRates-compatible JSON files)")
    printUsage()
    process.exit(1)
  }
  if (!Number.isFinite(args.max) || args.max <= 0) {
    console.error("--max must be a positive number")
    process.exit(1)
  }
  if (!Number.isFinite(args.minSubs) || args.minSubs < 1) {
    console.error("--min-subs must be a positive number")
    process.exit(1)
  }

  let matrix = loadMatrix()
  const tiers = loadTiers()
  const localTasks = localTaskList()
  const ourRates = taskPassRates(args.results)

  // --trust-leaderboard-fails gate (driver-level only; Phase 5's actual
  // trust gate doesn't exist yet). A task where EVERY reporting submission
  // scored 0 could be a genuinely hard task, OR a task that's broken/
  // unsolvable in the leaderboard's harness sandbox (infra/verifier bug) --
  // indistinguishable from the matrix alone. Exclude it from all three
  // curation outputs unless explicitly trusted.
  const unanimousFails: string[] = []
  if (!args.trustLeaderboardFails) {
    const filtered: Matrix = {}
    for (const [task, row] of Object.entries(matrix)) {
      const rates = Object.values(row)
      if (rates.length > 0 && rates.every((r) => r === 0)) {
        unanimousFails.push(task)
        continue
      }
      filtered[task] = row
    }
    matrix = filtered
    unanimousFails.sort()
  }

  const rawStats = harnessVariance(matrix, args.minSubs)
  const tierStats = tierVariance(matrix, tiers, args.minSubs)
  const stats: Record<string, TaskStats> = args.useTiers ? tierStats : rawStats

  const result = curateBand(stats, ourRates, {
    band: args.band,
    localTasks,
    max: args.max,
    minSubs: args.minSubs,
  })

  writeTextAtomic(BAND_OUT, result.band.length ? result.band.join("\n") + "\n" : "")
  writeTextAtomic(SHORTLIST_OUT, result.shortlist.length ? result.shortlist.join("\n") + "\n" : "")

  const subsInMatrix = new Set<string>()
  for (const row of Object.values(matrix)) for (const s of Object.keys(row)) subsInMatrix.add(s)

  const fmt = (n: number | null): string => (n === null ? "n/a" : n.toFixed(3))
  const lines: string[] = []
  lines.push("# Leaderboard band curation report")
  lines.push("")
  lines.push(`Generated ${new Date().toISOString()} by term-bench2/leaderboard/curate-band.ts`)
  lines.push("")
  lines.push("## Inputs")
  lines.push(`- matrix.json: ${Object.keys(matrix).length} tasks (post-fail-filter), ${subsInMatrix.size} submissions`)
  lines.push(`- tiers.json: ${Object.keys(tiers).length} submissions mapped`)
  lines.push(`- --results: ${args.results.join(", ")}`)
  lines.push(`- ourRates: ${Object.keys(ourRates).length} tasks with a local pass rate`)
  lines.push(`- localTasks (TB2 checkout): ${localTasks.length} task dirs with task.toml`)
  lines.push(
    `- band=[${args.band[0]}, ${args.band[1]}]  max=${args.max}  minSubs=${args.minSubs}  ` +
      `ranking=${args.useTiers ? "tierVariance" : "harnessVariance"}  trustLeaderboardFails=${args.trustLeaderboardFails}`,
  )
  lines.push("")
  if (unanimousFails.length > 0) {
    lines.push(`## Unanimous-fail tasks excluded (${unanimousFails.length})`)
    lines.push(
      "Every reporting submission scored 0 — excluded pending Phase 5's gate on whether this " +
        "is a genuine difficulty signal or an infra/verifier artifact. Re-run with " +
        "`--trust-leaderboard-fails` to include them.",
    )
    lines.push("")
    for (const t of unanimousFails) lines.push(`- ${t}`)
    lines.push("")
  }
  lines.push(`## Band (${result.band.length}/${args.max} cap)`)
  lines.push(
    `Local + variance-trusted + in-band + we already have a local pass rate. Sorted by ` +
      `${args.useTiers ? "tier" : "raw"} variance, descending.`,
  )
  lines.push("")
  for (const t of result.band) {
    const s = stats[t]!
    lines.push(`- \`${t}\` mean=${fmt(s.mean)} variance=${fmt(s.variance)} coverage=${s.coverage} ourRate=${ourRates[t]!.toFixed(2)}`)
  }
  lines.push("")
  lines.push(`## Shortlist (${result.shortlist.length})`)
  lines.push("Same qualification as band, but no local ourRates entry yet — run these locally before promoting.")
  lines.push("")
  for (const t of result.shortlist) {
    const s = stats[t]!
    lines.push(`- \`${t}\` mean=${fmt(s.mean)} variance=${fmt(s.variance)} coverage=${s.coverage}`)
  }
  lines.push("")
  lines.push(`## Excluded — not in local TB2 checkout (${result.excludedNonLocal.length})`)
  lines.push("Qualifies on leaderboard variance/band criteria but has no task.toml under the local checkout — fetch via `bench task-load`.")
  lines.push("")
  for (const t of result.excludedNonLocal) lines.push(`- ${t}`)
  lines.push("")

  writeTextAtomic(REPORT_OUT, lines.join("\n"))

  console.log(
    `curate-band: band=${result.band.length} shortlist=${result.shortlist.length} ` +
      `excludedNonLocal=${result.excludedNonLocal.length} unanimousFailsExcluded=${unanimousFails.length}\n` +
      `  wrote ${BAND_OUT}\n  wrote ${SHORTLIST_OUT}\n  wrote ${REPORT_OUT}`,
  )
}

await main()
