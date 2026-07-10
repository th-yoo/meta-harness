#!/usr/bin/env bash
# run-parallel.sh — launch N isolated concurrent `runner.py run` invocations,
# each on its own MH_BENCH_WORK sandbox root so they don't clobber each other.
#
# Usage:
#   bash run-parallel.sh [--dry-run] [RUNNER_ARGS...] -- MODEL:RESULTS_FILE [MODEL:RESULTS_FILE ...]
#
# Example (haiku + sonnet account-global baselines in parallel):
#   bash run-parallel.sh --task-file baseline-tasks.txt --layers account --max-agent-timeout 600 -- \
#     anthropic/claude-haiku-4-5:results/account-global-v0-baseline-haiku.json \
#     anthropic/claude-sonnet-4-6:results/account-global-v0-baseline-sonnet.json
#
# Each run gets MH_BENCH_WORK=$HOME/bench-runs/<results-stem> (always under $HOME
# — a /tmp root ELOOPs the sandbox). Never uses ~/bench (the shared default).
# Work dirs are removed on completion; --results-file (and its .log) persist.
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

pids=(); works=(); rfiles=()
for spec in "${SPECS[@]}"; do
  model="${spec%%:*}"; rfile="${spec#*:}"
  if [ -z "$model" ] || [ -z "$rfile" ] || [ "$model" = "$spec" ]; then
    echo "bad spec '$spec' — want MODEL:RESULTS_FILE" >&2; exit 2
  fi
  slug="$(basename "$rfile" .json)"
  work="$HOME/bench-runs/$slug"
  case "$work" in
    "$HOME"/*) : ;;
    *) echo "refuse: work dir '$work' is not under \$HOME" >&2; exit 2 ;;
  esac
  if [ "$work" = "$HOME/bench" ]; then
    echo "refuse: work dir resolves to ~/bench (the shared default)" >&2; exit 2
  fi
  cmd=(python3 "$SCRIPT_DIR/runner.py" run --model "$model" --results-file "$rfile" "${PASS_ARGS[@]}")
  if [ "$DRY" = 1 ]; then
    echo "MH_BENCH_WORK=$work ${cmd[*]}"
    continue
  fi
  mkdir -p "$work"
  MH_BENCH_WORK="$work" "${cmd[@]}" > "${rfile}.log" 2>&1 &
  pids+=("$!"); works+=("$work"); rfiles+=("$rfile")
  echo "launched $model → $rfile  (MH_BENCH_WORK=$work, pid $!)"
done
[ "$DRY" = 1 ] && exit 0

rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done

echo "=== results ==="
for rf in "${rfiles[@]}"; do
  pr=$(python3 -c "import json,sys;print(json.load(open('$rf')).get('pass_rate'))" 2>/dev/null || echo "?")
  echo "  $rf  pass_rate=$pr"
done
for w in "${works[@]}"; do rm -rf "$w"; done
exit $rc
