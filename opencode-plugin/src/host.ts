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
 * interface EvolutionEngine (engine.ts) depends on.
 */

import type { StoreLayer } from "./harness-store.ts"

export interface ScoreResult {
  passed: boolean
  note: string
}

/**
 * A fully-serializable description of an in-flight proposer/promoter/curator
 * cycle — enough to apply its staged artifact from a DIFFERENT process than the
 * one that spawned it (Task L8, Claude Code). On opencode the spawn + apply run
 * in one long-lived process and this is passed in-memory to applyStagedArtifact;
 * on Claude Code it is written to a lock file at spawn time and re-read on a
 * later hook event (short-lived hook processes can't poll for the artifact).
 *
 * Everything here is JSON-round-trippable: StoreLayer is `{root, scope,
 * higherRoots}` (all strings), and the staging paths are re-derived from
 * `{worktree, kind, layer.scope, version}` rather than stored, so the descriptor
 * stays small and canonical.
 */
export interface StagedArtifactDescriptor {
  kind: "propose" | "promote" | "curate"
  worktree: string
  version: string
  /** propose/curate: the target layer. promote: the TARGET (account) layer. */
  layer: StoreLayer
  /** promote only: the source (project) layer being generalized upward. */
  source?: StoreLayer
  /** propose/curate: was the layer in playbook (ops) mode at spawn time. */
  playbookMode: boolean
  /** Captured at spawn (config may change before apply) — recorded in meta.json. */
  proposerModel: string
  proposerVariant: string
  /** The child session id (from runTaskAgent). */
  sessionId: string
  /** Epoch ms the child was spawned — drives stale-lock expiry. */
  spawnedAt: number
  /** Give-up horizon (ms). Mirrors opencode's waitForFile timeout so a crashed
   * child's lock can't wedge the layer forever. */
  timeoutMs: number
  /** Spawning process pid (diagnostic only; expiry is timestamp-based). */
  pid: number
}

export interface HarnessHost {
  readonly platform: string // "opencode"
  readonly projectRoot: string // worktree

  log(level: "debug" | "info" | "warn" | "error", msg: string): Promise<void> | void
  /**
   * Show a user-facing notification. `title` defaults to "Meta-Harness"; pass
   * `null` to omit the title entirely (some notifications embed the branding in
   * the message instead and must render title-less).
   */
  notify(
    msg: string,
    variant?: "info" | "success" | "warning" | "error",
    durationMs?: number,
    title?: string | null,
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
   * dispatch, which stayed a hook-plumbing concern in index.ts/engine.ts
   * (EvolutionEngine.handleCommand) rather than moving onto this host
   * interface. Least churn + identical behavior: only the
   * toast/clearPrompt/appendPrompt block moves behind the host; the Map, the
   * Promise, and the timeout all stay exactly where they were.
   */
  showScorePrompt(text: string, isJudgeSuggestion: boolean): Promise<void>

  /**
   * Score-inversion seam (Task L6 — Claude Code adapter).
   *
   * OPTIONAL. The opencode flow is idle-THEN-wait-for-score: sessionIdle shows
   * the prompt (showScorePrompt) and blocks on a pending Promise that a LATER
   * command-intercept resolves. Claude Code inverts this to score-THEN-run-idle:
   * hooks are short-lived processes, so the /mh-score UserPromptSubmit hook first
   * stores the human verdict, then invokes sessionIdle IN-PROCESS. There is no
   * separate process to hold a pending Promise, so promptHumanScore must be able
   * to obtain the already-known verdict synchronously instead of prompting.
   *
   * Contract: return a ScoreResult when a verdict has been pre-staged for this
   * session (promptHumanScore then returns it immediately, WITHOUT calling
   * showScorePrompt or arming the pending-Promise/timeout machinery); return
   * undefined when none is staged (promptHumanScore falls through to the normal
   * opencode prompt-and-wait path). A host that never pre-stages (OpencodeHost)
   * simply does not implement this method — behavior is then byte-identical to
   * before this seam existed.
   */
  takePendingScore?(sessionID: string): ScoreResult | undefined

  /**
   * Judge transport: text-in/text-out, ALL tools denied, system prompt
   * REPLACED. opencode impl: session.create + judgeSessions marking (BEFORE
   * the prompt, so the system.transform hook fires the replacement) +
   * session.prompt + read the inline reply from the assistant message parts.
   *
   * `system` is accepted for interface generality (a future host may inject
   * it directly per-call); OpencodeHost does not consume it — opencode's
   * replacement mechanism is keyed off session-id Set membership consulted
   * by the system.transform hook (kept in index.ts by design — see that
   * file's header), not a value passed per-call.
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
   *
   * `system` / `stagingPaths` / `timeoutMs` (daemon carrier migration T3) are
   * OPTIONAL and platform-specific: Claude Code's daemon-worker transport
   * (runClaudeCodeTaskAgent) requires all three to actually spawn — a caller
   * that omits them gets null + a warn log. `stagingPaths` is typed `unknown`
   * here (like `model`) to keep this interface free of Claude-Code-specific
   * types (daemon-seat.ts's WorkerStagingPaths); ClaudeCodeHost narrows it at
   * its own boundary. OpencodeHost does not consume any of the three.
   */
  runTaskAgent(opts: {
    title: string
    prompt: string
    model?: unknown
    system?: string
    stagingPaths?: unknown
    timeoutMs?: number
  }): Promise<{ id: string } | null>

  /**
   * Apply-on-next-event seam (Task L8 — Claude Code).
   *
   * OPTIONAL. When a host implements this, trigger{Propose,Promote,Curate}
   * spawn the detached child, hand the descriptor here, and RETURN immediately
   * WITHOUT polling waitForFile — the host persists the descriptor (a lock file)
   * and applies the staged artifact on a later hook event via applyStagedArtifact.
   * A host that does NOT implement it (OpencodeHost) keeps the original inline
   * waitForFile-then-apply path — behavior byte-identical to before this seam.
   *
   * F6 — pairing requirement: hosts implementing stageArtifactApply MUST also
   * implement proposerInFlight (the in-memory inFlight Set alone cannot guard
   * across short-lived processes).
   */
  stageArtifactApply?(descriptor: StagedArtifactDescriptor): void

  /**
   * Cross-process in-flight guard (Task L8 — Claude Code). OPTIONAL. Returns
   * true when a live (non-stale) proposer/promoter/curator lock already exists
   * for `root`, so trigger* can skip a double-fire even though its in-memory
   * `inFlight` Set is empty in a fresh hook process. Absent on opencode (whose
   * in-memory Set suffices) → guard is a no-op there.
   */
  proposerInFlight?(root: string): boolean

  /** env-snapshot's bootstrap-probe shell-out. */
  exec(cmd: string, timeoutMs?: number): Promise<{ stdout: string; exitCode: number }>
}
