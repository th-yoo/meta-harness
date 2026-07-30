#!/usr/bin/env bash
# km-sensors-sync — mirror each dogfooded repo's HOST-LOCAL kkamak sensor
# streams (.km/{gate-outcomes,trial-arms}.ndjson, gitignored) into a
# git-tracked snapshot under THIS repo (evidence/kkamak-sensors/<host>/), so
# they travel across hosts via `git pull`/`push` (CLAUDE.md: cross-host
# transfer in this project is git-only — .km/ does NOT travel on its own).
#
# Same diff-first discipline as term-bench2/store-sync.sh:33-79, adapted for
# ndjson append-only logs instead of a directory mirror:
#   - export is an APPEND-ONLY UNION (dedupe by full-line identity) into the
#     snapshot — it never reorders or removes an existing snapshot line.
#   - export REFUSES if the committed snapshot contains a line absent from
#     the local file: ndjson lines are immutable appends, so a "snapshot has
#     it, local doesn't" state means local truncation/rot, not intended
#     shrinkage. This is the load-bearing safety property (mirrors
#     store-sync.sh's would-delete refusal).
#   - import is REPORT-ONLY: the runtime .km/ files are host-local and this
#     script never writes to them; `import` prints what a union WOULD add to
#     local, for a human to verify/reconcile by hand.
#
# Usage (run from anywhere in the repo):
#   scripts/km-sensors-sync.sh export             union .km/*.ndjson -> evidence/kkamak-sensors/<host>/
#   scripts/km-sensors-sync.sh export --dry-run    preview would-add counts, no writes
#   scripts/km-sensors-sync.sh import              report what snapshot -> local would add (no writes, ever)
#   scripts/km-sensors-sync.sh diff                show drift both directions, per repo/file
#
# Cross-host workflow (see docs/resume.md / CLAUDE.md):
#   host with new sensor data: git pull; km-sensors-sync.sh export; git add evidence/kkamak-sensors; git commit; git push
#   other host (verification):  git pull; km-sensors-sync.sh import
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_ROOT="$REPO_ROOT/evidence/kkamak-sensors"
HOST="$(hostname -s)"

die() { echo "km-sensors-sync: $*" >&2; exit 2; }

# REPOS mirrors km-crank/src/crank.ts:64 (the dogfooded repos) — kept
# as a plain list here, not sourced from the .ts, so this script has no
# runtime dependency on bun/node.
REPOS=(~/z2/meta-harness ~/z2/squad ~/z2/km-play ~/z2/kkamak)
FILES=(gate-outcomes trial-arms)

usage() {
  cat <<EOF
km-sensors-sync — mirror .km/ sensor streams to the git-tracked snapshot
evidence/kkamak-sensors/<host>/ (host = \$(hostname -s), currently: $HOST).

  km-sensors-sync.sh export             union .km/*.ndjson -> evidence/kkamak-sensors/$HOST/
  km-sensors-sync.sh export --dry-run   preview would-add counts, no writes
  km-sensors-sync.sh import             report what snapshot -> local would add (report-only, never writes .km/)
  km-sensors-sync.sh diff               show drift both directions, per repo/file

Repos (mirrors km-crank/src/crank.ts REPOS):
$(printf '  %s\n' "${REPOS[@]}")
EOF
}

# lines_missing PATTERN_FILE INPUT_FILE
# Prints lines of INPUT_FILE (full-line identity) that do NOT appear
# verbatim in PATTERN_FILE, deduped (first-occurrence order preserved).
# Missing INPUT_FILE -> nothing printed. Missing PATTERN_FILE is treated as
# empty (every input line counts as "missing").
lines_missing() {
  local pat="$1" inp="$2"
  [ -f "$inp" ] || return 0
  if [ -f "$pat" ]; then
    grep -Fxvf "$pat" "$inp" 2>/dev/null | awk '!seen[$0]++'
  else
    awk '!seen[$0]++' "$inp"
  fi
}

# Every (repo, file-kind) pair as "SRC|DST|LABEL" lines, one per call.
each_pair() {
  local repo base src dst kind
  for repo in "${REPOS[@]}"; do
    base="$(basename "$repo")"
    for kind in "${FILES[@]}"; do
      src="$repo/.km/$kind.ndjson"
      dst="$EVIDENCE_ROOT/$HOST/$base.$kind.ndjson"
      echo "$src|$dst|$base.$kind"
    done
  done
}

cmd_export() {
  local dry="${1:-}"
  local any_violation=0
  local src dst label missing count

  # Pass 1: diff-first refusal check — scan ALL pairs before writing anything.
  while IFS='|' read -r src dst label; do
    missing="$(lines_missing "$src" "$dst")"
    count=0
    [ -n "$missing" ] && count="$(printf '%s\n' "$missing" | wc -l | tr -d ' ')"
    if [ "$count" -gt 0 ]; then
      any_violation=1
      echo "REFUSING: $label — snapshot has $count line(s) absent from local ($src)" >&2
      echo "  snapshot: $dst" >&2
      echo "  local file missing these lines — truncation/rot? Inspect with:" >&2
      echo "    km-sensors-sync.sh diff" >&2
    fi
  done < <(each_pair)

  if [ "$any_violation" -eq 1 ]; then
    echo "km-sensors-sync: REFUSING export — the committed snapshot would shrink relative to local history." >&2
    echo "  Never silently drops ndjson lines. Nothing was written." >&2
    exit 3
  fi

  # Pass 2: append-only union per pair.
  local total=0
  while IFS='|' read -r src dst label; do
    [ -f "$src" ] || { echo "  $label: no local data ($src absent) — skipped"; continue; }
    local add
    add="$(lines_missing "$dst" "$src")"
    local n=0
    [ -n "$add" ] && n="$(printf '%s\n' "$add" | wc -l | tr -d ' ')"
    total=$((total + n))
    if [ -n "$dry" ]; then
      echo "  $label: would add $n line(s) -> $dst"
    else
      if [ "$n" -gt 0 ]; then
        mkdir -p "$(dirname "$dst")"
        printf '%s\n' "$add" >> "$dst"
      fi
      echo "  $label: added $n line(s) -> $dst"
    fi
  done < <(each_pair)

  if [ -n "$dry" ]; then
    echo "km-sensors-sync: dry-run — $total line(s) would be added across all files, nothing written."
  else
    echo "km-sensors-sync: export done — $total line(s) added. Now: git add $EVIDENCE_ROOT/$HOST && git commit && git push"
  fi
}

cmd_import() {
  echo "km-sensors-sync: import is REPORT-ONLY — .km/ runtime files are never written."
  local src dst label add n
  while IFS='|' read -r src dst label; do
    if [ ! -f "$dst" ]; then
      echo "  $label: no committed snapshot ($dst absent) — nothing to report"
      continue
    fi
    add="$(lines_missing "$src" "$dst")"
    n=0
    [ -n "$add" ] && n="$(printf '%s\n' "$add" | wc -l | tr -d ' ')"
    if [ "$n" -eq 0 ]; then
      echo "  $label: local already has everything the snapshot has"
    else
      echo "  $label: union would add $n line(s) to local ($src) from the snapshot"
    fi
  done < <(each_pair)
}

cmd_diff() {
  local src dst label local_only snapshot_only lo so
  while IFS='|' read -r src dst label; do
    local_only="$(lines_missing "$dst" "$src")"
    snapshot_only="$(lines_missing "$src" "$dst")"
    lo=0; so=0
    [ -n "$local_only" ] && lo="$(printf '%s\n' "$local_only" | wc -l | tr -d ' ')"
    [ -n "$snapshot_only" ] && so="$(printf '%s\n' "$snapshot_only" | wc -l | tr -d ' ')"
    if [ ! -f "$src" ] && [ ! -f "$dst" ]; then
      echo "  $label: neither local nor snapshot has data"
    elif [ "$lo" -eq 0 ] && [ "$so" -eq 0 ]; then
      echo "  $label: (in sync)"
    else
      echo "  $label: local-only=$lo (not yet exported) snapshot-only=$so (would refuse export if >0)"
    fi
  done < <(each_pair)
}

MODE="${1:-}"
DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="--dry-run"

case "$MODE" in
  -h|--help|help) usage ;;
  export) cmd_export "$DRY" ;;
  import) cmd_import ;;
  diff) cmd_diff ;;
  *)
    usage >&2
    die "usage: km-sensors-sync.sh export|import|diff [--dry-run]"
    ;;
esac
