/**
 * bench/p2/rule.ts — the P2 Frozen Rule
 * (docs/superpowers/plans/2026-08-06-p2-actuator-binding.md §Frozen Rule)
 * plus its mechanical compliance predicate.
 *
 * P2_RULE_TEXT is byte-verbatim from the plan's frozen code fence — every
 * arm (A1/A3/A4) delivers this exact string, never a paraphrase. ruleSha()
 * stamps its sha256 into results so a future reader can confirm which
 * rule content a given run actually used, independent of this file's
 * history (the plan freezes the rule at commit; amendments are pre-first-
 * datum only, and recorded).
 *
 * isCompliant() implements the plan's anti-gaming compliance predicate
 * verbatim: DONE-CHECK.txt content is non-empty AND at least one of its
 * non-empty lines shares a >=8-char substring with some Bash-tool command
 * that actually ran (bashCommands). Checking only fixed-length 8-char
 * windows of the DONE-CHECK line (rather than all substrings of all
 * lengths) is sufficient for the plan's ">= 8 chars" criterion: any shared
 * substring of length >= 8 between a line L and a command C necessarily
 * contains at least one exact 8-char window of L (its own first 8
 * characters), and that window is itself a substring of C because it is a
 * prefix of the longer shared substring which is wholly contained in C.
 * So scanning only 8-char windows misses nothing a longer match would
 * catch. Echoing the rule text (or any prose that never ran as a command)
 * does not satisfy this by construction: the predicate never reads
 * P2_RULE_TEXT, only the caller-supplied bashCommands.
 *
 * bashCommandsFromEvents() is driver-neutral: it takes a structural subset
 * of harness-store.ts's TrajEvent (t/tool/args) rather than importing that
 * type, matching this task's brief ("events with tool names matching
 * /bash/i carry their command text"). claude-code's Bash tool events carry
 * a JSON-stringified `{command, ...}` in `args` (drivers/claude-code.ts);
 * opencode's bash events carry the raw command string directly in `args`
 * (drivers/opencode.ts). Both are unwrapped the same way traj-replay.ts's
 * (unexported) shellCommandText does it — duplicated here in miniature
 * rather than imported, since F1 keeps this module self-contained under
 * p2/ and traj-replay.ts does not export that helper.
 *
 * Deviation from task-2-brief.md's literal stub signature — recorded per
 * spec-is-law: the brief declares
 * `bashCommandsFromEvents(events: Array<{ tool?: string; command?: string }>)`,
 * but the real TrajEvent (harness-store.ts:615) has no `command` field —
 * the field is `args`, and claude-code's driver JSON-wraps it. Implemented
 * against the real shape per this task's explicit instruction to read the
 * type before asserting field names; TrajEvent[] is structurally
 * assignable to this function's parameter type, so callers can pass real
 * captured trajectories unchanged.
 */
import { createHash } from "node:crypto"

/** The Frozen Rule, byte-verbatim from the plan's code fence. Delivered by
 * every arm (A1 appended bullet, A3 gate message, A4 review prompt). */
export const P2_RULE_TEXT =
  "Before you finish, independently verify your work: run at least one\n" +
  "concrete check command against the actual artifacts (tests, a build, or\n" +
  "direct inspection of produced output) and write the command(s) you ran\n" +
  "and their observed result to /app/DONE-CHECK.txt. Your own reasoning\n" +
  "does not count as verification."

/** The frozen in-container path the rule tells the agent to write to. */
export const DONE_CHECK_PATH = "/app/DONE-CHECK.txt"

/** sha256 of P2_RULE_TEXT — the arm-content identity, stamped in results. */
export function ruleSha(): string {
  return createHash("sha256").update(P2_RULE_TEXT, "utf-8").digest("hex")
}

/** Anti-gaming threshold from the plan's Frozen Rule section — a shared
 * substring must be at least this many characters to count. */
const MIN_SHARED_CHARS = 8

/** True iff some MIN_SHARED_CHARS-length window of `line` is a substring
 * of at least one entry in `commands`. See file header for why scanning
 * only fixed-length windows of the line (not all substring lengths, and
 * not windows of the commands) is sufficient for the ">= 8 chars shared"
 * criterion. */
function sharesWindowWithSomeCommand(line: string, commands: string[]): boolean {
  for (let i = 0; i + MIN_SHARED_CHARS <= line.length; i++) {
    const window = line.slice(i, i + MIN_SHARED_CHARS)
    if (commands.some((c) => c.includes(window))) return true
  }
  return false
}

/**
 * Mechanical compliance: doneCheckContent is non-empty AND at least one of
 * its non-empty lines shares a >=8-char substring with some Bash-tool
 * command from bashCommands. Pure — the caller reads the file and extracts
 * the commands (e.g. via bashCommandsFromEvents below).
 */
export function isCompliant(doneCheckContent: string | undefined, bashCommands: string[]): boolean {
  if (!doneCheckContent) return false
  const lines = doneCheckContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return lines.some((line) => sharesWindowWithSomeCommand(line, bashCommands))
}

/** Pull the literal shell command text out of a captured `args` string.
 * Mirrors traj-replay.ts's (unexported) shellCommandText: if args parses
 * as JSON with a string `.command` field (claude-code's shape), use that;
 * otherwise args IS the command already (opencode's shape). */
function commandTextFromArgs(args: string): string {
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

/**
 * Extract Bash-tool command strings from parsed TrajEvents. Driver-neutral:
 * events whose `tool` name matches /bash/i (opencode's lowercase "bash",
 * claude-code's capitalized "Bash") carry their command text in `args`;
 * everything else (edit/grep/task/text/error events, or events with no
 * `tool` field at all) is skipped.
 */
export function bashCommandsFromEvents(events: Array<{ t?: string; tool?: string; args?: string }>): string[] {
  const commands: string[] = []
  for (const ev of events) {
    if (!ev.tool || !/bash/i.test(ev.tool)) continue
    commands.push(commandTextFromArgs(ev.args ?? ""))
  }
  return commands
}
