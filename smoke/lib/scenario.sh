#!/usr/bin/env bash
# scenario.sh — shared helpers for a single tier-A smoke scenario. Each scenario
# script sources this, seeds fixtures, drives one slash command, and asserts on
# the rendered toast. Exit 0 = all checks passed, 1 = a check failed.
set -u
_SC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./oc-driver.sh
source "$_SC_DIR/oc-driver.sh"

RC=0

# env_up — isolated env + auto-teardown (kills the pane, removes the temp env).
_sc_cleanup() { oc_kill 2>/dev/null; rm_oc_env; }
env_up() { mk_oc_env; trap _sc_cleanup EXIT; }

# report <rc> <label> — record a check.
report() {
  if [ "$1" -eq 0 ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; RC=1; fi
}

# role_seed <relpath-under-project-role-root> <content> — drop a fixture into the
# seeded project-role (mh-build) store.
role_seed() {
  local abs="$OC_ROLE_ROOT/$1"
  mkdir -p "$(dirname "$abs")"
  printf '%s' "$2" > "$abs"
}

# A valid TrialState (trial v1 vs baseline v0) for the TRIAL-line / propose-guard
# scenarios.
TRIAL_JSON='{"trial":"v1","baseline":"v0","baselineSystem":"# baseline","baselineTools":"","startedAt":"2026-07-10T00:00:00.000Z","minSessions":5}'

# assert_no_spawn — TOKEN-FREE invariant guard. /mh-propose, /mh-curate and
# /mh-promote always toast "cycle started ✓" from the handler and then fire a
# BACKGROUND trigger; the trigger's own guard (trial-in-flight, or the promote
# evidence gate) is what prevents it from spawning a real opus proposer/curator/
# promoter session. This asserts that no such session was spawned — the isolated
# opencode log must contain exactly ONE created session (the main TUI session).
# Returns 0 (no spawn) or 1 (a spawn leaked — a real token cost).
assert_no_spawn() {
  local n L
  L="$(ls -t "$OC_DATA/opencode/log"/*.log 2>/dev/null | head -1)"
  [ -n "$L" ] || return 0   # no log at all → nothing was created
  # grep -c prints "0" and exits 1 on zero matches; capture the count directly
  # (do NOT `|| echo 99` — that appends a second line and breaks the [ -le ]).
  n="$(grep -cE 'message=created id=ses_' "$L" 2>/dev/null)"
  [ "${n:-0}" -le 1 ]
}
