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
  appendMetaMetric,
  buildProposerContext,
  candidatePath,
  listVersions,
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
  readPlaybook,
  renderPlaybook,
  applyPlaybookOps,
  applyBulletAssessments,
  seedPlaybook,
  readAgentConfig,
  validateAgentConfig,
  readEnvPolicy,
  validateEnvPolicy,
  type StoreLayer,
  type Playbook,
  type PlaybookOp,
  type AgentConfig,
  type EnvPolicy,
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
    const stagingOps = path.join(stagingBase, `${layer.scope}-${version}-ops.json`)
    const stagingAgentConfig = path.join(stagingBase, `${layer.scope}-${version}-agent-config.json`)
    const stagingEnvPolicy = path.join(stagingBase, `${layer.scope}-${version}-env-policy.json`)
    // Seed the playbook from the active system.md on first use (non-destructive);
    // ops mode iff the layer ends up with a playbook (empty stores stay legacy).
    const playbook = seedPlaybook(layer.root)

    const context = buildProposerContext(layer.root, layer.higherRoots)
    const prompt = buildProposerPrompt(layer, version, context, stagingSystem, stagingTools,
      stagingDiagnosis, stagingOps, stagingAgentConfig, stagingEnvPolicy, worktree, playbook)
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

    // Poll for the primary artifact: ops.json in playbook mode, system.md otherwise.
    const primary = playbook ? stagingOps : stagingSystem
    let found = await waitForFile(primary, cfg.proposerTimeoutMin * 60 * 1000)
    // Grace: playbook mode but the proposer wrote a whole system.md instead.
    if (!found && playbook && fs.existsSync(stagingSystem)) found = true
    proposerSessions.delete(sessionID)

    if (!found) {
      await client.tui.showToast({
        body: { title: "Meta-Harness",
                message: `Proposer timed out for ${layer.scope} — keeping current`,
                variant: "warning", duration: 5_000 },
      })
      return
    }

    const tools = fs.existsSync(stagingTools)
      ? fs.readFileSync(stagingTools, "utf-8").trim()
      : ""
    if (tools) fs.rmSync(stagingTools, { force: true })

    // Read + relocate the diagnosis first — its bulletAssessments must be applied
    // to the ACTIVE playbook before we branch the ops off it.
    let diagnosis: Record<string, unknown> | null = null
    if (fs.existsSync(stagingDiagnosis)) {
      try { diagnosis = JSON.parse(fs.readFileSync(stagingDiagnosis, "utf-8")) } catch {
        await client.app.log({ body: { service: "meta-harness", level: "warn",
          message: `proposer ${layer.scope} ${version}: diagnosis.json malformed — skipped` } })
      }
      fs.rmSync(stagingDiagnosis, { force: true })
    } else {
      await client.app.log({ body: { service: "meta-harness", level: "warn",
        message: `proposer ${layer.scope} ${version}: no diagnosis.json written (soft-required)` } })
    }

    // Build the candidate: ops mode edits the playbook; legacy/grace uses system.md.
    let system: string
    let newPlaybook: Playbook | undefined
    if (playbook && fs.existsSync(stagingOps)) {
      let ops: PlaybookOp[] = []
      try {
        const parsed = JSON.parse(fs.readFileSync(stagingOps, "utf-8"))
        if (Array.isArray(parsed?.ops)) ops = parsed.ops
      } catch { /* malformed ops → no-op edit */ }
      fs.rmSync(stagingOps, { force: true })
      const assessments = (diagnosis?.["bulletAssessments"] as { id: string; verdict: "helpful" | "harmful" }[]) || []
      if (assessments.length) applyBulletAssessments(layer.root, assessments)
      const base = readPlaybook(layer.root) ?? playbook   // re-read after assessments
      newPlaybook = applyPlaybookOps(base, ops)
      system = renderPlaybook(newPlaybook)
    } else {
      system = fs.readFileSync(stagingSystem, "utf-8").trim()
      newPlaybook = undefined
    }
    if (fs.existsSync(stagingSystem)) fs.rmSync(stagingSystem, { force: true })

    // Optional agent-config op — PROJECT layers only (gated). Account-layer
    // candidates are validated by bench `ab`, which runs the default `build`
    // agent where the plugin is inert, so an evolved agent-config there can't
    // be measured — never pick one up for account scopes.
    let agentConfig: AgentConfig | null = null
    if (isProject && fs.existsSync(stagingAgentConfig)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stagingAgentConfig, "utf-8"))
        agentConfig = validateAgentConfig(parsed)
        if (!agentConfig) {
          await client.app.log({ body: { service: "meta-harness", level: "warn",
            message: `proposer ${layer.scope} ${version}: agent-config.json invalid — skipped` } })
        }
      } catch {
        await client.app.log({ body: { service: "meta-harness", level: "warn",
          message: `proposer ${layer.scope} ${version}: agent-config.json malformed — skipped` } })
      }
      fs.rmSync(stagingAgentConfig, { force: true })
    }

    // Optional env-policy op — PROJECT layers only (gated), same rationale as
    // agent-config above: bench `ab` validates account-layer candidates by
    // running the default `build` agent, where an evolved env-policy can
    // never be measured — never pick one up for account scopes.
    let envPolicy: EnvPolicy | null = null
    if (isProject && fs.existsSync(stagingEnvPolicy)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stagingEnvPolicy, "utf-8"))
        envPolicy = validateEnvPolicy(parsed)
        if (!envPolicy) {
          await client.app.log({ body: { service: "meta-harness", level: "warn",
            message: `proposer ${layer.scope} ${version}: env-policy.json invalid — skipped` } })
        }
      } catch {
        await client.app.log({ body: { service: "meta-harness", level: "warn",
          message: `proposer ${layer.scope} ${version}: env-policy.json malformed — skipped` } })
      }
      fs.rmSync(stagingEnvPolicy, { force: true })
    }

    // Carry the active knob forward when this cycle didn't re-emit one — the
    // staged value (if any) always wins, otherwise durability requires we
    // re-derive from active (same reasoning as the playbook: never let an
    // absent stage mean "delete the evolved knob"). Must read BEFORE
    // startTrial below, which overwrites active via writeActive.
    const effAgentConfig = agentConfig ?? readAgentConfig(layer.root)
    const effEnvPolicy = envPolicy ?? readEnvPolicy(layer.root)

    createCandidate(layer.root, version, system, tools, newPlaybook, effAgentConfig ?? undefined, effEnvPolicy ?? undefined)
    appendMetaMetric(layer.root, {
      event: "propose", candidate: version, scope: layer.scope,
      kind: newPlaybook ? "propose-ops" : "propose",
    })
    writeCandidateMeta(layer.root, version, {
      proposerModel: cfg.proposerModel,
      proposerVariant: cfg.proposerVariant,
      scope: layer.scope,
      kind: newPlaybook ? "propose-ops" : "propose",
      createdAt: new Date().toISOString(),
    })
    if (diagnosis) writeDiagnosis(layer.root, version, diagnosis)

    const toolsNote = tools ? " + tools.md" : ""
    if (isProject) {
      // Selection gate: go live provisionally as a trial; confirm/revert after
      // TRIAL_MIN_SESSIONS scored sessions (see resolveTrial in the idle hook).
      const baseline = activeVersion(layer.root)
      startTrial(layer.root, version, system, tools, TRIAL_MIN_SESSIONS, newPlaybook ?? null, effAgentConfig, effEnvPolicy)
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

    const found = await waitForFile(stagingSystem, cfg.proposerTimeoutMin * 60 * 1000)
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

/**
 * Store-access section: tells the (agentic) proposer session it can — and
 * should — read the candidate archive directly with its file tools, instead of
 * relying only on the compressed excerpts embedded in the prompt. This is the
 * founding paper's core mechanism (Meta-Harness, arXiv 2603.28052): the
 * proposer inspects raw source, scores, and execution traces of prior
 * candidates through the filesystem; compressed digests lose the evidence.
 * Held-out trajectories are never written to the store, so nothing leakable
 * exists under this root by construction.
 */
export function buildStoreAccessSection(layer: StoreLayer): string {
  const active = activeVersion(layer.root)
  const versions = listVersions(layer.root)
  const MAX_INDEX = 20
  const shown = versions.slice(-MAX_INDEX)
  const lines = shown.map((v) => {
    const score = readScore(layer.root, v)
    let trajCount = 0
    try {
      trajCount = fs
        .readdirSync(candidatePath(layer.root, v, "traj"))
        .filter((f) => f.endsWith(".ndjson")).length
    } catch { /* no traj dir */ }
    const hasDx = fs.existsSync(candidatePath(layer.root, v, "diagnosis.json"))
    const marker = v === active ? " (ACTIVE)" : ""
    return `- ${v}${marker} — pass ${score.nPass} / fail ${score.nFail} — trajectories: ${trajCount} — diagnosis: ${hasDx ? "yes" : "no"}`
  })
  const elided = versions.length > shown.length
    ? `\n(${versions.length - shown.length} older versions elided — list \`candidates/\` for all)`
    : ""

  return `## Store access — read the archive before diagnosing

You are an agent with file tools. The full candidate archive for this layer is on disk at:

    ${layer.root}

Layout: \`active/{system.md,tools.md,.version}\` (current), and per candidate
\`candidates/<vN>/\`: \`system.md\` + \`tools.md\` (the rules that ran), \`score.json\`
(pass/fail + per-session records), \`traj/<sessionID>.ndjson\` (FULL execution
traces — one JSON event per line), \`diagnosis.json\` (that generation's root-cause
analysis), \`meta.json\` (which proposer produced it).

Candidate index:
${lines.join("\n") || "(no candidates yet)"}${elided}

Before proposing, INSPECT the archive: read the full trajectories of failing
sessions (the excerpts below are an index, not the evidence), and read prior
candidates' rules alongside their scores — what was already tried, and did it
help? Do not re-propose a rule a prior candidate already tried without effect.

STRICTLY READ-ONLY: never create, modify, or delete anything under ${layer.root}.
Your ONLY write target is the staging directory named at the end of this prompt.`
}

export function buildProposerPrompt(
  layer: StoreLayer,
  version: string,
  context: string,
  stagingSystem: string,
  stagingTools: string,
  stagingDiagnosis: string,
  stagingOps: string,
  stagingAgentConfig: string,
  stagingEnvPolicy: string,
  worktree: string,
  playbook: Playbook | null,
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

  // Playbook mode shows the itemized bullets (ids + helpful/harmful counters);
  // legacy mode shows the raw system.md.
  const currentSystemSection = playbook
    ? `## Current ${layer.scope} playbook (edit these bullets by id)\n\n\`\`\`json\n${JSON.stringify(playbook.bullets.filter((b) => b.status === "active"), null, 2)}\n\`\`\``
    : currentSystem
      ? `## Current ${layer.scope} system.md (refine — do not discard good rules)\n\n\`\`\`\n${currentSystem}\n\`\`\``
      : `## Current ${layer.scope} system.md\n\n(empty — write from scratch)`

  const currentToolsSection = currentTools
    ? `## Current ${layer.scope} tools.md (refine — do not discard good rules)\n\n\`\`\`\n${currentTools}\n\`\`\``
    : `## Current ${layer.scope} tools.md\n\n(empty — write from scratch if tool patterns warrant it)`

  const storeAccessSection = buildStoreAccessSection(layer)

  const failing = buildFailureExcerpts(layer.root, activeVer)
  const failingSection = failing
    ? `## Failing-trajectory excerpts (an INDEX of where to look — read the full traces via Store access above)\n\n${failing}`
    : "## Failing-trajectory excerpts\n\n(none captured yet — check the archive via Store access above, or diagnose from the scores/notes)"
  const priorDx = readDiagnosis<Record<string, unknown>>(layer.root, activeVer)
  const priorSection = priorDx
    ? `## Root causes already diagnosed for ${activeVer} — do NOT re-propose the same fix\n\n\`\`\`json\n${JSON.stringify(priorDx, null, 2).slice(0, 2000)}\n\`\`\`\n`
    : ""

  const relSystem = path.relative(worktree, stagingSystem)
  const relTools  = path.relative(worktree, stagingTools)
  const relDiag   = path.relative(worktree, stagingDiagnosis)
  const relOps    = path.relative(worktree, stagingOps)
  const relAgentConfig = path.relative(worktree, stagingAgentConfig)
  const relEnvPolicy = path.relative(worktree, stagingEnvPolicy)
  const stagingDir = path.relative(worktree, path.dirname(stagingSystem))

  // Agent-config op — PROJECT layers only. Account-layer candidates are
  // validated by bench `ab`, which runs the default `build` agent (where the
  // plugin is inert), so an evolved agent-config there can never be measured —
  // do not offer this section for account scopes.
  const agentConfigSection = layer.scope.startsWith("project")
    ? (() => {
        const currentCfg = readAgentConfig(layer.root)
        const currentCfgText = currentCfg ? `\`\`\`json\n${JSON.stringify(currentCfg, null, 2)}\n\`\`\`` : "none"
        return `
## Optional: agent-config.json (bash-tool timeout tuning)

Current effective agent-config for ${layer.scope}: ${currentCfgText}

Whitelisted schema (unknown fields are dropped; out-of-range values are clamped/filtered):
- \`fastTimeoutMs\` (number, clamped to [500, 30000]) — overrides the default bash-tool timeout applied to "fast" commands.
- \`extraFastCommands\` (string[], ≤20 entries, each matching \`/^[a-z0-9._+-]{1,32}$/\`) — additional commands to treat as fast (capped timeout).
- \`extraSlowCommands\` (string[], ≤20 entries, same pattern) — additional commands to treat as slow (no cap); wins over extraFastCommands on conflict.

Emit this file ONLY if a diagnosed root cause is a timeout / tool-latency problem; otherwise omit it.

\`\`\`bash
cat > "${relAgentConfig}" << 'ENDOFAGENTCONFIG'
{"schemaVersion":1,"fastTimeoutMs":8000,"extraFastCommands":["mytool"],"extraSlowCommands":["slowtool"]}
ENDOFAGENTCONFIG
\`\`\`
`
      })()
    : ""

  // Env-policy op — PROJECT layers only, same gating rationale as agent-config
  // above: an evolved env-policy at an account layer can never be measured by
  // bench `ab` (default `build` agent, plugin inert) — never offer this
  // section for account scopes.
  const envPolicySection = layer.scope.startsWith("project")
    ? (() => {
        const currentPolicy = readEnvPolicy(layer.root)
        const currentPolicyText = currentPolicy ? `\`\`\`json\n${JSON.stringify(currentPolicy, null, 2)}\n\`\`\`` : "none"
        return `
## Optional: env-policy.json (environment-snapshot probe tuning)

Current effective env-policy for ${layer.scope}: ${currentPolicyText}

Whitelisted schema (unknown fields are dropped; out-of-range/invalid values are clamped/filtered):
- \`probes\` (object of booleans \`{ls, lang, pkg, mem}\`) — which environment probes to run; omitted keys default to enabled (true).
- \`lsPath\` (string, absolute, matching \`/^\\/[A-Za-z0-9_\\/.-]{0,120}$/\`) — path the \`ls\` probe lists; a relative or shell-unsafe path is dropped.
- \`maxLsEntries\` (number, clamped to [5, 100]) — cap on entries the \`ls\` probe reports.
- \`languageProbes\` (string[], filtered to the fixed whitelist \`["python3","gcc","g++","node","java","rustc","go"]\`) — which language/toolchain probes to run.

Emit this file ONLY if a diagnosed root cause is missing/incorrect ENVIRONMENT CONTEXT (the agent lacked info the env snapshot should have surfaced); otherwise omit it.

\`\`\`bash
cat > "${relEnvPolicy}" << 'ENDOFENVPOLICY'
{"schemaVersion":1,"probes":{"ls":true,"lang":true,"pkg":false,"mem":false},"lsPath":"/app","maxLsEntries":25,"languageProbes":["python3","node"]}
ENDOFENVPOLICY
\`\`\`
`
      })()
    : ""

  const step2 = playbook
    ? `STEP 2 — Edit the playbook. From the diagnosis, choose the SMALLEST set of edits (≤3) that would prevent the diagnosed root cause: \`add\` a new bullet, \`update\` an existing bullet by id, or \`delete\` (prune) a bullet that the trajectories show is unhelpful or harmful. Do not duplicate a rule already covered by a more-general layer. Bullets are SHORT behavioral rules (one sentence).`
    : `STEP 2 — Propose. From the diagnosis, identify the SINGLE most impactful behavioral gap in system.md — a rule that would prevent the diagnosed root cause, is not already covered by more-general layers, and is not a root cause already diagnosed for ${activeVer}. Both artifacts SHORT and behavioral: system.md under 20 lines, tools.md under 15.`

  const diagShape = playbook
    ? `{"failures":[{"sessionID":"<id>","taxonomy":"<one label>","rootCause":"<2-5 sentences>","firstUnrecoverableStep":"<quote>"}],"bulletAssessments":[{"id":"<bullet id followed-and-helped or followed-and-hurt>","verdict":"helpful"|"harmful"}]}`
    : `{"failures":[{"sessionID":"<id from a trajectory above>","taxonomy":"<one label from the list>","rootCause":"<2-5 sentences>","firstUnrecoverableStep":"<quote the offending event>"}]}`

  const writeMain = playbook
    ? `**Required** — write your playbook edits (≤3 ops; each new/updated bullet should reflect a diagnosed root cause):
\`\`\`bash
cat > "${relOps}" << 'ENDOFOPS'
{"ops":[{"op":"add","text":"<new behavioral rule>"},{"op":"update","id":"b2","text":"<revised rule>"},{"op":"delete","id":"b5"}]}
ENDOFOPS
\`\`\``
    : `**Required** — write the improved system.md (each new rule should cite the diagnosis it addresses):
\`\`\`bash
cat > "${relSystem}" << 'ENDOFSYSTEM'
<your improved ${layer.scope} system prompt — short behavioral rules only>
ENDOFSYSTEM
\`\`\``

  return `# Meta-Harness Proposer — ${layer.scope}

${guidance}

${coveredSection}${currentSystemSection}

${currentToolsSection}

## Prior session scores and traces for this layer

${context || "(no sessions scored yet — write a sensible baseline for this scope)"}

${storeAccessSection}

${failingSection}

${priorSection}## Your task — DIAGNOSE, then edit

STEP 1 — Diagnose the failures. For each failing trajectory above (up to 3), find the FIRST unrecoverable step and the root cause. Classify each with exactly ONE taxonomy label from:
${FAILURE_TAXONOMY.map((t) => `  - ${t}`).join("\n")}
${playbook ? "Also note which existing bullets the failing runs followed-and-helped or followed-and-hurt (bulletAssessments)." : ""}

${step2}
No project docs / task-specific knowledge / AGENTS.md content.

## Write the results

**Required FIRST** — write your diagnosis (drives the next generation's memory):
\`\`\`bash
mkdir -p "${stagingDir}"
cat > "${relDiag}" << 'ENDOFDIAG'
${diagShape}
ENDOFDIAG
\`\`\`

${writeMain}

**Optional** — write tools.md only if tool patterns were identified:
\`\`\`bash
cat > "${relTools}" << 'ENDOFTOOLS'
<per-tool guidance keyed by tool name — only include tools with clear patterns>
ENDOFTOOLS
\`\`\`
${agentConfigSection}${envPolicySection}
After writing the files, briefly explain which diagnosed root cause each edit addresses.`
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

// ── Curator (Phase 3 — ACE anti-bloat) ──────────────────────────────────────

/** Max active bullets per layer before the curator is suggested. */
export const CURATOR_BUDGET = 25

/**
 * Consolidate a layer's playbook: merge near-duplicates, prune net-harmful/obsolete
 * bullets, enforce the budget. The output is a candidate that goes through the SAME
 * gate as a proposal (project → trial; account → inactive pending ab).
 */
export async function triggerCurate(
  client: Client,
  worktree: string,
  layer: StoreLayer,
): Promise<void> {
  if (inFlight.has(layer.root)) {
    await client.app.log({ body: { service: "meta-harness", level: "info",
      message: `curate skipped: ${layer.scope} already has a session in flight` } })
    return
  }
  const isProject = layer.scope === "project-global" || layer.scope === "project-role"
  if (isProject && readTrial(layer.root) !== null) {
    await client.tui.showToast({ body: { title: "Meta-Harness",
      message: `Trial in progress for ${layer.scope} — skipping curate`, variant: "info", duration: 5_000 } })
    return
  }
  const playbook = seedPlaybook(layer.root)   // seed from system.md if first use
  const activeBullets = playbook?.bullets.filter((b) => b.status === "active") ?? []
  if (!playbook || activeBullets.length === 0) {
    await client.tui.showToast({ body: { title: "Meta-Harness",
      message: `No playbook to curate for ${layer.scope} (empty layer)`, variant: "warning", duration: 6_000 } })
    return
  }

  inFlight.add(layer.root)
  try {
    const version = nextVersion(layer.root)
    const stagingBase = path.join(worktree, ".meta-harness", "staging")
    const stagingOps = path.join(stagingBase, `curate-${layer.scope}-${version}-ops.json`)
    const prompt = buildCuratePrompt(layer, playbook, stagingOps, worktree)
    const cfg = readMhConfig()
    const proposerModel = parseModelSpec(cfg.proposerModel)

    await client.app.log({ body: { service: "meta-harness", level: "info",
      message: `Starting curator ${layer.scope} → ${version} (${activeBullets.length} bullets, model=${cfg.proposerModel})` } })
    await client.tui.showToast({ body: { title: "Meta-Harness",
      message: `Curating ${layer.scope} ${version}…`, variant: "info", duration: 5_000 } })

    const sessionRes = await client.session.create({ body: { title: `[meta-harness] curate ${layer.scope} ${version}` } })
    const sessionID = sessionRes.data?.id
    if (!sessionID) {
      await client.app.log({ body: { service: "meta-harness", level: "error", message: "Failed to create curator session" } })
      return
    }
    proposerSessions.add(sessionID)
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: prompt }], ...(proposerModel ? { model: proposerModel } : {}) },
    })

    const found = await waitForFile(stagingOps, cfg.proposerTimeoutMin * 60 * 1000)
    proposerSessions.delete(sessionID)
    if (!found) {
      await client.tui.showToast({ body: { title: "Meta-Harness",
        message: `Curator timed out for ${layer.scope} — nothing changed`, variant: "warning", duration: 5_000 } })
      return
    }

    let ops: PlaybookOp[] = []
    try {
      const parsed = JSON.parse(fs.readFileSync(stagingOps, "utf-8"))
      if (Array.isArray(parsed?.ops)) ops = parsed.ops
    } catch { /* malformed → no-op curation */ }
    fs.rmSync(stagingOps, { force: true })

    const newPlaybook = applyPlaybookOps(playbook, ops)
    const system = renderPlaybook(newPlaybook)
    const tools = readActiveTools(layer.root)
    // Curation only ever edits the playbook — it never stages its own
    // agent-config/env-policy, so the active knob must be carried forward
    // unconditionally here (read BEFORE startTrial below overwrites active).
    const agentConfig = readAgentConfig(layer.root)
    const envPolicy = readEnvPolicy(layer.root)
    createCandidate(layer.root, version, system, tools, newPlaybook, agentConfig ?? undefined, envPolicy ?? undefined)
    appendMetaMetric(layer.root, { event: "curate", candidate: version, scope: layer.scope })
    writeCandidateMeta(layer.root, version, {
      proposerModel: cfg.proposerModel, scope: layer.scope, kind: "curate",
      createdAt: new Date().toISOString(),
    })

    if (isProject) {
      const baseline = activeVersion(layer.root)
      startTrial(layer.root, version, system, tools, TRIAL_MIN_SESSIONS, newPlaybook, agentConfig, envPolicy)
      await client.tui.showToast({ body: { title: "Meta-Harness",
        message: `Curation trial: ${layer.scope} ${version} (baseline ${baseline}) — resolves after ${TRIAL_MIN_SESSIONS} scored sessions`,
        variant: "info", duration: 8_000 } })
    } else {
      await client.tui.showToast({ body: { title: "Meta-Harness",
        message: `Curation candidate ${version} for ${layer.scope} — validate with runner.py ab, then /mh-activate`,
        variant: "info", duration: 10_000 } })
    }
  } finally {
    inFlight.delete(layer.root)
  }
}

export function buildCuratePrompt(layer: StoreLayer, playbook: Playbook, stagingOps: string, worktree: string): string {
  const active = playbook.bullets.filter((b) => b.status === "active")
  const relOps = path.relative(worktree, stagingOps)
  const stagingDir = path.relative(worktree, path.dirname(stagingOps))
  return `# Meta-Harness Curator — ${layer.scope}

You maintain the ${layer.scope} playbook: short behavioral rules. It has ${active.length} active bullets (budget: ${CURATOR_BUDGET}). Each carries helpful/harmful counters accumulated from real sessions.

## Current playbook

\`\`\`json
${JSON.stringify(active, null, 2)}
\`\`\`

${buildStoreAccessSection(layer)}

Use the archive as evidence for merge/prune decisions: a bullet's helpful/harmful
counters summarize sessions whose full trajectories are on disk — when a prune is
borderline, read the traces before deciding.

## Your task — consolidate, do NOT invent

Emit edit ops (add is NOT allowed — curation only merges and prunes):
1. MERGE near-duplicate or overlapping bullets — \`update\` one to the merged wording, \`delete\` the others.
2. PRUNE net-harmful bullets (harmful > helpful AND harmful ≥ 2) and clearly obsolete ones.
3. Keep the total ≤ ${CURATOR_BUDGET} active bullets. If still over budget, \`delete\` the lowest-value bullets (lowest helpful − harmful).
Preserve every high-value rule. If nothing needs changing, emit an empty ops list.

## Write the results

\`\`\`bash
mkdir -p "${stagingDir}"
cat > "${relOps}" << 'ENDOFOPS'
{"ops":[{"op":"update","id":"b2","text":"<merged rule>"},{"op":"delete","id":"b7"}]}
ENDOFOPS
\`\`\`

After writing, briefly explain what you merged and pruned and why.`
}

// ── Helpers ────────────────────────────────────────────────────────────────

export async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const interval = 5_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
