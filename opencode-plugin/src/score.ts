/**
 * score.ts
 *
 * Human scoring via the TUI control API.
 *
 * Flow:
 *   1. session.idle fires in index.ts
 *   2. Plugin shows a toast: "Rate this session — type /mh-score good|bad [note]"
 *   3. Human types the slash command
 *   4. command.execute.before hook intercepts it, resolves the pending Promise
 *   5. Caller receives { passed, note }
 *
 * Why slash command instead of tui/control/next?
 *   tui/control/next is a pull-based API (server sends a JSON request, TUI
 *   shows it and returns the human's response). It works well for structured
 *   prompts but requires the TUI to implement the control/next flow.
 *   A slash command is simpler and works with the existing command.execute.before
 *   hook — no TUI-side changes needed.
 */

import type { PluginInput } from "@opencode-ai/plugin"

export interface ScoreResult {
  passed: boolean
  note: string
}

type Client = PluginInput["client"]

// One pending resolver per session. At most one session is scored at a time
// in practice, but we key by sessionID to be safe.
const pending = new Map<string, (result: ScoreResult) => void>()

/**
 * Show a scoring prompt in the TUI and wait for the human to respond.
 *
 * The returned Promise resolves when the human runs:
 *   /mh-score good [optional note]
 *   /mh-score bad [optional note]
 *
 * Times out after `timeoutMs` (default 5 min) and returns null if the human
 * doesn't score the session.
 */
const DEFAULT_PREFILL = "/mh-score good"

export async function promptHumanScore(
  client: Client,
  sessionID: string,
  timeoutMs = 5 * 60 * 1000,
  prefill?: string,
): Promise<ScoreResult | null> {
  const text = prefill ?? DEFAULT_PREFILL
  const isJudgeSuggestion = prefill !== undefined && prefill !== DEFAULT_PREFILL

  await client.tui.showToast({
    body: {
      title: "Meta-Harness: rate this session",
      message: isJudgeSuggestion
        ? "Type /mh-score good  or  /mh-score bad (judge suggestion — edit if wrong)"
        : "Type /mh-score good  or  /mh-score bad",
      variant: "info",
      duration: 30_000,
    },
  })

  // Clear any existing text then pre-fill the command
  await client.tui.clearPrompt()
  await client.tui.appendPrompt({
    body: { text },
  })

  return new Promise<ScoreResult | null>((resolve) => {
    pending.set(sessionID, resolve)

    // Timeout: resolve with null so the caller can skip this session
    setTimeout(() => {
      if (pending.has(sessionID)) {
        pending.delete(sessionID)
        resolve(null)
      }
    }, timeoutMs)
  })
}

/**
 * Called from the command.execute.before hook in index.ts.
 *
 * Parses "/mh-score good|bad [note...]" and resolves the pending Promise
 * for the given session. Returns true if the command was consumed.
 */
export function handleScoreCommand(
  command: string,
  args: string,
  sessionID: string,
): boolean {
  if (command !== "mh-score") return false

  const parts = args.trim().split(/\s+/)
  const raw = parts[0]?.toLowerCase()
  const note = parts.slice(1).join(" ")

  // Accept: good/1/yes/y/ok/pass → passed
  //         bad/0/no/n/fail      → failed
  const PASS = new Set(["good", "1", "yes", "y", "ok", "pass"])
  const FAIL = new Set(["bad", "0", "no", "n", "fail"])

  const verdict = PASS.has(raw ?? "") ? "good" : FAIL.has(raw ?? "") ? "bad" : null
  if (verdict === null) return false

  const resolve = pending.get(sessionID)
  if (resolve) {
    pending.delete(sessionID)
    resolve({ passed: verdict === "good", note })
  }

  return true
}
