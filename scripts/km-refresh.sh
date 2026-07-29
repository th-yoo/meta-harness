#!/usr/bin/env bash
# km-refresh — refresh the installed kkamak plugin from its cc-gate-plugin
# source: sync the marketplace, uninstall + reinstall, then verify the
# installed version matches cc-gate-plugin/.claude-plugin/plugin.json.
#
# GOTCHA (documented): `claude plugin uninstall kkamak` deletes the plugin's
# cache root (~/.claude/plugins/cache/kkamak-local/kkamak/<version>/) before
# reinstalling. If a Claude Code session is actively running with the kkamak
# plugin loaded, deleting that cache root out from under it kills its hooks
# fail-open (the hook binary vanishes mid-session, so the next hook call
# can't spawn -> gate treats the failure as fail-open, i.e. silently stops
# gating). Refuse to run against a shared install while any `claude` process
# is live, unless the caller explicitly accepts the risk with --force.
#
#   km-refresh.sh          refresh; refuse loud if a claude process is live
#   km-refresh.sh --force  refresh anyway (accept the risk to any live session)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/cc-gate-plugin"
PLUGIN_JSON="$PLUGIN_DIR/.claude-plugin/plugin.json"
MARKETPLACE="kkamak-local"
PLUGIN="kkamak"

die() { echo "km-refresh: $*" >&2; exit 2; }

[ -f "$PLUGIN_JSON" ] || die "cannot find $PLUGIN_JSON — is cc-gate-plugin/ laid out as expected?"

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  -h|--help)
    cat <<EOF
km-refresh.sh — refresh the installed kkamak plugin from source.

  km-refresh.sh          refresh; refuse loud if a claude process is live
  km-refresh.sh --force  refresh anyway (accept the risk to any live session)
EOF
    exit 0
    ;;
esac

if pgrep -f "claude" >/dev/null 2>&1; then
  if [ "$FORCE" -ne 1 ]; then
    die "live claude process(es) detected (pgrep -f claude) — uninstalling kkamak" \
        "deletes its plugin cache root and kills a running session's hooks" \
        "fail-open. Re-run with --force to proceed anyway."
  fi
  echo "km-refresh: WARNING — proceeding with --force while claude process(es) are running." >&2
fi

WANT_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN_JSON")" \
  || die "could not read \"version\" from $PLUGIN_JSON"
echo "km-refresh: target version = $WANT_VERSION (from $PLUGIN_JSON)"

echo "km-refresh: refreshing marketplace..."
claude plugin marketplace update "$MARKETPLACE" \
  || claude plugin marketplace add "$PLUGIN_DIR" \
  || die "marketplace update/add failed"

echo "km-refresh: uninstalling $PLUGIN..."
claude plugin uninstall "$PLUGIN" \
  || echo "km-refresh: uninstall reported non-zero (plugin may not have been installed) — continuing"

echo "km-refresh: installing $PLUGIN@$MARKETPLACE..."
claude plugin install "$PLUGIN@$MARKETPLACE" || die "install failed"

echo "km-refresh: verifying..."
LIST_OUT="$(claude plugin list 2>&1)"
echo "$LIST_OUT"

INSTALLED_VERSION="$(printf '%s\n' "$LIST_OUT" \
  | grep -A2 "❯ ${PLUGIN}@${MARKETPLACE}" \
  | grep "Version:" | head -1 | sed 's/^ *Version: *//')"

[ -n "$INSTALLED_VERSION" ] || die "could not find $PLUGIN@$MARKETPLACE in 'claude plugin list' output"

if [ "$INSTALLED_VERSION" != "$WANT_VERSION" ]; then
  die "version mismatch after install: installed=$INSTALLED_VERSION want=$WANT_VERSION"
fi

echo "km-refresh: OK — $PLUGIN@$MARKETPLACE is $INSTALLED_VERSION, matches $PLUGIN_JSON"
