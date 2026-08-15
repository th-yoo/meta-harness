/**
 * hook-rule-gate.ts — generates the in-container PreToolUse hook-rule
 * evaluator for the bench surface (hook-rule P1 plan, Task 7). Nothing in
 * this module runs INSIDE a container itself: it produces the `eval.sh`
 * TEXT that Task 8's cmd-run.ts wiring copies in, mirroring rule-gate.ts's
 * `buildRuleGateScript`/copy-in split exactly.
 *
 * Rule embedding: every per-rule field — including the two fully-formed
 * output JSON lines (deny / additionalContext, P0-verified shapes) — is
 * built at GENERATION time in TS and embedded as sh-single-quote-escaped
 * literals (rule-gate.ts's `shQuote`). The script never JSON-escapes or
 * parses the rule table at runtime — a JSON parser written in plain bash is
 * the fragile option this module avoids (rule-gate.ts module header).
 *
 * Input extraction (frozen contract 3): `tool_name` and the canonical input
 * field (`command` / `file_path`) are pulled from the stdin JSON by an awk
 * character-level scanner (embedded below) — string-aware, escape-aware,
 * brace-depth-tracked, binding the FIRST occurrence of the key at the
 * correct nesting level. This CLOSES the two P1 sed holes that were the
 * spec-§8 P3 gate item: (1) escaped quotes/backslashes in the value now
 * decode instead of truncating; (2) a later occurrence of the key name (a
 * nested object's own key) can no longer shadow the real field.
 *
 * Remaining residuals (documented, deliberately accepted):
 *  - \uXXXX escapes are left ENCODED in the extracted value (the scanner
 *    emits the literal `\uXXXX` text) — a pattern written against the
 *    decoded character won't match on the bench surface. Affects only
 *    patterns targeting non-ASCII input.
 *  - Glob/Grep's "JSON-serialized tool input" is the RAW input substring
 *    (balanced-brace capture), not a re-serialization — byte-identical to
 *    the dogfood evaluator's JSON.stringify only for compact single-line
 *    input, which is what Claude Code emits. Whitespace-formatted stdin
 *    would differ.
 *
 * Fail-open (spec law): the script ALWAYS exits 0 — malformed stdin, unknown
 * tool, unwritable outcomes dir, zero rules: all silent allows. A PreToolUse
 * hook only blocks via its stdout JSON, and only a deny-mode match (with
 * killSwitch off) ever emits one.
 *
 * Portability: bash 3.2 floor, same as rule-gate.ts's generated script — no
 * `set -u`/`set -e` (zero-length-array + fail-open), POSIX ERE only via
 * `[[ =~ ]]` with the pattern in a variable (the §2 birth screen guarantees
 * every exported pattern is POSIX-ERE-portable; this script never re-screens
 * — export-time enforcement, spec §3). The extractor needs only POSIX awk
 * (substr/length/-v — no gawk extensions; verified under macOS BSD awk,
 * present in the bench image's base toolchain).
 *
 * F2: outcomes.log carries `<id> <mode> <epoch-seconds>` per matched rule —
 * never the input text.
 */
import { shQuote } from "./rule-gate.ts"

/** Where the evaluator script + outcomes log live inside the container.
 * Overridable via the `HOOK_RULE_GATE_DIR` env var — baked into the
 * generated script as its default, read at script-runtime from the env for
 * testability (rule-gate.ts's `RULE_GATE_DIR` precedent). */
export const HOOK_RULE_GATE_DIR = "/app/.hookrule-gate"

/** One compiled-table rule (frozen contract 2's `rules[]` entry shape) —
 * a plain structural type on purpose: this module takes the parsed table as
 * an argument and imports nothing from the store lane. */
export interface HookRuleSpec {
  id: string
  toolMatcher: string
  inputPattern: string
  feedback: string
  mode: string
}

/** The P0-verified PreToolUse deny output (PROBE.md verdict A). */
function denyJson(feedback: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: feedback,
    },
  })
}

/** The P0-verified non-blocking context output (PROBE.md verdict B) — also
 * the killSwitch demotion target for a deny match (contract 3). */
function warnJson(feedback: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: feedback,
    },
  })
}

/**
 * Generate the full `eval.sh` text for one PreToolUse invocation. Evaluates
 * every embedded rule whose toolMatcher equals the call's tool (match =
 * violation, contract 3), logs each match to outcomes.log, then emits the
 * severest matched rule's output — first-by-embedded-order tiebreak, which
 * is id order (the exporter stable-sorts by numeric bullet id, contract 2).
 */
export function buildHookRuleEvalScript(rules: HookRuleSpec[], killSwitch: boolean): string {
  const idsLiteral = rules.map((r) => shQuote(r.id)).join(" ")
  const toolsLiteral = rules.map((r) => shQuote(r.toolMatcher)).join(" ")
  const patternsLiteral = rules.map((r) => shQuote(r.inputPattern)).join(" ")
  const modesLiteral = rules.map((r) => shQuote(r.mode)).join(" ")
  const denyLiteral = rules.map((r) => shQuote(denyJson(r.feedback))).join(" ")
  const warnLiteral = rules.map((r) => shQuote(warnJson(r.feedback))).join(" ")

  return `#!/bin/bash
# Generated by hook-rule-gate.ts (buildHookRuleEvalScript) — do not hand-edit.
# Fail-open contract: this script must ALWAYS exit 0; only its stdout JSON
# (deny-mode match, killSwitch off) ever blocks a tool call. No 'set -u'
# (bash 3.2 zero-length arrays) and no 'set -e' (any command failure must
# fall through to the silent allow).

HOOK_RULE_GATE_DIR="\${HOOK_RULE_GATE_DIR:-${HOOK_RULE_GATE_DIR}}"
mkdir -p "$HOOK_RULE_GATE_DIR" 2>/dev/null
OUTCOMES="$HOOK_RULE_GATE_DIR/outcomes.log"
KILL_SWITCH=${killSwitch ? 1 : 0}

RULE_IDS=(${idsLiteral})
RULE_TOOLS=(${toolsLiteral})
RULE_PATTERNS=(${patternsLiteral})
RULE_MODES=(${modesLiteral})
RULE_DENY_JSON=(${denyLiteral})
RULE_WARN_JSON=(${warnLiteral})

INPUT="$(cat 2>/dev/null)"

# JSON field extraction: character-level awk scanner (module header) —
# string-aware, escape-decoding, brace-depth-tracked, binding the FIRST
# occurrence of the key at depth 1 of the scanned text. mode=str prints the
# decoded string value; mode=obj prints the raw balanced object/array value.
# Residuals: \\uXXXX left encoded; obj capture is the raw substring.
JSON_EXTRACT_AWK='
{ buf = buf $0 "\\n" }
END {
  n = length(buf)
  depth = 0; inStr = 0; esc = 0; cur = ""; lastKey = ""; pend = 0
  capNext = 0; capping = 0; capStart = 0
  for (i = 1; i <= n; i++) {
    c = substr(buf, i, 1)
    if (inStr) {
      if (esc) {
        if (c == "n") cur = cur "\\n"
        else if (c == "t") cur = cur "\\t"
        else if (c == "r") cur = cur "\\r"
        else if (c == "b") cur = cur "\\b"
        else if (c == "f") cur = cur "\\f"
        else if (c == "u") cur = cur "\\\\u"
        else cur = cur c
        esc = 0
      } else if (c == "\\\\") esc = 1
      else if (c == "\\"") {
        inStr = 0
        if (depth == 1) {
          if (pend) {
            if (mode == "str" && lastKey == key) { print cur; exit }
            pend = 0; lastKey = ""
          } else lastKey = cur
        }
      } else cur = cur c
    } else {
      if (c == "\\"") { inStr = 1; cur = "" }
      else if (c == ":") {
        if (depth == 1) { pend = 1; if (mode == "obj" && lastKey == key) capNext = 1 }
      } else if (c == "{" || c == "[") {
        depth = depth + 1
        if (capNext && depth == 2) { capStart = i; capNext = 0; capping = 1 }
      } else if (c == "}" || c == "]") {
        depth = depth - 1
        if (capping && depth == 1) { printf "%s", substr(buf, capStart, i - capStart + 1); exit }
        if (depth == 1) { pend = 0; lastKey = "" }
      } else if (c == ",") {
        if (depth == 1) { pend = 0; lastKey = ""; capNext = 0 }
      }
    }
  }
}
'

json_extract() {
  awk -v mode="$1" -v key="$2" "$JSON_EXTRACT_AWK"
}

TOOL="$(printf '%s' "$INPUT" | json_extract str tool_name)"
[ -n "$TOOL" ] || exit 0

# Canonical input field per tool (frozen contract 3). command/file_path are
# extracted from INSIDE the tool_input object (obj capture, then str within
# it) so sibling or nested same-named keys elsewhere can never bind.
case "$TOOL" in
  Bash)
    VALUE="$(printf '%s' "$INPUT" | json_extract obj tool_input | json_extract str command)"
    ;;
  Edit|Write|Read)
    VALUE="$(printf '%s' "$INPUT" | json_extract obj tool_input | json_extract str file_path)"
    ;;
  Glob|Grep)
    # JSON-serialized tool input: the raw balanced object substring (keeps
    # the leading '{' so ^-anchored patterns see the same text shape as the
    # dogfood evaluator's JSON.stringify — byte-equal for the compact JSON
    # Claude Code emits; module-header residual).
    VALUE="$(printf '%s' "$INPUT" | json_extract obj tool_input)"
    ;;
  *)
    exit 0
    ;;
esac

BEST=-1
BEST_RANK=0
NOW="$(date +%s)"
i=0
while [ "$i" -lt "\${#RULE_IDS[@]}" ]; do
  if [ "\${RULE_TOOLS[$i]}" = "$TOOL" ]; then
    pat="\${RULE_PATTERNS[$i]}"
    if [[ "$VALUE" =~ $pat ]]; then
      # F2: id/mode/epoch only — never the input text.
      printf '%s %s %s\\n' "\${RULE_IDS[$i]}" "\${RULE_MODES[$i]}" "$NOW" 2>/dev/null >> "$OUTCOMES"
      case "\${RULE_MODES[$i]}" in
        deny) rank=3 ;;
        warn) rank=2 ;;
        *) rank=1 ;;
      esac
      # Strict > keeps the FIRST rule at the severest rank (id-order tiebreak).
      if [ "$rank" -gt "$BEST_RANK" ]; then
        BEST_RANK=$rank
        BEST=$i
      fi
    fi
  fi
  i=$((i + 1))
done

[ "$BEST" -ge 0 ] || exit 0

case "\${RULE_MODES[$BEST]}" in
  deny)
    if [ "$KILL_SWITCH" = "1" ]; then
      printf '%s\\n' "\${RULE_WARN_JSON[$BEST]}"
    else
      printf '%s\\n' "\${RULE_DENY_JSON[$BEST]}"
    fi
    ;;
  warn)
    printf '%s\\n' "\${RULE_WARN_JSON[$BEST]}"
    ;;
esac
exit 0
`
}

/** The `podman exec` argv TAIL for post-attempt outcomes readback — pairs
 * with `buildExecArgv(name, readHookRuleOutcomesArgs())` at the call site,
 * mirroring rule-gate.ts's `readRuleGateStateArgs` precedent exactly. */
export function readHookRuleOutcomesArgs(): string[] {
  return ["cat", `${HOOK_RULE_GATE_DIR}/outcomes.log`]
}
