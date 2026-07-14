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
import { cmdAb, type CmdAbArgs } from "./cmd-ab.ts"
import { cmdJudgeAudit, type JudgeAuditArgs } from "./judge-audit.ts"
import { LAYER_CHOICES, type LayerName } from "./record.ts"
import { cmdSplit, type SplitArgs } from "./splits.ts"
import { cmdReportLoop, type ReportLoopArgs } from "./report-loop.ts"
import { BenchError, log } from "./util.ts"
import { DRIVER_IDS } from "./drivers/index.ts"
import { readFileSync } from "node:fs"
import { writeSquadDefV1, readActiveSquadDef, syncWireContracts, STANDARD_SQUAD } from "../fleet/squad-def.ts"
import { cmdRolesRender } from "../fleet/render.ts"
import { cmdRolesImport } from "../fleet/import.ts"
import { cmdRoleRun } from "../fleet/run.ts"
import { cmdRoleScore, FLEET_GATES, type FleetGate } from "../fleet/score.ts"
import { cmdSquadRun } from "../fleet/squad-cli.ts"
import { cmdSquadPropose } from "../fleet/squad-propose.ts"

const USAGE = `usage: runner.ts [--tb-root PATH] <command> [options]

commands:
  prep        [--apply]
  oracle      [--tasks TASK [TASK ...]] [--task-file PATH] [--results-file PATH]
              [--staging scripts|runtime]  (default: runtime)
  run         [--tasks TASK [TASK ...]] [--task-file PATH] [--all]
              [--model ID] [--variant V] [--k N] [--layers global|account|project|none]
              [--no-store] [--save-all-traj] [--no-harness] [--results-file PATH]
              [--label NAME] [--max-agent-timeout SEC] [--resume] [--agent NAME]
              [--pin LAYER=vN]... [--staging scripts|runtime] [--driver ID]
  ab          --layer L --candidate vN [--tasks TASK [TASK ...]] [--task-file PATH]
              [--all] [--split-file PATH] [--model ID] [--variant V] [--k N]
              [--layers global|account|project] [--agent NAME] [--alpha F]
              [--nonregress-margin F] [--min-tasks-before-stop N] [--no-early-stop]
              [--max-agent-timeout SEC] [--resume] [--no-store] [--save-all-traj]
              [--results-file PATH] [--staging scripts|runtime] [--driver ID]
  judge-audit --layer L --candidate vN [--agent NAME] [--model ID] [--limit N]
  split       make|rotate|show [--seed N] [--folds N] [--source FILE]
              [--split-file PATH] [--results PATH]... [--band LO,HI]
              [--sentinels N] [--sentinel-hi F]
  report-loop [--json] [--sink PATH]... [--no-flag]
              [--plateau-ab-k K] [--plateau-trial-k K]
  squad-def-init
  roles-render  --project PATH [--role R]... [--pin LAYER=vN]... [--force]
  roles-import  --from DIR [--role R]... [--force] [--map SRC=DEST1,DEST2]...
  role-run      --project PATH --role R [--model M] [--node-path P] [--slice-id S]
                [--timeout-sec N] [--json] (--input-file F | "input")
  role-score    --project PATH --id ID good|bad [--note S] [--node-path P]
                [--gate gate1|gate2|verdict|merge|lint|infeasible]
  squad-run     --project PATH --slice-id S (--slice "text" | --slice-file F)
                [--resume --gate-answer approve|revise]
                [--gate-policy root-human|auto] [--squad-type T] [--model M] [--json]
  squad-propose [--squad-type T] [--model M] [--timeout-sec N]`

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
    if (a === "--driver") {
      const v = argv[i + 1]
      if (v === undefined || !(DRIVER_IDS as readonly string[]).includes(v)) return null
      out.driver = v
      i += 2
      continue
    }
    return null
  }
  return out
}

function parseAbArgs(argv: string[]): CmdAbArgs | null {
  const out: Partial<CmdAbArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--layer") {
      const v = argv[i + 1]
      if (v === undefined || !(LAYER_CHOICES as string[]).includes(v)) return null
      out.layer = v as LayerName
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
    if (a === "--split-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.splitFile = v
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
      if (v !== "global" && v !== "account" && v !== "project") return null
      out.layers = v
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
    if (a === "--alpha") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.alpha = Number(v)
      i += 2
      continue
    }
    if (a === "--nonregress-margin") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.nonregressMargin = Number(v)
      i += 2
      continue
    }
    if (a === "--min-tasks-before-stop") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.minTasksBeforeStop = Number(v)
      i += 2
      continue
    }
    if (a === "--no-early-stop") {
      out.noEarlyStop = true
      i++
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
    if (a === "--driver") {
      const v = argv[i + 1]
      if (v === undefined || !(DRIVER_IDS as readonly string[]).includes(v)) return null
      out.driver = v
      i += 2
      continue
    }
    return null
  }
  if (out.layer === undefined || out.candidate === undefined) return null
  return out as CmdAbArgs
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

interface RolesRenderArgs {
  project: string
  roles?: string[]
  pins?: string[]
  force?: boolean
}

function parseRolesRenderArgs(argv: string[]): RolesRenderArgs | null {
  const out: Partial<RolesRenderArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--project") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.project = v
      i += 2
      continue
    }
    if (a === "--role") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.roles = out.roles ?? []
      out.roles.push(v)
      i += 2
      continue
    }
    if (a === "--pin") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.pins = out.pins ?? []
      out.pins.push(v)
      i += 2
      continue
    }
    if (a === "--force") {
      out.force = true
      i++
      continue
    }
    return null
  }
  if (out.project === undefined) return null
  return out as RolesRenderArgs
}

interface RolesImportArgs {
  from: string
  roles?: string[]
  force?: boolean
  map?: Record<string, string[]>
}

function parseRolesImportArgs(argv: string[]): RolesImportArgs | null {
  const out: Partial<RolesImportArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--from") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.from = v
      i += 2
      continue
    }
    if (a === "--role") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.roles = out.roles ?? []
      out.roles.push(v)
      i += 2
      continue
    }
    if (a === "--force") {
      out.force = true
      i++
      continue
    }
    if (a === "--map") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.map = out.map ?? {}
      const [src, destStr] = v.split("=")
      if (!src || !destStr) return null
      const dests = destStr.split(",")
      out.map[src] = dests
      i += 2
      continue
    }
    return null
  }
  if (out.from === undefined) return null
  return out as RolesImportArgs
}

interface RoleRunCliArgs {
  project: string
  role: string
  model?: string
  nodePath?: string
  sliceId?: string
  timeoutSec?: number
  json?: boolean
  inputFile?: string
  input?: string
}

function parseRoleRunArgs(argv: string[]): RoleRunCliArgs | null {
  const out: Partial<RoleRunCliArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--project") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.project = v
      i += 2
      continue
    }
    if (a === "--role") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.role = v
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
    if (a === "--node-path") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.nodePath = v
      i += 2
      continue
    }
    if (a === "--slice-id") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sliceId = v
      i += 2
      continue
    }
    if (a === "--timeout-sec") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.timeoutSec = Number(v)
      i += 2
      continue
    }
    if (a === "--json") {
      out.json = true
      i++
      continue
    }
    if (a === "--input-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.inputFile = v
      i += 2
      continue
    }
    // Sole positional: the input string. Only one is accepted (matches the
    // brief's `"input"` singular positional — a caller passes it as one
    // already-quoted argv element, same convention role-run's other single-
    // value flags use).
    if (out.input === undefined) {
      out.input = a
      i++
      continue
    }
    return null
  }
  if (out.project === undefined || out.role === undefined) return null
  // Exactly one of --input-file / positional input must be given.
  if ((out.inputFile === undefined) === (out.input === undefined)) return null
  return out as RoleRunCliArgs
}

interface RoleScoreCliArgs {
  project: string
  id: string
  verdict: "good" | "bad"
  note?: string
  nodePath?: string
  gate?: FleetGate
}

function parseRoleScoreArgs(argv: string[]): RoleScoreCliArgs | null {
  const out: Partial<RoleScoreCliArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--project") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.project = v
      i += 2
      continue
    }
    if (a === "--id") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.id = v
      i += 2
      continue
    }
    if (a === "--note") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.note = v
      i += 2
      continue
    }
    if (a === "--node-path") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.nodePath = v
      i += 2
      continue
    }
    if (a === "--gate") {
      const v = argv[i + 1]
      if (v === undefined || !(FLEET_GATES as string[]).includes(v)) return null
      out.gate = v as FleetGate
      i += 2
      continue
    }
    // Sole positional: the verdict, "good" or "bad" (matches role-run's
    // single-positional convention).
    if (out.verdict === undefined) {
      if (a !== "good" && a !== "bad") return null
      out.verdict = a
      i++
      continue
    }
    return null
  }
  if (out.project === undefined || out.id === undefined || out.verdict === undefined) return null
  return out as RoleScoreCliArgs
}

interface SquadRunCliArgs {
  project: string
  sliceId: string
  slice?: string
  sliceFile?: string
  resume?: boolean
  gateAnswer?: string
  gatePolicy?: "root-human" | "auto"
  squadType?: string
  /** Flat per-squad model override, forwarded verbatim into every
   * `cmdRoleRun` call the drive makes for this squad-run invocation (see
   * squad-cli.ts's default `DriveFn`). This COLLAPSES the per-role model
   * tiering (haiku analyzer/evaluator, sonnet designer/implementer,
   * roles.ts's `spec.model`) onto a single model for every role when set —
   * a single flat flag can't express a per-role map. That's the accepted
   * tradeoff for this override; a per-role map (e.g. `--model-map
   * analyzer=haiku,...`) is a bigger, deferred design. Omitted (undefined)
   * preserves the existing per-role tiering unchanged, same as `role-run`'s
   * own `--model` (cli.ts's role-run case, run.ts:203 `args.model ??
   * spec.model`). */
  model?: string
  json?: boolean
}

export function parseSquadRunArgs(argv: string[]): SquadRunCliArgs | null {
  const out: Partial<SquadRunCliArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--project") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.project = v
      i += 2
      continue
    }
    if (a === "--slice-id") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sliceId = v
      i += 2
      continue
    }
    if (a === "--slice") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.slice = v
      i += 2
      continue
    }
    if (a === "--slice-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.sliceFile = v
      i += 2
      continue
    }
    if (a === "--resume") {
      out.resume = true
      i++
      continue
    }
    if (a === "--gate-answer") {
      const v = argv[i + 1]
      if (v === undefined || (v !== "approve" && v !== "revise")) return null
      out.gateAnswer = v
      i += 2
      continue
    }
    if (a === "--gate-policy") {
      const v = argv[i + 1]
      if (v === undefined || (v !== "root-human" && v !== "auto")) return null
      out.gatePolicy = v
      i += 2
      continue
    }
    if (a === "--squad-type") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.squadType = v
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
    if (a === "--json") {
      out.json = true
      i++
      continue
    }
    return null
  }
  if (out.project === undefined || out.sliceId === undefined) return null
  // --slice and --slice-file are mutually exclusive when both given; fresh
  // runs require exactly one, but resume needs neither (cmdSquadRun itself
  // enforces "fresh run requires a slice").
  if (out.slice !== undefined && out.sliceFile !== undefined) return null
  return out as SquadRunCliArgs
}

interface SquadProposeCliArgs {
  squadType?: string
  model?: string
  timeoutSec?: number
}

function parseSquadProposeArgs(argv: string[]): SquadProposeCliArgs | null {
  const out: SquadProposeCliArgs = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--squad-type") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.squadType = v
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
    if (a === "--timeout-sec") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.timeoutSec = Number(v)
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
      case "ab": {
        const abArgs = parseAbArgs(subArgs)
        if (abArgs === null) {
          printUsage()
          return 2
        }
        await cmdAb(paths, abArgs)
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
      case "squad-def-init": {
        // Idempotent refresh (live-loop finding): the def's own "already
        // active" die is preserved (writeSquadDefV1 unchanged), but this CLI
        // path treats it as the existing tolerated case — re-sync the
        // active def's wire contracts either way, so a stale contract.md
        // never lingers after the squad def or its wire block evolves.
        try {
          writeSquadDefV1(STANDARD_SQUAD)
          log("squad def 'standard' v1 written + active")
        } catch (e) {
          if (!(e instanceof BenchError) || !/already has an active version/.test(e.message)) throw e
          syncWireContracts(readActiveSquadDef(STANDARD_SQUAD.type))
          log(`squad def '${STANDARD_SQUAD.type}' already active — wire contracts refreshed`)
        }
        return 0
      }
      case "roles-render": {
        const rolesRenderArgs = parseRolesRenderArgs(subArgs)
        if (rolesRenderArgs === null) {
          printUsage()
          return 2
        }
        cmdRolesRender(rolesRenderArgs)
        return 0
      }
      case "roles-import": {
        const rolesImportArgs = parseRolesImportArgs(subArgs)
        if (rolesImportArgs === null) {
          printUsage()
          return 2
        }
        cmdRolesImport(rolesImportArgs)
        return 0
      }
      case "role-run": {
        const roleRunArgs = parseRoleRunArgs(subArgs)
        if (roleRunArgs === null) {
          printUsage()
          return 2
        }
        const input = roleRunArgs.inputFile !== undefined ? readFileSync(roleRunArgs.inputFile, "utf-8") : roleRunArgs.input!
        await cmdRoleRun({
          project: roleRunArgs.project,
          role: roleRunArgs.role,
          input,
          model: roleRunArgs.model,
          nodePath: roleRunArgs.nodePath,
          sliceId: roleRunArgs.sliceId,
          timeoutSec: roleRunArgs.timeoutSec,
          json: roleRunArgs.json,
        })
        return 0
      }
      case "role-score": {
        const roleScoreArgs = parseRoleScoreArgs(subArgs)
        if (roleScoreArgs === null) {
          printUsage()
          return 2
        }
        await cmdRoleScore({
          project: roleScoreArgs.project,
          id: roleScoreArgs.id,
          verdict: roleScoreArgs.verdict,
          note: roleScoreArgs.note,
          nodePath: roleScoreArgs.nodePath,
          gate: roleScoreArgs.gate,
        })
        return 0
      }
      case "squad-run": {
        const squadRunArgs = parseSquadRunArgs(subArgs)
        if (squadRunArgs === null) {
          printUsage()
          return 2
        }
        const slice =
          squadRunArgs.sliceFile !== undefined ? readFileSync(squadRunArgs.sliceFile, "utf-8") : squadRunArgs.slice
        await cmdSquadRun({
          project: squadRunArgs.project,
          sliceId: squadRunArgs.sliceId,
          slice,
          resume: squadRunArgs.resume,
          gateAnswer: squadRunArgs.gateAnswer,
          gatePolicy: squadRunArgs.gatePolicy,
          squadType: squadRunArgs.squadType,
          model: squadRunArgs.model,
          json: squadRunArgs.json,
        })
        return 0
      }
      case "squad-propose": {
        const squadProposeArgs = parseSquadProposeArgs(subArgs)
        if (squadProposeArgs === null) {
          printUsage()
          return 2
        }
        const result = await cmdSquadPropose({
          squadType: squadProposeArgs.squadType,
          model: squadProposeArgs.model,
          timeoutSec: squadProposeArgs.timeoutSec,
        })
        console.log(JSON.stringify(result))
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
