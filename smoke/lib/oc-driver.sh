#!/usr/bin/env bash
# oc-driver.sh — tmux primitives for driving the real opencode TUI. Shared by the
# smoke suite and usable for ad-hoc interactive driving.
#
# CRITICAL timing note: the harness has NO foreground `sleep`, and shell no-op
# loops (`for i in seq N; do :; done`) burn ~microseconds, NOT wall-clock. The
# opencode TUI needs real time to (a) finish painting and (b) become input-ready.
# Every wait here is therefore a poll that forks `tmux capture-pane` each
# iteration — those subprocess calls ARE the wall-clock. `oc_type` additionally
# send-verifies (retries the keystrokes until they actually appear on screen),
# because the first keystrokes after paint are otherwise silently dropped.
#
# Sources oc-env.sh (provides OC_PROJ + oc_env_prefix + mk/rm_oc_env).
# Requires: OC_SESSION set by oc_start.

set -u
_DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./oc-env.sh
source "$_DRIVER_DIR/oc-env.sh"

# Skip cleanly (exit 0) if the tools we need are missing.
require_tools() {
  local missing=""
  command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
  command -v opencode >/dev/null 2>&1 || missing="$missing opencode"
  command -v git >/dev/null 2>&1 || missing="$missing git"   # mk_oc_env needs `git init` for the worktree boundary
  if [ -n "$missing" ]; then
    echo "SKIP: missing required tool(s):$missing"
    exit 0
  fi
}

# oc_wait_for <regex> [max_poll=6000] — poll capture-pane until the rendered grid
# matches (extended regex). Returns 0 on match, 1 on timeout. The capture-pane
# forks are the real-time source.
oc_wait_for() {
  local re="$1" max="${2:-6000}" i
  for ((i=0; i<max; i++)); do
    tmux capture-pane -t "$OC_SESSION" -p 2>/dev/null | grep -Eq "$re" && return 0
  done
  return 1
}

# oc_capture — dump the rendered pane.
oc_capture() { tmux capture-pane -t "$OC_SESSION" -p 2>/dev/null; }

# oc_start [--model M] — launch opencode --agent mh-build in a detached pane on
# the isolated env, and block until the TUI paints. Requires mk_oc_env already
# called. Uses a wide pane so /mh-status (rendered in one toast bubble) doesn't
# wrap/clip.
oc_start() {
  local model="" cols="${OC_COLS:-200}" rows="${OC_ROWS:-50}"
  [ "${1:-}" = "--model" ] && { model="$2"; shift 2; }
  OC_SESSION="mh-smoke-$$-${RANDOM}"
  export OC_SESSION
  tmux kill-session -t "$OC_SESSION" 2>/dev/null
  eval "tmux new-session -d -s '$OC_SESSION' -x $cols -y $rows -c '$OC_PROJ' \"$(oc_env_prefix) opencode --agent mh-build ${model:+--model $model}\""
  oc_wait_for "Ask anything" 12000
}

# oc_type <text> [verify_regex] — type literal text into the input box, retrying
# until it actually appears (default verify = the text itself, escaped). Bounded.
# Returns 0 once landed, 1 if it never lands.
oc_type() {
  local text="$1" verify="${2:-}" attempt
  [ -z "$verify" ] && verify="$(printf '%s' "$text" | sed 's/[.[\*^$()+?{|]/\\&/g')"
  for attempt in 1 2 3 4 5 6 7 8; do
    tmux send-keys -t "$OC_SESSION" -l -- "$text"
    oc_wait_for "$verify" 1500 && return 0
    tmux send-keys -t "$OC_SESSION" C-u   # clear a partial/failed entry, retry
  done
  return 1
}

# oc_submit — press Enter (kept separate from typing so slash commands submit).
oc_submit() { tmux send-keys -t "$OC_SESSION" Enter; }

# oc_run_command <cmd-text> <success_regex> [max_enters=3] — type a slash command
# and press Enter until <success_regex> renders. This handles opencode's command
# completion palette uniformly: for a no-arg command (e.g. "/mh-status") the
# palette stays open and the FIRST Enter just closes it (a no-op — the plugin
# intercepts the command on submit, so a palette-closing Enter never reaches the
# model); a command WITH args auto-closes the palette so the first Enter submits.
# Polling <success_regex> after each Enter stops as soon as the plugin's toast
# appears, so no extra Enter is ever sent once the command has run. Returns 0 on
# match, 1 if it never renders.
oc_run_command() {
  local cmd="$1" re="$2" max="${3:-3}" k
  oc_type "$cmd" >/dev/null || return 1
  for ((k=0; k<max; k++)); do
    tmux send-keys -t "$OC_SESSION" Enter
    oc_wait_for "$re" 2500 && return 0
  done
  return 1
}

# oc_key <KEY...> — send special tmux key names (Escape, Tab, C-p, Up, Down, ...).
oc_key() { tmux send-keys -t "$OC_SESSION" "$@"; }

# oc_settle [poll_iters=2500] — burn real wall-clock (each capture-pane fork is
# the clock) to let a background trigger run before inspecting state. Matches a
# never-present pattern so it always runs the full budget.
oc_settle() { oc_wait_for "___never___settle___" "${1:-2500}" || true; }

# oc_kill — tear down the pane.
oc_kill() { tmux kill-session -t "$OC_SESSION" 2>/dev/null; return 0; }
