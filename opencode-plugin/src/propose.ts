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
  buildProposerContext,
  createCandidate,
  nextVersion,
  writeActive,
  readActiveSystem,
  readActiveTools,
  type StoreLayer,
} from "./harness-store.ts"
import { proposerSessions } from "./session-state.ts"

type Client = PluginInput["client"]

/** How many scored project-role sessions before auto-propose. */
export const PROJECT_ROLE_THRESHOLD = 5

/** How many scored project-global sessions before auto-propose. */
export const PROJECT_GLOBAL_THRESHOLD = 10

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
  const version = nextVersion(layer.root)
  const stagingBase = path.join(worktree, ".meta-harness", "staging")
  const stagingSystem = path.join(stagingBase, `${layer.scope}-${version}-system.md`)
  const stagingTools  = path.join(stagingBase, `${layer.scope}-${version}-tools.md`)

  const context = buildProposerContext(layer.root, layer.higherRoots)
  const prompt = buildProposerPrompt(layer, version, context, stagingSystem, stagingTools, worktree)

  await client.app.log({
    body: {
      service: "meta-harness",
      level: "info",
      message: `Starting proposer for ${layer.scope} → ${version}`,
    },
  })

  await client.tui.showToast({
    body: {
      title: "Meta-Harness",
      message: `Proposing ${layer.scope} ${version}…`,
      variant: "info",
      duration: 5_000,
    },
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
    body: { parts: [{ type: "text", text: prompt }] },
  })

  // Poll for the required system.md staging file (tools.md is optional)
  const found = await waitForFile(stagingSystem, 10 * 60 * 1000)

  proposerSessions.delete(sessionID)

  if (!found) {
    await client.tui.showToast({
      body: {
        title: "Meta-Harness",
        message: `Proposer timed out for ${layer.scope} — keeping current`,
        variant: "warning",
        duration: 5_000,
      },
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
  writeActive(layer.root, version, system, tools)

  const toolsNote = tools ? " + tools.md" : ""
  await client.tui.showToast({
    body: {
      title: "Meta-Harness",
      message: `Activated ${layer.scope} ${version}${toolsNote}`,
      variant: "success",
      duration: 8_000,
    },
  })

  await client.app.log({
    body: {
      service: "meta-harness",
      level: "info",
      message: `Activated ${layer.scope} ${version}${toolsNote}`,
    },
  })
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
  worktree: string,
): string {
  const guidance = SCOPE_GUIDANCE[layer.scope]
  const currentSystem = readActiveSystem(layer.root)
  const currentTools = readActiveTools(layer.root)

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

  // Relative staging paths so bash commands work in worktree
  const relSystem = path.relative(worktree, stagingSystem)
  const relTools  = path.relative(worktree, stagingTools)
  const stagingDir = path.relative(worktree, path.dirname(stagingSystem))

  return `# Meta-Harness Proposer — ${layer.scope}

${guidance}

${coveredSection}${currentSystemSection}

${currentToolsSection}

## Prior session scores and traces for this layer

${context || "(no sessions scored yet — write a sensible baseline for this scope)"}

## Your task

Analyze the traces above. Pay attention to:
- PASS vs FAIL patterns in the session outcomes
- Tool usage summaries (e.g. "bash×5(1err) read×3") — which tools were overused, misused, or produced errors?
- Notes from the human rater (these are expert engineering judgments)

Then:
1. Identify the ONE most impactful gap in **system.md** — a behavioral rule not already covered above.
2. Identify any **tool-usage patterns** worth capturing in **tools.md** — keyed by tool name.
   tools.md format:
   \`\`\`
   ## bash
   <guidance specific to bash usage at this scope>
   ## read
   <guidance specific to read tool usage>
   ## edit
   <guidance specific to edit tool usage>
   \`\`\`
   Only include a tool section if the traces reveal a meaningful pattern for it.
   If no tool patterns are apparent, skip tools.md entirely.
3. Both artifacts: SHORT and behavioral only. system.md under 20 lines. tools.md under 15 lines total.
   Do NOT write project documentation, AGENTS.md content, or task-specific knowledge.

## Write the results

**Required** — write the improved system.md:
\`\`\`bash
mkdir -p "${stagingDir}"
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

After writing the file(s), briefly explain what you changed and why, citing specific traces.`
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
