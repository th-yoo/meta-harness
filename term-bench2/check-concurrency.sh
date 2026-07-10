#!/usr/bin/env bash
# check-concurrency.sh — token-free proof that per-run sandbox isolation holds.
# For each task, run TWO `runner.py oracle` invocations concurrently on distinct
# MH_BENCH_WORK roots (both under $HOME) and assert BOTH pass. `oracle` runs
# solve.sh (no LLM) through the same sandbox path, so without isolation the two
# runs would clobber each other's /app/tests/logs and at least one would fail.
#
# Usage: bash check-concurrency.sh [TASK ...]   (default: sqlite-db-truncate)
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v bwrap >/dev/null 2>&1 || { echo "SKIP: bwrap unavailable"; exit 0; }

TASKS=("$@"); [ ${#TASKS[@]} -ge 1 ] || TASKS=(sqlite-db-truncate)
rc=0
for task in "${TASKS[@]}"; do
  wa="$HOME/bench-test-a"; wb="$HOME/bench-test-b"
  rm -rf "$wa" "$wb"
  echo "── concurrent oracle: $task (A=$wa, B=$wb) ──"
  MH_BENCH_WORK="$wa" python3 "$SCRIPT_DIR/runner.py" oracle --tasks "$task" >"/tmp/cc-a-$task.log" 2>&1 &
  pa=$!
  MH_BENCH_WORK="$wb" python3 "$SCRIPT_DIR/runner.py" oracle --tasks "$task" >"/tmp/cc-b-$task.log" 2>&1 &
  pb=$!
  wait "$pa"; wait "$pb"
  ra="$(cat "$wa/logs/verifier/reward.txt" 2>/dev/null || echo X)"
  rb="$(cat "$wb/logs/verifier/reward.txt" 2>/dev/null || echo X)"
  echo "  A reward=$ra   B reward=$rb"
  if [ "$ra" = "1" ] && [ "$rb" = "1" ]; then echo "  PASS $task"; else echo "  FAIL $task"; rc=1; fi
  rm -rf "$wa" "$wb"
done
echo "=== concurrency proof $( [ $rc -eq 0 ] && echo PASS || echo FAIL) ==="
exit $rc
