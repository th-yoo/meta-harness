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
  const stagingPath = path.join(
    worktree,
    ".meta-harness",
    "staging",
    `${layer.scope}-${version}.md`,
  )
  const context = buildProposerContext(layer.root, layer.higherRoots)
  const prompt = buildProposerPrompt(layer, version, context, stagingPath, worktree)

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

  // Poll for the staging file the proposer writes
  const found = await waitForFile(stagingPath, 10 * 60 * 1000)

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

  // Relocate staging file into the target store (works for account stores too)
  const system = fs.readFileSync(stagingPath, "utf-8").trim()
  fs.rmSync(stagingPath, { force: true })

  createCandidate(layer.root, version, system)
  writeActive(layer.root, version, system)

  await client.tui.showToast({
    body: {
      title: "Meta-Harness",
      message: `Activated ${layer.scope} ${version}`,
      variant: "success",
      duration: 8_000,
    },
  })

  await client.app.log({
    body: {
      service: "meta-harness",
      level: "info",
      message: `Activated ${layer.scope} ${version}`,
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
  stagingPath: string,
  worktree: string,
): string {
  const guidance = SCOPE_GUIDANCE[layer.scope]
  const currentSystem = readActiveSystem(layer.root)

  // Read "already covered" text for display in prompt
  const coveredTexts = layer.higherRoots
    .map((r) => readActiveSystem(r))
    .filter(Boolean)

  const coveredSection = coveredTexts.length > 0
    ? `## Already covered by more-general layers — DO NOT REPEAT\n\n${coveredTexts.join("\n\n---\n\n")}\n\n`
    : ""

  const currentSection = currentSystem
    ? `## Current ${layer.scope} prompt (refine this — do not discard good rules)\n\n\`\`\`\n${currentSystem}\n\`\`\`\n\n`
    : `## Current ${layer.scope} prompt\n\n(empty — write a new one from scratch)\n\n`

  // Use relative path for staging so bash command works in worktree
  const relStaging = path.relative(worktree, stagingPath)

  return `# Meta-Harness Proposer — ${layer.scope}

${guidance}

${coveredSection}${currentSection}## Prior session scores and traces for this layer

${context || "(no sessions scored yet — write a sensible baseline for this scope)"}

## Your task

1. Analyze the traces above. What patterns appear in FAIL sessions? What in PASS sessions?
2. Identify the ONE most impactful gap: a rule that would fix the most failures and is NOT
   already covered by the more-general layers above.
3. If all sessions passed (no failures), make one small improvement to the current prompt.
4. Write the improved system prompt — SHORT behavioral rules only, under 20 lines.
   Do NOT write project documentation, AGENTS.md content, or task-specific knowledge.
   Only write behavioral instructions (what the agent should DO and HOW).

## Write the result

Run this bash command to write the improved prompt to the staging file:

\`\`\`bash
mkdir -p "${path.dirname(relStaging)}"
cat > "${relStaging}" << 'ENDOFPROMPT'
<your improved ${layer.scope} system prompt here — short behavioral rules only>
ENDOFPROMPT
\`\`\`

After writing the file, briefly explain what you changed and why, citing specific traces.`
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
