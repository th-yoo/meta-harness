/**
 * cli.ts — mini argv parser + dispatcher for the bench runner port.
 *
 * Structured for extension (`run`, `ab`, `judge-audit` land in P6 — see the
 * task brief's "Explicitly OUT of scope"); `prep`, `oracle`, `split`, and
 * `report-loop` exist today, no speculative flags for the others.
 */
import { makeBenchPaths } from "./paths.ts"
import { cmdPrep } from "./cmd-prep.ts"
import { cmdOracle } from "./cmd-oracle.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { cmdRun, type CmdRunArgs } from "./cmd-run.ts"
import { cmdJudgeAudit, type JudgeAuditArgs } from "./judge-audit.ts"
import { cmdSplit, type SplitArgs } from "./splits.ts"
import { cmdReportLoop, type ReportLoopArgs } from "./report-loop.ts"
import { BenchError } from "./util.ts"

const USAGE = `usage: runner.ts [--tb-root PATH] <command> [options]

commands:
  prep        [--apply]
  oracle      [--tasks TASK [TASK ...]] [--task-file PATH] [--results-file PATH]
              [--staging scripts|runtime]  (default: runtime)
  run         [--tasks TASK [TASK ...]] [--task-file PATH] [--all]
              [--model ID] [--variant V] [--k N] [--layers global|account|project|none]
              [--no-store] [--save-all-traj] [--no-harness] [--results-file PATH]
              [--label NAME] [--max-agent-timeout SEC] [--resume] [--agent NAME]
              [--pin LAYER=vN]... [--staging scripts|runtime]
  judge-audit --layer L --candidate vN [--agent NAME] [--model ID] [--limit N]
  split       make|rotate|show [--seed N] [--folds N] [--source FILE]
              [--split-file PATH] [--results PATH]... [--band LO,HI]
              [--sentinels N] [--sentinel-hi F]
  report-loop [--json] [--sink PATH]... [--no-flag]
              [--plateau-ab-k K] [--plateau-trial-k K]`

function printUsage(): void {
  console.error(USAGE)
}

/** Pulls the global `--tb-root PATH` flag out of argv wherever it appears,
 * returning the remaining args untouched (subcommand + its own flags). */
function extractTbRoot(argv: string[]): { tbRoot?: string; rest: string[] } | null {
  const rest: string[] = []
  let tbRoot: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tb-root") {
      const value = argv[i + 1]
      if (value === undefined) return null
      tbRoot = value
      i++
      continue
    }
    rest.push(argv[i]!)
  }
  return { tbRoot, rest }
}

interface PrepArgs {
  apply?: boolean
}

function parsePrepArgs(argv: string[]): PrepArgs | null {
  const out: PrepArgs = {}
  for (const a of argv) {
    if (a === "--apply") {
      out.apply = true
      continue
    }
    return null
  }
  return out
}

interface OracleArgs {
  tasks?: string[]
  taskFile?: string
  resultsFile?: string
  staging?: StagingMode
}

function parseOracleArgs(argv: string[]): OracleArgs | null {
  const out: OracleArgs = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--tasks") {
      const vals: string[] = []
      i++
      while (i < argv.length && !argv[i]!.startsWith("--")) {
        vals.push(argv[i]!)
        i++
      }
      if (vals.length === 0) return null
      out.tasks = vals
      continue
    }
    if (a === "--task-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.taskFile = v
      i += 2
      continue
    }
    if (a === "--results-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.resultsFile = v
      i += 2
      continue
    }
    if (a === "--staging") {
      const v = argv[i + 1]
      if (v !== "scripts" && v !== "runtime") return null
      out.staging = v
      i += 2
      continue
    }
    return null
  }
  return out
}

/** Consume a `--tasks TASK [TASK...]` run, stopping at the next `--flag`.
 * Shared by parseRunArgs/parseAbArgs (both accept the same nargs="+" form). */
function consumeTasksList(argv: string[], i: number): { vals: string[]; next: number } | null {
  const vals: string[] = []
  let j = i + 1
  while (j < argv.length && !argv[j]!.startsWith("--")) {
    vals.push(argv[j]!)
    j++
  }
  if (vals.length === 0) return null
  return { vals, next: j }
}

function parseRunArgs(argv: string[]): CmdRunArgs | null {
  const out: CmdRunArgs = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--tasks") {
      const r = consumeTasksList(argv, i)
      if (r === null) return null
      out.tasks = r.vals
      i = r.next
      continue
    }
    if (a === "--task-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.taskFile = v
      i += 2
      continue
    }
    if (a === "--all") {
      out.all = true
      i++
      continue
    }
    if (a === "--model") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.model = v
      i += 2
      continue
    }
    if (a === "--variant") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.variant = v
      i += 2
      continue
    }
    if (a === "--k") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.k = Number(v)
      i += 2
      continue
    }
    if (a === "--layers") {
      const v = argv[i + 1]
      if (v !== "global" && v !== "account" && v !== "project" && v !== "none") return null
      out.layers = v
      i += 2
      continue
    }
    if (a === "--no-store") {
      out.noStore = true
      i++
      continue
    }
    if (a === "--save-all-traj") {
      out.saveAllTraj = true
      i++
      continue
    }
    if (a === "--no-harness") {
      out.noHarness = true
      i++
      continue
    }
    if (a === "--results-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.resultsFile = v
      i += 2
      continue
    }
    if (a === "--label") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.label = v
      i += 2
      continue
    }
    if (a === "--max-agent-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.maxAgentTimeout = Number(v)
      i += 2
      continue
    }
    if (a === "--resume") {
      out.resume = true
      i++
      continue
    }
    if (a === "--agent") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.agent = v
      i += 2
      continue
    }
    if (a === "--pin") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.pin = out.pin ?? []
      out.pin.push(v)
      i += 2
      continue
    }
    if (a === "--staging") {
      const v = argv[i + 1]
      if (v !== "scripts" && v !== "runtime") return null
      out.staging = v
      i += 2
      continue
    }
    return null
  }
  return out
}

function parseJudgeAuditArgs(argv: string[]): JudgeAuditArgs | null {
  const out: Partial<JudgeAuditArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--layer") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.layer = v
      i += 2
      continue
    }
    if (a === "--candidate") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.candidate = v
      i += 2
      continue
    }
    if (a === "--agent") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.agent = v
      i += 2
      continue
    }
    if (a === "--model") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.model = v
      i += 2
      continue
    }
    if (a === "--limit") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.limit = Number(v)
      i += 2
      continue
    }
    return null
  }
  if (out.layer === undefined || out.candidate === undefined) return null
  return out as JudgeAuditArgs
}

function parseSplitArgs(argv: string[]): SplitArgs | null {
  if (argv.length === 0) return null
  const splitCmd = argv[0]
  if (splitCmd !== "make" && splitCmd !== "rotate" && splitCmd !== "show") return null
  const out: SplitArgs = { splitCmd }
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--seed") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.seed = Number(v)
      i += 2
      continue
    }
    if (a === "--folds") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.folds = Number(v)
      i += 2
      continue
    }
    if (a === "--source") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.source = v
      i += 2
      continue
    }
    if (a === "--split-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.splitFile = v
      i += 2
      continue
    }
    if (a === "--results") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.results = out.results ?? []
      out.results.push(v)
      i += 2
      continue
    }
    if (a === "--band") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.band = v
      i += 2
      continue
    }
    if (a === "--sentinels") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sentinels = Number(v)
      i += 2
      continue
    }
    if (a === "--sentinel-hi") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sentinelHi = Number(v)
      i += 2
      continue
    }
    return null
  }
  return out
}

function parseReportLoopArgs(argv: string[]): ReportLoopArgs | null {
  const out: ReportLoopArgs = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--json") {
      out.json = true
      i++
      continue
    }
    if (a === "--no-flag") {
      out.noFlag = true
      i++
      continue
    }
    if (a === "--sink") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sink = out.sink ?? []
      out.sink.push(v)
      i += 2
      continue
    }
    if (a === "--plateau-ab-k") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.plateauAbK = Number(v)
      i += 2
      continue
    }
    if (a === "--plateau-trial-k") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.plateauTrialK = Number(v)
      i += 2
      continue
    }
    return null
  }
  return out
}

export async function main(argv: string[]): Promise<number> {
  try {
    const global = extractTbRoot(argv)
    if (global === null) {
      printUsage()
      return 2
    }
    const { tbRoot, rest } = global
    const paths = makeBenchPaths(tbRoot !== undefined ? { tbRoot } : undefined)

    if (rest.length === 0) {
      printUsage()
      return 2
    }
    const [sub, ...subArgs] = rest as [string, ...string[]]

    switch (sub) {
      case "prep": {
        const prepArgs = parsePrepArgs(subArgs)
        if (prepArgs === null) {
          printUsage()
          return 2
        }
        await cmdPrep(paths, prepArgs)
        return 0
      }
      case "oracle": {
        const oracleArgs = parseOracleArgs(subArgs)
        if (oracleArgs === null) {
          printUsage()
          return 2
        }
        await cmdOracle(paths, oracleArgs)
        return 0
      }
      case "run": {
        const runArgs = parseRunArgs(subArgs)
        if (runArgs === null) {
          printUsage()
          return 2
        }
        await cmdRun(paths, runArgs)
        return 0
      }
      case "judge-audit": {
        const judgeArgs = parseJudgeAuditArgs(subArgs)
        if (judgeArgs === null) {
          printUsage()
          return 2
        }
        return await cmdJudgeAudit(paths, judgeArgs)
      }
      case "split": {
        const splitArgs = parseSplitArgs(subArgs)
        if (splitArgs === null) {
          printUsage()
          return 2
        }
        cmdSplit(paths, splitArgs)
        return 0
      }
      case "report-loop": {
        const reportArgs = parseReportLoopArgs(subArgs)
        if (reportArgs === null) {
          printUsage()
          return 2
        }
        cmdReportLoop(paths, reportArgs)
        return 0
      }
      default:
        printUsage()
        return 2
    }
  } catch (e) {
    if (e instanceof BenchError) {
      console.error(`error: ${e.message}`)
      return 1
    }
    throw e
  }
}
