/**
 * cmd-propose-lesson.ts — `bench propose-lesson`: run the enhanced lesson
 * proposer (docs/proposer-lesson-prompt.md) over a candidate's taxonomy +
 * verifier contracts → ONE proposed bullet (or abstain), optionally staged as
 * an INACTIVE candidate via --create vN. Mirrors cmd-failure-taxonomy's shape
 * (evidence from the store, one host-side judge-transport LLM call, no task
 * runs). Adoption stays with the gate: this command never activates anything.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { BenchPaths } from "./paths.ts"
import { die, log } from "./util.ts"
import { runJudgeOpencode } from "./opencode-run.ts"
import { DEFAULT_JUDGE_MODEL, type RunJudgeFn } from "./judge-audit.ts"
import { layerStoreRoots, type LayerName } from "./record.ts"
import {
  candidateExists,
  createCandidate,
  listVersions,
  readPlaybook,
  readTaxonomy,
  renderPlaybook,
  type Playbook,
} from "../harness-store.ts"
import { buildLessonProposerPrompt, parseLessonProposal, type LessonEvidence } from "./lesson-proposer.ts"

export interface ProposeLessonArgs {
  layer: string
  candidate: string
  agent?: string
  model?: string
  /** CSV of guard task names to declare in the prompt. */
  guards?: string
  /** JSON file: [{text, verdict, outcome?}] — gate-rejected lessons. */
  rejectedFile?: string
  /** Write the parsed proposal JSON here. */
  out?: string
  /** Stage the proposed bullet as this INACTIVE candidate (vN). */
  create?: string
}

/** Per-task verifier sources, truncated — raw untrusted evidence the proposer
 * summarizes itself (loop-1 post-mortem: this input is REQUIRED, not optional). */
const VERIFIER_FILES = ["verify.sh", "test.sh", "test_outputs.py"]
const VERIFIER_TRUNCATE = 4000

function readVerifierContracts(tbRoot: string, tasks: string[]): { task: string; source: string }[] {
  const out: { task: string; source: string }[] = []
  for (const task of tasks) {
    const parts: string[] = []
    for (const f of VERIFIER_FILES) {
      const p = join(tbRoot, task, "tests", f)
      if (existsSync(p)) parts.push(`# ${f}\n${readFileSync(p, "utf8").slice(0, VERIFIER_TRUNCATE)}`)
    }
    if (parts.length > 0) out.push({ task, source: parts.join("\n\n") })
  }
  return out
}

export async function cmdProposeLesson(
  paths: BenchPaths,
  args: ProposeLessonArgs,
  runJudge: RunJudgeFn = (prompt, model) => runJudgeOpencode(prompt, model),
  /** Test seam: bypass layerStoreRoots resolution (mirrors runJudge injection). */
  layerRootOverride?: string,
): Promise<number> {
  const candidate = args.candidate
  if (!/^v\d+$/.test(candidate)) die(`--candidate must look like vN, got '${candidate}'`)
  if (args.create && !/^v\d+$/.test(args.create)) die(`--create must look like vN, got '${args.create}'`)
  const model = args.model || DEFAULT_JUDGE_MODEL

  let layerRoot = layerRootOverride
  if (!layerRoot) {
    const roots = new Map(layerStoreRoots("global", args.agent || "", paths.metaRoot))
    layerRoot = roots.get(args.layer as LayerName)
    if (!layerRoot) die(`--layer ${args.layer} requires --agent (role layers need --agent)`)
  }

  if (!candidateExists(layerRoot, candidate)) {
    const have = listVersions(layerRoot).join(", ") || "none"
    die(`propose-lesson: no such candidate '${candidate}' under ${layerRoot} (have: ${have})`)
  }
  const taxonomy = readTaxonomy(layerRoot, candidate)
  if (!taxonomy || taxonomy.entries.length === 0) {
    log(`propose-lesson: no taxonomy for ${candidate} — run \`bench failure-taxonomy\` first`)
    return 2
  }
  const playbook = readPlaybook(layerRoot, candidate)
  if (!playbook) die(`propose-lesson: ${candidate} has no playbook.json`)
  if (args.create && candidateExists(layerRoot, args.create)) {
    die(`propose-lesson: --create ${args.create} already exists — pick a fresh version`)
  }

  const rejected: LessonEvidence["rejected"] = args.rejectedFile
    ? (JSON.parse(readFileSync(args.rejectedFile, "utf8")) as LessonEvidence["rejected"])
    : []
  const tasks = [...new Set(taxonomy.entries.map((e) => e.task))]
  const verifierContracts = readVerifierContracts(paths.tbRoot, tasks)
  if (verifierContracts.length === 0) {
    log(`warning: no verifier sources found under ${paths.tbRoot} for tasks [${tasks.join(", ")}] — contract section will be empty`)
  }

  const evidence: LessonEvidence = {
    taxonomy,
    playbook: playbook.bullets
      .filter((b) => b.status === "active")
      .map((b) => ({ id: b.id, text: b.text, helpful: b.helpful, harmful: b.harmful })),
    covered: "",
    rejected,
    verifierContracts,
    divergence: "",
    guards: (args.guards ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  }

  const prompt = buildLessonProposerPrompt(evidence)
  const reply = await runJudge(prompt, model)
  if (!reply) {
    log("propose-lesson: judge transport returned nothing")
    return 1
  }
  const parsed = parseLessonProposal(reply)
  if (!parsed.ok) {
    log(`propose-lesson: reply rejected — ${parsed.error}`)
    return 1
  }
  const proposal = parsed.proposal
  log(`proposal: ${proposal.action} — ${proposal.reason}`)
  if (proposal.bullet) log(`bullet (${proposal.wordCount}w, mode=${proposal.bullet.mode}): ${proposal.bullet.text}`)
  if (proposal.predictions) log(`falsify_if: ${proposal.predictions.falsifyIf}`)
  if (args.out) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(args.out, JSON.stringify(proposal, null, 2))
    log(`proposal written to ${args.out}`)
  }

  if (proposal.action === "abstain" || !args.create) return 0

  // Stage as an INACTIVE candidate: base playbook + the one bullet; system.md =
  // faithful render so composeHarness injects it (standing rule 5 in
  // docs/loop-roadmap.md — a bullet absent from system.md silently vanishes
  // from the assembled harness).
  const now = new Date().toISOString()
  const newPb: Playbook = JSON.parse(JSON.stringify(playbook))
  newPb.bullets.push({
    id: `b${newPb.nextId}`,
    text: proposal.bullet!.text,
    helpful: 0,
    harmful: 0,
    addedBy: args.create,
    status: "active",
    createdAt: now,
    updatedAt: now,
  })
  newPb.nextId += 1
  createCandidate(layerRoot, args.create, renderPlaybook(newPb), "", newPb)
  log(`staged INACTIVE candidate ${args.create} (+1 bullet on ${candidate}; gate decides adoption)`)
  return 0
}
