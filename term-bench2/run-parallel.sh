#!/usr/bin/env bash
# run-parallel.sh — launch N concurrent `runner.ts run` invocations.
# The podman sandbox gives every task attempt its own container, so concurrent
# runs are isolated natively; each spec only needs its own --results-file.
#
# Usage:
#   bash run-parallel.sh [--dry-run] [RUNNER_ARGS...] -- MODEL:RESULTS_FILE [MODEL:RESULTS_FILE ...]
#
# Example (haiku + sonnet account-global baselines in parallel):
#   bash run-parallel.sh --task-file baseline-tasks.txt --layers account --max-agent-timeout 600 -- \
#     anthropic/claude-haiku-4-5:results/account-global-v0-baseline-haiku.json \
#     anthropic/claude-sonnet-4-6:results/account-global-v0-baseline-sonnet.json
#
# Each run logs to <results-file>.log; pass rates are printed at the end.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY=0
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done
SPECS=("$@")
[ ${#SPECS[@]} -ge 1 ] || { echo "usage: run-parallel.sh [--dry-run] [RUNNER_ARGS] -- MODEL:RESULTS_FILE ..." >&2; exit 2; }

pids=(); rfiles=()
for spec in "${SPECS[@]}"; do
  model="${spec%%:*}"; rfile="${spec#*:}"
  if [ -z "$model" ] || [ -z "$rfile" ] || [ "$model" = "$spec" ]; then
    echo "bad spec '$spec' — want MODEL:RESULTS_FILE" >&2; exit 2
  fi
  cmd=(bun "$SCRIPT_DIR/runner.ts" run --model "$model" --results-file "$rfile" "${PASS_ARGS[@]}")
  if [ "$DRY" = 1 ]; then
    echo "${cmd[*]}"
    continue
  fi
  "${cmd[@]}" > "${rfile}.log" 2>&1 &
  pids+=("$!"); rfiles+=("$rfile")
  echo "launched $model → $rfile  (pid $!)"
done
[ "$DRY" = 1 ] && exit 0

rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done

echo "=== results ==="
for rf in "${rfiles[@]}"; do
  pr=$(jq -r '.pass_rate // "?"' "$rf" 2>/dev/null || echo "?")
  echo "  $rf  pass_rate=$pr"
done
exit $rc
