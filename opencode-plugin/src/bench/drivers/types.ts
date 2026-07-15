/**
 * drivers/types.ts — the generic AgentDriver interface.
 *
 * B1 (task-B1-brief.md) extracts this seam so the generic retry loop in
 * agent-run.ts can drive any coding agent CLI (opencode today; claude-code /
 * codex are future drivers), not just opencode. Every opencode-specific
 * detail (its NDJSON event shape, its `--auto --format json` flags, its
 * error-classification heuristics) lives behind this interface in
 * drivers/opencode.ts — nothing opencode-specific belongs in agent-run.ts.
 */
import type { ExecResult } from "../exec.ts"
import type { TrajEvent, ToolUsage } from "../../harness-store.ts"
import type { AgentAuthMounts } from "../agent-auth.ts"

export interface AgentRunOutput {
  turnCount: number
  toolUsage: ToolUsage
  events: TrajEvent[]
  /** True ONLY on the wall-timeout branch (agent-run.ts's runAgent). Absent
   *  (not merely false) ⇒ not a timeout. Distinguishes a timeout's 0-turn
   *  result from auth-fail/transient-exhaustion 0-turn results, which stay
   *  unset — Loop-3's proposer-visibility work depends on this. */
  timedOut?: boolean
  /** Agent-phase wall-clock seconds. Optional; only set alongside timedOut
   *  today (agent-run.ts's elapsedSec on the timeout branch). */
  agentElapsedSec?: number
}

/** How the evolvable harness markdown reaches the agent. */
export type HarnessDelivery =
  | { kind: "workspace-file"; filename: string } // podman cp to /app/<filename>
  | { kind: "argv-flags"; buildFlags(harnessMd: string): string[] } // future drivers

/** Per-attempt classification, checked in this precedence order by the
 *  generic retry loop (auth beats transient). */
export type AttemptClass = "auth" | "transient" | "done"

export interface AgentDriver {
  /** Registry id + provenance string + log prefix. */
  id: string
  /** In-container argv for one agent attempt (cwd is /app). `model` is already driver-native (modelArg applied by caller). */
  buildArgv(opts: { model: string; variant: string; instruction: string }): string[]
  /** Canonical "provider/model" slug -> driver-native model arg; may die() on unsupported. */
  modelArg(canonicalModel: string): string
  harness: HarnessDelivery
  /** Driver stdout -> neutral result (turn counting + tool errors + TrajEvents). */
  parseOutput(stdout: string): AgentRunOutput
  /** Classify a finished (non-timed-out) attempt for the retry loop. */
  classifyAttempt(result: ExecResult): AttemptClass
  /** Host-side auth prep: mounts + optional container env + cleanup. */
  prepareAuth(): AgentAuthMounts
  /** In-container version probe argv, e.g. ["opencode","--version"]. */
  versionArgv: string[]
  /** Driver-specific remediation text logged after AUTH_FAIL_MARK
   * (agent-run.ts's runAgent) on an unrecoverable auth failure — e.g. which
   * command re-authenticates THIS driver's CLI. Optional: a driver that
   * doesn't set one gets agent-run.ts's generic (driver-neutral) fallback
   * tail instead of another driver's CLI-specific wording. */
  authHint?: string
}
