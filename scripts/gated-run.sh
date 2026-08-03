#!/bin/bash
# Generic gated launcher for sized-go spend chains. Replaces the family of
# one-off `*-autolaunch.sh` scripts that used to live in host-local scratch
# (/mnt/d/tmp) and therefore did NOT travel between hosts (CLAUDE.md rule:
# reusable procedure -> the repo).
#
# Shape: wait for prerequisite markers -> poll until every required model
# tier is available (probe-fidelity: the models THIS batch calls) -> run the
# command -> touch a completion marker other links can gate on.
#
#   scripts/gated-run.sh --name retry112 \
#     --models claude-haiku-4-5 \
#     --after /tmp/kkamak/gauge-verify.done \
#     --marker /tmp/kkamak/retry112.done \
#     -- bun cc-gate-plugin/src/gauge/replay-cli.ts derive --go 112
#
# Flags:
#   --name <label>          log prefix (required)
#   --models a[,b,...]      model ids to probe; ALL must be OK before running
#   --after f[,g,...]       marker files that must exist first (ordering gate)
#   --marker <file>         touched after the command exits (any status)
#   --interval <seconds>    poll interval, default 300
#   -- <command...>         everything after `--` is the command, run from repo root
#
# WARNING (learned the hard way 2026-08-03): never edit this file, or any
# script, while a tmux session is running it — bash re-reads the file at a
# stale byte offset and the session dies silently, leaving a frozen log.
# Kill the session FIRST, then edit, then relaunch.
#
# Cost note: probing is free (a 429 is rejected pre-inference); only a
# success spends ~20 tokens per model per poll.
set -uo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/probe-models.sh"

NAME="" MODELS="" AFTER="" MARKER="" INTERVAL=300
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=$2; shift 2 ;;
    --models) MODELS=$2; shift 2 ;;
    --after) AFTER=$2; shift 2 ;;
    --marker) MARKER=$2; shift 2 ;;
    --interval) INTERVAL=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "gated-run: unknown flag $1" >&2; exit 2 ;;
  esac
done
[ -n "$NAME" ] || { echo "gated-run: --name is required" >&2; exit 2; }
[ $# -gt 0 ] || { echo "gated-run: no command given after --" >&2; exit 2; }

log() { echo "[$NAME $(date +%H:%M:%S)] $*"; }
log "armed (models=${MODELS:-none} after=${AFTER:-none} marker=${MARKER:-none})"

if [ -n "$AFTER" ]; then
  while true; do
    missing=""
    IFS=, read -ra deps <<< "$AFTER"
    for d in "${deps[@]}"; do [ -f "$d" ] || missing="$missing $d"; done
    [ -z "$missing" ] && break
    log "waiting on marker(s):$missing"
    sleep "$INTERVAL"
  done
  log "prerequisite markers present"
fi

if [ -n "$MODELS" ]; then
  IFS=, read -ra models <<< "$MODELS"
  while ! all_ok "${models[@]}"; do
    log "not all required tiers available — holding"
    sleep "$INTERVAL"
  done
  log "all required tiers clear"
fi

cd "$REPO"
log "running: $*"
"$@"
STATUS=$?
log "command exit=$STATUS"
[ -n "$MARKER" ] && mkdir -p "$(dirname "$MARKER")" && touch "$MARKER" && log "marker touched: $MARKER"
log "done"
exit $STATUS
