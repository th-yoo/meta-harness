#!/usr/bin/env bash
# check-concurrency.sh — token-free proof that per-run sandbox isolation holds.
# For each task, run TWO `runner.ts oracle` invocations concurrently and assert
# BOTH pass. `oracle` runs solve.sh (no LLM) through the same podman sandbox
# path as agent runs — each invocation gets its own container, so without
# isolation the two runs would clobber each other's /app,/tests,/logs and at
# least one would fail.
#
# Usage: bash check-concurrency.sh [TASK ...]   (default: sqlite-db-truncate)
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v podman >/dev/null 2>&1 || { echo "SKIP: podman unavailable"; exit 0; }

TASKS=("$@"); [ ${#TASKS[@]} -ge 1 ] || TASKS=(sqlite-db-truncate)
rc=0
for task in "${TASKS[@]}"; do
  ra_json="/tmp/cc-a-$task.json"; rb_json="/tmp/cc-b-$task.json"
  rm -f "$ra_json" "$rb_json"
  echo "── concurrent oracle: $task ──"
  bun "$SCRIPT_DIR/runner.ts" oracle --tasks "$task" --results-file "$ra_json" >"/tmp/cc-a-$task.log" 2>&1 &
  pa=$!
  bun "$SCRIPT_DIR/runner.ts" oracle --tasks "$task" --results-file "$rb_json" >"/tmp/cc-b-$task.log" 2>&1 &
  pb=$!
  wait "$pa"; wait "$pb"
  ra="$(jq -r --arg t "$task" '.tasks[$t].reward // "X"' "$ra_json" 2>/dev/null || echo X)"
  rb="$(jq -r --arg t "$task" '.tasks[$t].reward // "X"' "$rb_json" 2>/dev/null || echo X)"
  echo "  A reward=$ra   B reward=$rb"
  if [ "$ra" = "1" ] && [ "$rb" = "1" ]; then echo "  PASS $task"; else echo "  FAIL $task"; rc=1; fi
done
echo "=== concurrency proof $( [ $rc -eq 0 ] && echo PASS || echo FAIL) ==="
exit $rc
