/**
 * cmd-failure-taxonomy.ts — `bench failure-taxonomy`: classify a version's FAILING
 * trajectories into failure MODEs (AHE Agent-Debugger method) → candidates/vN/
 * taxonomy.json. Read-only over the store + the host-side judge LLM; no task runs.
 * Mirrors judge-audit.ts's cmdJudgeAudit (collect eligible traces → per-trace judge
 * call → aggregate). NOTE: the traj store is recency-capped (pruneTrajectories,
 * keepFailures=20), so this is a recency-biased sample of failures, not the full set.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { BenchPaths } from "./paths.ts"
import { die, log } from "./util.ts"
import { runJudgeOpencode } from "./opencode-run.ts"
import { DEFAULT_JUDGE_MODEL, type RunJudgeFn } from "./judge-audit.ts"
import { layerStoreRoots, type LayerName } from "./record.ts"
import { readScore, readTrajectory, writeTaxonomy, type Taxonomy } from "../harness-store.ts"
import { buildTaxonomyPrompt, parseTaxonomyEntry } from "./failure-taxonomy.ts"

export interface FailureTaxonomyArgs {
  layer: string
  candidate: string
  agent?: string
  model?: string
  limit?: number
}

export async function cmdFailureTaxonomy(
  paths: BenchPaths,
  args: FailureTaxonomyArgs,
  runJudge: RunJudgeFn = (prompt, model) => runJudgeOpencode(prompt, model),
): Promise<number> {
  const candidate = args.candidate
  if (!/^v\d+$/.test(candidate)) die(`--candidate must look like vN, got '${candidate}'`)
  const model = args.model || DEFAULT_JUDGE_MODEL
  const limit = args.limit ?? 20
  const roots = new Map(layerStoreRoots("global", args.agent || "", paths.metaRoot))
  const layerRoot = roots.get(args.layer as LayerName)
  if (!layerRoot) die(`--layer ${args.layer} requires --agent (role layers need --agent)`)

  const score = readScore(layerRoot, candidate)
  // FAILING sessions with a (non-pruned) trajectory; most-recent-first, capped.
  const failing = score.sessions
    .filter((s) => s.passed === false)
    .reverse()
    .slice(0, limit)
    .map((s) => ({ sid: s.sessionID, task: s.summary || s.note || s.sessionID, traj: readTrajectory(layerRoot, candidate, s.sessionID) }))
    .filter((x) => x.traj.length > 0)

  if (failing.length === 0) {
    log(`no failing trajectories with a stored traj for ${candidate} (all passing, or pruned) — nothing to classify`)
    return 2
  }

  const entries: Taxonomy["entries"] = []
  for (const { sid, task, traj } of failing) {
    const instrPath = join(paths.tbRoot, task, "instruction.md")
    const instr = existsSync(instrPath) ? readFileSync(instrPath, "utf8") : ""
    const reply = await runJudge(buildTaxonomyPrompt(traj, task, instr, true), model)
    const e = reply ? parseTaxonomyEntry(reply) : null
    const mode = e?.mode ?? "other"
    entries.push({ sessionID: sid, task, mode, failurePoint: e?.failurePoint ?? "", rootCause: e?.rootCause ?? "", generalMechanism: e?.generalMechanism ?? "" })
    log(`  ${task} [${sid}] → ${mode}`)
  }

  const modeFractions: Record<string, number> = {}
  const byTask: Record<string, string[]> = {}
  for (const e of entries) {
    modeFractions[e.mode] = (modeFractions[e.mode] ?? 0) + 1
    ;(byTask[e.task] ??= []).push(e.mode)
  }
  const tax: Taxonomy = { version: candidate, model, nClassified: entries.length, modeFractions, entries, byTask }
  writeTaxonomy(layerRoot, candidate, tax)
  log(`taxonomy: ${entries.length} classified → ${Object.entries(modeFractions).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  log(`(recency-capped at ${limit} — a biased sample, not the full failure set)`)
  return 0
}
