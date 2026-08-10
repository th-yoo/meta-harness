/**
 * drivers/claude-code.ts — the claude-code AgentDriver (task-B5-brief.md).
 *
 * Mirrors drivers/opencode.ts's structure (argv construction, NDJSON stdout
 * parsing for turn counting + tool usage + TrajEvents, and
 * transient-vs-auth-vs-done attempt classification) behind the same
 * AgentDriver interface (drivers/types.ts), for `claude -p ... --output-format
 * stream-json --verbose` instead of `opencode run --format json`.
 *
 * Ground truth for the stream-json shape below is this task's CAPTURED
 * FIXTURES (test/fixtures/drivers/claude-code/), not task-B5-brief.md's shape
 * sketch — see this task's report for the deltas found during capture
 * (pinned CLI 2.1.207, matching the host and B4's baked-image version):
 *
 *   - The brief's guess that a failed `"result"` event carries a
 *     `subtype:"error_*"` is wrong for auth/pre-flight failures: BOTH real
 *     captured auth fixtures (an unauthenticated CLAUDE_CONFIG_DIR and an
 *     invalid ANTHROPIC_API_KEY) came back with `"subtype":"success"` and
 *     `"is_error":true` — `is_error` is the reliable failure flag, `subtype`
 *     is not (strings(1) on the installed CC binary DOES show real
 *     `error_during_execution` / `error_max_turns` subtypes exist, just not
 *     for this failure class — presumably reserved for mid-run agent-loop
 *     failures rather than pre-flight auth rejection).
 *   - The brief's guess that "activity" (real work vs. a bare error) can be
 *     detected by scanning stdout for `"type":"assistant"` is wrong: CC
 *     emits a synthetic assistant echo (`message.model:"<synthetic>"`) with
 *     NO tool_use even for a pure pre-flight auth rejection (see
 *     fixtures/drivers/claude-code/auth-error.txt) — using bare "assistant"
 *     presence as the activity signal would make hadActivity permanently
 *     true and silently disable auth/transient classification. `tool_use`
 *     presence is used instead (see classifyAttempt below).
 */
import type { TrajEvent, ToolUsage } from "../../harness-store.ts"
import type { ExecResult } from "../exec.ts"
import { prepareClaudeCodeAuth } from "../agent-auth.ts"
import { AUTH_ERROR_RE, TRANSIENT_RE } from "../agent-run.ts"
import { die } from "../util.ts"
import { jsonStringify } from "./opencode.ts"
import type { AgentDriver, AgentRunOutput, AttemptClass } from "./types.ts"

/** Tools whose is_error tool_result counts as a tool error. Mirrors
 * opencode.ts's EXECUTION_TOOLS restriction rationale (avoid false positives
 * from a read-only tool's "error" meaning e.g. "file not found", not a
 * genuine execution failure) — CC's own tool names are capitalized (fixture
 * evidence: "Bash", not "bash"), unlike opencode's lowercase tool ids. */
export const EXECUTION_TOOLS = new Set(["Bash", "Task"])

const MAX_EVENTS = 400
/** Exported for bench/traj-replay.ts's truncation guard — the SAME cap
 * opencode.ts hardcodes inline at its `args.slice(0, 300)` call site
 * (drivers/opencode.ts:63). Both drivers apply this cap at capture time and
 * `--save-all-traj` does not bypass it, so a captured `args` string at
 * EXACTLY this length is ambiguous (could be a genuine 300-char command or
 * a longer one silently cut) and must be treated as non-replayable. */
export const MAX_ARGS_CHARS = 300
const MAX_TEXT_CHARS = 800

type Json = Record<string, unknown>

function parseLines(stdout: string): Json[] {
  const out: Json[] = []
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    try {
      out.push(JSON.parse(line) as Json)
    } catch {
      continue
    }
  }
  return out
}

function contentBlocks(ev: Json): Json[] {
  const message = (ev["message"] as Json) ?? {}
  const content = message["content"]
  return Array.isArray(content) ? (content as Json[]) : []
}

/** tool_use.id -> its later tool_result, joined across the two separate
 * NDJSON events CC emits (an `assistant` event with the tool_use block, then
 * a LATER `user` event carrying `{"type":"tool_result","tool_use_id":...}`)
 * — unlike opencode, whose single tool_use event already carries its own
 * output inline (drivers/opencode.ts's normalizeEvents needs no such join). */
function buildToolResultMap(events: Json[]): Map<string, { content: string; isError: boolean }> {
  const map = new Map<string, { content: string; isError: boolean }>()
  for (const ev of events) {
    if (ev["type"] !== "user") continue
    for (const block of contentBlocks(ev)) {
      if (block["type"] !== "tool_result") continue
      const toolUseId = block["tool_use_id"]
      if (typeof toolUseId !== "string") continue
      const rawContent = block["content"]
      const content = typeof rawContent === "string" ? rawContent : jsonStringify(rawContent ?? "")
      map.set(toolUseId, { content, isError: block["is_error"] === true })
    }
  }
  return map
}

/**
 * claude-code stream-json NDJSON -> compact TrajEvents for the proposer.
 * Same caps as opencode.ts's normalizeEvents (args<=300, output<=800,
 * text<=800, maxEvents 400): tool_use -> {t:"tool", tool, args, output?,
 * error?} (output/error from the joined tool_result); assistant text ->
 * {t:"text", text} (blank skipped); a failed result event -> {t:"error",
 * error} (error signal is is_error:true OR an "error_*" subtype — see file
 * header for why subtype alone is not reliable).
 */
export function normalizeEvents(stdout: string, maxEvents = MAX_EVENTS): TrajEvent[] {
  const events = parseLines(stdout)
  const toolResults = buildToolResultMap(events)
  const out: TrajEvent[] = []

  for (const ev of events) {
    if (out.length >= maxEvents) break
    const t = ev["type"] as string

    if (t === "assistant") {
      for (const block of contentBlocks(ev)) {
        if (out.length >= maxEvents) break
        const bt = block["type"]
        if (bt === "tool_use") {
          const tool = (block["name"] as string) || "unknown"
          const id = block["id"]
          const rawInput = block["input"]
          const args = typeof rawInput === "string" ? rawInput : jsonStringify(rawInput ?? "")
          const joined = typeof id === "string" ? toolResults.get(id) : undefined
          out.push({
            t: "tool",
            tool,
            args: args.slice(0, MAX_ARGS_CHARS),
            output: (joined?.content ?? "").slice(0, MAX_TEXT_CHARS),
            error: joined?.isError ?? false,
          })
        } else if (bt === "text") {
          const txt = block["text"]
          if (typeof txt === "string" && txt.trim()) {
            out.push({ t: "text", text: txt.slice(0, MAX_TEXT_CHARS) })
          }
        }
      }
    } else if (t === "result") {
      const subtype = ev["subtype"]
      const isError = ev["is_error"] === true || (typeof subtype === "string" && subtype.startsWith("error"))
      if (isError) {
        const msg = (ev["result"] as string) || (typeof subtype === "string" ? subtype : "") || "error"
        out.push({ t: "error", text: String(msg).slice(0, MAX_TEXT_CHARS) })
      }
    }
  }

  return out
}

/**
 * Parse NDJSON output for turn count and tool usage.
 * turnCount: the `result` event's `num_turns` when present (every fixture
 * captured for this task has it). Fallback (documented per
 * task-B5-brief.md, not exercised by any real fixture — result events always
 * carried num_turns): count of `assistant` NDJSON events containing >=1 text
 * content block, i.e. one count per "final answer" turn CC streamed.
 * toolUsage: one entry per tool_use block's `name`; errors = the joined
 * tool_result's `is_error:true`, counted only for EXECUTION_TOOLS (mirrors
 * opencode.ts's rationale — a Read/Grep "error" is usually just "not found",
 * not an execution failure worth flagging).
 */
function parseOutput(stdout: string): AgentRunOutput {
  const events = parseLines(stdout)
  const toolResults = buildToolResultMap(events)

  let resultTurns: number | undefined
  let fallbackTurns = 0
  const toolUsage: ToolUsage = {}

  for (const ev of events) {
    const t = ev["type"] as string
    if (t === "result") {
      const nt = ev["num_turns"]
      if (typeof nt === "number") resultTurns = nt
      continue
    }
    if (t !== "assistant") continue
    let hasText = false
    for (const block of contentBlocks(ev)) {
      const bt = block["type"]
      if (bt === "text") {
        hasText = true
      } else if (bt === "tool_use") {
        const tool = (block["name"] as string) || "unknown"
        const id = block["id"]
        if (!toolUsage[tool]) toolUsage[tool] = { calls: 0, errors: 0 }
        toolUsage[tool]!.calls += 1
        const joined = typeof id === "string" ? toolResults.get(id) : undefined
        if (joined?.isError && EXECUTION_TOOLS.has(tool)) toolUsage[tool]!.errors += 1
      }
    }
    if (hasText) fallbackTurns += 1
  }

  const turnCount = resultTurns ?? fallbackTurns
  const events_ = normalizeEvents(stdout)
  return { turnCount, toolUsage, events: events_ }
}

/**
 * Classify a finished (non-timed-out) attempt. Same auth-beats-transient
 * precedence as opencode.ts's classifyAttempt, adapted to CC's shape (see
 * this file's header for the fixture-driven deltas from the brief's sketch):
 *
 *  - hadActivity: `"type":"tool_use"` presence (NOT bare `"type":"assistant"`
 *    — see file header; a synthetic pre-flight-rejection assistant echo is
 *    NOT real activity).
 *  - hadErrorEvent: a `"subtype":"error*"` result OR an explicit
 *    `"is_error":true` anywhere in the stream — CC's structured failure
 *    signal, equivalent to opencode's `{"type":"error"}` event marker.
 *  - auth: (hadErrorEvent || rc!==0) && !hadActivity && AUTH_ERROR_RE match.
 *  - transient: (hadErrorEvent && !hadActivity) as a strong/structured
 *    signal on its own, OR (rc!==0 && !hadActivity && TRANSIENT_RE match) as
 *    the weaker signal requiring text corroboration — exactly opencode's
 *    asymmetry (a raw nonzero exit with no structured error event needs the
 *    regex to avoid over-triggering on e.g. a container-level crash).
 */
function classifyAttempt(result: ExecResult): AttemptClass {
  const out = result.stdout || ""
  const hadActivity = out.includes('"type":"tool_use"')
  const hadErrorEvent = /"subtype":"error/.test(out) || out.includes('"is_error":true')

  // Silent-done hardening (P2 launch-1 burn): rc!=0 with an EMPTY stdout is
  // a process that failed before producing anything — CC's pre-flight
  // refusals (e.g. --dangerously-skip-permissions as root without
  // IS_SANDBOX=1) print to STDERR only. Classify from stderr; anything
  // unmatched is still transient, never "done".
  if (result.rc !== 0 && !hadActivity && out.trim() === "") {
    return AUTH_ERROR_RE.test(result.stderr || "") ? "auth" : "transient"
  }

  const isAuth = (hadErrorEvent || result.rc !== 0) && !hadActivity && AUTH_ERROR_RE.test(out)
  if (isAuth) return "auth"

  const transient = (hadErrorEvent && !hadActivity) || (result.rc !== 0 && !hadActivity && TRANSIENT_RE.test(out))
  if (transient) return "transient"

  return "done"
}

const ANTHROPIC_PREFIX = "anthropic/"

function modelArg(canonicalModel: string): string {
  if (!canonicalModel.startsWith(ANTHROPIC_PREFIX)) {
    return die(`--driver claude-code supports anthropic/* models only, got "${canonicalModel}"`)
  }
  return canonicalModel.slice(ANTHROPIC_PREFIX.length)
}

// stream-json + --verbose: NDJSON, one JSON event per line (this file's
// parser/classifier contract). --dangerously-skip-permissions: the bench
// container has no human to approve tool calls (mirrors opencode's --auto).
// CC has no variant concept (task-B5-brief.md) — fail loud rather than
// silently drop a variant a caller thinks is being applied.
function buildArgv(opts: { model: string; variant: string; instruction: string }): string[] {
  if (opts.variant) {
    return die(`--driver claude-code has no variant concept, got variant "${opts.variant}"`)
  }
  return [
    "claude",
    "-p",
    opts.instruction,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--dangerously-skip-permissions",
  ]
}

export const claudeCodeDriver: AgentDriver = {
  id: "claude-code",
  buildArgv,
  modelArg,
  // CLAUDE.md is CC's auto-loaded project memory file (analogous to
  // opencode's AGENTS.md) — the runAgent loop podman-cp's it to /app/CLAUDE.md.
  harness: { kind: "workspace-file", filename: "CLAUDE.md" },
  parseOutput,
  classifyAttempt,
  prepareAuth: () => prepareClaudeCodeAuth(),
  versionArgv: ["claude", "--version"],
  // CC-appropriate remediation (final-review fix 5) — the pre-fix message
  // wrongly told a claude-code user to run `opencode auth login`.
  authHint:
    "the model credential was rejected (a missing/expired claude-code session). " +
    "Refresh it (run `claude /login` on the host), or set ANTHROPIC_API_KEY.",
}
