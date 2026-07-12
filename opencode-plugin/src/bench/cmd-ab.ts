/**
 * cmd-ab.ts — `ab` subcommand: statistically-gated A/B of a candidate vs the
 * active version of ONE layer. Verbatim-in-spirit port of term-bench2/
 * runner.py's cmd_ab (:2030-2285).
 *
 * Arm A = all-active composition, arm B = same but the target layer pinned
 * to the candidate; interleaved per run-pair to neutralise drift. By default
 * the task set is the checked-in held-in/held-out split (splits.json):
 * held-in is scored first with a futility early-kill; the held-out fold
 * runs only if the candidate survives, and its arm-B sessions are NEVER
 * written to score.json (the proposer must never see them — see this file's
 * `record_arm_b` wiring and test/bench-ab.test.ts's held-out-never-recorded
 * invariant test). The decision comes from ab-stats.ts's `decide` via
 * splits.ts's `abDecision`, which wires in the stratified held-out gate.
 * Writes candidates/<vN>/ab-verdict.json — the contract harness-store.ts's
 * readAbVerdict/abAccepted read.
 *
 * Task-attempt machinery (container create/start/staging/agent/verify/rm) is
 * NOT duplicated here — both arms of every run-pair go through cmd-run.ts's
 * `runTaskOnce` (injectable as `runOneTask`, matching cmd-run.ts's own
 * RunOneTaskFn contract), per the task brief's reuse mandate.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { StagingMode } from "./cmd-oracle.ts"
import { podman } from "./exec.ts"
import type { ExecFn } from "./staging.ts"
import { runTaskOnce, inContainerAgentVersion, type RunOneTaskFn } from "./cmd-run.ts"
import { getDriver } from "./drivers/index.ts"
import { assembleAgentsMd, envBlock, sessionRecord } from "./record.ts"
import { layerStoreRoots, type LayerName } from "./record.ts"
import { selectTasks, taskTimeouts } from "./tasks.ts"
import {
  loadActiveSplit,
  splitHash,
  resumeIdentCheck,
  filterTaskResults,
  abDecision,
  type SplitMeta,
  type PhaseTaggedTaskResults,
} from "./splits.ts"
import { pairedRunStats, mcnemarExactOneSided, bootstrapTaskCi, futilityStop, type DecisionConfig, type PairStats } from "./ab-stats.ts"
import { die, log, pyFixed, pySigned, writeJsonAtomic } from "./util.ts"
import type { BenchPaths } from "./paths.ts"
import {
  candidateExists,
  listVersions,
  activeVersion,
  candidatePath,
  recordSession,
  writeTrajectory,
  pruneTrajectories,
  appendMetaMetric,
  type AbSetStats,
} from "../harness-store.ts"

interface AbTaskResult {
  candidate: number[]
  active: number[]
  phase: "held-in" | "held-out"
  sentinel: boolean
  error?: string
}
type AbTaskResults = Record<string, AbTaskResult>

export interface CmdAbArgs {
  layer: LayerName
  candidate: string
  tasks?: string[]
  taskFile?: string
  all?: boolean
  splitFile?: string
  model?: string
  variant?: string
  k?: number
  layers?: "global" | "account" | "project"
  agent?: string
  alpha?: number
  nonregressMargin?: number
  minTasksBeforeStop?: number
  noEarlyStop?: boolean
  maxAgentTimeout?: number
  resume?: boolean
  noStore?: boolean
  saveAllTraj?: boolean
  resultsFile?: string
  staging?: StagingMode
  driver?: string
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

export async function cmdAb(
  paths: BenchPaths,
  args: CmdAbArgs,
  runOneTask: RunOneTaskFn = runTaskOnce,
  execFn: ExecFn = podman,
): Promise<void> {
  const layer = args.layer
  const candidate = args.candidate
  const agent = args.agent || ""
  const layers = args.layers ?? "global"
  const model = args.model || "anthropic/claude-sonnet-4-6"
  const variant = args.variant || ""
  const k = args.k ?? 2
  const noStore = Boolean(args.noStore)
  const staging = args.staging ?? "runtime"
  const maxAgentTimeout = args.maxAgentTimeout ?? 0
  const driver = getDriver(args.driver ?? "opencode")

  if (!/^v\d+$/.test(candidate)) die(`--candidate must look like vN, got '${candidate}'`)
  if ((layer === "account-role" || layer === "project-role") && !agent) {
    die(`--layer ${layer} requires --agent`)
  }

  const roots = new Map(layerStoreRoots(layers, agent, paths.metaRoot))
  if (!roots.has(layer)) {
    die(`--layer ${layer} not included by --layers ${layers}` + (agent ? "" : " (role layers need --agent)"))
  }
  const layerRoot = roots.get(layer)!

  if (!candidateExists(layerRoot, candidate)) {
    const have = listVersions(layerRoot).join(", ") || "none"
    die(`no such candidate ${candidate} under ${layerRoot} (have: ${have})`)
  }

  const baseline = activeVersion(layerRoot)
  if (baseline === candidate) die(`candidate ${candidate} is already the active version — nothing to compare`)

  // ── Task selection: split (default) vs legacy explicit ──────────────────
  const explicit = Boolean((args.tasks && args.tasks.length > 0) || args.taskFile || args.all)
  let heldInTasks: string[]
  let heldOutTasks: string[]
  let splitMeta: SplitMeta | null
  let activeFold: number

  if (explicit) {
    heldInTasks = args.all
      ? selectTasks(paths, { all: true })
      : args.taskFile
        ? selectTasks(paths, { taskFile: args.taskFile })
        : selectTasks(paths, { tasks: args.tasks })
    heldOutTasks = []
    splitMeta = null
    activeFold = -1
    log(
      "ab: LEGACY mode (explicit tasks) — no held-out split; a verdict can be reject/inconclusive only, never accept",
    )
  } else {
    const splitsPath = args.splitFile ?? paths.splitsFile
    if (!existsSync(splitsPath)) {
      die(`no split at ${splitsPath} — run 'runner.ts split make', or pass --tasks/--task-file/--all for legacy mode`)
    }
    const loaded = loadActiveSplit(splitsPath)
    heldInTasks = loaded.heldIn
    heldOutTasks = loaded.heldOut
    splitMeta = loaded.meta
    activeFold = loaded.meta.activeFold
    for (const t of [...heldInTasks, ...heldOutTasks]) {
      if (!existsSync(join(paths.tbRoot, t, "task.toml"))) {
        die(`split task '${t}' not found under tbRoot (${paths.tbRoot})`)
      }
    }
  }

  // Sentinels ride held_out but must never dilute the fold-only regression
  // gate — stratify held-out into fold vs sentinel now.
  const sentinelSet = new Set(splitMeta ? splitMeta.sentinels : [])
  const foldOutTasks = heldOutTasks.filter((t) => !sentinelSet.has(t))
  const sentinelOutTasks = heldOutTasks.filter((t) => sentinelSet.has(t))

  // Compose both arms once (they differ in exactly one layer by construction).
  const harnessA = assembleAgentsMd(layers, paths.metaRoot, agent, {})
  const harnessB = assembleAgentsMd(layers, paths.metaRoot, agent, { [layer]: candidate })
  const agentVersion = await inContainerAgentVersion(paths, driver, execFn)
  const envB = await envBlock(harnessB, maxAgentTimeout, model, paths.metaRoot, undefined, agentVersion, driver.id)

  const cfg: DecisionConfig = {
    alpha: args.alpha ?? 0.05,
    nonregressMargin: args.nonregressMargin ?? 0.05,
    hoGuardAlpha: 0.05,
  }
  const earlyStop = !args.noEarlyStop
  const minTasks = args.minTasksBeforeStop ?? 12

  const verdictPath = candidatePath(layerRoot, candidate, "ab-verdict.json")
  const partialPath = candidatePath(layerRoot, candidate, "ab-verdict.partial.json")

  const runIdent: Record<string, unknown> = {
    layer,
    candidate,
    baseline,
    model,
    k,
    activeFold,
    splitHash: splitHash(heldInTasks, heldOutTasks),
    driver: driver.id,
  }

  log(
    `A/B: ${layer} ${candidate} vs active ${baseline}  held-in=${heldInTasks.length} held-out=${heldOutTasks.length}  k=${k}  fold=${activeFold}`,
  )
  if (agent) log(`Agent role layers: ${agent}`)

  const taskResults: AbTaskResults = {}
  let earlyStopped = false

  if (args.resume && existsSync(partialPath)) {
    let prev: Record<string, unknown> = {}
    try {
      prev = JSON.parse(readFileSync(partialPath, "utf-8")) as Record<string, unknown>
    } catch {
      prev = {}
    }
    resumeIdentCheck(prev, runIdent)
    earlyStopped = Boolean(prev["earlyStopped"])
    const prevResults = (prev["taskResults"] as AbTaskResults) || {}
    for (const [t, tr] of Object.entries(prevResults)) {
      if (tr.error === "setup_failed") {
        taskResults[t] = tr
      } else if ((tr.candidate?.length ?? 0) >= k && (tr.active?.length ?? 0) >= k) {
        taskResults[t] = tr
      }
    }
    if (Object.keys(taskResults).length > 0) {
      log(`Resuming ab: ${Object.keys(taskResults).length} task(s) already complete${earlyStopped ? " (early-stopped)" : ""}`)
    }
  }

  const runStartTs = new Date().toISOString()

  function stats(phase: "held-in" | "held-out", sentinel?: boolean): PairStats {
    return pairedRunStats(filterTaskResults(taskResults as PhaseTaggedTaskResults, phase, sentinel))
  }

  function statsBlock(ps: PairStats): AbSetStats {
    return {
      nTasks: ps.nTasks,
      nPairs: ps.nPairs,
      b: ps.b,
      c: ps.c,
      delta: round4(ps.delta),
      mcnemarP: round4(mcnemarExactOneSided(ps.b, ps.c)),
      bootCI90: bootstrapTaskCi(Object.values(ps.taskDeltas)),
    }
  }

  function verdictDict(status: string): Record<string, unknown> {
    const [decision, reasons, hi, ho, hoSentinel] = abDecision(
      taskResults as PhaseTaggedTaskResults,
      cfg,
      earlyStopped,
      foldOutTasks,
      sentinelOutTasks,
    )
    const winner = decision === "accept" ? "candidate" : decision === "reject" ? "active" : "tie"
    const included = Object.entries(taskResults).filter(([, tr]) => !tr.error)
    const nAll = included.length
    const candPass = included.filter(([, tr]) => tr.candidate.length > 0 && Math.max(...tr.candidate) === 1).length
    const actPass = included.filter(([, tr]) => tr.active.length > 0 && Math.max(...tr.active) === 1).length
    const d: Record<string, unknown> = {
      schemaVersion: 2,
      layer,
      candidate,
      baseline,
      activeFold,
      splitHash: runIdent["splitHash"],
      decision,
      winner,
      reasons,
      candidateRate: nAll ? round4(candPass / nAll) : 0.0,
      activeRate: nAll ? round4(actPass / nAll) : 0.0,
      nTasks: nAll,
      k,
      heldIn: statsBlock(hi),
      heldOut: ho ? statsBlock(ho) : null,
      sentinels: hoSentinel ? statsBlock(hoSentinel) : null,
      earlyStopped,
      split: splitMeta,
      env: envB,
      taskResults,
      model,
      variant,
      timestamp: runStartTs,
    }
    if (status) d["status"] = status
    return d
  }

  async function runPhase(phase: "held-in" | "held-out", taskList: string[], recordArmB: boolean): Promise<void> {
    for (const task of taskList) {
      if (earlyStopped) break
      if (taskResults[task]) {
        log(`\n=== ab ${task} [${phase}] (skipped — already done) ===`)
        continue
      }
      log(`\n=== ab ${task} [${phase}]: ${candidate} vs active ${baseline} ===`)
      const { agentTimeout, verifierTimeout } = taskTimeouts(paths, task, maxAgentTimeout)
      const tr: AbTaskResult = { candidate: [], active: [], phase, sentinel: sentinelSet.has(task) }

      for (let ki = 0; ki < k; ki++) {
        if (k > 1) log(`  -- pair ${ki + 1}/${k} --`)
        log("  [arm A: active]")
        const resA = await runOneTask(paths, task, model, variant, harnessA, agentTimeout, verifierTimeout, staging, driver)
        log("  [arm B: candidate]")
        const resB = await runOneTask(paths, task, model, variant, harnessB, agentTimeout, verifierTimeout, staging, driver)

        if (resA.error === "setup_failed" || resB.error === "setup_failed") {
          tr.error = "setup_failed"
          log("  setup_failed — task excluded from rates")
          break
        }
        tr.active.push(resA.reward)
        tr.candidate.push(resB.reward)

        // Record ONLY arm B, and ONLY for held-in (held-out stays invisible
        // to the proposer — evaluator outside the loop).
        if (recordArmB && !noStore && resB.turns > 0) {
          const rec = sessionRecord(
            task,
            resB.sessionId,
            resB.reward === 1,
            resB.turns,
            resB.toolUsage,
            model,
            variant,
            envB as unknown as Record<string, unknown>,
          )
          const score = recordSession(layerRoot, candidate, rec)
          if (resB.events.length > 0 && (resB.reward !== 1 || args.saveAllTraj)) {
            writeTrajectory(layerRoot, candidate, resB.sessionId, resB.events)
            pruneTrajectories(layerRoot, candidate)
          }
          log(`  store ${layer} ${candidate}: nPass=${score.nPass} nFail=${score.nFail}`)
        }
      }
      taskResults[task] = tr
      writeJsonAtomic(partialPath, verdictDict("in_progress"))

      if (phase === "held-in" && earlyStop) {
        const hi = stats("held-in")
        if (futilityStop(hi.b, hi.c, hi.nTasks, minTasks)) {
          earlyStopped = true
          log(`  FUTILITY: candidate behind (b=${hi.b} c=${hi.c}) after ${hi.nTasks} held-in tasks — early stop`)
        }
      }
    }
  }

  await runPhase("held-in", heldInTasks, true)
  if (!earlyStopped) await runPhase("held-out", heldOutTasks, false)

  const final = verdictDict("")
  writeJsonAtomic(verdictPath, final)
  const finalHeldIn = final["heldIn"] as AbSetStats
  const finalHeldOut = final["heldOut"] as AbSetStats | null
  appendMetaMetric(join(paths.metaRoot, ".meta-harness"), {
    event: "ab",
    layer,
    candidate,
    baseline,
    decision: final["decision"],
    heldInDelta: finalHeldIn.delta,
    heldInP: finalHeldIn.mcnemarP,
    nPairs: finalHeldIn.nPairs,
    heldOutDelta: finalHeldOut ? finalHeldOut.delta : null,
    splitFold: splitMeta ? splitMeta.activeFold : null,
    earlyStopped: final["earlyStopped"],
    model,
  })
  rmSync(partialPath, { force: true })

  // Summary
  console.log("\n" + "=".repeat(74))
  console.log(
    `${"Task".padEnd(30)} ${"phase".padStart(9)} ${"candidate".padStart(12)} ${"active".padStart(10)}  ${"verdict".padStart(7)}`,
  )
  console.log("-".repeat(74))
  for (const [t, tr] of Object.entries(taskResults)) {
    const ph = tr.phase ?? "?"
    if (tr.error === "setup_failed") {
      console.log(`${t.slice(0, 29).padEnd(30)} ${ph.padStart(9)} ${"—".padStart(12)} ${"—".padStart(10)}  ${"skip".padStart(7)}`)
      continue
    }
    const cp = Math.max(...tr.candidate)
    const ap = Math.max(...tr.active)
    const v = cp > ap ? "cand" : cp < ap ? "active" : "tie"
    console.log(
      `${t.slice(0, 29).padEnd(30)} ${ph.padStart(9)} ${JSON.stringify(tr.candidate).padStart(12)} ${JSON.stringify(tr.active).padStart(10)}  ${v.padStart(7)}`,
    )
  }
  console.log("=".repeat(74))
  console.log(`DECISION: ${(final["decision"] as string).toUpperCase()}   (winner=${final["winner"]})`)
  console.log(
    `  held-in : delta=${pySigned(finalHeldIn.delta, 3)} McNemar p=${pyFixed(finalHeldIn.mcnemarP, 3)} ` +
      `CI90=[${finalHeldIn.bootCI90.join(", ")}] (n=${finalHeldIn.nPairs} pairs, b=${finalHeldIn.b} c=${finalHeldIn.c})`,
  )
  if (finalHeldOut) {
    console.log(
      `  held-out: delta=${pySigned(finalHeldOut.delta, 3)} McNemar p=${pyFixed(finalHeldOut.mcnemarP, 3)} ` +
        `CI90=[${finalHeldOut.bootCI90.join(", ")}] (n=${finalHeldOut.nPairs} pairs)`,
    )
  }
  const sentBlock = final["sentinels"] as AbSetStats | null
  if (sentBlock) {
    console.log(`  sentinels: delta=${pySigned(sentBlock.delta, 3)} (n=${sentBlock.nPairs} pairs)`)
  }
  for (const r of final["reasons"] as string[]) {
    console.log(`  · ${r}`)
  }
  log(`Verdict written → ${verdictPath}`)

  if (args.resultsFile) {
    writeJsonAtomic(args.resultsFile, final)
  }
}
