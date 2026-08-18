#!/bin/bash
# Install (rsync) every probe task into the sibling terminal-bench-2 checkout.
# Source of truth = this directory (git-tracked, travels via push/pull);
# tbRoot copies are host-local and MUST be reconstructed via this script.
# NOTE: real copies, not symlinks — tbRoot is bind-mounted at /tb inside the
# bench container, so an absolute symlink into meta-harness breaks there
# (proven: oracle FAIL on first raman-peak-report attempt, 2026-08-19).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tb_root="${TB_ROOT:-$here/../../../terminal-bench-2}"

if [ ! -d "$tb_root" ]; then
  echo "tbRoot not found: $tb_root (set TB_ROOT)" >&2
  exit 1
fi

for task_dir in "$here"/*/; do
  task="$(basename "$task_dir")"
  rsync -a --delete "$task_dir" "$tb_root/$task/"
  echo "installed $task -> $tb_root/$task"
done
