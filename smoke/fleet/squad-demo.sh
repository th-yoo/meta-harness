#!/usr/bin/env bash
# smoke/fleet/squad-demo.sh — live depth-1 squad E2E (controller-run; ~5
# haiku-class drives). Drives the real `term-bench2/runner.ts` subcommands
# end to end against fixture personas (test/fixtures/fleet — NOT oc-test;
# the fleet repo stays read-only per spec §11): squad-def-init, roles-import,
# roles-render, squad-run --gate-policy auto, then prints the outcome JSON
# and each role store's score.json nPass/nFail counts.
#
# Prereqs: `opencode` on PATH and authed (a real, credentialed opencode
# install — this script spends real tokens, ~5 haiku-class calls per run).
#
# MIGRATION HAZARD (mandatory guard — read before touching META_HARNESS_HOME):
#
#   `term-bench2/runner.ts` calls `migrateAccountRoot()` (harness-store.ts)
#   on EVERY invocation. That function's contract: if the account root has
#   never been migrated off its legacy, opencode-owned location
#   (~/.config/opencode/.meta-harness) — i.e. that path still exists as a
#   real directory, not yet a symlink — and the NEW target root doesn't
#   exist yet, it MOVES the legacy directory into the new root and leaves a
#   symlink behind. This script sets META_HARNESS_HOME to a smoke-test-only
#   root so it never touches the real account store — but the FIRST time
#   ANY runner.ts command runs with a not-yet-migrated legacy store present,
#   migrateAccountRoot would move that REAL store into whatever
#   META_HARNESS_HOME happens to be set to at the time. Pointing
#   META_HARNESS_HOME at this script's smoke-only root on a not-yet-migrated
#   machine would silently relocate the user's real evolved store into the
#   smoke sandbox.
#
#   Guard: refuse to run until that one-time migration has already happened
#   (verified harness-store.ts:1199 — migrateAccountRoot is a no-op once the
#   legacy path is a symlink, so repeat smoke runs after the first real
#   migration are always safe). If this fires, run any runner.ts command
#   ONCE without META_HARNESS_HOME set first (e.g. `bun term-bench2/runner.ts
#   squad-def-init`), which performs the real migration and leaves the
#   symlink this guard checks for.
set -euo pipefail

LEGACY_STORE="$HOME/.config/opencode/.meta-harness"
if [ -d "$LEGACY_STORE" ] && [ ! -L "$LEGACY_STORE" ]; then
  echo "SKIP: pre-migration store present — run any runner.ts command once WITHOUT META_HARNESS_HOME first (migrateAccountRoot)"
  exit 0
fi

# Persistent, under $HOME, isolated from the real account store (never a
# mktemp dir — the point is a stable place role stores accumulate scores
# across repeat smoke runs, same as a real fleet deployment would).
export META_HARNESS_HOME="$HOME/.mh-fleet-smoke"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER=(bun "$REPO_ROOT/term-bench2/runner.ts")
FIXTURES="$REPO_ROOT/opencode-plugin/test/fixtures/fleet"

if ! command -v opencode >/dev/null 2>&1; then
  echo "SKIP: opencode not on PATH"
  exit 0
fi

PROJ="$(mktemp -d)"
cleanup() { rm -rf "$PROJ"; }
trap cleanup EXIT

echo "== tmp project: $PROJ =="
git -C "$PROJ" init -q
git -C "$PROJ" config user.email "fleet-smoke@example.com"
git -C "$PROJ" config user.name "fleet smoke"

echo "== squad-def-init =="
if ! "${RUNNER[@]}" squad-def-init; then
  echo "(squad def already active — idempotent-refuse, continuing)"
fi

echo "== roles-import (fixtures — repo read-only) =="
"${RUNNER[@]}" roles-import --from "$FIXTURES" --map architect=analyzer,designer --force

echo "== roles-render =="
"${RUNNER[@]}" roles-render --project "$PROJ"

echo "== squad-run (gate-policy auto) =="
OUTCOME_JSON="$("${RUNNER[@]}" squad-run --project "$PROJ" --slice-id demo \
  --slice "add slugify(s) to util.sh + a test" --gate-policy auto --json)"

echo "== outcome =="
echo "$OUTCOME_JSON"

echo "== per-store score counts (account-role, active version) =="
for role in analyzer designer implementer evaluator; do
  agent="mh-$role"
  root="$META_HARNESS_HOME/roles/$agent"
  version="$(cat "$root/active/.version" 2>/dev/null || echo v0)"
  score_file="$root/candidates/$version/score.json"
  if [ -f "$score_file" ]; then
    n_pass="$(grep -o '"nPass": *[0-9]*' "$score_file" | head -1 | grep -o '[0-9]*$')"
    n_fail="$(grep -o '"nFail": *[0-9]*' "$score_file" | head -1 | grep -o '[0-9]*$')"
    echo "  $agent ($version): nPass=${n_pass:-0} nFail=${n_fail:-0}"
  else
    echo "  $agent ($version): no score.json (no drives recorded)"
  fi
done
