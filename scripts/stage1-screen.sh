#!/bin/bash
# Path A Stage-1 screen — executable form of
# docs/superpowers/plans/2026-08-03-path-a-stage1-runbook.md §4 (launch) + §3H
# (binding per-arm launch check). Lived in host-local scratch until 2026-08-03;
# moved into the repo so the procedure travels (CLAUDE.md rule).
#
# SPEND: 4 arms x 7 band tasks x k=1 = 28 sonnet trials. Requires its own
# explicit sized go — this script is the procedure, not the permission.
#
# Host knobs (defaults = yoo-dev office; override via env on another host):
#   KKAMAK_HOME     store root holding the v7/v13/v14/v15 candidates
#   TB_ROOT         terminal-bench-2 clone
#   SCREEN_SESSION  tmux session name for the runner
#
# §3H watchdog: arms run serially v7,v13,v14,v15 and each logs
# "Harness assembled (N chars)". Expected N per arm is derived from the
# committed seed texts (28-char account preamble + trimmed system.md).
# A mismatch means the wrong text is composed -> kill BEFORE that arm's
# trials count, reap orphan containers, exit non-zero.
set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${KKAMAK_HOME:=$REPO/.kkamak}"
: "${TB_ROOT:=/home/th-yoo/z2/terminal-bench-2}"
: "${SCREEN_SESSION:=stage1screen}"
LOG=${STAGE1_LOG:-/mnt/d/tmp/path-a-stage1-screen-$(date +%Y%m%d-%H%M).log}
EXPECTED=(394 2689 3233 2991)   # v7 v13 v14 v15 — runbook §3H table

echo "stage1-screen: repo=$(git -C "$REPO" rev-parse --short HEAD) store=$KKAMAK_HOME tb=$TB_ROOT log=$LOG"
echo "stage1-screen: alias mapping v13=s1 v14=s2 v15=s3; model anthropic/claude-sonnet-5" | tee -a "$LOG"

tmux new-session -d -s "$SCREEN_SESSION" "cd $REPO && \
  export KKAMAK_HOME=$KKAMAK_HOME && \
  export META_HARNESS_HOME=$KKAMAK_HOME && \
  bun term-bench2/runner.ts --tb-root $TB_ROOT screen \
    --layer account-global --candidates v7,v13,v14,v15 \
    --tasks path-tracing-reverse mailman headless-terminal sanitize-git-repo \
            query-optimize financial-document-processor sparql-university \
    --model anthropic/claude-sonnet-5 --layers account \
    --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
    --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on \
    --no-oauth-gate --no-pack-measured \
    >> $LOG 2>&1; echo DONE_EXIT=\$? >> $LOG"

i=0
while [ $i -lt 4 ]; do
  N=$(grep -o "Harness assembled ([0-9]* chars)" "$LOG" 2>/dev/null | sed -n "$((i+1))p" | grep -o "[0-9]\+")
  if [ -n "$N" ]; then
    if [ "$N" != "${EXPECTED[$i]}" ]; then
      echo "WATCHDOG FAIL: arm index $i assembled N=$N expected ${EXPECTED[$i]} — killing $(date)"
      tmux kill-session -t "$SCREEN_SESSION" 2>/dev/null
      sleep 5
      podman ps -a --format '{{.Names}}' | grep '^mh-' | xargs -r podman rm -f
      echo "WATCHDOG: killed + reaped. Fix, then re-invoke (screen resume skips complete arms)."
      exit 1
    fi
    echo "watchdog: arm $i assembled N=$N OK"
    i=$((i+1))
    continue
  fi
  if grep -q "^DONE_EXIT=" "$LOG" 2>/dev/null; then
    echo "watchdog: run ended before all 4 assembled lines (saw $i) — check $LOG"
    break
  fi
  sleep 20
done
echo "stage1-screen: watchdog done $(date); screen continues in tmux $SCREEN_SESSION; log $LOG"
