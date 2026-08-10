/**
 * drivers/opencode.ts — the opencode AgentDriver.
 *
 * Ports term-bench2/runner.py's normalize_events (:768-812) and the
 * opencode-specific pieces of run_opencode (:813-965) — argv construction,
 * NDJSON stdout parsing (turn counting + tool usage), and the
 * transient-vs-auth-vs-done attempt classification — behind the AgentDriver
 * interface (drivers/types.ts) extracted in task-B1-brief.md. The generic
 * retry loop that used to own all of this lives in agent-run.ts now; nothing
 * here is aware of retries, backoff, or MAX_ATTEMPTS.
 */
import type { TrajEvent, ToolUsage } from "../../harness-store.ts"
import type { ExecResult } from "../exec.ts"
import { prepareAgentAuthMounts } from "../agent-auth.ts"
import { AUTH_ERROR_RE, TRANSIENT_RE } from "../agent-run.ts"
import type { AgentDriver, AgentRunOutput, AttemptClass } from "./types.ts"

/** Tools whose non-zero exit / "error" status counts as a tool error —
 * runner.py:906's EXECUTION_TOOLS. */
export const EXECUTION_TOOLS = new Set(["bash", "task"])

/** Exported for drivers/claude-code.ts, which needs the identical
 * "stringify-or-fall-back-to-String()" behavior for its tool_use `input` /
 * tool_result `content` fields (task-B5-brief.md's shared-helper note). */
export function jsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * opencode `run --format json` NDJSON → compact TrajEvents for the proposer.
 * Verbatim port of runner.py:768-810: skip non-`{`/unparseable/step_finish
 * lines; tool_use → {t:"tool", tool, args<=300, output<=800, error}; text
 * (skip-blank) <=800; error extraction; capped at maxEvents.
 */
export function normalizeEvents(ndjsonText: string, maxEvents = 400): TrajEvent[] {
  const events: TrajEvent[] = []
  for (const rawLine of ndjsonText.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const t = (ev["type"] as string) ?? ""
    if (t === "tool_use") {
      const part = (ev["part"] as Record<string, unknown>) ?? {}
      const state = (part["state"] as Record<string, unknown>) ?? {}
      const tool = (part["tool"] as string) ?? "unknown"
      const rawArgs = "input" in state ? state["input"] : ((part["input"] as unknown) ?? "")
      const args = typeof rawArgs === "string" ? rawArgs : jsonStringify(rawArgs)
      const rawOut = state["output"] ?? ""
      const out = typeof rawOut === "string" ? rawOut : jsonStringify(rawOut)
      const status = (state["status"] as string) ?? ""
      const metadata = (state["metadata"] as Record<string, unknown>) || {}
      const exitCode = (metadata["exit"] as number) ?? 0
      const err = status === "error" || Boolean(exitCode && exitCode !== 0)
      events.push({ t: "tool", tool, args: args.slice(0, 300), output: out.slice(0, 800), error: err })
    } else if (t === "text") {
      const part = (ev["part"] as Record<string, unknown>) ?? {}
      const txt = (ev["text"] as string) || (part["text"] as string) || ""
      if (typeof txt === "string" && txt.trim()) {
        events.push({ t: "text", text: txt.slice(0, 800) })
      }
    } else if (t === "error") {
      const errVal = ev["error"] ?? {}
      let msg: string
      if (errVal && typeof errVal === "object" && !Array.isArray(errVal)) {
        const eo = errVal as Record<string, unknown>
        const data = (eo["data"] as Record<string, unknown>) ?? {}
        msg = (data["message"] as string) || (eo["name"] as string) || jsonStringify(eo)
      } else {
        msg = String(errVal)
      }
      events.push({ t: "error", text: String(msg).slice(0, 800) })
    }
    if (events.length >= maxEvents) break
  }
  return events
}

/**
 * Parse NDJSON output for turn count and tool usage.
 * turn_count = number of step_finish events with reason=="stop"
 * tool errors = tool_use events where state.status=="error" OR
 *   metadata.exit != 0 — EXECUTION_TOOLS only, to avoid false positives.
 */
function parseOutput(stdout: string): AgentRunOutput {
  let turnCount = 0
  const toolUsage: ToolUsage = {}

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const evtType = (event["type"] as string) ?? ""

    if (evtType === "tool_use") {
      const part = (event["part"] as Record<string, unknown>) ?? {}
      const tool = (part["tool"] as string) ?? "unknown"
      const state = (part["state"] as Record<string, unknown>) ?? {}
      if (!toolUsage[tool]) toolUsage[tool] = { calls: 0, errors: 0 }
      toolUsage[tool]!.calls += 1
      if (EXECUTION_TOOLS.has(tool)) {
        const status = (state["status"] as string) ?? ""
        const metadata = (state["metadata"] as Record<string, unknown>) || {}
        const exitCode = (metadata["exit"] as number) ?? 0
        if (status === "error" || (exitCode && exitCode !== 0)) {
          toolUsage[tool]!.errors += 1
        }
      }
    } else if (evtType === "step_finish") {
      const part = (event["part"] as Record<string, unknown>) ?? {}
      if (part["reason"] === "stop") turnCount += 1
    }
  }

  // Note: Python's MH_DEBUG dump-to-/tmp behavior (runner.py:940-948) is
  // dropped in this port — it is a local debugging aid, not part of any
  // marker-string consumer contract (flagged in the task report).

  const events = normalizeEvents(stdout)
  return { turnCount, toolUsage, events }
}

/**
 * Classify a finished (non-timed-out) attempt: an {"type":"error"} event AND
 * no assistant/tool activity (step_finish/tool_use) is a candidate failure;
 * AUTH_ERROR_RE vs TRANSIENT_RE then tells an unrecoverable auth failure
 * apart from a transient provider hiccup (see agent-run.ts's AUTH_ERROR_RE
 * doc comment for why the two are otherwise indistinguishable by shape).
 */
function classifyAttempt(result: ExecResult): AttemptClass {
  const out = result.stdout || ""
  const hadErrorEvent = out.includes('"type":"error"')
  const hadActivity = out.includes('"type":"step_finish"') || out.includes('"type":"tool_use"')

  // Silent-done hardening (P2 launch-1 burn, cross-driver contract): rc!=0
  // with an EMPTY stdout failed before producing anything — the message, if
  // any, is on stderr. Never "done".
  if (result.rc !== 0 && !hadActivity && out.trim() === "") {
    return AUTH_ERROR_RE.test(result.stderr || "") ? "auth" : "transient"
  }

  const isAuth = (hadErrorEvent || result.rc !== 0) && !hadActivity && AUTH_ERROR_RE.test(out)
  if (isAuth) return "auth"

  const transient = (hadErrorEvent && !hadActivity) || (result.rc !== 0 && !hadActivity && TRANSIENT_RE.test(out))
  if (transient) return "transient"

  return "done"
}

// --format json: one JSON event per line (NDJSON). --auto: approve all tool
// permissions. NEVER --pure — it strips provider/auth config (see
// runner.py:836-840's comment, preserved here for the same reason).
function buildArgv(opts: { model: string; variant: string; instruction: string }): string[] {
  const cmd = ["opencode", "run", "--dir", "/app", "--auto", "--format", "json", "--model", opts.model]
  if (opts.variant) cmd.push("--variant", opts.variant)
  cmd.push(opts.instruction)
  return cmd
}

export const opencodeDriver: AgentDriver = {
  id: "opencode",
  buildArgv,
  modelArg: (canonicalModel: string) => canonicalModel,
  harness: { kind: "workspace-file", filename: "AGENTS.md" },
  parseOutput,
  classifyAttempt,
  prepareAuth: (opts) => prepareAgentAuthMounts({ keyOnly: opts?.keyOnly }),
  versionArgv: ["opencode", "--version"],
  // Byte-identical to the pre-fix hardcoded tail in agent-run.ts's runAgent
  // (final-review fix 5) — opencode's own auth remediation is unchanged,
  // only now driver-selected instead of hardcoded for every driver.
  authHint:
    "the model credential was rejected (auth.json oauth token likely expired). " +
    "Refresh it (run a host `opencode run`, or `opencode auth login`), or set a long-lived *_API_KEY.",
}
