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

import type { HarnessHost, ScoreResult } from "./host.ts"

export type { ScoreResult }

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
  host: HarnessHost,
  sessionID: string,
  timeoutMs = 5 * 60 * 1000,
  prefill?: string,
): Promise<ScoreResult | null> {
  // Score-inversion seam (Task L6): if the host has a verdict pre-staged for
  // this session (Claude Code's score-then-run-idle flow), consume it and return
  // immediately — no prompt, no pending Promise. Hosts that never pre-stage
  // (OpencodeHost) don't implement takePendingScore, so this is a no-op there
  // and the original prompt-and-wait path below runs unchanged.
  const staged = host.takePendingScore?.(sessionID)
  if (staged) return staged

  const text = prefill ?? DEFAULT_PREFILL
  const isJudgeSuggestion = prefill !== undefined && prefill !== DEFAULT_PREFILL

  await host.showScorePrompt(text, isJudgeSuggestion)

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
 * Pure parse of "/mh-score good|bad [note...]" into a ScoreResult, or null when
 * the verdict token isn't recognized. Factored out (Task L6) so the Claude Code
 * adapter — which must obtain the verdict WITHOUT the in-memory pending-Promise
 * machinery (its /mh-score arrives in a fresh hook process) — can reuse the
 * exact same parsing the opencode command-intercept uses.
 *
 *   good/1/yes/y/ok/pass → passed
 *   bad/0/no/n/fail      → failed
 */
export function parseScoreArgs(args: string): ScoreResult | null {
  const parts = args.trim().split(/\s+/)
  const raw = parts[0]?.toLowerCase()
  const note = parts.slice(1).join(" ")

  const PASS = new Set(["good", "1", "yes", "y", "ok", "pass"])
  const FAIL = new Set(["bad", "0", "no", "n", "fail"])

  if (PASS.has(raw ?? "")) return { passed: true, note }
  if (FAIL.has(raw ?? "")) return { passed: false, note }
  return null
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

  const verdict = parseScoreArgs(args)
  if (verdict === null) return false

  const resolve = pending.get(sessionID)
  if (resolve) {
    pending.delete(sessionID)
    resolve(verdict)
  }

  return true
}
