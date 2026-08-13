/**
 * rule-gate.ts — generates the in-container Stop-hook gate for a3
 * (a3-rule-routing-tb2 plan, Task 6). Nothing in this module runs INSIDE a
 * container itself: it produces two artifacts that Task 7's wiring copies
 * in (mirroring p2/cmd-p2.ts's `STOP_GATE_SETTINGS_PATH` copy-in precedent,
 * this file's header) —
 *
 *  - `buildRuleGateScript(checks)` — bash script TEXT (`check.sh`) that runs
 *    each structured-bullet check in order and enforces the round cap.
 *  - `buildRuleGateSettings()` — settings.json TEXT whose single Stop hook
 *    invokes that script (`bash /app/.rule-gate/check.sh`).
 *
 * Round-cap contract (plan-review fix — the load-bearing detail of this
 * file): COMPARE-then-increment, mirroring cc-gate-plugin's own
 * `src/core/stop.ts:122` (`if (state.round < cfg.rounds)` checked BEFORE
 * `state.round + 1` is computed) — NOT increment-then-compare, which would
 * exhaust the gate after a single block instead of two. Concretely, with
 * `RULE_GATE_ROUNDS_CAP = 2`:
 *   - pre-increment rounds=0 (1st failure): 0 < 2 → rounds→1, BLOCK (exit 2)
 *   - pre-increment rounds=1 (2nd failure): 1 < 2 → rounds→2, BLOCK (exit 2)
 *   - pre-increment rounds=2 (3rd failure): 2 >= 2 → rounds→3, EXHAUSTED,
 *     ALLOW (exit 0) — three failures total gate the session shut for two
 *     rounds, then let it through on the third.
 *
 * Check embedding: cmd text is embedded directly in the generated bash
 * source as sh-single-quote-escaped literals (`shQuote` below), NOT a JSON
 * sidecar parsed by hand-rolled bash — a JSON parser written in plain bash
 * is the fragile option this file avoids. `shQuote` uses the standard
 * close-escape-reopen trick (`'` → `'\''`) so a cmd containing single quotes
 * survives byte-for-byte; `bash -c "$cmd"` then interprets the
 * reconstructed string as ordinary shell text, no re-escaping needed at
 * that point.
 *
 * Portability: the generated script implements its own per-check timeout
 * (background job + a `sleep`-and-`kill` watchdog) instead of shelling out
 * to coreutils `timeout` — the production target (the bench Linux
 * container) has it, but this project's own dev host (macOS, no
 * coreutils package installed) does not, and Task 6's Step-1 tests spawn
 * this script's REAL bash locally (no fakes) per the brief. A self-
 * contained watchdog behaves identically in both places and needs no
 * `command -v` branching. The generated script also avoids bash>=4
 * features (no `declare -A`, no `${var,,}`) and drops `set -u` (bash 3.2's
 * `"${arr[@]}"` on a zero-length array is a footgun under `set -u`) so it
 * runs unmodified under both macOS's stock `/bin/bash` (3.2) and a modern
 * container bash (5.x).
 *
 * Process-group kill (fix round 1, review finding): the watchdog doesn't
 * just `kill` the check's direct pid — `run_one` (below) puts each check in
 * its OWN process group via `set -m` and kills the whole group (`kill -TERM
 * -"$pid"`), mirroring GNU `timeout`'s own default (group, not single-pid)
 * behavior. A bare single-pid kill orphans anything the check backgrounds —
 * a live repro showed a check's backgrounded grandchild still writing to
 * disk ~5s after check.sh had already exited 2, and the bench container is
 * long-lived across many Stop cycles, so that leak accumulates. No
 * `setsid` (not guaranteed on the bench image or POSIX) — job control is a
 * bash builtin present in both 3.2 and 5.x.
 *
 * F2 (state.json never carries cmd text): `state.json` stores only
 * `{rounds, exhausted, perRule: {<bulletId>: {blocked, lastFail}}}` — counts
 * and an ISO timestamp, keyed by bulletId. `perRule` tracks the MOST
 * RECENTLY failing bulletId's entry only (a deliberate scope cut — see this
 * task's report); the primary gate signal (`rounds`/`exhausted`/exit code)
 * is unaffected by that cut and is what Step 1's tests pin.
 */

/** Where the gate's state + generated script live inside the container.
 * Overridable via the `RULE_GATE_DIR` env var — baked into the generated
 * script as its default, and read at script-runtime from the env for
 * testability (Step-1 tests point it at a temp dir). */
export const RULE_GATE_DIR = "/app/.rule-gate"

/** Block for this many failures before allowing through exhausted (a THIRD
 * failure is the one that exhausts — see module header). */
export const RULE_GATE_ROUNDS_CAP = 2

/** Tail cap (bytes) on the failing check's captured stdout+stderr printed
 * to fd 2 as block evidence. */
const MAX_EVIDENCE_BYTES = 2048

export interface RuleGateCheck {
  bulletId: string
  cmd: string
  timeoutMs: number
}

/** sh single-quote escaping: wrap in `'...'`, replacing each embedded `'`
 * with the standard close-escape-reopen sequence `'\''`. Round-trips any
 * byte sequence (no NUL) back to the exact original string when bash parses
 * the resulting literal — this is what lets a cmd containing single quotes
 * survive script generation. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** timeoutMs -> a plain decimal seconds literal for the watchdog `sleep`
 * argument (fractional seconds are fine — both GNU and macOS `sleep`
 * accept them). */
function toSeconds(timeoutMs: number): string {
  return String(timeoutMs / 1000)
}

/**
 * Generate the full `check.sh` text for one Stop-hook invocation. Iterates
 * `checks` in order; the FIRST one that fails drives the round-cap decision
 * (compare-then-increment, module header) and the script stops there — it
 * never runs checks past the first failure. All checks passing exits 0
 * with NO state.json write (brief: "All pass -> reset nothing, exit 0").
 */
export function buildRuleGateScript(checks: RuleGateCheck[]): string {
  const idsLiteral = checks.map((c) => shQuote(c.bulletId)).join(" ")
  const cmdsLiteral = checks.map((c) => shQuote(c.cmd)).join(" ")
  const secsLiteral = checks.map((c) => shQuote(toSeconds(c.timeoutMs))).join(" ")

  return `#!/bin/bash
# Generated by rule-gate.ts (buildRuleGateScript) — do not hand-edit.
# No 'set -u': bash 3.2's "\${arr[@]}" on a zero-length array errors under
# set -u (fixed only in bash 4.4+) — this script must run unmodified on
# macOS's stock /bin/bash (3.2) as well as a modern container bash.
set -o pipefail

RULE_GATE_DIR="\${RULE_GATE_DIR:-${RULE_GATE_DIR}}"
mkdir -p "$RULE_GATE_DIR"
STATE_FILE="$RULE_GATE_DIR/state.json"
OUT_FILE="$RULE_GATE_DIR/.check-out"
ROUNDS_CAP=${RULE_GATE_ROUNDS_CAP}
MAX_EVIDENCE=${MAX_EVIDENCE_BYTES}

CHECK_IDS=(${idsLiteral})
CHECK_CMDS=(${cmdsLiteral})
CHECK_SECS=(${secsLiteral})

# Self-contained per-check timeout (module header: no coreutils 'timeout'
# dependency). $1=cmd $2=secs; combined stdout+stderr -> $OUT_FILE; returns
# the check's own exit code (143/SIGTERM-ish on a real timeout).
#
# Process-GROUP kill (fix round 1): 'set -m' (job control) makes the
# backgrounded 'bash -c "$1"' the leader of a FRESH process group (pgid ==
# its own pid) instead of sharing check.sh's group — the same thing GNU
# coreutils 'timeout' does by default. A negative pid in 'kill' targets the
# whole group, so anything the check itself backgrounds (a grandchild) dies
# with it; a bare 'kill -TERM "$pid"' (no leading '-') only ever hits that
# one pid and orphans descendants — exactly the leak a live repro caught
# (a check backgrounding a sleep+marker-writer kept writing ~5s after
# check.sh had already exited). No 'setsid' (not guaranteed on the bench
# image or POSIX) — job control is a bash builtin, present in 3.2 and 5.x
# alike. Applied after EVERY check, not just a timed-out one: a check that
# finishes on its own can equally leave a backgrounded grandchild running,
# and the container is long-lived across Stop cycles, so that leaks too.
# The escalation-to-KILL grace timer is fire-and-forgotten (own stdin/
# stdout/stderr, none of check.sh's own pipes) so it adds no wall-clock
# cost to run_one itself — group cleanup finishes on its own schedule after
# this function (and often the whole script) has already returned.
run_one() {
  : > "$OUT_FILE"
  set -m
  bash -c "$1" >"$OUT_FILE" 2>&1 &
  local pid=$!
  set +m
  ( sleep "$2"; kill -TERM -"$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  kill -TERM -"$pid" 2>/dev/null
  ( sleep 0.3; kill -KILL -"$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  return "$rc"
}

FAIL_INDEX=-1
i=0
while [ "$i" -lt "\${#CHECK_IDS[@]}" ]; do
  if run_one "\${CHECK_CMDS[$i]}" "\${CHECK_SECS[$i]}"; then
    i=$((i + 1))
  else
    FAIL_INDEX=$i
    break
  fi
done

if [ "$FAIL_INDEX" -lt 0 ]; then
  # All checks passed — reset nothing (brief: no state.json write at all).
  exit 0
fi

FAIL_ID="\${CHECK_IDS[$FAIL_INDEX]}"
EVIDENCE="$(tail -c "$MAX_EVIDENCE" "$OUT_FILE" 2>/dev/null)"

# Read prior rounds (0 if state.json absent/unparseable) — we are the only
# writer of this file and always write the same compact single-line shape,
# so a plain grep suffices (no jq / hand-rolled JSON parser).
CUR_ROUNDS=0
if [ -f "$STATE_FILE" ]; then
  FOUND_ROUNDS="$(grep -o '"rounds":[0-9]*' "$STATE_FILE" | head -1 | grep -o '[0-9]*$')"
  if [ -n "$FOUND_ROUNDS" ]; then
    CUR_ROUNDS="$FOUND_ROUNDS"
  fi
fi

# Prior blocked-count for THIS bulletId specifically (perRule tracks only
# the most-recently-failing bulletId's entry — F2 counts-only scope cut,
# see module header). A different bulletId failing now starts its own
# count fresh at 1, which is correct: it's a distinct rule.
PREV_BLOCKED=0
if [ -f "$STATE_FILE" ]; then
  FOUND_BLOCKED="$(grep -o "\\"$FAIL_ID\\":{\\"blocked\\":[0-9]*" "$STATE_FILE" | grep -o '[0-9]*$')"
  if [ -n "$FOUND_BLOCKED" ]; then
    PREV_BLOCKED="$FOUND_BLOCKED"
  fi
fi
NEW_BLOCKED=$((PREV_BLOCKED + 1))
NEW_ROUNDS=$((CUR_ROUNDS + 1))
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Compare-THEN-increment (module header): CUR_ROUNDS (pre-increment) decides
# block vs exhausted; NEW_ROUNDS (post-increment) is what gets persisted.
if [ "$CUR_ROUNDS" -lt "$ROUNDS_CAP" ]; then
  EXHAUSTED_JSON=false
else
  EXHAUSTED_JSON=true
fi

printf '{"rounds":%d,"exhausted":%s,"perRule":{"%s":{"blocked":%d,"lastFail":"%s"}}}\\n' \\
  "$NEW_ROUNDS" "$EXHAUSTED_JSON" "$FAIL_ID" "$NEW_BLOCKED" "$NOW" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"

if [ "$CUR_ROUNDS" -lt "$ROUNDS_CAP" ]; then
  printf '%s\\n' "$EVIDENCE" 1>&2
  exit 2
else
  echo "rule-gate: exhausted after ${RULE_GATE_ROUNDS_CAP} blocks" 1>&2
  exit 0
fi
`
}

/** settings.json text whose single Stop hook runs the generated script —
 * mirrors p2/assets/stop-gate-settings.json's exit-2/stderr-evidence shape
 * (that file's header, cmd-p2.ts's `STOP_GATE_SETTINGS_PATH` copy-in), but
 * this one is DYNAMIC text (the command line is fixed, not per-check) since
 * all per-check content lives in check.sh, not settings.json. */
export function buildRuleGateSettings(): string {
  return (
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: `bash ${RULE_GATE_DIR}/check.sh`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  )
}

/** The `podman exec` argv TAIL for post-attempt state readback — pairs with
 * `buildExecArgv(name, readRuleGateStateArgs())` at the call site (no
 * container name is available to this pure function), mirroring
 * self-score.ts's `readSelfScore` / p2/cmd-p2.ts's `gatherEvidence`
 * `execFn(buildExecArgv(name, ["cat", ...]))` precedent exactly. */
export function readRuleGateStateArgs(): string[] {
  return ["cat", `${RULE_GATE_DIR}/state.json`]
}
