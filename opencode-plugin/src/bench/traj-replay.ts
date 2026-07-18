/**
 * bench/traj-replay.ts — env-fidelity spot-check helper (task-5-brief.md's
 * W3, part of the Phase 5 leaderboard-fail-picks gate).
 *
 * `extractShellCommands` turns a captured trajectory (`TrajEvent[]`,
 * harness-store.ts:542) into an ordered sh transcript for REPLAYING inside a
 * real per-task podman image during the manual spot-check procedure
 * documented in docs/env-fidelity-spotcheck.md. It does not execute
 * anything itself — it only produces text a human (or a follow-up script)
 * feeds to `sh`.
 *
 * ── Truncation guard (architect MAJOR, see task-5-brief.md) ─────────────
 * Both drivers hard-cap a tool event's `args` at capture time — opencode.ts
 * inlines `args.slice(0, 300)` at drivers/opencode.ts:63; claude-code.ts
 * exports the same value as `MAX_ARGS_CHARS` (drivers/claude-code.ts,
 * re-exported here so this file keys off the driver's real constant instead
 * of a second hardcoded 300). `--save-all-traj` does NOT bypass this cap —
 * it's applied at NDJSON-normalization time, before anything is persisted.
 * A captured `args` string whose length is EXACTLY `MAX_ARGS_CHARS` is
 * therefore ambiguous: it could be a genuine command of that exact length,
 * or a longer one silently cut mid-token. Since we cannot tell which, any
 * such event is flagged truncated and its command is NEVER emitted as an
 * executable line — only as a clearly-marked comment — so a garbled/partial
 * command can't be blindly replayed as if it were real. Under-cap args are
 * unambiguous (the driver would not have cut a shorter string) and are
 * emitted verbatim.
 *
 * ── Shell-tool detection ──────────────────────────────────────────────
 * Which tool names count as "shell" is taken from what the drivers
 * ACTUALLY record for shell execution (verified against driver source +
 * captured fixtures test/fixtures/drivers/{opencode,claude-code}/*.ndjson):
 * opencode's tool_use events use the lowercase `"bash"` tool id
 * (EXECUTION_TOOLS in drivers/opencode.ts); claude-code's use the
 * capitalized `"Bash"` (EXECUTION_TOOLS in drivers/claude-code.ts). See
 * SHELL_TOOLS below. Anything else (read, edit, grep, task, ...) is
 * rendered as a `# <tool>: <args>` comment line — never executed.
 *
 * ── args shape per driver ────────────────────────────────────────────
 * opencode's captured `args` for a bash tool_use is already the raw shell
 * command string (fixture evidence: `"input":"echo hi"`). claude-code's is
 * a JSON-stringified `{command, description, ...}` object (fixture
 * evidence: `"input":{"command":"echo hello && pwd","description":"..."}}`,
 * run through the shared `jsonStringify` helper — see drivers/opencode.ts's
 * `jsonStringify` and its claude-code.ts re-export). `shellCommandText`
 * below pulls `.command` out when `args` parses as JSON with a string
 * `command` field, and falls back to the raw `args` string otherwise —
 * duck-typed rather than keyed off the tool name, so it degrades gracefully
 * if a driver's shape changes.
 *
 * ── Return shape ─────────────────────────────────────────────────────
 * `commands`: one entry per `t:"tool"` event, in original order (`t:"text"`
 * and `t:"error"` events carry no invocation and are skipped entirely — no
 * placeholder is emitted for them). A shell-tool entry is either the bare
 * replayable command line, or — if truncated — a `#`-prefixed comment that
 * never gets executed by a naive `sh` replay. A non-shell-tool entry is
 * always a `# <tool>: <args>` comment line, replayable or not.
 * `truncated`: the indices, INTO THE ORIGINAL `events` ARRAY (not into
 * `commands`), of every tool event whose `args` length was exactly
 * `MAX_ARGS_CHARS` — flagged regardless of whether that tool was a shell
 * tool, since the manual spot-check procedure needs to know about ANY
 * truncated arg to decide whether to reconstruct or downgrade a verdict
 * (docs/env-fidelity-spotcheck.md's truncation-downgrade rule), not just
 * ones that happened to land on an executable line.
 */
import type { TrajEvent } from "../harness-store.ts"
import { MAX_ARGS_CHARS } from "./drivers/claude-code.ts"

export { MAX_ARGS_CHARS }

/** Tool names the drivers record for shell execution. Lowercase `"bash"` =
 * opencode (drivers/opencode.ts's EXECUTION_TOOLS); capitalized `"Bash"` =
 * claude-code (drivers/claude-code.ts's EXECUTION_TOOLS). Confirmed against
 * both drivers' captured fixtures (test/fixtures/drivers/*). */
export const SHELL_TOOLS = new Set(["bash", "Bash"])

/** Pull the literal shell command out of a tool event's `args`. Duck-typed:
 * if `args` parses as JSON with a string `.command` field (claude-code's
 * shape), use that; otherwise treat `args` itself as the command text
 * (opencode's shape — plain, non-JSON already). */
function shellCommandText(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>)["command"]
      if (typeof command === "string") return command
    }
  } catch {
    /* not JSON — args IS the command, fall through */
  }
  return args
}

export interface ExtractedCommands {
  /** Ordered sh transcript, one entry per `t:"tool"` event. Shell-tool
   * entries are bare executable lines (unless truncated, in which case
   * they're a comment); non-shell-tool entries are always comments. */
  commands: string[]
  /** Indices into the INPUT `events` array (not into `commands`) of every
   * tool event whose `args` hit exactly `MAX_ARGS_CHARS` — non-replayable. */
  truncated: number[]
}

/**
 * Extract a replayable sh transcript from a captured trajectory. See the
 * file header for the truncation guard and shell-tool-detection rules.
 */
export function extractShellCommands(events: TrajEvent[]): ExtractedCommands {
  const commands: string[] = []
  const truncated: number[] = []

  events.forEach((ev, i) => {
    if (ev.t !== "tool") return // text/error events carry no invocation

    const tool = ev.tool ?? "unknown"
    const args = ev.args ?? ""
    const isCapped = args.length === MAX_ARGS_CHARS
    if (isCapped) truncated.push(i)

    if (SHELL_TOOLS.has(tool)) {
      if (isCapped) {
        commands.push(
          `# TRUNCATED ${tool} (args hit the ${MAX_ARGS_CHARS}-char capture cap — non-replayable, reconstruct manually): ${args}`,
        )
      } else {
        commands.push(shellCommandText(args))
      }
    } else {
      commands.push(`# ${tool}: ${args}`)
    }
  })

  return { commands, truncated }
}
