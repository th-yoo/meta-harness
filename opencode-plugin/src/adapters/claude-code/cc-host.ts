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
 *   - runTextAgent → the judge transport (Task L7): a one-shot `claude -p`
 *                child process with the system prompt FULLY REPLACED
 *                (--system-prompt) and every tool denied (--disallowedTools),
 *                spawned in a scratch cwd OUTSIDE the project so the
 *                project's own .claude/settings.json hooks (which are
 *                cwd/project-scoped) can never fire for the judge — a judge
 *                session must not record itself. See runClaudeCodeTextAgent
 *                below for the full contract (model-strip / timeout / JSON
 *                parse / never-throw).
 *   - runTaskAgent → NOT implemented in Phase A (proposer = L8). Logs a clear
 *                notice and returns null — the documented "failed to create
 *                session" sentinel that propose.ts already degrades on
 *                gracefully (log-and-skip), so an auto-propose trigger can
 *                never crash a scoring hook. See the report's score-inversion
 *                / degradation section for why null-return (not throw) is
 *                used: the engine fires these fire-and-forget via
 *                `void trigger*(...)` with no catch, so a throw would become
 *                an unhandled rejection and risk the adapter's exit-0 prime
 *                directive.
 *   - exec     → Bun.spawn bash -c (env-snapshot's bootstrap probes).
 */

import fs from "node:fs"
import path from "node:path"
import type { HarnessHost, ScoreResult } from "../../host.ts"
import { ccRuntimeDir } from "./file-state.ts"

// Minimal module-scoped Bun ambient (this project has no `bun-types` dep — see
// bench/exec.ts for the same pattern). Covers both exec()'s bash -c calls and
// runClaudeCodeTextAgent's `claude -p` child — same opts shape (stdout piped,
// stderr/stdin ignored, cwd optional) suffices for both.
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

// ── judge transport (Task L7) ────────────────────────────────────────────

/** The live-verified (claude 2.1.207) child-process handle shape — a subset
 * of Bun.spawn's return value. Kept as its own named type (rather than reused
 * inline) so `CCSpawnFn` reads as a real seam, not an implementation detail. */
export interface CCChildProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | string): void
}

/** Injectable spawn seam (mirrors bench/retry-provider.ts's SpawnFn /
 * bench/record.ts's SpawnFn convention) — tests supply a fake to assert argv
 * and to simulate hangs (timeout-kill) / crashes without ever touching a real
 * `claude` binary. `opts.stdin` is always "ignore" (VERIFIED: `claude -p`
 * without `< /dev/null` prints a 3s "no stdin data received" warning that
 * pollutes captured stdout) — passed explicitly so it's part of the
 * assertable contract, not just baked into the default impl. */
export type CCSpawnFn = (
  argv: string[],
  opts: { cwd: string; stdin: "ignore" },
) => CCChildProcess

function defaultCCSpawn(argv: string[], opts: { cwd: string; stdin: "ignore" }): CCChildProcess {
  return Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
}

/** VERIFIED (claude 2.1.207 probe): denying this exact list yields a
 * text-only reply — no tool_use, no permission prompt. Byte-identical intent
 * to opencode-host.ts's ALL_TOOLS_DENIED (CC's tool names differ from
 * opencode's, hence a separate list rather than a shared constant). */
const DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "Task", "WebFetch", "WebSearch", "NotebookEdit",
] as const

/** Matches opts.model's actual runtime shape: `runJudge` (judge.ts) always
 * calls `host.runTextAgent` with `model: parseModelSpec(cfg.judgeModel)` —
 * an opencode-style `{providerID, modelID}` (from a "provider/model" config
 * string) or `undefined` (unset/unprefixed judgeModel). `opts.model` is typed
 * `unknown` on the HarnessHost interface for platform generality, so this is
 * a runtime type guard, not a cast. */
function isProviderModelSpec(v: unknown): v is { providerID: string; modelID: string } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { providerID?: unknown }).providerID === "string" &&
    typeof (v as { modelID?: unknown }).modelID === "string"
  )
}

/** Sensible default judge timeout — matches bench/opencode-run.ts's
 * `runJudgeOpencode` default (90s), so a CC judge call and an opencode judge
 * call are bounded the same in practice. */
const DEFAULT_JUDGE_TIMEOUT_MS = 90_000

/** claude -p's `--output-format json` result shape (VERIFIED, claude
 * 2.1.207): only the fields this transport reads are declared. */
interface ClaudeJsonResult {
  result?: unknown
  is_error?: unknown
  total_cost_usd?: unknown
}

/**
 * The judge transport itself: spawn a ONE-SHOT `claude -p` with the system
 * prompt fully replaced and every tool denied, in a scratch cwd OUTSIDE the
 * project (so the project's own mh hooks — which are cwd/.claude-scoped —
 * can never fire; a judge session recording itself would be a feedback
 * loop), parse `--output-format json` stdout, and return the reply text.
 *
 * Free function (not a private class method) so tests can inject `spawnFn`
 * directly without reaching into ClaudeCodeHost internals — `log` is passed
 * in rather than closed over so the SAME function backs
 * `ClaudeCodeHost.runTextAgent` (which forwards to `this.log`) with zero
 * duplication.
 *
 * Contract (matches OpencodeHost.runTextAgent — judge.ts/engine.ts consume
 * both identically): NEVER throws; returns the reply string on success, or
 * null on ANY failure (non-anthropic judgeModel, spawn error, timeout,
 * non-zero exit, `is_error`, unparseable JSON, missing `result`). A null
 * return is judge.ts's own "no verdict" sentinel — scoring itself is
 * unaffected.
 */
export async function runClaudeCodeTextAgent(
  opts: {
    title: string
    system: string
    prompt: string
    model?: unknown
    timeoutMs?: number
  },
  log: (level: LogLevel, msg: string) => void,
  spawnFn: CCSpawnFn = defaultCCSpawn,
): Promise<string | null> {
  try {
    // ── model resolution: CC only speaks anthropic models ──────────────────
    let modelId: string | undefined
    if (opts.model !== undefined) {
      if (!isProviderModelSpec(opts.model)) {
        log("warn", `[cc-host] runTextAgent: unrecognized model spec ${JSON.stringify(opts.model)} — ignoring, letting claude use its default model`)
      } else if (opts.model.providerID !== "anthropic") {
        log(
          "warn",
          `[cc-host] runTextAgent: judgeModel provider "${opts.model.providerID}" is not "anthropic" — ` +
            `Claude Code's judge transport is a native \`claude -p\` process and can ONLY use anthropic models. ` +
            `Set config.json's judgeModel to an "anthropic/<model>" slug (e.g. "anthropic/claude-sonnet-4-5") to enable the CC judge. Skipping this judge call.`,
        )
        return null
      } else {
        modelId = opts.model.modelID
      }
    }

    // ── isolation: scratch cwd OUTSIDE the project ──────────────────────────
    const scratchRoot = path.join(ccRuntimeDir(), "judge")
    fs.mkdirSync(scratchRoot, { recursive: true })
    const scratchCwd = fs.mkdtempSync(path.join(scratchRoot, "j-"))

    try {
      const argv = [
        "claude", "-p", opts.prompt,
        "--system-prompt", opts.system,
        "--output-format", "json",
        ...(modelId ? ["--model", modelId] : []),
        "--disallowedTools", ...DISALLOWED_TOOLS,
      ]

      const timeoutMs = opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS
      const proc = spawnFn(argv, { cwd: scratchCwd, stdin: "ignore" })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try { proc.kill() } catch { /* already gone */ }
      }, timeoutMs)

      let stdout: string
      let exitCode: number
      try {
        [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      } finally {
        clearTimeout(timer)
      }

      if (timedOut) {
        log("warn", `[cc-host] runTextAgent: claude -p timed out after ${timeoutMs}ms — killed, skipping judge`)
        return null
      }
      if (exitCode !== 0) {
        log("warn", `[cc-host] runTextAgent: claude -p exited ${exitCode} — skipping judge`)
        return null
      }

      let parsed: ClaudeJsonResult
      try {
        parsed = JSON.parse(stdout) as ClaudeJsonResult
      } catch {
        log("warn", "[cc-host] runTextAgent: could not parse claude -p --output-format json stdout — skipping judge")
        return null
      }

      if (typeof parsed.total_cost_usd === "number") {
        log("debug", `[cc-host] runTextAgent: judge call cost $${parsed.total_cost_usd.toFixed(4)}`)
      }

      if (parsed.is_error) {
        log("warn", `[cc-host] runTextAgent: claude -p reported is_error — skipping judge (result: ${JSON.stringify(parsed.result)})`)
        return null
      }
      if (typeof parsed.result !== "string") {
        log("warn", "[cc-host] runTextAgent: claude -p JSON result had no string `result` field — skipping judge")
        return null
      }

      return parsed.result
    } finally {
      try { fs.rmSync(scratchCwd, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
    }
  } catch (err) {
    log("warn", `[cc-host] runTextAgent: unexpected failure — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export class ClaudeCodeHost implements HarnessHost {
  readonly platform = "claude-code"
  readonly projectRoot: string

  /** In-memory verdicts staged by the /mh-score hook for the score-inversion
   * seam. In-memory (not on disk) is correct: setPendingScore + sessionIdle run
   * in ONE hook process, so the staged verdict never needs to outlive it. */
  private readonly pendingScores = new Map<string, ScoreResult>()

  private readonly logFile: string

  /** Injectable spawn seam for the judge transport (runTextAgent) —
   * defaults to the real `claude -p` child. Tests inject a fake so the full
   * suite never touches a real `claude` binary. */
  private readonly spawnFn: CCSpawnFn

  constructor(projectRoot: string, opts: { logFile?: string; spawnFn?: CCSpawnFn } = {}) {
    this.projectRoot = projectRoot
    this.logFile = opts.logFile ?? path.join(ccRuntimeDir(), "hook.log")
    this.spawnFn = opts.spawnFn ?? defaultCCSpawn
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

  async runTextAgent(opts: {
    title: string
    system: string
    prompt: string
    model?: unknown
    timeoutMs?: number
  }): Promise<string | null> {
    return runClaudeCodeTextAgent(opts, (level, msg) => this.log(level, msg), this.spawnFn)
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
