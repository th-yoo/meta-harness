/**
 * propose.ts
 *
 * Meta-Harness proposer loop — triggered after SESSIONS_BEFORE_PROPOSE
 * scored sessions accumulate on the current candidate.
 *
 * What it does:
 *   1. Builds the proposer context: all candidates with scores + trace excerpts
 *   2. Creates a child OpenCode session
 *   3. Sends the proposer prompt — the agent reads the filesystem via bash
 *      and writes a new system.md to .meta-harness/candidates/<nextVersion>/
 *   4. Waits for the file to appear, then activates it
 *
 * The proposer prompt deliberately tells the agent to write files via bash
 * (cat > file << 'EOF') so we don't need any custom tool — the existing
 * bash tool is sufficient.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import {
  buildProposerContext,
  createCandidate,
  nextVersion,
  writeActive,
  candidatePath,
} from "./harness-store.ts"

type Client = PluginInput["client"]

/** How many scored sessions before triggering a proposal. */
export const SESSIONS_BEFORE_PROPOSE = 5

/**
 * Trigger a proposer session and activate the result if successful.
 * Resolves when the new candidate is activated (or skipped on failure).
 */
export async function triggerPropose(
  client: Client,
  worktree: string,
): Promise<void> {
  const version = nextVersion(worktree)
  const context = buildProposerContext(worktree)
  const prompt = buildProposerPrompt(worktree, version, context)

  await client.app.log({
    body: {
      service: "meta-harness",
      level: "info",
      message: `Starting proposer session for ${version}`,
    },
  })

  await client.tui.showToast({
    body: {
      title: "Meta-Harness",
      message: `Proposing harness ${version}…`,
      variant: "info",
      duration: 5_000,
    },
  })

  // Create a child session for the proposer
  const sessionRes = await client.session.create({
    body: { title: `[meta-harness] propose ${version}` },
  })

  const sessionID = sessionRes.data?.id
  if (!sessionID) {
    await client.app.log({
      body: { service: "meta-harness", level: "error", message: "Failed to create proposer session" },
    })
    return
  }

  // Send the prompt — proposer will use bash to write files
  await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: prompt }] },
  })

  // Poll for the new system.md (proposer writes it via bash)
  const targetFile = candidatePath(worktree, version, "system.md")
  const activated = await waitForFile(targetFile, 10 * 60 * 1000)

  if (activated) {
    // Read the file the proposer wrote and register it properly
    const system = fs.readFileSync(targetFile, "utf-8").trim()
    createCandidate(worktree, version, system)   // ensures score.json exists
    writeActive(worktree, version, system)

    await client.tui.showToast({
      body: {
        title: "Meta-Harness",
        message: `Activated harness ${version}`,
        variant: "success",
        duration: 8_000,
      },
    })

    await client.app.log({
      body: {
        service: "meta-harness",
        level: "info",
        message: `Activated harness ${version}`,
      },
    })
  } else {
    await client.tui.showToast({
      body: {
        title: "Meta-Harness",
        message: `Proposer timed out — staying on current harness`,
        variant: "warning",
        duration: 5_000,
      },
    })
  }
}

// ── Proposer prompt ────────────────────────────────────────────────────────

function buildProposerPrompt(
  worktree: string,
  version: string,
  context: string,
): string {
  const targetDir = path.join(worktree, ".meta-harness", "candidates", version)

  return `\
# Meta-Harness Proposer

You are optimizing the **system prompt** for an AI coding assistant.

A system prompt is a SHORT set of behavioral instructions (under 20 lines) injected before every conversation. It tells the assistant HOW to behave — not what the project is.

## CRITICAL: What you must write

You must write a SHORT BEHAVIORAL SYSTEM PROMPT — like this example:

\`\`\`
You are an AI coding assistant.
- Read existing code before writing new code.
- Run tests after making changes.
- Prefer editing existing files over creating new ones.
- Do not leave placeholder comments or TODOs in output.
\`\`\`

Do NOT write project documentation. Do NOT copy AGENTS.md or README content.
Do NOT describe what the project does. ONLY write behavioral instructions.

## Prior session scores and traces

${context}

## Your task

1. Look at sessions rated **bad** — what went wrong?
2. Look at sessions rated **good** — what worked?
3. Write ONE new behavioral rule that addresses the most common failure.
4. If all sessions passed (no bad ratings), keep the current prompt and add one small improvement.

## Write the file NOW

Run this exact bash command to write the new system prompt:

\`\`\`bash
mkdir -p "${targetDir}"
cat > "${targetDir}/system.md" << 'ENDOFPROMPT'
You are an AI coding assistant.
- Read existing code before writing new code.
- Run tests after making changes.
- Prefer editing existing files over creating new ones.
- Do not leave placeholder comments or TODOs in output.
ENDOFPROMPT
\`\`\`

Replace the lines between ENDOFPROMPT markers with your improved behavioral instructions.
Keep it under 20 lines. Write ONLY behavioral rules, nothing else.`
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Poll for a file to appear, with timeout. Returns true if found. */
async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const interval = 5_000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true
    await new Promise((r) => setTimeout(r, interval))
  }

  return false
}
