#!/usr/bin/env bash
# sync-task-copies.sh — stage generated copies of the seam-gate kernel into
# the gcode-to-text-gate probe task.
#
# Single source of truth stays term-bench2/seam-gate/ (this directory) --
# edit validator.py, spec_check.py, hook.py, or specs/gcode-to-text-gate.json
# HERE, then re-run this script to refresh the task's staged copies. Never
# hand-edit anything under probe-tasks/gcode-to-text-gate/environment/
# task-deps/seam/ directly; it's overwritten wholesale on every run.
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

# spec.json: JSON has no comment syntax, so the "generated copy" notice
# lives in a sibling README.md instead of inside the file.
cp "$here/specs/gcode-to-text-gate.json" "$dest/spec.json"
cat > "$dest/README.md" <<'EOF'
GENERATED COPY — source of truth: term-bench2/seam-gate/specs/gcode-to-text-gate.json

Edit the spec there and re-run term-bench2/seam-gate/sync-task-copies.sh to
refresh spec.json in this directory. (JSON has no comment syntax, hence this
sibling note instead of an in-file header like the .py copies get.)
EOF
echo "  specs/gcode-to-text-gate.json -> $dest/spec.json (+ $dest/README.md)"

echo "sync-task-copies: done -- $dest refreshed"
