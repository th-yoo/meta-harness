#!/usr/bin/env bash
# store-sync.sh — mirror the meta-harness ACCOUNT store between the machine-local
# location (~/.config/meta-harness, i.e. accountMetaRoot()) and a git-tracked
# snapshot under the repo (term-bench2/store/), so the evolving loop artifacts
# (candidates v0/v1/…, active version, playbooks, traces, squad/role stores)
# travel across hosts by `git pull`/`git push` — no scp.
#
# The store is deliberately OUTSIDE git at runtime (accountMetaRoot); this script
# is the bridge. The snapshot is small (KB), text/JSON, git-friendly.
#
# Usage (run from anywhere in the repo):
#   term-bench2/store-sync.sh export        store  -> repo snapshot (then git add/commit/push)
#   term-bench2/store-sync.sh import         repo snapshot -> store (backs up existing first)
#   term-bench2/store-sync.sh diff           show drift between store and snapshot
#   term-bench2/store-sync.sh export --dry-run   preview without writing
#
# Cross-host loop workflow (see docs/resume.md):
#   host with v1:  git pull; store-sync.sh export; git add term-bench2/store; git commit; git push
#   other host:    git pull; store-sync.sh import; then run `ab`
set -euo pipefail

STORE="${META_HARNESS_HOME:-$HOME/.config/meta-harness}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAP="$REPO_ROOT/term-bench2/store"

die() { echo "store-sync: $*" >&2; exit 1; }

MODE="${1:-}"; DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="--dry-run"
command -v rsync >/dev/null || die "rsync not found"

case "$MODE" in
  export)
    [ -d "$STORE" ] || die "no account store at $STORE (nothing to export)"
    mkdir -p "$SNAP"
    echo "export: $STORE  ->  $SNAP  (mirror)"
    # --delete: a candidate removed locally is removed from the snapshot too
    # (the snapshot is a faithful mirror, not an append-only pile).
    rsync -a --delete $DRY "$STORE"/ "$SNAP"/
    [ -z "$DRY" ] && echo "done. now: git add term-bench2/store && git commit && git push" || echo "(dry run — nothing written)"
    ;;
  import)
    [ -d "$SNAP" ] || die "no snapshot at $SNAP (git pull first?)"
    if [ -d "$STORE" ] && [ -z "$DRY" ]; then
      BAK="$STORE.bak.$(date +%s 2>/dev/null || echo prev)"
      cp -R "$STORE" "$BAK" && echo "backed up existing store -> $BAK"
    fi
    mkdir -p "$STORE"
    echo "import: $SNAP  ->  $STORE  (mirror; repo is source of truth)"
    rsync -a --delete $DRY "$SNAP"/ "$STORE"/
    [ -z "$DRY" ] && echo "done. candidates now: $(ls "$STORE/global/candidates" 2>/dev/null | tr '\n' ' ')" || echo "(dry run — nothing written)"
    ;;
  diff)
    [ -d "$SNAP" ] || die "no snapshot at $SNAP"
    [ -d "$STORE" ] || die "no store at $STORE"
    echo "drift (store vs snapshot; '<' = only/newer in store, '>' = only in snapshot):"
    rsync -a --delete --dry-run -i "$STORE"/ "$SNAP"/ | grep -vE '^\.d\.\.\.\.\.\.\.\.\. \./$' || echo "  (in sync)"
    ;;
  *)
    die "usage: store-sync.sh export|import|diff [--dry-run]"
    ;;
esac
