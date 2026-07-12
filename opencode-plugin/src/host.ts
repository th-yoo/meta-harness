/**
 * host.ts
 *
 * HarnessHost — the evolution loop's OUTBOUND platform capabilities:
 * logging, notifications, the human-scoring UX, headless/agentic child
 * sessions, and shell exec. Extracted so a future host (e.g. Claude Code)
 * can implement the same surface without score.ts/judge.ts/propose.ts/
 * env-snapshot.ts ever changing.
 *
 * MUST stay free of opencode types in its signature — opencode-specific
 * types/imports live only in adapters/opencode-host.ts. This is the
 * interface the L4 EvolutionEngine extraction (index.ts) will depend on.
 */

export interface ScoreResult {
  passed: boolean
  note: string
}

export interface HarnessHost {
  readonly platform: string // "opencode"
  readonly projectRoot: string // worktree

  log(level: "debug" | "info" | "warn" | "error", msg: string): Promise<void> | void
  notify(
    msg: string,
    variant?: "info" | "success" | "warning" | "error",
    durationMs?: number,
  ): Promise<void> | void

  /**
   * Human scoring UX — the PROMPT side only: show the "rate this session"
   * toast and pre-fill the command box with the /mh-score text.
   *
   * Seam decision (see task report): the pending-Promise/timeout machinery
   * that WAITS for the human's /mh-score reply stays in score.ts, keyed by
   * sessionID. Resolution arrives asynchronously via the command.execute.before
   * hook intercept (wired in index.ts, unchanged here) — a host method can't
   * "return" through that intercept without the host also owning command
   * dispatch, which is out of scope until L4. Least churn + identical
   * behavior: only the toast/clearPrompt/appendPrompt block moves behind the
   * host; the Map, the Promise, and the timeout all stay exactly where they
   * were.
   */
  showScorePrompt(text: string, isJudgeSuggestion: boolean): Promise<void>

  /**
   * Judge transport: text-in/text-out, ALL tools denied, system prompt
   * REPLACED. opencode impl: session.create + judgeSessions marking (BEFORE
   * the prompt, so the system.transform hook fires the replacement) +
   * session.prompt + read the inline reply from the assistant message parts.
   *
   * `system` is accepted for interface generality (a future host may inject
   * it directly per-call); OpencodeHost does not consume it — opencode's
   * replacement mechanism is keyed off session-id Set membership consulted
   * by the system.transform hook (still in index.ts until L4), not a value
   * passed per-call.
   */
  runTextAgent(opts: {
    title: string
    system: string
    prompt: string
    model?: unknown
    timeoutMs?: number
  }): Promise<string | null>

  /**
   * Agentic child (proposer/promoter/curator): session.create + session.prompt,
   * fire-and-forget from the host's point of view. Artifact delivery stays
   * the staging-file + waitForFile pattern in propose.ts — this method does
   * NOT poll or wait for the artifact, and it does NOT unregister the
   * session from proposerSessions; the caller does that once waitForFile
   * settles (unchanged).
   */
  runTaskAgent(opts: {
    title: string
    prompt: string
    model?: unknown
  }): Promise<{ id: string } | null>

  /** env-snapshot's bootstrap-probe shell-out. */
  exec(cmd: string, timeoutMs?: number): Promise<{ stdout: string; exitCode: number }>
}
