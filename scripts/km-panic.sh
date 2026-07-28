#!/usr/bin/env bash
# km-panic — stop kkamak NOW, without restarting Claude Code.
#
# The gate reads gate.json fresh on every hook call, so every action here
# takes effect on the NEXT turn of a running session: no restart, no lost
# conversation context. (cc-gate-plugin/test/escape-hatch.test.ts locks
# that invariant.)
#
#   km-panic.sh status      what is armed right now
#   km-panic.sh gauge-off   stop km-gauge refiner spend, keep the gate
#   km-panic.sh off         disable the gate entirely (recoverable)
#   km-panic.sh restore     undo `off`
#   km-panic.sh nuke        print the full plugin-removal commands
#
# Run it from the repo whose gate you want to stop (uses $PWD).
set -uo pipefail

GATE="gate.json"
DISABLED="gate.json.disabled"

die() { echo "km-panic: $*" >&2; exit 2; }

case "${1:-}" in
  status)
    echo "repo:    $PWD"
    if [ -f "$GATE" ]; then
      python3 - "$GATE" <<'PY'
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"gate:    MALFORMED gate.json ({e}) -> gate is inert"); raise SystemExit(0)
print(f"gate:    ARMED   check={c.get('check')!r} rounds={c.get('rounds', 2)}")
print(f"gauge:   {'ON (refiner calls spend tokens)' if c.get('gauge') is True else 'off'}")
PY
    elif [ -f "$DISABLED" ]; then
      echo "gate:    DISABLED (via km-panic off) — restore with: km-panic.sh restore"
    else
      echo "gate:    inert (no gate.json in this repo)"
    fi
    echo -n "plugin:  "
    claude plugin list 2>/dev/null | grep -q kkamak && echo "kkamak INSTALLED (loads in every new session)" || echo "kkamak not installed"
    ;;

  gauge-off)
    [ -f "$GATE" ] || { echo "km-panic: no $GATE here — nothing to change"; exit 0; }
    python3 - "$GATE" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["gauge"] = False
json.dump(c, open(p, "w"), indent=2)
PY
    echo "km-panic: gauge OFF — no more refiner calls. Gate still running."
    echo "          revert with: git checkout $GATE"
    ;;

  off)
    if [ ! -f "$GATE" ]; then
      echo "km-panic: no $GATE here — gate already inert"; exit 0
    fi
    # Never clobber a previous disable.
    [ -f "$DISABLED" ] && die "$DISABLED already exists — resolve it first"
    mv "$GATE" "$DISABLED"
    echo "km-panic: gate DISABLED (moved to $DISABLED). Takes effect next turn."
    echo "          restore with: km-panic.sh restore"
    ;;

  restore)
    [ -f "$DISABLED" ] || { echo "km-panic: nothing to restore"; exit 0; }
    [ -f "$GATE" ] && die "$GATE exists — remove it before restoring"
    mv "$DISABLED" "$GATE"
    echo "km-panic: gate restored."
    ;;

  nuke)
    cat <<'EOF'
Full removal (needed only if the hooks themselves misbehave):

  claude plugin disable kkamak     # then /reload-plugins in the session
  claude plugin uninstall kkamak   # permanent

Note: `KKAMAK_GAUGE=off` is read from the environment of the Claude Code
process, so it only works if set BEFORE launching claude — it cannot stop a
session that is already running. Use `km-panic.sh gauge-off` for that.
EOF
    ;;

  *)
    die "usage: km-panic.sh {status|gauge-off|off|restore|nuke}"
    ;;
esac
