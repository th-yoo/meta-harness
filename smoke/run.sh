#!/usr/bin/env bash
# run.sh — tmux TUI smoke suite for the meta-harness opencode plugin.
#
# Tier A (default): token-free scenarios — slash commands that never call the
#   model. Each runs in a fully isolated temp env (temp XDG + git-init'd temp
#   project); the user's real store is never touched.
# Tier B (opt-in, MH_SMOKE_LIVE=1): one cheap Haiku session for the autofill +
#   scoring surfaces, which require a real interactive session to render.
#
# Exits nonzero if any scenario fails. Skips cleanly (exit 0) if tmux/opencode
# are unavailable.
set -u
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SMOKE_DIR/lib/oc-driver.sh"
require_tools   # clean skip (exit 0) if tmux/opencode missing

pass=0; fail=0; failed_list=""

run_scenario() {
  local f="$1" name; name="$(basename "$f" .sh)"
  echo "▶ $name"
  if bash "$f"; then :; else fail=$((fail+1)); failed_list="$failed_list $name"; echo "  ✗ SCENARIO FAILED"; return; fi
  pass=$((pass+1))
}

echo "═══ tmux TUI smoke suite ═══"
echo "opencode: $(opencode --version 2>/dev/null)   tmux: $(tmux -V)"
echo

echo "── Tier A (token-free) ──"
for f in "$SMOKE_DIR"/tier-a/s*.sh; do run_scenario "$f"; done

if [ "${MH_SMOKE_LIVE:-0}" = "1" ]; then
  echo; echo "── Tier B (live, one Haiku session) ──"
  for f in "$SMOKE_DIR"/tier-b/*.sh; do [ -e "$f" ] && run_scenario "$f"; done
else
  echo; echo "── Tier B skipped (set MH_SMOKE_LIVE=1 to run the live autofill scenario) ──"
fi

echo
echo "═══ summary: $pass scenario(s) passed, $fail failed ═══"
if [ "$fail" -ne 0 ]; then
  echo "failed:$failed_list"
  exit 1
fi
