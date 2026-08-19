#!/usr/bin/env bash
# sync-task-copies.sh — stage generated copies of the seam-gate kernel's CODE
# files into the gcode-to-text-gate probe task.
#
# Single source of truth stays term-bench2/seam-gate/ (this directory) --
# edit validator.py, spec_check.py, or hook.py HERE, then re-run this script
# to refresh the task's staged copies. Never hand-edit the copies under
# probe-tasks/gcode-to-text-gate/environment/task-deps/seam/ directly; they
# are overwritten wholesale on every run.
#
# spec.json is DELIBERATELY OUT OF SCOPE here (rung-4 Task 5 ruling): which
# spec.json a task arm ships -- the Task-3 curated spec, or a probe-generated
# spec that passed calibrate_gcode.py --check-only -- is an explicit per-arm
# decision recorded in that arm's verdict, not something this script should
# silently overwrite on every run. Deploying (or reverting) spec.json is a
# manual `cp` + a provenance note in task-deps/seam/README.md, done by
# whichever task/ruling makes that call. See
# docs/loop-probes/census-e2e-20260819/gcode-card/verdict.md ("v4 seamSpec"
# section) for the precedent this guard exists to protect.
#
# Usage: bash term-bench2/seam-gate/sync-task-copies.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../probe-tasks/gcode-to-text-gate/environment/task-deps/seam"
mkdir -p "$dest"

HEADER='# GENERATED COPY — source of truth: term-bench2/seam-gate/ — edit there and re-run sync-task-copies.sh'

# Python files: insert the header right after the shebang line (line 1) so
# the file still execs correctly as a script if anything ever invokes it
# directly, rather than always via `python3 <path>`.
copy_py_with_header() {
  local src="$1" name="$2"
  { head -n 1 "$here/$src"; echo "$HEADER"; tail -n +2 "$here/$src"; } > "$dest/$name"
  echo "  $src -> $dest/$name"
}

copy_py_with_header "validator.py" "validator.py"
copy_py_with_header "spec_check.py" "spec_check.py"
copy_py_with_header "hook.py" "hook.py"
copy_py_with_header "readers.py" "readers.py"

echo "sync-task-copies: done -- $dest refreshed (code files only; spec.json deployment is explicit per-arm, see header comment)"
