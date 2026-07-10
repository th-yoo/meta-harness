#!/usr/bin/env bash
# watch.sh — launch a VISIBLE (attachable) opencode TUI session in the isolated
# smoke env, so a human can watch (or take over) what the agent drives. tmux
# "-d" is detached-not-headless: the session is live and shared, so
# `tmux attach -t mh-watch` from any terminal on this machine shows it in real
# time. Detach with Ctrl-b d (leaves it running).
#
# Usage:
#   bash smoke/watch.sh            # start the session, print the attach command,
#                                  # keep it alive until you press Enter here
#   bash smoke/watch.sh --status   # also drive /mh-status so there's something to see
#
# Cleanup happens on exit (kills the pane + removes the temp env).
set -u
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SMOKE_DIR/lib/oc-driver.sh"
require_tools

mk_oc_env
OC_SESSION=mh-watch
export OC_SESSION
trap 'oc_kill; rm_oc_env' EXIT

tmux kill-session -t mh-watch 2>/dev/null
eval "tmux new-session -d -s mh-watch -x 200 -y 50 -c '$OC_PROJ' \"$(oc_env_prefix) opencode --agent mh-build\""
oc_wait_for "Ask anything" 12000 || { echo "opencode did not start"; exit 1; }

if [ "${1:-}" = "--status" ]; then
  oc_run_command "/mh-status" "project-role: active=v0" || true
fi

cat <<EOF

  opencode is running in tmux session 'mh-watch' (isolated env: $OC_PROJ).
  Watch it from another terminal on this machine:

      tmux attach -t mh-watch

  Detach with Ctrl-b then d. The session is shared — you can type in it too.

  Press Enter here to stop and clean up.
EOF
read -r _
