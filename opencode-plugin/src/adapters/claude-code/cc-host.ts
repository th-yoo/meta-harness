/**
 * adapters/claude-code/cc-host.ts
 *
 * ClaudeCodeHost — the HarnessHost (host.ts) implementation for Claude Code.
 * Mirrors adapters/opencode-host.ts in role, but the platform is fundamentally
 * different: there is no long-lived plugin holding a live TUI client. Every hook
 * fires a fresh short-lived process, so this host has no toast channel and no
 * session RPC. Phase A subset:
 *
 *   - platform "claude-code"; projectRoot = the hook stdin `cwd`.
 *   - log      → a runtime logfile (+ stderr). Hooks' stderr lands in CC's debug
 *                log; a durable file under runtime/cc guarantees inspectability
 *                regardless of where CC routes stderr.
 *   - notify   → logged. A short-lived hook cannot pop a live toast; the single
 *                user-visible surface is the hook's own stdout (a `block` reason
 *                or a SessionStart/Stop message), emitted by the dispatcher — not
 *                by these mid-pipeline notify() calls.
 *   - showScorePrompt → logged only. In CC it is never reached on the scoring
 *                path: the score-inversion seam (takePendingScore) short-circuits
 *                promptHumanScore before it prompts.
 *   - takePendingScore / setPendingScore → the score-inversion seam. The
 *                /mh-score UserPromptSubmit hook setPendingScore(verdict) then
 *                runs sessionIdle in the SAME process; promptHumanScore consumes
 *                the staged verdict via takePendingScore and returns immediately.
 *   - runTextAgent / runTaskAgent → NOT implemented in Phase A (judge = L7,
 *                proposer = L8). They log a clear notice and return null — the
 *                documented "failed to create session" sentinel that
 *                propose.ts/judge.ts already degrade on gracefully (log-and-skip),
 *                so an auto-propose trigger can never crash a scoring hook. See
 *                the report's score-inversion / degradation section for why
 *                null-return (not throw) is used: the engine fires these
 *                fire-and-forget via `void trigger*(...)` with no catch, so a
 *                throw would become an unhandled rejection and risk the adapter's
 *                exit-0 prime directive.
 *   - exec     → Bun.spawn bash -c (env-snapshot's bootstrap probes).
 */

import fs from "node:fs"
import path from "node:path"
import type { HarnessHost, ScoreResult } from "../../host.ts"
import { ccRuntimeDir } from "./file-state.ts"

// Minimal module-scoped Bun ambient (this project has no `bun-types` dep — see
// bench/exec.ts for the same pattern). Only the slice exec() uses.
declare const Bun: {
  spawn(
    cmd: string[],
    opts: {
      cwd?: string
      stdout: "pipe"
      stderr: "ignore"
      stdin: "ignore"
    },
  ): {
    readonly stdout: ReadableStream<Uint8Array>
    readonly exited: Promise<number>
    kill(signal?: number | string): void
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export class ClaudeCodeHost implements HarnessHost {
  readonly platform = "claude-code"
  readonly projectRoot: string

  /** In-memory verdicts staged by the /mh-score hook for the score-inversion
   * seam. In-memory (not on disk) is correct: setPendingScore + sessionIdle run
   * in ONE hook process, so the staged verdict never needs to outlive it. */
  private readonly pendingScores = new Map<string, ScoreResult>()

  private readonly logFile: string

  constructor(projectRoot: string, opts: { logFile?: string } = {}) {
    this.projectRoot = projectRoot
    this.logFile = opts.logFile ?? path.join(ccRuntimeDir(), "hook.log")
  }

  log(level: LogLevel, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}`
    // stderr first (surfaces in CC's debug log), then the durable file.
    try {
      process.stderr.write(line + "\n")
    } catch {
      /* never let logging break a hook */
    }
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
      fs.appendFileSync(this.logFile, line + "\n")
    } catch {
      /* best-effort; a full/RO disk must not break a hook */
    }
  }

  notify(
    msg: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    _durationMs = 5_000,
    _title: string | null = "Meta-Harness",
  ): void {
    // No live toast channel from a short-lived hook — record it. The dispatcher
    // owns the one user-visible stdout surface per hook.
    this.log(variant === "error" ? "error" : variant === "warning" ? "warn" : "info", `[notify] ${msg}`)
  }

  async showScorePrompt(text: string, _isJudgeSuggestion: boolean): Promise<void> {
    // Unreachable on the scoring path (takePendingScore short-circuits it); kept
    // for interface completeness and logged if ever hit.
    this.log("debug", `[showScorePrompt] ${text}`)
  }

  // ── score-inversion seam ─────────────────────────────────────────────────
  setPendingScore(sessionID: string, result: ScoreResult): void {
    this.pendingScores.set(sessionID, result)
  }

  takePendingScore(sessionID: string): ScoreResult | undefined {
    const r = this.pendingScores.get(sessionID)
    if (r) this.pendingScores.delete(sessionID)
    return r
  }

  async runTextAgent(_opts: {
    title: string
    system: string
    prompt: string
    model?: unknown
    timeoutMs?: number
  }): Promise<string | null> {
    this.log("warn", "[cc-host] runTextAgent not implemented in Phase A (judge = L7) — skipping")
    return null
  }

  async runTaskAgent(_opts: {
    title: string
    prompt: string
    model?: unknown
  }): Promise<{ id: string } | null> {
    this.log("warn", "[cc-host] runTaskAgent not implemented in Phase A (proposer = L8) — auto-propose/promote/curate skipped")
    return null
  }

  async exec(cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; exitCode: number }> {
    try {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd: this.projectRoot,
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      })
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* already gone */ }
      }, timeoutMs)
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      clearTimeout(timer)
      return { stdout, exitCode: exitCode ?? 0 }
    } catch {
      return { stdout: "", exitCode: 1 }
    }
  }
}
