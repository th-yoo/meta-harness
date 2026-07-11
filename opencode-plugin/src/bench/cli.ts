/**
 * cli.ts — mini argv parser + dispatcher for the bench runner port.
 *
 * Structured for extension (more subcommands land in later phases: run, ab,
 * split, report, judge — see the task brief's "Explicitly OUT of scope");
 * only `prep` and `oracle` exist today, no speculative flags for the others.
 */
import { makeBenchPaths } from "./paths.ts"
import { cmdPrep } from "./cmd-prep.ts"
import { cmdOracle } from "./cmd-oracle.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { BenchError } from "./util.ts"

const USAGE = `usage: runner.ts [--tb-root PATH] <command> [options]

commands:
  prep   [--apply]
  oracle [--tasks TASK [TASK ...]] [--task-file PATH] [--results-file PATH]
         [--staging scripts|runtime]  (default: runtime)`

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
