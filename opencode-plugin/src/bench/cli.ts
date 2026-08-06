/**
 * cli.ts — mini argv parser + dispatcher for the bench runner port.
 *
 * Structured for extension (`run`, `ab`, `judge-audit` land in P6 — see the
 * task brief's "Explicitly OUT of scope"); `prep`, `oracle`, `split`, and
 * `report-loop` exist today, no speculative flags for the others.
 */
import { makeBenchPaths, requiredApiKeyVar, DEFAULT_BENCH_MODEL } from "./paths.ts"
import { cmdPrep } from "./cmd-prep.ts"
import { cmdOracle } from "./cmd-oracle.ts"
import type { StagingMode } from "./cmd-oracle.ts"
import { cmdRun, type CmdRunArgs } from "./cmd-run.ts"
import { cmdP2, type CmdP2Args } from "./p2/cmd-p2.ts"
import { cmdTaskLoad, type CmdTaskLoadArgs } from "./cmd-task-load.ts"
import { cmdAb, type CmdAbArgs } from "./cmd-ab.ts"
import { cmdScreen, type CmdScreenArgs } from "./cmd-screen.ts"
import { cmdJudgeAudit, type JudgeAuditArgs } from "./judge-audit.ts"
import { cmdFailureTaxonomy, type FailureTaxonomyArgs } from "./cmd-failure-taxonomy.ts"
import { cmdProposeLesson, type ProposeLessonArgs } from "./cmd-propose-lesson.ts"
import { LAYER_CHOICES, type LayerName } from "./record.ts"
import { cmdSplit, type SplitArgs } from "./splits.ts"
import { cmdReportLoop, type ReportLoopArgs } from "./report-loop.ts"
import { correlateSelfScores, type ResultsLike } from "./self-score-correlate.ts"
import { BenchError, log, die } from "./util.ts"
import { DRIVER_IDS } from "./drivers/index.ts"
import { readOauthExpiresAt, OAUTH_PARALLEL_MARGIN_MS } from "./agent-auth.ts"
import { createHostPressure, type CreateHostPressureOpts, type HostPressure } from "./host-pressure.ts"
import { readFileSync } from "node:fs"
import { writeSquadDefV1, readActiveSquadDef, syncWireContracts, STANDARD_SQUAD } from "../fleet/squad-def.ts"
import { cmdRolesRender } from "../fleet/render.ts"
import { cmdRolesImport } from "../fleet/import.ts"
import { cmdRoleRun } from "../fleet/run.ts"
import { cmdRoleScore, FLEET_GATES, type FleetGate } from "../fleet/score.ts"
import { cmdSquadRun } from "../fleet/squad-cli.ts"
import { cmdSquadPropose } from "../fleet/squad-propose.ts"
import { cmdSquadTrial } from "../fleet/squad-trial.ts"
import { runMaster, acquireSingletonLock, type MasterDeps } from "../fleet/master/master.ts"
import { fakeTransport } from "../fleet/master/transport.ts"
import { loadRegistry } from "../fleet/master/namespace.ts"

const USAGE = `usage: runner.ts [--tb-root PATH] <command> [options]

commands:
  prep        [--apply]
  oracle      [--tasks TASK [TASK ...]] [--task-file PATH] [--results-file PATH]
              [--staging scripts|runtime]  (default: runtime) [--enforce-resources]
  run         [--tasks TASK [TASK ...]] [--task-file PATH] [--all]
              [--model ID] [--variant V] [--k N] [--layers global|account|project|none]
              [--no-store] [--save-all-traj] [--self-check] [--no-harness] [--results-file PATH]
              [--label NAME] [--max-agent-timeout SEC] [--max-verifier-timeout SEC]
              [--min-agent-timeout SEC] [--resume] [--agent NAME]
              [--pin LAYER=vN]... [--staging scripts|runtime] [--driver ID] [--enforce-resources]
              [--parallel] [--cpu-budget N] [--mem-budget MB] [--min-cpus N] [--min-mem-mb MB]
              [--no-pack-measured] [--host-pressure observe|on] [--no-oauth-gate]
  task-load   [--tasks TASK [TASK ...]] [--task-file PATH] [--all]
              [--results-file PATH] [--cpu-budget N] [--mem-budget MB]
              (read-only: declared footprint + timeouts + co-run preview)
  p2-run      --arm a1|a3|a4 (--tasks TASK [TASK ...] | --task-file PATH)
              --k N --results-file PATH --go N [--model ID]
              (P2 actuator-binding probe — never the stock run path; fences:
               --results-file required + must resolve under
               docs/loop-probes/p2/, --go must equal the exact planned
               container-execution count (tasks × k, ×2 for a4's potential
               re-pass); never writes term-bench2/store/**)
  ab          --layer L --candidate vN [--tasks TASK [TASK ...]] [--task-file PATH]
              [--all] [--split-file PATH] [--model ID] [--variant V] [--k N]
              [--layers global|account|project] [--agent NAME] [--alpha F]
              [--nonregress-margin F] [--min-tasks-before-stop N] [--no-early-stop]
              [--max-agent-timeout SEC] [--max-verifier-timeout SEC] [--min-agent-timeout SEC] [--resume]
              [--no-store] [--save-all-traj]
              [--results-file PATH] [--staging scripts|runtime] [--driver ID] [--enforce-resources]
              [--parallel] [--cpu-budget N] [--mem-budget MB] [--min-cpus N] [--min-mem-mb MB]
              [--no-pack-measured] [--host-pressure observe|on] [--speed-tiebreak] [--no-oauth-gate]
  screen      --layer L --candidates vN[,vN...] [--agent NAME]
              [--tasks TASK [TASK ...]] [--task-file PATH] [--all]
              [--model ID] [--variant V] [--layers global|account|project|none]
              [--staging scripts|runtime] [--driver ID]
              [--max-agent-timeout SEC] [--max-verifier-timeout SEC] [--min-agent-timeout SEC]
              [--enforce-resources] [--parallel] [--cpu-budget N] [--mem-budget MB]
              [--min-cpus N] [--min-mem-mb MB] [--no-pack-measured] [--host-pressure observe|on]
              [--no-oauth-gate]
              (k=1 candidate tournament — cheap ranking pre-pass; a screen never
               writes the store or emits a verdict, only an ADVANCE hint for ab)
  judge-audit --layer L --candidate vN [--agent NAME] [--model ID] [--limit N]
  failure-taxonomy --layer L --candidate vN [--agent NAME] [--model ID] [--limit N]
  propose-lesson --layer L --candidate vN [--agent NAME] [--model ID] [--guards CSV] [--rejected-file F] [--out F] [--create vM]
  split       make|rotate|show [--seed N] [--folds N] [--source FILE]
              [--split-file PATH] [--results PATH]... [--band LO,HI]
              [--sentinels N] [--sentinel-hi F]
  report-loop [--json] [--sink PATH]... [--no-flag]
              [--plateau-ab-k K] [--plateau-trial-k K]
  self-score-report --results-file PATH   (best-of-k Phase 0 gate)
  squad-def-init
  roles-render  --project PATH [--role R]... [--pin LAYER=vN]... [--force]
  roles-import  --from DIR [--role R]... [--force] [--map SRC=DEST1,DEST2]...
  role-run      --project PATH --role R [--model M] [--node-path P] [--slice-id S]
                [--timeout-sec N] [--json] (--input-file F | "input")
  role-score    --project PATH --id ID good|bad [--note S] [--node-path P]
                [--gate gate1|gate2|verdict|merge|lint|infeasible]
  squad-run     --project PATH --slice-id S (--slice "text" | --slice-file F)
                [--resume --gate-answer approve|revise]
                [--gate-policy root-human|auto] [--squad-type T] [--model M]
                [--def-version vN] [--json]
  squad-propose [--squad-type T] [--model M] [--timeout-sec N]
  squad-trial   --project PATH --candidate vN [--squad-type T]
                [--slice "text" | --slice-file F] [--n N]
  master        --master-root PATH [--dry-run]
                (singleton daemon: relay gates + schedule + reconcile;
                 real transport is a later drop-in — --dry-run only for now)`

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
  enforceResources?: boolean
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
    if (a === "--enforce-resources") {
      out.enforceResources = true
      i++
      continue
    }
    return null
  }
  return out
}

/** Parses a `--cpu-budget`/`--mem-budget` value, rejecting anything that
 * would defeat scheduler.ts's fit checks: NaN (a typo'd non-numeric value),
 * Infinity, zero, or negative. A NaN budget makes both `fitsBudget` and
 * `exceedsTotalBudget` false for every item, so `schedule()` never launches
 * anything and hangs forever, and `packPreview()`'s inner loop never
 * advances its cursor — an infinite loop (verified live). Shared by
 * parseRunArgs/parseAbArgs/parseTaskLoadArgs (all accept the same two
 * flags), AND by parseRunArgs/parseAbArgs's `--min-cpus`/`--min-mem-mb`
 * resource-floor flags (same positive-number contract — a floor of 0/NaN
 * is as meaningless as a budget of 0/NaN). Returns `null` on any invalid
 * value — same "return null" style every other invalid-value case in these
 * parsers already uses. */
function parseBudgetNum(v: string): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** Consume a `--tasks TASK [TASK...]` run, stopping at the next `--flag`.
 * Shared by parseRunArgs/parseAbArgs/parseTaskLoadArgs (all accept the same
 * nargs="+" form). */
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

function parseTaskLoadArgs(argv: string[]): CmdTaskLoadArgs | null {
  const out: CmdTaskLoadArgs = {}
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
    if (a === "--results-file") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.resultsFile = v
      i += 2
      continue
    }
    if (a === "--cpu-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.cpuBudget = n
      i += 2
      continue
    }
    if (a === "--mem-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.memBudget = n
      i += 2
      continue
    }
    return null
  }
  return out
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
    if (a === "--self-check") {
      out.selfCheck = true
      i++
      continue
    }
    if (a === "--enforce-resources") {
      out.enforceResources = true
      i++
      continue
    }
    if (a === "--parallel") {
      out.parallel = true
      i++
      continue
    }
    if (a === "--cpu-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.cpuBudget = n
      i += 2
      continue
    }
    if (a === "--mem-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.memBudget = n
      i += 2
      continue
    }
    if (a === "--min-cpus") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minCpus = n
      i += 2
      continue
    }
    if (a === "--min-mem-mb") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minMemMb = n
      i += 2
      continue
    }
    if (a === "--min-agent-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minAgentTimeout = n
      i += 2
      continue
    }
    if (a === "--no-pack-measured") {
      out.noPackMeasured = true
      i++
      continue
    }
    if (a === "--no-oauth-gate") {
      out.noOauthGate = true
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
    if (a === "--max-verifier-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.maxVerifierTimeout = Number(v)
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
    if (a === "--host-pressure") {
      const v = argv[i + 1]
      if (v !== "observe" && v !== "on") return null
      out.hostPressure = v
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

/** Syntactic-only parser for `p2-run` — mirrors parseRunArgs's shape.
 * Deliberately does NOT enforce the business-rule fences (results-file
 * required, path under docs/loop-probes/p2/, --go arithmetic match): those
 * are cmdP2's OWN contract (p2/cmd-p2.ts's header), exercised directly by
 * test/p2-cmd.test.ts against `cmdP2`, not against this CLI-syntax layer.
 * Only `--arm`'s enum is validated here (same pattern as --layers/
 * --staging/--driver above) since a malformed enum value is a parse error,
 * not a business rule. */
function parseP2Args(argv: string[]): CmdP2Args | null {
  const out: CmdP2Args = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--arm") {
      const v = argv[i + 1]
      if (v !== "a1" && v !== "a3" && v !== "a4") return null
      out.arm = v
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
    if (a === "--k") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.k = Number(v)
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
    if (a === "--go") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.go = Number(v)
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
    return null
  }
  return out
}

/** Per-task agent-timeout fallback (seconds) used ONLY for the oauth-parallel
 * freshness calc below when `--max-agent-timeout` wasn't passed — mirrors
 * tasks.ts's `taskTimeouts` default (a task.toml with no `agent.timeout_sec`
 * gets 900s, and `--max-agent-timeout` 0/unset means "no cap", i.e. each
 * task's own declared timeout applies). This gate runs before task selection
 * so it can't see per-task declared timeouts; 900s is the conservative floor
 * used elsewhere in this codebase for "no override given". */
const DEFAULT_TASK_AGENT_TIMEOUT_SEC = 900

/** Shared `--parallel` gate (spec D3/D4), reused by both `run` and `ab`
 * (Task 7). Enforced in the CLI — the universal guard covering ALL drivers,
 * including ones whose prepareAuth ignores keyOnly (e.g. claude-code) whose
 * no-key path mounts a shared credential dir rw (the concurrency race). Throws
 * BenchError (→ rc 1) so the message reaches the operator; must run BEFORE any
 * podman work. `model` is the already-defaulted model string.
 *
 * oauth-parallel freshness gate (Task 1): a no-key `--parallel` run is no
 * longer an automatic hard failure. The refresh-token race (agent-auth.ts's
 * header) only fires if a container's oauth token actually REFRESHES during
 * the parallel window (~8h access-token expiry) — a token that will outlive
 * this run's max agent timeout plus a ~5min refresh buffer
 * (OAUTH_PARALLEL_MARGIN_MS) never refreshes mid-run, so no shared write, no
 * race. `readExpiry` is an injectable seam (default: the real oauth reader)
 * so tests never touch the real ~/.claude/Keychain. */
export function validateParallel(
  a: {
    parallel?: boolean
    enforceResources?: boolean
    cpuBudget?: number
    memBudget?: number
    maxAgentTimeout?: number
    noOauthGate?: boolean
  },
  model: string,
  readExpiry: () => number | null = () => readOauthExpiresAt(),
): void {
  const budgetFlags = a.cpuBudget !== undefined || a.memBudget !== undefined
  if (budgetFlags && !a.parallel) {
    throw new BenchError("--cpu-budget/--mem-budget require --parallel")
  }
  if (!a.parallel) return
  if (!a.enforceResources) {
    throw new BenchError(
      "--parallel requires --enforce-resources (budget packing needs each task's declared cpus/memory)",
    )
  }
  const keyVar = requiredApiKeyVar(model)
  if (process.env[keyVar]) return // key present — allow, unchanged

  const exp = readExpiry()
  if (exp === null) {
    // Genuinely no auth at all (no key, no oauth credential either) —
    // unchanged behavior/message from before this task.
    throw new BenchError(
      `--parallel needs ${keyVar} in the environment: concurrent tasks can't share the ` +
        `oauth credential mount safely — export ${keyVar} or drop --parallel`,
    )
  }

  // --no-oauth-gate (operator escape hatch): the host rotates the oauth token
  // automatically during active CC/opencode use (within ~5min of expiry, under
  // a proper-lockfile on ~/.claude — see docs/oauth-parallel-race-research.md),
  // so an operator keeping a session active can assert freshness themselves.
  // Skip the freshness reject and the part-C cap requirement below — oauth
  // gates like key-auth. Placed AFTER the exp===null reject: no credential at
  // all still refuses (nothing could auth, gate or no gate).
  if (a.noOauthGate) return

  // --min-agent-timeout floor note: the worst-case task duration this gate
  // bounds against is `maxAgentTimeout` (the cap). The floor only RAISES a
  // task's declared timeout UP TO the floor, after which the cap still applies
  // (tasks.ts's taskTimeouts: effective = min(max(declared, floor), cap) ≤
  // cap). So the floor can never push the worst case above the cap → this
  // freshness math stays correct unchanged, no `minAgentTimeout` term needed.
  const neededMs = (a.maxAgentTimeout || DEFAULT_TASK_AGENT_TIMEOUT_SEC) * 1000 + OAUTH_PARALLEL_MARGIN_MS
  const remainingMs = exp - Date.now()
  if (remainingMs < neededMs) {
    const remainingMin = Math.max(0, Math.floor(remainingMs / 60_000))
    const neededMin = Math.ceil(neededMs / 60_000)
    throw new BenchError(
      `--parallel: oauth token expires in ~${remainingMin}min, needs at least ${neededMin}min to safely ` +
        `run a --parallel task (max-agent-timeout + ${OAUTH_PARALLEL_MARGIN_MS / 60_000}min refresh buffer) — ` +
        `re-login (\`claude\` / \`opencode auth login\`) and retry, or export ${keyVar}`,
    )
  }

  // Task 2 part C: the freshness math above (and the scheduler launch-guard
  // it feeds, buildOauthParallelCanLaunch below) is only EXACT if every task
  // is capped at a known duration. An unset/0 --max-agent-timeout means "no
  // cap" (tasks.ts's taskTimeouts falls back to each task's own declared
  // task.toml timeout, up to ~1800s) — which could exceed the 900s floor
  // `neededMs` assumed above and cross the token's expiry mid-run. Require an
  // EXPLICIT non-zero cap for oauth+parallel so the whole run has an exact
  // bound; key-auth and serial are unaffected (this check is unreachable on
  // both — key-auth returns above, serial returned at the top of this fn).
  if (!a.maxAgentTimeout) {
    throw new BenchError(
      `--parallel with oauth needs an explicit --max-agent-timeout N (seconds) so we can guarantee no task runs ` +
        `across your token's expiry — pass --max-agent-timeout, or export ${keyVar} instead`,
    )
  }
  // else: token outlives this run's worst-case task, AND every task is capped
  // at a known duration — oauth+parallel allowed. buildOauthParallelCanLaunch
  // (below) builds the scheduler launch-guard that re-checks this near the
  // actual expiry boundary for long --parallel sweeps (Task 2 parts A/B).
}

/**
 * oauth-parallel freshness gate, PART 2 (Task 2 of the oauth-parallel
 * design): builds the scheduler launch-guard (scheduler.ts's `schedule()`
 * `canLaunch` param) that bounds the ENTIRE --parallel window to the oauth
 * token's TTL, not just the run's start. validateParallel's pre-flight check
 * (above) only runs once, before task 1 — a long --parallel sweep could
 * still cross the token's expiry mid-run without this: this function's
 * result gets re-checked by schedule() before EVERY launch, so no NEW task
 * is ever started once the token can no longer outlive one more task +
 * OAUTH_PARALLEL_MARGIN_MS.
 *
 * Returns `undefined` (unbounded launches, byte-identical to every path from
 * before this gate existed) for every case validateParallel already treats
 * as fine-as-is: serial, key-auth, and "no oauth credential either" (that
 * last one is a hard refusal in validateParallel — this function is only
 * ever reached in production AFTER validateParallel did NOT throw, so this
 * branch means the CLI's own gate was bypassed; it stays a safe no-op rather
 * than bounding on a `null` expiry).
 *
 * Must run AFTER validateParallel has NOT thrown (main() calls both, in that
 * order, below): validateParallel's Task 2 part C addition REQUIRES an
 * explicit non-zero --max-agent-timeout for oauth+parallel, so by the time
 * this runs for a real oauth+parallel CLI invocation, `a.maxAgentTimeout` is
 * guaranteed truthy — the `|| DEFAULT_TASK_AGENT_TIMEOUT_SEC` fallback below
 * exists only so this function's OWN unit tests (which call it directly,
 * bypassing validateParallel) exercise the identical formula
 * validateParallel's own `neededMs` calc uses; production never needs it.
 *
 * `readExpiry` is the same injectable seam as validateParallel's own —
 * default: the real oauth reader, so tests never touch the real
 * ~/.claude/Keychain unless they explicitly ask to.
 */
export function buildOauthParallelCanLaunch(
  a: { parallel?: boolean; maxAgentTimeout?: number; noOauthGate?: boolean },
  model: string,
  readExpiry: () => number | null = () => readOauthExpiresAt(),
): (() => boolean) | undefined {
  if (!a.parallel) return undefined
  // --no-oauth-gate: operator asserts host-side auto-rotation keeps the token
  // fresh — unbounded launches, same as key-auth (see validateParallel).
  if (a.noOauthGate) return undefined
  const keyVar = requiredApiKeyVar(model)
  if (process.env[keyVar]) return undefined // key-auth: unbounded, unchanged

  const exp = readExpiry()
  if (exp === null) return undefined // no oauth credential either — nothing to bound against

  // --min-agent-timeout floor note: this freshness math keys on maxAgentTimeout
  // (the cap) and stays correct — effective per-task time = min(max(declared,
  // floor), cap) ≤ cap, so the floor can never push a task past the cap.
  const neededMs = (a.maxAgentTimeout || DEFAULT_TASK_AGENT_TIMEOUT_SEC) * 1000 + OAUTH_PARALLEL_MARGIN_MS
  return () => Date.now() + neededMs <= exp
}

/**
 * Host-pressure launch-gate builder (plan S3) — the transient companion to
 * buildOauthParallelCanLaunch above, and shaped the same way: main() calls it
 * once at the canLaunch assignment site and assigns the result to
 * CmdRunArgs/CmdAbArgs's internal-only `pressureGate` field, which cmd-run.ts/
 * cmd-ab.ts thread straight into scheduler.ts's `schedule()` `pauseGate` param.
 *
 * Returns `undefined` when `--host-pressure` is absent (no sensor created,
 * schedule()'s pauseGate stays unset — byte-identical to before this flag
 * existed). Otherwise creates exactly ONE `createHostPressure` per command
 * invocation and closes over it:
 *   - `on`: the gate IS the live sensor — pauses launches while the host is
 *     under pressure.
 *   - `observe`: the gate still SAMPLES the sensor every call (so state-change
 *     logging happens through the same hysteresis state machine) but ALWAYS
 *     returns false — it never pauses. Calibration-only; the point is to
 *     eyeball thresholds over a run before `on` gates anything.
 * The single sensor is shared across every call of the returned gate, which
 * for `ab` means across BOTH phases (fresh scheduler per phase, same gate
 * closure) — correct: pressure hysteresis is a property of the machine over
 * wall-clock time, not per-phase state.
 *
 * Only the --parallel paths ever consult the returned gate (schedule() isn't
 * called on the serial path — a serial run is width-1 by construction), so a
 * serial `--host-pressure` is legal and simply inert.
 *
 * `createSensor` is the injectable test seam (default `createHostPressure`) so
 * unit tests exercise the wiring without sampling the real host.
 */
export function buildPressureGate(
  a: { hostPressure?: "observe" | "on" },
  createSensor: (opts: CreateHostPressureOpts) => HostPressure = createHostPressure,
): (() => boolean) | undefined {
  if (a.hostPressure === undefined) return undefined
  const sensor = createSensor({ log })
  if (a.hostPressure === "on") return () => sensor.underPressure()
  // observe: sample (state-change logging runs inside underPressure) but never pause.
  return () => {
    sensor.underPressure()
    return false
  }
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
    if (a === "--max-verifier-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.maxVerifierTimeout = Number(v)
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
    if (a === "--host-pressure") {
      const v = argv[i + 1]
      if (v !== "observe" && v !== "on") return null
      out.hostPressure = v
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
    if (a === "--enforce-resources") {
      out.enforceResources = true
      i++
      continue
    }
    if (a === "--parallel") {
      out.parallel = true
      i++
      continue
    }
    if (a === "--cpu-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.cpuBudget = n
      i += 2
      continue
    }
    if (a === "--mem-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.memBudget = n
      i += 2
      continue
    }
    if (a === "--min-cpus") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minCpus = n
      i += 2
      continue
    }
    if (a === "--min-mem-mb") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minMemMb = n
      i += 2
      continue
    }
    if (a === "--min-agent-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minAgentTimeout = n
      i += 2
      continue
    }
    if (a === "--no-pack-measured") {
      out.noPackMeasured = true
      i++
      continue
    }
    if (a === "--no-oauth-gate") {
      out.noOauthGate = true
      i++
      continue
    }
    if (a === "--speed-tiebreak") {
      out.speedTiebreak = true
      i++
      continue
    }
    return null
  }
  if (out.layer === undefined || out.candidate === undefined) return null
  return out as CmdAbArgs
}

/** `--candidates v3,v5,v7` — comma-separated (unlike --tasks' nargs="+"
 * form), since a screen's candidate list is always short vN literals with
 * no risk of colliding with a following `--flag`. */
function parseCandidatesList(v: string): string[] | null {
  const vals = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  return vals.length === 0 ? null : vals
}

function parseScreenArgs(argv: string[]): CmdScreenArgs | null {
  const out: Partial<CmdScreenArgs> = {}
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
    if (a === "--candidates") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const vals = parseCandidatesList(v)
      if (vals === null) return null
      out.candidates = vals
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
    if (a === "--layers") {
      const v = argv[i + 1]
      if (v !== "global" && v !== "account" && v !== "project" && v !== "none") return null
      out.layers = v
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
    if (a === "--max-agent-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.maxAgentTimeout = Number(v)
      i += 2
      continue
    }
    if (a === "--max-verifier-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.maxVerifierTimeout = Number(v)
      i += 2
      continue
    }
    if (a === "--min-agent-timeout") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minAgentTimeout = n
      i += 2
      continue
    }
    if (a === "--enforce-resources") {
      out.enforceResources = true
      i++
      continue
    }
    if (a === "--parallel") {
      out.parallel = true
      i++
      continue
    }
    if (a === "--cpu-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.cpuBudget = n
      i += 2
      continue
    }
    if (a === "--mem-budget") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.memBudget = n
      i += 2
      continue
    }
    if (a === "--min-cpus") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minCpus = n
      i += 2
      continue
    }
    if (a === "--min-mem-mb") {
      const v = argv[i + 1]
      if (v === undefined) return null
      const n = parseBudgetNum(v)
      if (n === null) return null
      out.minMemMb = n
      i += 2
      continue
    }
    if (a === "--no-pack-measured") {
      out.noPackMeasured = true
      i++
      continue
    }
    if (a === "--no-oauth-gate") {
      out.noOauthGate = true
      i++
      continue
    }
    if (a === "--host-pressure") {
      const v = argv[i + 1]
      if (v !== "observe" && v !== "on") return null
      out.hostPressure = v
      i += 2
      continue
    }
    return null
  }
  if (out.layer === undefined || out.candidates === undefined) return null
  return out as CmdScreenArgs
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

function parseFailureTaxonomyArgs(argv: string[]): FailureTaxonomyArgs | null {
  const out: Partial<FailureTaxonomyArgs> = {}
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
  return out as FailureTaxonomyArgs
}

function parseProposeLessonArgs(argv: string[]): ProposeLessonArgs | null {
  const out: Partial<ProposeLessonArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === "--layer" || a === "--candidate" || a === "--agent" || a === "--model" || a === "--guards" || a === "--out" || a === "--create") {
      if (v === undefined) return null
      const key = a.slice(2) as "layer" | "candidate" | "agent" | "model" | "guards" | "out" | "create"
      out[key] = v
      i += 2
      continue
    }
    if (a === "--rejected-file") {
      if (v === undefined) return null
      out.rejectedFile = v
      i += 2
      continue
    }
    return null
  }
  if (out.layer === undefined || out.candidate === undefined) return null
  return out as ProposeLessonArgs
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
  /** Pin this run to a specific squad-def CANDIDATE version instead of the
   * active one (spec §6 ch2 — def-version pin / squad-trial's own use of
   * this same knob). See squad-cli.ts's `cmdSquadRun` doc comment for the
   * full resume-inheritance contract. */
  defVersion?: string
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
    if (a === "--def-version") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.defVersion = v
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

interface SquadTrialCliArgs {
  project: string
  candidate: string
  squadType?: string
  slice?: string
  sliceFile?: string
  n?: number
}

export function parseSquadTrialArgs(argv: string[]): SquadTrialCliArgs | null {
  const out: Partial<SquadTrialCliArgs> = {}
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
    if (a === "--candidate") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.candidate = v
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
    if (a === "--n") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.n = Number(v)
      i += 2
      continue
    }
    return null
  }
  if (out.project === undefined || out.candidate === undefined) return null
  if (out.slice !== undefined && out.sliceFile !== undefined) return null
  return out as SquadTrialCliArgs
}

interface MasterCliArgs {
  masterRoot: string
  dryRun?: boolean
}

/** Mirrors the shape of `parseSquadRunArgs`: a flat positional-free flag
 * scanner. The master takes only `--master-root PATH` (where its durable
 * runtime + registry live) and an optional `--dry-run` (wire the in-memory
 * fake transport for a one-shot reconcile smoke, since no real offset-acked
 * transport is configured yet — R1). */
function parseMasterArgs(argv: string[]): MasterCliArgs | null {
  const out: Partial<MasterCliArgs> = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--master-root") {
      const v = argv[i + 1]
      if (v === undefined) return null
      out.masterRoot = v
      i += 2
      continue
    }
    if (a === "--dry-run") {
      out.dryRun = true
      i++
      continue
    }
    return null
  }
  if (out.masterRoot === undefined) return null
  return out as MasterCliArgs
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
        // --parallel gate (before any podman work — matches cmdRun's own
        // default model resolution so the required key var is derived from the
        // effective model).
        {
          const runModel = runArgs.model || DEFAULT_BENCH_MODEL
          validateParallel(runArgs, runModel)
          // oauth-parallel freshness gate, part 2 (Task 2): the scheduler
          // launch-guard, computed ONCE here (right after the pre-flight gate
          // passed) and threaded through as internal-only wiring on
          // CmdRunArgs — see cmd-run.ts's `canLaunch` field doc comment.
          runArgs.canLaunch = buildOauthParallelCanLaunch(runArgs, runModel)
          // host-pressure launch gate (plan S3): build ONE sensor per command
          // invocation and set the transient pause gate as internal-only
          // wiring on CmdRunArgs — undefined (no gate) unless --host-pressure
          // was passed. Threaded into schedule()'s pauseGate by cmd-run.ts.
          runArgs.pressureGate = buildPressureGate(runArgs)
        }
        await cmdRun(paths, runArgs)
        return 0
      }
      case "p2-run": {
        const p2Args = parseP2Args(subArgs)
        if (p2Args === null) {
          printUsage()
          return 2
        }
        await cmdP2(paths, p2Args)
        return 0
      }
      case "task-load": {
        const taskLoadArgs = parseTaskLoadArgs(subArgs)
        if (taskLoadArgs === null) {
          printUsage()
          return 2
        }
        cmdTaskLoad(paths, taskLoadArgs)
        return 0
      }
      case "ab": {
        const abArgs = parseAbArgs(subArgs)
        if (abArgs === null) {
          printUsage()
          return 2
        }
        // Shared --parallel gate (spec D3/D4) — same guard `run` uses, before
        // any podman work; derives the required key var from the effective
        // model exactly as cmdAb's own default does.
        {
          const abModel = abArgs.model || DEFAULT_BENCH_MODEL
          validateParallel(abArgs, abModel)
          // oauth-parallel freshness gate, part 2 (Task 2): same scheduler
          // launch-guard as `run`, above — see that case's comment.
          abArgs.canLaunch = buildOauthParallelCanLaunch(abArgs, abModel)
          // host-pressure launch gate (plan S3): same builder as `run` — one
          // shared per-command sensor closure, reused across BOTH ab phases.
          abArgs.pressureGate = buildPressureGate(abArgs)
        }
        await cmdAb(paths, abArgs)
        return 0
      }
      case "screen": {
        const screenArgs = parseScreenArgs(subArgs)
        if (screenArgs === null) {
          printUsage()
          return 2
        }
        // Same shared --parallel gate as `run`/`ab` (spec D3/D4) — before any
        // podman work; derives the required key var from the effective model
        // exactly as cmdScreen's own default does.
        {
          const screenModel = screenArgs.model || DEFAULT_BENCH_MODEL
          validateParallel(screenArgs, screenModel)
          // oauth-parallel freshness gate, part 2 (Task 2): same scheduler
          // launch-guard as `run`/`ab` — see those cases' comments. cmdScreen
          // reuses ONE gate closure across every candidate's cmdRun call.
          screenArgs.canLaunch = buildOauthParallelCanLaunch(screenArgs, screenModel)
          // host-pressure launch gate (plan S3): same builder as `run`/`ab` —
          // one shared per-command sensor closure, reused across every
          // candidate in the sweep.
          screenArgs.pressureGate = buildPressureGate(screenArgs)
        }
        await cmdScreen(paths, screenArgs)
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
      case "failure-taxonomy": {
        const taxArgs = parseFailureTaxonomyArgs(subArgs)
        if (taxArgs === null) {
          printUsage()
          return 2
        }
        return await cmdFailureTaxonomy(paths, taxArgs)
      }
      case "propose-lesson": {
        const plArgs = parseProposeLessonArgs(subArgs)
        if (plArgs === null) {
          printUsage()
          return 2
        }
        return await cmdProposeLesson(paths, plArgs)
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
      case "self-score-report": {
        // best-of-k Phase 0 GATE: correlate a --self-check run's self-scores
        // against the hidden reward. Prints the report as JSON.
        const idx = subArgs.indexOf("--results-file")
        const rf = idx >= 0 ? subArgs[idx + 1] : undefined
        if (!rf) {
          console.error("usage: self-score-report --results-file PATH")
          return 2
        }
        // Fail closed with a clean message, not a raw stack (review R4#2): a
        // missing file, bad JSON, or wrong artifact (no `tasks`) is operator
        // error on a hand-run gate, so translate to BenchError (the only class
        // the outer handler rescues) instead of an unhandled rejection.
        let results: ResultsLike
        try {
          results = JSON.parse(readFileSync(rf, "utf-8")) as ResultsLike
        } catch (e) {
          throw new BenchError(`self-score-report: cannot read/parse '${rf}': ${(e as Error).message}`)
        }
        if (!results || typeof results.tasks !== "object" || results.tasks === null) {
          throw new BenchError(`self-score-report: '${rf}' has no 'tasks' object — not a bench results file`)
        }
        const report = correlateSelfScores(results)
        console.log(JSON.stringify(report, null, 2))
        const liftPp = `${(report.liftSelfPass * 100).toFixed(1)}pp`
        // Print BOTH sample sizes — n_tasks (the task-count floor) and
        // n_selfpass (the self-PASS attempt-count floor liftSelfPass is
        // actually computed over) — so a verdict resting on a tiny
        // n_selfpass (e.g. one lucky self-PASS among 30 tasks) is visible to
        // the operator instead of hidden behind a healthy-looking N (review
        // C1).
        const sizes = `N=${report.nTasks}, n_selfpass=${report.nSelfPass}`
        const undersizedNote = [
          report.nTasks < report.minTasks ? `N < ${report.minTasks}` : null,
          report.nSelfPass < report.minSelfPass ? `n_selfpass < ${report.minSelfPass}` : null,
        ].filter(Boolean).join(", ")
        const nNote = undersizedNote ? ` — ${undersizedNote} (undersized)` : ""
        console.log(
          report.predictive
            ? `\nGATE: PREDICTIVE (self-PASS lift ${liftPp}, ${sizes}) — best-of-k worth building`
            : `\nGATE: NOT predictive (self-PASS lift ${liftPp}, ${sizes}${nNote}) — do NOT build the k-loop; reassess the selector`,
        )
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
          defVersion: squadRunArgs.defVersion,
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
      case "squad-trial": {
        const squadTrialArgs = parseSquadTrialArgs(subArgs)
        if (squadTrialArgs === null) {
          printUsage()
          return 2
        }
        await cmdSquadTrial({
          project: squadTrialArgs.project,
          squadType: squadTrialArgs.squadType,
          candidate: squadTrialArgs.candidate,
          slice: squadTrialArgs.slice,
          sliceFile: squadTrialArgs.sliceFile,
          n: squadTrialArgs.n,
        })
        return 0
      }
      case "master": {
        const masterArgs = parseMasterArgs(subArgs)
        if (masterArgs === null) {
          printUsage()
          return 2
        }
        const registry = loadRegistry(masterArgs.masterRoot)
        // resumeSquad binds the shipped `cmdSquadRun`, mapping the namespace
        // project key to its runtimeRoot (`project = ns.runtimeRoot`) — the
        // relay REUSES checkpoint/resume, never reimplements it.
        const deps: MasterDeps = {
          masterRoot: masterArgs.masterRoot,
          transport: fakeTransport(),
          resumeSquad: async (a) => {
            const ns = registry.projects[a.project]
            if (!ns) die(`master: unregistered project '${a.project}'`)
            return cmdSquadRun({
              project: ns.runtimeRoot,
              sliceId: a.sliceId,
              resume: true,
              gateAnswer: a.gateAnswer,
              gatePolicy: ns.gatePolicy,
            })
          },
          registry,
          // Real sub-scheduler (self-hosting fleet-dev), git probe, worktree
          // removal and crash-intent assembly are later drop-ins behind these
          // seams; the --dry-run smoke never exercises them (empty queue /
          // empty intents).
          sub: async () => die("master: no sub-scheduler configured (--dry-run)"),
          git: {
            hasMergeHead: () => false,
            branchContains: () => false,
            abortMerge: () => {},
          },
          removeWorktree: () => {},
          loadIntents: () => [],
        }
        if (!masterArgs.dryRun) {
          // Real Telegram/Slack (offset-acked, R1) transport is a later
          // drop-in behind the Transport seam; refuse to serve without one.
          die("master: no transport configured (--dry-run only)")
        }
        // --dry-run: singleton-lock + one reconcile pass, then stop
        // immediately (until → true, no serving loop) — a hermetic smoke of
        // the daemon wiring.
        const release = acquireSingletonLock(masterArgs.masterRoot)
        try {
          await runMaster(deps, { until: () => true })
        } finally {
          release()
        }
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
