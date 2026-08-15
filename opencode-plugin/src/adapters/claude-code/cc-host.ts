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
 *   - runTextAgent → the judge transport (Task L7; daemon-carried since the
 *                2026-08-14 carrier migration): ONE cc-api-daemon call with
 *                the system prompt supplied via seat isolation (toolless,
 *                no settingSources, no auto-memory — so CC's own harness,
 *                hooks, and CLAUDE.md can never contaminate or record a
 *                judge turn). See runClaudeCodeTextAgent below for the full
 *                contract (model fallback / proof / truncation / never-throw).
 *   - runTaskAgent → the proposer/promoter/curator transport (Task L8, daemon
 *                carrier migration T3): writes a WorkerArgs argsfile under
 *                ccRuntimeDir() and spawns a DETACHED `[process.execPath,
 *                proposer-worker.ts, argsFilePath]` bun worker
 *                (runClaudeCodeTaskAgent below), returning `{id}` immediately
 *                without waiting — the staged artifact is applied on a LATER
 *                hook event via a lock file (proposer.ts's apply-on-next-event
 *                scan), not polled in-process. NEVER throws: returns null on
 *                any spawn/model failure, the documented "failed to create
 *                session" sentinel that propose.ts already degrades on
 *                gracefully (log-and-skip), so an auto-propose trigger can
 *                never crash a scoring hook — the engine fires these
 *                fire-and-forget via `void trigger*(...)` with no catch, so a
 *                throw would become an unhandled rejection and risk the
 *                adapter's exit-0 prime directive.
 *   - exec     → Bun.spawn bash -c (env-snapshot's bootstrap probes).
 */

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { HarnessHost, ScoreResult, StagedArtifactDescriptor } from "../../host.ts"
import { ensureDaemon, daemonCall, closeSession, modelProvenBy } from "@th-yoo/cc-api-daemon"
import { seatIsolation, seatMaxTokens, DEFAULT_JUDGE_MODEL } from "./daemon-seat.ts"
import { ccRuntimeDir } from "./file-state.ts"
import { writeProposerLock, proposerInFlight as lockInFlight } from "./proposer.ts"
import { DEFAULT_PROPOSER_MODEL } from "../../harness-store.ts"
import type { WorkerArgs, WorkerStagingPaths } from "./daemon-seat.ts"

// Minimal module-scoped Bun ambient (this project has no `bun-types` dep — see
// bench/exec.ts for the same pattern). Covers exec()'s bash -c calls and
// runClaudeCodeTaskAgent's detached daemon-worker spawn (defaultWorkerSpawn) —
// same opts shape (stdout/stderr/stdin, cwd, env optional) suffices for both.
declare const Bun: {
  spawn(
    cmd: string[],
    opts: {
      cwd?: string
      env?: Record<string, string | undefined>
      stdout?: "pipe" | "ignore"
      stderr?: "pipe" | "ignore" | number
      stdin?: "pipe" | "ignore"
    },
  ): {
    readonly stdout: ReadableStream<Uint8Array>
    readonly exited: Promise<number>
    kill(signal?: number | string): void
    unref(): void
    ref(): void
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error"

// ── judge transport (Task L7) ────────────────────────────────────────────

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

/** Injectable daemon-client seam for the judge transport (a4-review.ts's
 * deps pattern) — tests supply fakes for `ensureDaemon`/`daemonCall`/
 * `closeSession` so the full suite never touches a real daemon. */
export type JudgeDeps = {
  call?: typeof daemonCall
  ensure?: typeof ensureDaemon
  close?: typeof closeSession
}

/**
 * The judge transport itself: ONE record through cc-api-daemon with the
 * system prompt carried in the seat isolation (toolless, no settingSources,
 * no auto-memory, session never persisted — so CC's own harness, hooks, and
 * CLAUDE.md can never fire for the judge; a judge session recording itself
 * would be a feedback loop). Session is closed in a `finally`
 * (close-not-release, a4-review.ts's convention).
 *
 * Free function (not a private class method) so tests can inject `deps`
 * directly without reaching into ClaudeCodeHost internals — `log` is passed
 * in rather than closed over so the SAME function backs
 * `ClaudeCodeHost.runTextAgent` (which forwards to `this.log`) with zero
 * duplication.
 *
 * Contract (matches OpencodeHost.runTextAgent — judge.ts/engine.ts consume
 * both identically): NEVER throws; returns the reply string on success, or
 * null on ANY failure (non-anthropic judgeModel, daemon unreachable,
 * non-`ok` outcome, unproven model, api-lane maxTokens truncation). A null
 * return is judge.ts's own "no verdict" sentinel — scoring itself is
 * unaffected.
 *
 * Model: `opts.model` undefined falls back to DEFAULT_JUDGE_MODEL — the
 * daemon hard-requires a non-empty model (no daemon-side default, unlike
 * the old CLI transport). ONE `effectiveModel` feeds both the call and
 * `seatMaxTokens` so a future api-lane (haiku) judge computes its cap off
 * the same model string; `seatMaxTokens` is `undefined` on the agent lane,
 * where the daemon hard-rejects any call carrying maxTokens.
 *
 * Timeout: `budgetMs` is passed EXPLICITLY (`opts.timeoutMs ??
 * DEFAULT_JUDGE_TIMEOUT_MS`) — no current caller sets `opts.timeoutMs`, and
 * daemonCall's own internal default is 36s (ACP_BUDGET.clientBudgetMs), so
 * omitting it would silently regress the judge timeout 90s→36s.
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
  deps: JudgeDeps = {},
): Promise<string | null> {
  const call = deps.call ?? daemonCall
  const ensure = deps.ensure ?? ensureDaemon
  const close = deps.close ?? closeSession

  const env = process.env
  let sessionIdToClose: string | undefined
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
            `Claude Code's judge transport is a daemon-carried call and can ONLY use anthropic models. ` +
            `Set config.json's judgeModel to an "anthropic/<model>" slug (e.g. "anthropic/claude-sonnet-4-5") to enable the CC judge. Skipping this judge call.`,
        )
        return null
      } else {
        modelId = opts.model.modelID
      }
    }

    const effectiveModel = modelId ?? DEFAULT_JUDGE_MODEL

    await ensure(env, { waitMs: 15_000 })

    const outcome = await call(opts.prompt, effectiveModel, env, {
      isolation: seatIsolation(opts.system, opts.title),
      maxTokens: seatMaxTokens(effectiveModel, "judge"),
      budgetMs: opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
    })

    if (outcome.kind !== "ok") {
      log("warn", `[cc-host] runTextAgent: daemon call failed (${outcome.kind}) — skipping judge`)
      return null
    }
    sessionIdToClose = outcome.sessionId

    if (!modelProvenBy(outcome.model, effectiveModel, outcome.canonicalModel)) {
      log("warn", `[cc-host] runTextAgent: reply model "${outcome.model}" does not prove requested "${effectiveModel}" — skipping judge`)
      return null
    }

    // Truncation is checked on the SPECIFIC value "max_tokens" — absence (or
    // any other value) means unknown, never "not truncated" (the agent lane
    // has no equivalent value; a4-review.ts's convention).
    if (outcome.stopReason === "max_tokens") {
      log("warn", `[cc-host] runTextAgent: reply truncated at the api-lane maxTokens cap — skipping judge`)
      return null
    }

    return outcome.text
  } catch (err) {
    log("warn", `[cc-host] runTextAgent: unexpected failure — ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    if (sessionIdToClose) {
      try {
        await close(sessionIdToClose, env)
      } catch {
        /* best effort — close-not-release, but never lets a close failure
         * override the judge outcome already decided above */
      }
    }
  }
}

// ── task transport (Task L8: proposer / promoter / curator) ───────────────

/** Sentinel that neutralizes the project's own mh hooks for a detached child
 * running IN the project worktree — CC would otherwise fire this project's
 * SessionStart/PostToolUse/Stop hooks for it, a self-referential capture
 * loop. hook-cli/dispatch see MH_CHILD and exit 0 before any engine call
 * (mechanism (d): a sentinel env var — robust regardless of which settings the
 * child loads, and purely additive). The current runTaskAgent spawn (a
 * toolless daemon worker, not a CC session) does NOT set this — see the
 * childEnv comment below — the guard stays live for any transport that DOES
 * spawn a real CC child in this worktree. See dispatch.ts / hook-cli.ts. */
export const MH_CHILD_ENV = "MH_CHILD"

/** Detached child handle — the subset of Bun.spawn's return this transport uses.
 * Only `unref()` (let the short-lived hook process exit without waiting on the
 * long-running proposer). stdout/stderr/stdin are all "ignore": nobody reads the
 * child; its artifact-delivery contract is the staging file, not stdout. */
export interface CCTaskChild {
  unref(): void
}

/** Injectable detached-spawn seam (mirrors bench/retry-provider.ts's SpawnFn /
 * bench/record.ts's SpawnFn convention) — tests supply a fake to assert
 * argv/env/cwd and to confirm unref() without ever spawning a real process.
 * Needs `env` (the daemon worker's argsfile path travels via argv, but PATH/
 * HOME/auth travel via env) and never pipes stdout. */
export type CCTaskSpawnFn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => CCTaskChild

/** Absolute path to the worker entrypoint, module-relative so it resolves
 * regardless of the spawning hook process's cwd. `path.dirname(new
 * URL(import.meta.url).pathname)`, not `import.meta.dir`: import.meta.dir is
 * Bun-only and untyped under this project's tsconfig (no bun-types dep) —
 * see bench/paths.ts / judge.ts for the same pattern. */
const PROPOSER_WORKER_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "proposer-worker.ts",
)

/** Fallback timeoutMs when a not-yet-migrated caller omits it — mirrors
 * harness-store.ts's DEFAULT_PROPOSER_TIMEOUT_MIN (20 minutes). T4
 * (triggerPropose/Promote/Curate) always supplies the real
 * cfg.proposerTimeoutMin-derived value; this only guards a caller mid-migration
 * that already passed system + stagingPaths but not timeoutMs. */
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60_000

/** Strip an "anthropic/…" config-string prefix down to the bare model id
 * daemonCall/WorkerArgs.model expects. A small local helper rather than
 * harness-store's `parseModelSpec` — DEFAULT_PROPOSER_MODEL is always a
 * well-formed "provider/model" literal, so the extra generality (and the
 * undefined-on-bare-name case) isn't needed here. */
function bareModelId(spec: string): string {
  const i = spec.indexOf("/")
  return i >= 0 ? spec.slice(i + 1) : spec
}

export function defaultWorkerSpawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): CCTaskChild {
  // NEVER a bare "bun": detached hook children under launchd have a minimal
  // PATH — this was the exact documented 4/4-day proposer outage (hook.log
  // 2026-08-02..05) when the old transport had to resolve a bare `claude`
  // argv[0] against that PATH. argv[0] here is process.execPath (the
  // already-running Bun binary, PATH-independent), so no PATH-resolution
  // step is needed at all.
  // stderr -> durable append log under ccRuntimeDir() (stderr-blindness
  // fix, 2026-08-15): the worker is DETACHED — with "ignore", every failure
  // (validation rejects, daemon outcomes, deadline exits) vanished; four
  // silent worker deaths were debugged blind in the 08-14/15 crank arc.
  // Logging must never block the spawn: any failure falls back to "ignore".
  let stderrFd: number | "ignore" = "ignore"
  try {
    const dir = path.join(ccRuntimeDir(), "worker-logs")
    fs.mkdirSync(dir, { recursive: true })
    stderrFd = fs.openSync(path.join(dir, "proposer-worker.log"), "a")
  } catch { /* fall back to ignore */ }
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: stderrFd,
    stdin: "ignore",
  })
  // The child holds its own dup of the fd; close the parent's copy so a
  // long-lived hook process never leaks descriptors across spawns.
  if (typeof stderrFd === "number") { try { fs.closeSync(stderrFd) } catch { /* already closed */ } }
  return child
}

/**
 * The proposer/promoter/curator transport: write a WorkerArgs argsfile under
 * ccRuntimeDir() and spawn a DETACHED `[process.execPath, proposer-worker.ts,
 * argsFilePath]` bun worker that runs the daemon-carried cycle (see
 * proposer-worker.ts), then return `{id}` IMMEDIATELY without waiting. The
 * hook process that called this exits seconds later; the worker keeps running
 * (unref'd). Nobody in THIS process ever polls for the artifact — the staged
 * output is applied on a LATER hook event (see proposer.ts's
 * apply-on-next-event scan). That inversion is why this is a fire-and-forget
 * detached spawn, not the judge's await-to-completion child.
 *
 * NEVER throws (exit-0 prime directive): returns null on any failure, which
 * propose.ts already degrades on (log "Failed to create ... session" +
 * return). Non-anthropic proposerModel → null with an actionable log, same as
 * the judge: the daemon worker can only run anthropic models. A caller not yet
 * migrated to pass `system`/`stagingPaths` (T4) also gets null + a warn — the
 * worker has nothing to run without them.
 */
export function runClaudeCodeTaskAgent(
  opts: {
    title: string
    prompt: string
    model?: unknown
    cwd: string
    system?: string
    stagingPaths?: WorkerStagingPaths
    timeoutMs?: number
  },
  log: (level: LogLevel, msg: string) => void,
  spawnFn: CCTaskSpawnFn = defaultWorkerSpawn,
  env: Record<string, string | undefined> = process.env,
): { id: string } | null {
  try {
    if (opts.system === undefined || opts.stagingPaths === undefined) {
      log("warn", "[cc-host] runTaskAgent: missing system/stagingPaths — cannot spawn daemon worker")
      return null
    }

    // The daemon's argsfile.model is REQUIRED (unlike the old `claude -p`
    // transport, where omitting --model let the CLI fall back to its own
    // default) — an undefined OR unrecognized model spec now falls back to
    // the bare DEFAULT_PROPOSER_MODEL id rather than being omitted. An
    // explicit non-anthropic model is still a real failure (unchanged).
    let modelId: string
    if (opts.model !== undefined) {
      if (!isProviderModelSpec(opts.model)) {
        log("warn", `[cc-host] runTaskAgent: unrecognized model spec ${JSON.stringify(opts.model)} — falling back to the default proposer model`)
        modelId = bareModelId(DEFAULT_PROPOSER_MODEL)
      } else if (opts.model.providerID !== "anthropic") {
        log(
          "warn",
          `[cc-host] runTaskAgent: proposerModel provider "${opts.model.providerID}" is not "anthropic" — ` +
            `Claude Code's proposer transport is a daemon-carried worker and can ONLY use anthropic models. ` +
            `Set config.json's proposerModel to an "anthropic/<model>" slug (e.g. "anthropic/claude-opus-4-8"). Skipping this proposer.`,
        )
        return null
      } else {
        modelId = opts.model.modelID
      }
    } else {
      modelId = bareModelId(DEFAULT_PROPOSER_MODEL)
    }

    // A known UUID up front so the returned {id} matches the argsfile's
    // artifactId (used for the pending-artifact descriptor + logging).
    const sessionId = randomUUID()

    const workerArgs: WorkerArgs = {
      kind: opts.stagingPaths.kind,
      prompt: opts.prompt,
      systemPrompt: opts.system,
      model: modelId,
      stagingPaths: opts.stagingPaths,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      spawnedAt: Date.now(),
      artifactId: sessionId,
    }

    const argsDir = path.join(ccRuntimeDir(), "proposer-args")
    fs.mkdirSync(argsDir, { recursive: true })
    const argsFilePath = path.join(argsDir, `${sessionId}.json`)
    fs.writeFileSync(argsFilePath, JSON.stringify(workerArgs))

    const argv = [process.execPath, PROPOSER_WORKER_PATH, argsFilePath]

    // Inherit the parent env (PATH/HOME/auth the worker needs). MH_CHILD_ENV
    // is intentionally NOT set: the sentinel exists to neutralize this
    // project's OWN mh hooks for a `claude -p` child running (and thus
    // triggering hooks) IN the project worktree — the daemon worker is a
    // plain toolless bun process with no CC session of its own, so there are
    // no hooks for it to self-trigger.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v

    const child = spawnFn(argv, { cwd: opts.cwd, env: childEnv })
    try { child.unref() } catch { /* not fatal — worst case the parent waits briefly */ }
    log("info", `[cc-host] runTaskAgent: spawned detached proposer worker "${opts.title}" (artifact ${sessionId}, cwd ${opts.cwd})`)
    return { id: sessionId }
  } catch (err) {
    log("warn", `[cc-host] runTaskAgent: failed to spawn detached worker — ${err instanceof Error ? err.message : String(err)}`)
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

  /** Injectable daemon-client seam for the judge transport (runTextAgent) —
   * defaults to the real cc-api-daemon client trio. Tests inject fakes so
   * the full suite never touches a real daemon. */
  private readonly judgeDeps: JudgeDeps

  /** Injectable detached-spawn seam for the task transport (runTaskAgent) —
   * defaults to the real detached bun worker. Tests inject a fake. */
  private readonly taskSpawnFn: CCTaskSpawnFn

  constructor(
    projectRoot: string,
    opts: { logFile?: string; judgeDeps?: JudgeDeps; taskSpawnFn?: CCTaskSpawnFn } = {},
  ) {
    this.projectRoot = projectRoot
    this.logFile = opts.logFile ?? path.join(ccRuntimeDir(), "hook.log")
    this.judgeDeps = opts.judgeDeps ?? {}
    this.taskSpawnFn = opts.taskSpawnFn ?? defaultWorkerSpawn
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
    return runClaudeCodeTextAgent(opts, (level, msg) => this.log(level, msg), this.judgeDeps)
  }

  async runTaskAgent(opts: {
    title: string
    prompt: string
    model?: unknown
    system?: string
    stagingPaths?: WorkerStagingPaths
    timeoutMs?: number
  }): Promise<{ id: string } | null> {
    // Detached worker spawned with cwd = the PROJECT worktree (diagnostic
    // only now — the toolless daemon worker never touches the repo via cwd).
    // Fire-and-forget: returns {id} at once; the artifact is applied on a
    // later hook event.
    return runClaudeCodeTaskAgent(
      { ...opts, cwd: this.projectRoot },
      (level, msg) => this.log(level, msg),
      this.taskSpawnFn,
    )
  }

  // ── apply-on-next-event seam (Task L8) ────────────────────────────────────
  // triggerPropose/Promote/Curate hand the descriptor here right after the
  // detached spawn; we persist it as a lock so a LATER hook event applies it
  // (see proposer.ts). The lock's presence also answers proposerInFlight.

  stageArtifactApply(descriptor: StagedArtifactDescriptor): void {
    writeProposerLock(descriptor)
  }

  proposerInFlight(root: string): boolean {
    return lockInFlight(this.projectRoot, root)
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
