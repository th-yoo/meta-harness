#!/bin/bash
# 7b process gate — ARMED merge path for this repo (2026-08-03, boundary ts
# 1785732646822). Spec: docs/superpowers/specs/2026-08-03-process-gate-7b-draft.md.
# THE merge command while the gate is armed: refuses to merge a branch whose
# range lacks a compliant committed review artifact, then merges --no-ff.
#   usage: scripts/merge-with-gate.sh <branch> [git-merge args, e.g. -m "msg"]
# Why not a pre-merge-commit git hook: modern git's automatic (ort) merge
# never materializes MERGE_HEAD before that hook runs (only AUTO_MERGE), so
# a hook cannot identify the merged tip — it silently passes. Measured on
# git 2.43.0, 2026-08-03. Workflow-level placement is the spec's own
# recommendation (§1: "last step of finishing-a-development-branch").
set -euo pipefail
BRANCH=${1:?usage: merge-with-gate.sh <branch> [git-merge args]}
shift
MB=$(git merge-base HEAD "$BRANCH")
bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-review-artifact.ts" "$MB" "$BRANCH"
git merge --no-ff "$BRANCH" "$@"
