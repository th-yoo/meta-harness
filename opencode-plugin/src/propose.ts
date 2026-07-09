/**
 * propose.ts
 *
 * Store-aware proposer loop for the 4-layer meta-harness system.
 *
 * Each layer has its own proposer, guided to fill only the gaps above it:
 *   account-global  — general rules for all coding, all projects
 *   project-global  — general rules for this project (all roles)
 *   account-role    — rules for <role> across all projects
 *   project-role    — rules for <role> in this project (most specific)
 *
 * The proposer writes a new system.md to an in-project staging file via bash,
 * then the plugin relocates it into the target storeRoot via Node fs.
 * This avoids external-directory permission prompts when writing to the
 * account-level stores under ~/.config/opencode/.meta-harness/.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import {
  accountGlobalRoot,
  activeVersion,
  buildProposerContext,
  buildPromotionEvidence,
  createCandidate,
  nextVersion,
  readActiveSystem,
  readActiveTools,
  readScore,
  readTrial,
  startTrial,
  readMhConfig,
  parseModelSpec,
  writeCandidateMeta,
  buildFailureExcerpts,
  readDiagnosis,
  writeDiagnosis,
  type StoreLayer,
} from "./harness-store.ts"
import { proposerSessions } from "./session-state.ts"

type Client = PluginInput["client"]

/** Failure-taxonomy labels the proposer must pick from when diagnosing. */
export const FAILURE_TAXONOMY = [
  "wrong-plan", "spec-misread", "env-misread", "tool-misuse",
  "premature-termination", "verifier-mismatch", "resource-limit", "flaky-infra",
] as const

/** How many scored project-role sessions before auto-propose. */
export const PROJECT_ROLE_THRESHOLD = 5

/** How many scored project-global sessions before auto-propose. */
export const PROJECT_GLOBAL_THRESHOLD = 10

/** Trial sessions required before a project-layer candidate is confirmed/reverted. */
export const TRIAL_MIN_SESSIONS = 5

/** Minimum scored sessions on the source active version before /mh-promote runs. */
export const PROMOTE_MIN_EVIDENCE = 3

/** Store roots with a proposer/promoter session currently running (one per root). */
const inFlight = new Set<string>()

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Trigger a proposer session for one store layer.
 * `layer.higherRoots` supplies the gap-filling "already covered" context.
 * The proposer writes to a staging file inside the worktree; the plugin
 * then relocates it into `layer.root` after the session completes.
 */
export async function triggerPropose(
  client: Client,
  worktree: string,
  layer: StoreLayer,
): Promise<void> {
  if (inFlight.has(layer.root)) {
    await client.app.log({
      body: { service: "meta-harness", level: "info",
              message: `propose skipped: ${layer.scope} already has a session in flight` },
    })
    return
  }
  const isProject = layer.scope === "project-global" || layer.scope === "project-role"
  if (isProject && readTrial(layer.root) !== null) {
    await client.tui.showToast({
      body: { title: "Meta-Harness",
              message: `Trial in progress for ${layer.scope} — skipping propose`,
              variant: "info", duration: 5_000 },
    })
    return
  }

  inFlight.add(layer.root)
  try {
    const version = nextVersion(layer.root)
    const stagingBase = path.join(worktree, ".meta-harness", "staging")
    const stagingSystem = path.join(stagingBase, `${layer.scope}-${version}-system.md`)
    const stagingTools  = path.join(stagingBase, `${layer.scope}-${version}-tools.md`)
    const stagingDiagnosis = path.join(stagingBase, `${layer.scope}-${version}-diagnosis.json`)

    const context = buildProposerContext(layer.root, layer.higherRoots)
    const prompt = buildProposerPrompt(layer, version, context, stagingSystem, stagingTools, stagingDiagnosis, worktree)
    const cfg = readMhConfig()
    const proposerModel = parseModelSpec(cfg.proposerModel)

    await client.app.log({
      body: { service: "meta-harness", level: "info",
              message: `Starting proposer for ${layer.scope} → ${version} (model=${cfg.proposerModel})` },
    })
    await client.tui.showToast({
      body: { title: "Meta-Harness", message: `Proposing ${layer.scope} ${version}…`,
              variant: "info", duration: 5_000 },
    })

    const sessionRes = await client.session.create({
      body: { title: `[meta-harness] ${layer.scope} ${version}` },
    })
    const sessionID = sessionRes.data?.id
    if (!sessionID) {
      await client.app.log({
        body: { service: "meta-harness", level: "error", message: "Failed to create proposer session" },
      })
      return
    }

    proposerSessions.add(sessionID)
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: prompt }],
        ...(proposerModel ? { model: proposerModel } : {}),
      },
    })

    // Poll for the required system.md staging file (tools.md is optional)
    const found = await waitForFile(stagingSystem, 10 * 60 * 1000)
    proposerSessions.delete(sessionID)

    if (!found) {
      await client.tui.showToast({
        body: { title: "Meta-Harness",
                message: `Proposer timed out for ${layer.scope} — keeping current`,
                variant: "warning", duration: 5_000 },
      })
      return
    }

    // Relocate staging files into the target store (works for account stores too)
    const system = fs.readFileSync(stagingSystem, "utf-8").trim()
    fs.rmSync(stagingSystem, { force: true })
    const tools = fs.existsSync(stagingTools)
      ? fs.readFileSync(stagingTools, "utf-8").trim()
      : ""
    if (tools) fs.rmSync(stagingTools, { force: true })

    createCandidate(layer.root, version, system, tools)
    writeCandidateMeta(layer.root, version, {
      proposerModel: cfg.proposerModel,
      proposerVariant: cfg.proposerVariant,
      scope: layer.scope,
      kind: "propose",
      createdAt: new Date().toISOString(),
    })
    // Relocate the diagnosis (soft-required — warn if the proposer skipped it).
    if (fs.existsSync(stagingDiagnosis)) {
      try {
        writeDiagnosis(layer.root, version, JSON.parse(fs.readFileSync(stagingDiagnosis, "utf-8")))
      } catch {
        await client.app.log({ body: { service: "meta-harness", level: "warn",
          message: `proposer ${layer.scope} ${version}: diagnosis.json malformed — skipped` } })
      }
      fs.rmSync(stagingDiagnosis, { force: true })
    } else {
      await client.app.log({ body: { service: "meta-harness", level: "warn",
        message: `proposer ${layer.scope} ${version}: no diagnosis.json written (soft-required)` } })
    }

    const toolsNote = tools ? " + tools.md" : ""
    if (isProject) {
      // Selection gate: go live provisionally as a trial; confirm/revert after
      // TRIAL_MIN_SESSIONS scored sessions (see resolveTrial in the idle hook).
      const baseline = activeVersion(layer.root)
      startTrial(layer.root, version, system, tools, TRIAL_MIN_SESSIONS)
      await client.tui.showToast({
        body: { title: "Meta-Harness",
                message: `Trial started: ${layer.scope} ${version}${toolsNote} (baseline ${baseline}) — resolves after ${TRIAL_MIN_SESSIONS} scored sessions`,
                variant: "info", duration: 8_000 },
      })
      await client.app.log({
        body: { service: "meta-harness", level: "info",
                message: `Trial started ${layer.scope} ${version} (baseline ${baseline})` },
      })
    } else {
      // Account layers are validated by TB2, not everyday usage — leave the
      // candidate INACTIVE pending an ab-verdict; the human activates via /mh-activate.
      await client.tui.showToast({
        body: { title: "Meta-Harness",
                message: `Candidate ${version}${toolsNote} created for ${layer.scope} — validate with runner.py ab, then /mh-activate ${layer.scope} ${version}`,
                variant: "info", duration: 10_000 },
      })
      await client.app.log({
        body: { service: "meta-harness", level: "info",
                message: `Candidate ${layer.scope} ${version} created (inactive, awaiting ab-verdict)` },
      })
    }
  } finally {
    inFlight.delete(layer.root)
  }
}

/**
 * Promote proven rules from a project layer up to the corresponding account
 * layer. Opens a promoter session that selects the generalizable rules and
 * merges them into the account layer's active text, creating an INACTIVE
 * account candidate (the TB2 ab-verdict gate then decides activation).
 */
export async function triggerPromote(
  client: Client,
  worktree: string,
  source: StoreLayer,   // project-global | project-role
  target: StoreLayer,   // account-global | account-role
): Promise<void> {
  if (inFlight.has(target.root)) {
    await client.app.log({
      body: { service: "meta-harness", level: "info",
              message: `promote skipped: ${target.scope} already has a session in flight` },
    })
    return
  }

  const srcScore = readScore(source.root, activeVersion(source.root))
  if (srcScore.sessions.length < PROMOTE_MIN_EVIDENCE || srcScore.nPass === 0) {
    await client.tui.showToast({
      body: { title: "Meta-Harness",
              message: `Not enough evidence to promote ${source.scope} (need ≥${PROMOTE_MIN_EVIDENCE} scored sessions with ≥1 pass; have ${srcScore.sessions.length} sessions, ${srcScore.nPass} pass)`,
              variant: "warning", duration: 8_000 },
    })
    return
  }

  inFlight.add(target.root)
  try {
    const version = nextVersion(target.root)
    const stagingBase = path.join(worktree, ".meta-harness", "staging")
    const stagingSystem = path.join(stagingBase, `promote-${target.scope}-${version}-system.md`)
    const stagingTools  = path.join(stagingBase, `promote-${target.scope}-${version}-tools.md`)

    const prompt = buildPromotePrompt(source, target, version, stagingSystem, stagingTools, worktree)
    const cfg = readMhConfig()
    const proposerModel = parseModelSpec(cfg.proposerModel)

    await client.app.log({
      body: { service: "meta-harness", level: "info",
              message: `Starting promoter ${source.scope} → ${target.scope} ${version} (model=${cfg.proposerModel})` },
    })
    await client.tui.showToast({
      body: { title: "Meta-Harness", message: `Promoting ${source.scope} → ${target.scope} ${version}…`,
              variant: "info", duration: 5_000 },
    })

    const sessionRes = await client.session.create({
      body: { title: `[meta-harness] promote ${source.scope}→${target.scope} ${version}` },
    })
    const sessionID = sessionRes.data?.id
    if (!sessionID) {
      await client.app.log({
        body: { service: "meta-harness", level: "error", message: "Failed to create promoter session" },
      })
      return
    }

    proposerSessions.add(sessionID)
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: prompt }],
        ...(proposerModel ? { model: proposerModel } : {}),
      },
    })

    const found = await waitForFile(stagingSystem, 10 * 60 * 1000)
    proposerSessions.delete(sessionID)

    if (!found) {
      await client.tui.showToast({
        body: { title: "Meta-Harness",
                message: `Promoter timed out for ${target.scope} — nothing created`,
                variant: "warning", duration: 5_000 },
      })
      return
    }

    const system = fs.readFileSync(stagingSystem, "utf-8").trim()
    fs.rmSync(stagingSystem, { force: true })
    const tools = fs.existsSync(stagingTools)
      ? fs.readFileSync(stagingTools, "utf-8").trim()
      : ""
    if (tools) fs.rmSync(stagingTools, { force: true })

    createCandidate(target.root, version, system, tools) // inactive — account gate applies
    writeCandidateMeta(target.root, version, {
      proposerModel: cfg.proposerModel,
      proposerVariant: cfg.proposerVariant,
      scope: target.scope,
      kind: "promote",
      source: source.scope,
      createdAt: new Date().toISOString(),
    })

    const toolsNote = tools ? " + tools.md" : ""
    await client.tui.showToast({
      body: { title: "Meta-Harness",
              message: `Promotion candidate ${version}${toolsNote} for ${target.scope} — validate with runner.py ab, then /mh-activate ${target.scope} ${version}`,
              variant: "success", duration: 10_000 },
    })
    await client.app.log({
      body: { service: "meta-harness", level: "info",
              message: `Promotion candidate ${target.scope} ${version} created (inactive)` },
    })
  } finally {
    inFlight.delete(target.root)
  }
}

// ── Proposer prompt ────────────────────────────────────────────────────────

const SCOPE_GUIDANCE: Record<StoreLayer["scope"], string> = {
  "account-global": `\
You are writing the ACCOUNT-GLOBAL layer — rules true for ALL coding work across ALL projects.
Only include behaviors so universal that every AI coding session should follow them, regardless
of project, role, or toolchain. Think: "would this rule help any developer on any project?"
If the answer is "only sometimes" or "only for this kind of task", it does NOT belong here.`,

  "project-global": `\
You are writing the PROJECT-GLOBAL layer — rules for ALL roles within THIS project.
These rules capture project-specific conventions: stack, toolchain, test commands, file layout,
coding style. They apply to every mh-* agent in this project but NOT to other projects.
Do not repeat universal coding principles already in the account-global layer.`,

  "account-role": `\
You are writing the ACCOUNT-ROLE (role-global) layer — rules for this ROLE across ALL projects.
These rules encode what makes this role effective in general, regardless of the current project.
Think: "what does a skilled person in this role always do?" — expertise, discipline, checklists
specific to the role. Do not repeat universal principles or project-specific conventions.`,

  "project-role": `\
You are writing the PROJECT-ROLE layer — the most specific layer: this ROLE in THIS project.
These rules address failure patterns specific to using this role on this codebase. They tune
the role's general behavior for this project's particular constraints, quirks, or patterns.
Do not repeat anything from the higher layers.`,
}

function buildProposerPrompt(
  layer: StoreLayer,
  version: string,
  context: string,
  stagingSystem: string,
  stagingTools: string,
  stagingDiagnosis: string,
  worktree: string,
): string {
  const guidance = SCOPE_GUIDANCE[layer.scope]
  const currentSystem = readActiveSystem(layer.root)
  const currentTools = readActiveTools(layer.root)
  const activeVer = activeVersion(layer.root)

  // Read "already covered" text (system + tools) from higher layers
  const coveredParts: string[] = []
  for (const r of layer.higherRoots) {
    const sys = readActiveSystem(r)
    const tools = readActiveTools(r)
    if (sys) coveredParts.push(`### system.md\n${sys}`)
    if (tools) coveredParts.push(`### tools.md\n${tools}`)
  }

  const coveredSection = coveredParts.length > 0
    ? `## Already covered by more-general layers — DO NOT REPEAT\n\n${coveredParts.join("\n\n")}\n\n`
    : ""

  const currentSystemSection = currentSystem
    ? `## Current ${layer.scope} system.md (refine — do not discard good rules)\n\n\`\`\`\n${currentSystem}\n\`\`\``
    : `## Current ${layer.scope} system.md\n\n(empty — write from scratch)`

  const currentToolsSection = currentTools
    ? `## Current ${layer.scope} tools.md (refine — do not discard good rules)\n\n\`\`\`\n${currentTools}\n\`\`\``
    : `## Current ${layer.scope} tools.md\n\n(empty — write from scratch if tool patterns warrant it)`

  // Full failing-trajectory excerpts + root causes already diagnosed for this version.
  const failing = buildFailureExcerpts(layer.root, activeVer)
  const failingSection = failing
    ? `## Failing trajectories (full tool I/O — where the agent actually went wrong)\n\n${failing}`
    : "## Failing trajectories\n\n(none captured yet — diagnose from the scores/notes above)"
  const priorDx = readDiagnosis<Record<string, unknown>>(layer.root, activeVer)
  const priorSection = priorDx
    ? `## Root causes already diagnosed for ${activeVer} — do NOT re-propose the same fix\n\n\`\`\`json\n${JSON.stringify(priorDx, null, 2).slice(0, 2000)}\n\`\`\`\n`
    : ""

  const relSystem = path.relative(worktree, stagingSystem)
  const relTools  = path.relative(worktree, stagingTools)
  const relDiag   = path.relative(worktree, stagingDiagnosis)
  const stagingDir = path.relative(worktree, path.dirname(stagingSystem))

  return `# Meta-Harness Proposer — ${layer.scope}

${guidance}

${coveredSection}${currentSystemSection}

${currentToolsSection}

## Prior session scores and traces for this layer

${context || "(no sessions scored yet — write a sensible baseline for this scope)"}

${failingSection}

${priorSection}## Your task — DIAGNOSE, then propose ONE rule

STEP 1 — Diagnose the failures. For each failing trajectory above (up to 3), find the FIRST unrecoverable step and the root cause. Classify each with exactly ONE taxonomy label from:
${FAILURE_TAXONOMY.map((t) => `  - ${t}`).join("\n")}

STEP 2 — Propose. From the diagnosis, identify the SINGLE most impactful behavioral gap in system.md — a rule that would prevent the diagnosed root cause, is not already covered by more-general layers, and is not a root cause already diagnosed for ${activeVer}. Optionally capture tool-usage patterns in tools.md (keyed by tool name).
Both artifacts SHORT and behavioral: system.md under 20 lines, tools.md under 15. No project docs / task-specific knowledge / AGENTS.md content.

## Write the results

**Required FIRST** — write your diagnosis (drives the next generation's memory):
\`\`\`bash
mkdir -p "${stagingDir}"
cat > "${relDiag}" << 'ENDOFDIAG'
{"failures":[{"sessionID":"<id from a trajectory above>","taxonomy":"<one label from the list>","rootCause":"<2-5 sentences>","firstUnrecoverableStep":"<quote the offending event>"}]}
ENDOFDIAG
\`\`\`

**Required** — write the improved system.md (each new rule should cite the diagnosis it addresses):
\`\`\`bash
cat > "${relSystem}" << 'ENDOFSYSTEM'
<your improved ${layer.scope} system prompt — short behavioral rules only>
ENDOFSYSTEM
\`\`\`

**Optional** — write tools.md only if tool patterns were identified:
\`\`\`bash
cat > "${relTools}" << 'ENDOFTOOLS'
<per-tool guidance keyed by tool name — only include tools with clear patterns>
ENDOFTOOLS
\`\`\`

After writing the files, briefly explain which diagnosed root cause each new rule addresses.`
}

function buildPromotePrompt(
  source: StoreLayer,
  target: StoreLayer,
  version: string,
  stagingSystem: string,
  stagingTools: string,
  worktree: string,
): string {
  const guidance = SCOPE_GUIDANCE[target.scope]

  // "Already covered" context comes from account layers ONLY. Do NOT use
  // target.higherRoots verbatim — for account-role that includes project-global,
  // which is the promotion source's sibling, not covered context.
  const coveredParts: string[] = []
  if (target.scope === "account-role") {
    const agSys = readActiveSystem(accountGlobalRoot())
    const agTools = readActiveTools(accountGlobalRoot())
    if (agSys) coveredParts.push(`### system.md\n${agSys}`)
    if (agTools) coveredParts.push(`### tools.md\n${agTools}`)
  }
  const coveredSection = coveredParts.length > 0
    ? `## Already covered by more-general layers — DO NOT REPEAT\n\n${coveredParts.join("\n\n")}\n\n---\n\n`
    : ""

  const targetSys = readActiveSystem(target.root)
  const targetTools = readActiveTools(target.root)
  const mergeBaseSection = targetSys
    ? `## Current ${target.scope} system.md (merge base — keep existing rules unless contradicted)\n\n\`\`\`\n${targetSys}\n\`\`\``
    : `## Current ${target.scope} system.md\n\n(empty — this promotion establishes it)`
  const mergeBaseTools = targetTools
    ? `## Current ${target.scope} tools.md (merge base — keep unless contradicted)\n\n\`\`\`\n${targetTools}\n\`\`\``
    : ""

  const srcSys = readActiveSystem(source.root)
  const srcTools = readActiveTools(source.root)
  const sourceSection = [
    `## Proven ${source.scope} rules to consider promoting\n\n### system.md\n\`\`\`\n${srcSys || "(empty)"}\n\`\`\``,
    srcTools ? `### tools.md\n\`\`\`\n${srcTools}\n\`\`\`` : null,
    `### Evidence\n${buildPromotionEvidence(source.root)}`,
  ].filter(Boolean).join("\n\n")

  const relSystem = path.relative(worktree, stagingSystem)
  const relTools  = path.relative(worktree, stagingTools)
  const stagingDir = path.relative(worktree, path.dirname(stagingSystem))

  return `# Meta-Harness Promoter — ${source.scope} → ${target.scope}

${guidance}

${coveredSection}${mergeBaseSection}

${mergeBaseTools}

${sourceSection}

## Your task

Promote rules that GENERALIZE from the project layer up to the account layer.

1. Read the proven ${source.scope} rules and their session evidence above.
2. Select ONLY rules that hold beyond this one project — drop anything that names
   this project's stack, file paths, commands, test runners, or conventions.
3. Merge the selected general rules into the merge base (keep the base's existing
   rules unless a promoted rule directly supersedes one). Write the COMPLETE merged
   system.md — not a diff.
4. Keep it SHORT and behavioral: system.md under 20 lines, tools.md under 15 lines.
   Do NOT write project documentation or task-specific knowledge.

## Write the results

**Required** — write the merged system.md:
\`\`\`bash
mkdir -p "${stagingDir}"
cat > "${relSystem}" << 'ENDOFSYSTEM'
<the complete merged ${target.scope} system prompt — general behavioral rules only>
ENDOFSYSTEM
\`\`\`

**Optional** — write tools.md only if general tool patterns warrant it:
\`\`\`bash
cat > "${relTools}" << 'ENDOFTOOLS'
<per-tool guidance keyed by tool name — only tools with general patterns>
ENDOFTOOLS
\`\`\`

After writing the file(s), briefly explain which rules you promoted and which you
dropped as too project-specific, citing the evidence.`
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const interval = 5_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
