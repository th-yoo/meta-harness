/**
 * adapters/claude-code/dispatch.ts
 *
 * The pure event-dispatch core of the Claude Code adapter: given a hook event
 * name + the parsed hook stdin JSON + a { engine, host, state } context, it runs
 * the matching EvolutionEngine call(s) and returns the JSON object the hook
 * should print to stdout (or undefined = print nothing). Kept free of
 * process/argv/stdin so it is exercised directly from recorded-stdin fixtures;
 * hook-cli.ts is the thin process wrapper around it.
 *
 * Event map (mirrors the opencode adapter index.ts, adapted to CC hooks):
 *   SessionStart     → sessionMessage + composeInjection → additionalContext
 *   UserPromptSubmit → /mh-score: score-then-run-idle (the inversion) → block;
 *                      other /mh-*: handleCommand → block; else pass through
 *   PreToolUse(Bash) → adjustToolArgs → updatedInput (the bash-timeout knob)
 *   PostToolUse      → recordTool (tool_name lowercased for cross-platform keys)
 *   Stop             → recordTurn + an advisory /mh-score reminder systemMessage
 *
 * Advisory-strength caveat (documented in the brief's live probes): SessionStart
 * additionalContext and Stop systemMessage are SOFT guidance — same class as
 * AGENTS.md — not a hard steer. Phase A deliberately does not try to force
 * stronger delivery.
 */

import fs from "node:fs"
import path from "node:path"
import type { EvolutionEngine, SessionIdleOutcome, SessionState, SessionStateStore } from "../../engine.ts"
import { parseScoreArgs } from "../../score.ts"
import { MH_CHILD_ENV, type ClaudeCodeHost } from "./cc-host.ts"
import { applyPendingArtifacts } from "./proposer.ts"

/** The union of hook stdin shapes across the events we install (verified live
 * against claude 2.1.207 — see the brief's raw probe evidence). All event-
 * specific fields are optional; only session_id/cwd/hook_event_name are common. */
export interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  // SessionStart
  source?: "startup" | "resume" | string
  // UserPromptSubmit
  prompt?: string
  prompt_id?: string
  permission_mode?: string
  // Pre/PostToolUse
  tool_name?: string
  tool_input?: { command?: string; description?: string; timeout?: number; workdir?: string; [k: string]: unknown }
  tool_response?: { stdout?: string; stderr?: string; [k: string]: unknown }
  tool_use_id?: string
  // Stop
  last_assistant_message?: string
  stop_hook_active?: boolean
}

/** A hook's stdout payload, or undefined to print nothing. */
export type HookOutput = Record<string, unknown> | undefined

export interface DispatchContext {
  engine: EvolutionEngine
  host: ClaudeCodeHost
  state: SessionStateStore
}

/** Adapter-owned role detection (the engine never sniffs "mh-"). Mirrors the
 * opencode adapter's isMhRole. */
export function isMhRole(role: string): boolean {
  return role.startsWith("mh-")
}

/**
 * The session's declared role. Precedence: MH_ROLE env (set by the installed
 * settings.json env block) → the project's .kkamak/config.json
 * `defaultRole` → null. Null means "no role declared" → the session does not
 * participate and the hook exits silently.
 */
export function resolveRole(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env["MH_ROLE"]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".kkamak", "config.json"), "utf-8"))
    if (typeof cfg?.defaultRole === "string" && cfg.defaultRole.trim()) return cfg.defaultRole.trim()
  } catch {
    /* no project config, or unreadable → fall through to null */
  }
  return null
}

/**
 * F3 — the /mh-score block message, per sessionIdle's honest outcome. Every
 * outcome gets a DISTINCT message so a user (or a script scraping hook
 * output) can tell an actual record from a no-op. "not-active" doubles as
 * CC's one-score-per-session Phase-A note: cleanup() resets `bootstrapped`
 * to false right after a score is recorded, and — unlike opencode — no
 * SessionStart re-fires mid-session on Claude Code, so a second /mh-score in
 * the same session hits this same branch as a never-started one.
 */
function scoreOutcomeMessage(outcome: SessionIdleOutcome): string {
  switch (outcome) {
    case "recorded":
      return "Meta-Harness: score recorded ✓ (this notice is expected)"
    case "skipped-degenerate":
      return "Meta-Harness: session skipped — no substantive work to score (this notice is expected)"
    case "not-active":
      return (
        "Meta-Harness: no active session to score — nothing tracked, or this " +
        "session already scored (Claude Code scores once per session: resume " +
        "or start a new session to score more work)"
      )
    case "pending":
      return "Meta-Harness: a score is already pending for this session — try again in a moment"
  }
}

/** Conservative degenerate-session filter for the Stop reminder gate — replicated
 * from engine.ts's private isDegenerateSession so a greeting/empty turn doesn't
 * nag the user to score it (sessionIdle applies the SAME filter at score time). */
function isDegenerate(st: SessionState): boolean {
  if (st.turns === 0) return true
  const totalCalls = Object.values(st.toolUsage).reduce((n, t) => n + t.calls, 0)
  return totalCalls === 0 && st.summary.trim().length < 50
}

export async function dispatch(
  event: string,
  input: HookInput,
  ctx: DispatchContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  const { engine, host, state } = ctx

  // ── child-session non-participation (Task L8, mechanism (d)) ──────────────
  // A detached proposer/promoter/curator `claude -p` runs IN this project, so CC
  // fires THIS project's hooks for it. runClaudeCodeTaskAgent stamps MH_CHILD=1
  // on the child's env; every hook process it spawns inherits it. Bail before
  // ANY engine call (no capture, no injection, no pending-artifact scan) so a
  // proposer session never records itself — a self-referential capture loop.
  if (env[MH_CHILD_ENV]) return undefined

  const cwd = input.cwd ?? host.projectRoot

  // ── apply-on-next-event (Task L8) ─────────────────────────────────────────
  // Any hook event is a chance to flush completed proposer/promoter/curator
  // artifacts whose spawning hook process has already exited. Cheap (a readdir
  // of a usually-empty lock dir) and self-guarded (never throws into the hook).
  await applyPendingArtifacts(host, cwd)

  const sessionId = input.session_id ?? ""
  if (!sessionId) return undefined

  switch (event) {
    // ── SessionStart: bootstrap + compose the injected harness context ───────
    case "SessionStart": {
      const role = resolveRole(cwd, env)
      if (role === null) return undefined // non-participating → silent exit 0
      await engine.sessionMessage(sessionId, {
        role,
        isPrimary: true,
        participates: isMhRole(role),
      })
      const blocks = await engine.composeInjection(sessionId)
      if (blocks.length === 0) return undefined
      // resume/compaction re-fires SessionStart with the same session_id; the
      // engine is idempotent (snapshot injects once), and re-injecting the
      // system blocks each time is intended.
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: blocks.join("\n\n"),
        },
      }
    }

    // ── UserPromptSubmit: /mh-* command handling (incl. the score inversion) ─
    case "UserPromptSubmit": {
      const prompt = (input.prompt ?? "").trim()
      const m = prompt.match(/^\/(\S+)\s*([\s\S]*)$/)
      const command = m?.[1] ?? ""
      const args = m?.[2] ?? ""
      if (!isMhRole(command)) return undefined // ordinary prompt → reaches model

      // /mh-score is the ONE flow that inverts the opencode idle-then-wait model:
      // hooks are short-lived, so we stage the human verdict then run the idle
      // scoring pipeline IN-PROCESS; promptHumanScore reads the staged verdict
      // via host.takePendingScore and returns immediately.
      if (command === "mh-score") {
        const verdict = parseScoreArgs(args)
        if (verdict === null) {
          return { decision: "block", reason: "Meta-Harness: usage — /mh-score good|bad [note]" }
        }
        host.setPendingScore(sessionId, verdict)
        const outcome = await engine.sessionIdle(sessionId)
        return { decision: "block", reason: scoreOutcomeMessage(outcome) }
      }

      // Other /mh-* commands route through the shared engine handler; the
      // returned message becomes the block reason (CC has no toast channel).
      const result = await engine.handleCommand(command, args, sessionId)
      if (result.consumed) {
        return { decision: "block", reason: result.message }
      }
      return undefined
    }

    // ── PreToolUse(Bash): the bash-timeout knob via updatedInput rewrite ──────
    case "PreToolUse": {
      if ((input.tool_name ?? "").toLowerCase() !== "bash") return undefined
      const ti = input.tool_input ?? {}
      const newArgs = engine.adjustToolArgs(sessionId, "bash", {
        command: ti.command,
        timeout: typeof ti.timeout === "number" ? ti.timeout : undefined,
        workdir: ti.workdir,
      })
      if (!newArgs) return undefined
      // Merge onto the original input so description etc. survive the rewrite.
      const updatedInput = { ...ti, ...newArgs }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      }
    }

    // ── PostToolUse: tool-usage capture ──────────────────────────────────────
    case "PostToolUse": {
      const tool = (input.tool_name ?? "").toLowerCase()
      if (!tool) return undefined
      const resp = input.tool_response ?? {}
      const text = [resp.stdout, resp.stderr].filter((s) => typeof s === "string" && s).join("\n")
      engine.recordTool(sessionId, tool, text)
      return undefined
    }

    // ── Stop: capture the turn + advisory reminder to score ──────────────────
    case "Stop": {
      engine.recordTurn(sessionId, input.last_assistant_message ?? "")
      const st = state.get(sessionId)
      if (st && st.participates && st.bootstrapped && !isDegenerate(st)) {
        return {
          systemMessage:
            "Meta-Harness: reply complete — type /mh-score good|bad [note] to record this session for evolution.",
        }
      }
      return undefined
    }

    default:
      return undefined
  }
}
