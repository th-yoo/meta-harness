#!/usr/bin/env bash
# smoke-container.sh — Task 4 mechanical, in-container proof of the seam-gate
# Stop-hook wiring. NO model calls anywhere in this script: it stages the
# gcode-to-text-gate task's environment into a podman container (mirroring
# what environment/Dockerfile's COPY/RUN steps would do at build time),
# drops real oracle / bad artifact sets generated on the host via
# calibrate_gcode.py, and drives hook.py directly with synthetic Stop-hook
# stdin payloads -- proving the exit-code/stderr/budget contract end to end
# without ever invoking an agent.
#
# This is the task's acceptance evidence (Task 4 ruling #7). Prints PASS/FAIL
# per check and exits nonzero if any check fails.
#
# Usage: bash term-bench2/seam-gate/test/smoke-container.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEAM_GATE_DIR="$(cd "$HERE/.." && pwd)"
TASK_DEPS_SEAM="$SEAM_GATE_DIR/../probe-tasks/gcode-to-text-gate/environment/task-deps/seam"
TASK_DEPS_CLAUDE="$SEAM_GATE_DIR/../probe-tasks/gcode-to-text-gate/environment/task-deps/dot-claude"
GCODE_GZ="$SEAM_GATE_DIR/../probe-tasks/gcode-to-text-gate/environment/text.gcode.gz"

IMAGE="python:3.13-slim-bookworm"
# Documented per ruling #8: the bench's shared image (localhost/mh-bench, if
# present) was checked (`podman images | grep bench`) and found to be
# Ubuntu 24.04 / Python 3.12.3 with numpy NOT pre-installed -- i.e. neither
# base-image-accurate for this task (whose real Dockerfile FROMs
# python:3.13-slim-bookworm) nor a numpy shortcut. Using python:3.13-slim-
# bookworm directly instead, exactly as the task's own environment/
# Dockerfile does, and installing numpy at staging time same as the real
# build's `RUN pip install --quiet numpy` step.

CID=""
WORKDIR_HOST="$(mktemp -d)"

PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
  if [[ -n "$CID" ]]; then
    podman rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR_HOST"
}
trap cleanup EXIT

check() {
  # check <label> <cond: 0|1>
  local label="$1" cond="$2"
  if [[ "$cond" -eq 0 ]]; then
    echo "PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $label"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# --------------------------------------------------------------------------
# 0. Sanity: generated task-deps copies must exist (run sync-task-copies.sh
#    first if this fires).
# --------------------------------------------------------------------------
for f in validator.py spec_check.py hook.py spec.json; do
  if [[ ! -f "$TASK_DEPS_SEAM/$f" ]]; then
    echo "FAIL: prerequisite $TASK_DEPS_SEAM/$f missing -- run sync-task-copies.sh first"
    exit 1
  fi
done

echo "=== using image: $IMAGE ==="

# --------------------------------------------------------------------------
# 0.5. Real-parser staging check (Task-4 review CRITICAL fix): every other
#    step in this script hand-mirrors the intended staging with its own
#    podman commands -- it never actually parses environment/Dockerfile, so
#    a Dockerfile authored in a way the REAL runtime parser
#    (opencode-plugin/src/bench/staging.ts's parseTaskDockerfile) misreads
#    is invisible to it. This drives that unchanged parser over the task's
#    real Dockerfile and asserts the resolved pip package list is exactly
#    ["numpy"] and the COPY entries land where hook.py/the settings.json
#    hook expect. See check-dockerfile-staging.ts's header for the
#    regression this guards (a `|| echo "...install..."` fallback whose
#    prose contained the word "install" got misparsed as a second
#    pip-install marker).
# --------------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "FAIL: bun not found on PATH -- cannot run the real-parser staging check (check-dockerfile-staging.ts)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  bun "$HERE/check-dockerfile-staging.ts"
  check "real parseTaskDockerfile staging check (check-dockerfile-staging.ts)" "$?"
fi

# --------------------------------------------------------------------------
# 1. Generate ORACLE and BAD artifact sets on the HOST via calibrate_gcode.py
#    (its own module functions, not its CLI main() -- main()'s artifact
#    dirs are ephemeral TemporaryDirectory()s that get cleaned up before we
#    could copy them out).
# --------------------------------------------------------------------------
GCODE_PLAIN="$WORKDIR_HOST/text.gcode"
gzip -dc "$GCODE_GZ" > "$GCODE_PLAIN"

ORACLE_HOST="$WORKDIR_HOST/oracle"
BAD_HOST="$WORKDIR_HOST/bad"
mkdir -p "$ORACLE_HOST/.seam" "$BAD_HOST/.seam"

python3 - "$GCODE_PLAIN" "$ORACLE_HOST" "$BAD_HOST" "$SEAM_GATE_DIR" <<'PYEOF'
import sys
gcode_path, oracle_root, bad_root, seam_gate_dir = sys.argv[1:5]
sys.path.insert(0, seam_gate_dir)
import numpy as np
from calibrate_gcode import (
    collect_points, svd_plane_project, affine_residual_ratio,
    compute_cluster_rows, write_artifact_set, extract_cluster_predicate,
)
import json

with open(f"{seam_gate_dir}/specs/gcode-to-text-gate.json") as f:
    spec = json.load(f)
cell, _lo, _hi = extract_cluster_predicate(spec)

oracle_points, bad_points = collect_points(gcode_path)
if not oracle_points or not bad_points:
    print("ERROR: collect_points found no points -- fixture problem", file=sys.stderr)
    sys.exit(1)

oracle_proj = svd_plane_project(oracle_points, np)
oracle_ratio = affine_residual_ratio(oracle_points, np)
# Same BAD construction calibrate_gcode.py's own main() uses: correctly
# S0-scoped oracle points, but with raw x,y passed through as the
# "projection" instead of the real plane-basis projection -- reliably fails
# s4 (cluster_count_in_range) on this fixture (measured in Task 3).
bad_proj = np.array([[p[0], p[1]] for p in oracle_points], dtype=float)
bad_ratio = affine_residual_ratio(bad_points, np)

oracle_cluster_rows = compute_cluster_rows(oracle_proj, cell, np)
bad_cluster_rows = compute_cluster_rows(bad_proj, cell, np)

write_artifact_set(oracle_root, oracle_points, oracle_proj, oracle_ratio, oracle_cluster_rows)
write_artifact_set(bad_root, bad_points, bad_proj, bad_ratio, bad_cluster_rows)
print(f"oracle: {len(oracle_points)} points, bad: {len(bad_points)} points, cell={cell}")
PYEOF
GEN_STATUS=$?
if [[ $GEN_STATUS -ne 0 ]]; then
  echo "FAIL: host-side oracle/bad artifact generation failed"
  exit 1
fi
echo "generated oracle artifacts -> $ORACLE_HOST/.seam, bad artifacts -> $BAD_HOST/.seam"

# --------------------------------------------------------------------------
# 2. Start the container and stage the environment -- the setup_deps-
#    equivalent step. (See task-4-report.md "Dockerfile vs setup_deps.sh"
#    for why this mirrors environment/Dockerfile's COPY/RUN lines rather
#    than a literal setup_deps.sh script: the current harness runner
#    (opencode-plugin/src/bench/staging.ts) parses environment/Dockerfile
#    directly at runtime -- gen_setup_deps.py, which used to generate
#    physical setup_deps.sh files, was deleted in commit eeca01c during the
#    Bun-runner cutover, and no probe-task in this repo has one anymore.)
# --------------------------------------------------------------------------
CID="$(podman run -d --network bridge --name "seamgate-smoke-$$" "$IMAGE" sleep 3600)"
echo "container: $CID"

podman exec "$CID" mkdir -p /app/.seam /app/.claude

podman cp "$TASK_DEPS_SEAM/validator.py" "$CID:/app/.seam/validator.py"
podman cp "$TASK_DEPS_SEAM/spec_check.py" "$CID:/app/.seam/spec_check.py"
podman cp "$TASK_DEPS_SEAM/hook.py" "$CID:/app/.seam/hook.py"
podman cp "$TASK_DEPS_SEAM/spec.json" "$CID:/app/.seam/spec.json"
podman cp "$TASK_DEPS_CLAUDE/settings.json" "$CID:/app/.claude/settings.json"

podman exec "$CID" pip install --quiet numpy
NUMPY_INSTALL_STATUS=$?
check "setup_deps-equivalent staging: numpy installed" "$NUMPY_INSTALL_STATUS"

# --------------------------------------------------------------------------
# Helper: run hook.py inside the container with a synthetic Stop payload on
# stdin. Prints "EXIT <code>" on its own line to stdout so the caller can
# separate hook stdout/stderr from the exit-code marker cleanly.
# --------------------------------------------------------------------------
run_hook() {
  local stop_hook_active="$1"  # "true" or "false"
  local payload
  payload=$(printf '{"session_id":"smoke-test","transcript_path":"/tmp/does-not-matter.jsonl","hook_event_name":"Stop","stop_hook_active":%s}' "$stop_hook_active")
  printf '%s' "$payload" | podman exec -i "$CID" python3 /app/.seam/hook.py
}

copy_artifacts() {
  # copy_artifacts <host_seam_dir>
  local host_dir="$1"
  podman cp "$host_dir/.seam/points.txt" "$CID:/app/.seam/points.txt"
  podman cp "$host_dir/.seam/projected.txt" "$CID:/app/.seam/projected.txt"
}

reset_counter() {
  podman exec "$CID" sh -c 'echo 0 > /app/.seam/state'
}

# --------------------------------------------------------------------------
# 3. Oracle artifacts -> hook.py must exit 0 (all seams pass).
# --------------------------------------------------------------------------
copy_artifacts "$ORACLE_HOST"
reset_counter
HOOK_OUT="$(mktemp)"
HOOK_ERR="$(mktemp)"
run_hook "false" >"$HOOK_OUT" 2>"$HOOK_ERR"
CODE=$?
echo "  [oracle] exit=$CODE stdout=$(cat "$HOOK_OUT" | tr '\n' ' ') stderr=$(cat "$HOOK_ERR" | tr '\n' ' ')"
check "oracle artifacts -> hook.py exits 0" "$([[ $CODE -eq 0 ]] && echo 0 || echo 1)"

# --------------------------------------------------------------------------
# 4. Bad artifacts -> call #1: hook.py must exit 2, stderr must mention a
#    seam id (a "SEAM sN FAIL" line).
# --------------------------------------------------------------------------
copy_artifacts "$BAD_HOST"
run_hook "false" >"$HOOK_OUT" 2>"$HOOK_ERR"
CODE=$?
echo "  [bad #1] exit=$CODE stderr=$(cat "$HOOK_ERR" | tr '\n' ' ')"
check "bad artifacts (call 1) -> hook.py exits 2" "$([[ $CODE -eq 2 ]] && echo 0 || echo 1)"
check "bad artifacts (call 1) -> stderr mentions a seam id" "$(grep -Eq 'SEAM s[0-9]+ FAIL' "$HOOK_ERR" && echo 0 || echo 1)"

# --------------------------------------------------------------------------
# 5. Budget: two more calls with bad artifacts still in place. Call #2 still
#    under budget (must still exit 2); call #3 hits the budget (counter now
#    2 >= BUDGET) and must exit 0 with a notice on stdout.
# --------------------------------------------------------------------------
run_hook "false" >"$HOOK_OUT" 2>"$HOOK_ERR"
CODE=$?
echo "  [bad #2] exit=$CODE"
check "bad artifacts (call 2, still under budget) -> hook.py exits 2" "$([[ $CODE -eq 2 ]] && echo 0 || echo 1)"

run_hook "false" >"$HOOK_OUT" 2>"$HOOK_ERR"
CODE=$?
echo "  [bad #3 / budget] exit=$CODE stdout=$(cat "$HOOK_OUT" | tr '\n' ' ')"
check "bad artifacts (call 3) -> budget exhausted, hook.py exits 0" "$([[ $CODE -eq 0 ]] && echo 0 || echo 1)"
check "bad artifacts (call 3) -> stdout contains budget notice" "$(grep -qi 'budget' "$HOOK_OUT" && echo 0 || echo 1)"

# --------------------------------------------------------------------------
# 6. Corrupt spec.json -> hook.py must exit 0 (fail-open on the validator's
#    own internal-error path). Reset the block counter first so this check
#    is isolated from step 5's budget exhaustion (otherwise exit 0 would be
#    ambiguous between "budget skip" and "validator fail-open").
# --------------------------------------------------------------------------
reset_counter
podman exec "$CID" sh -c 'echo "not valid json {{{" > /app/.seam/spec.json'
run_hook "false" >"$HOOK_OUT" 2>"$HOOK_ERR"
CODE=$?
echo "  [corrupt spec] exit=$CODE stdout=$(cat "$HOOK_OUT" | tr '\n' ' ')"
check "corrupt spec.json -> hook.py fails open, exits 0" "$([[ $CODE -eq 0 ]] && echo 0 || echo 1)"

rm -f "$HOOK_OUT" "$HOOK_ERR"

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo "=================================================="
echo "smoke-container: $PASS_COUNT passed, $FAIL_COUNT failed"
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
