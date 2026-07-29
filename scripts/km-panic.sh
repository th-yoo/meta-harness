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
#   km-panic.sh trial-off   force-stop a live §4.3 gate-outcomes trial (abandon)
#   km-panic.sh nuke        print the full plugin-removal commands
#
# Run it from the repo whose gate you want to stop (uses $PWD).
set -uo pipefail

GATE="gate.json"
DISABLED="gate.json.disabled"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "km-panic: $*" >&2; exit 2; }

usage() {
  cat <<'EOF'
km-panic — stop kkamak NOW, without restarting Claude Code.

  km-panic.sh status      what is armed right now (read-only)
  km-panic.sh gauge-off   stop km-gauge refiner spend, keep the gate
  km-panic.sh off         disable the gate entirely (recoverable)
  km-panic.sh restore     undo `off`
  km-panic.sh trial-off   force-stop a live §4.3 gate-outcomes trial (abandon)
  km-panic.sh nuke        print the full plugin-removal commands

Every action takes effect on the NEXT turn of a running session: gate.json
is re-read on every hook call, so no restart and no lost context.
Run from the repo whose gate you want to stop (uses $PWD).
EOF
}

case "${1:-}" in
  -h|--help|help)
    usage
    ;;

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

  trial-off)
    # §11 item 9: manual command supersedes (§6 authority) — force-ABANDON a
    # live §4.3 gate-outcomes trial for the cwd's project-global store root
    # right now, without waiting for km-crank's next scheduled verdict. Reads
    # the live .trial via the same primitives resolveGateTrial/km-crank use
    # (opencode-plugin/src/harness-store.ts) — never a second, drifting
    # reimplementation of the .trial schema in bash.
    #
    # ABANDON, not rollback (final review, plan Task 8 amendment): spec §5's
    # abandon list names "a manual command supersedes (§6)" — a manual
    # supersede is not a decision-rule outcome AGAINST the candidate.
    # Post-54238eb, resolveGateTrial's abandon branch already restores the
    # baseline exactly like rollback does (state-identical) — only the
    # ledger row differs, and a "rollback" row here could later be misread
    # as the three-clause rule having judged the candidate.
    #
    # A LEGACY trial (no rewardMode) is explicitly NOT touched here: it
    # belongs to the old resolveTrial's rate-comparison path, not
    # resolveGateTrial's §4.3 authority — this verb only prints instructions
    # for that case (brief: "legacy .trial -> print instructions").
    command -v bun >/dev/null || die "bun not found — trial-off needs it to call resolveGateTrial"
    KKAMAK_PANIC_REPO_ROOT="$REPO_ROOT" bun run - <<'TS'
    const repoRoot = process.env.KKAMAK_PANIC_REPO_ROOT
    const { projectGlobalRoot, readTrial, resolveGateTrial } = await import(`${repoRoot}/opencode-plugin/src/harness-store.ts`)
    const root = projectGlobalRoot(process.cwd())
    const trial = readTrial(root)
    if (!trial) {
      console.log(`km-panic: no trial in this project's store (${root}) — nothing to do.`)
    } else if (trial.rewardMode !== "gate-outcomes") {
      console.log(`km-panic: legacy trial at ${root} (no rewardMode) — owned by resolveTrial, not this verb.`)
      console.log(`  It resolves automatically on the next /mh-score once minSessions is reached (rate comparison vs baseline).`)
      console.log(`  To force it now instead: manually restore ${root}/active/{system.md,tools.md} from the`)
      console.log(`  baselineSystem/baselineTools fields recorded in ${root}/active/.trial, then remove that .trial file.`)
    } else {
      const result = resolveGateTrial(root, { verdict: "abandoned", reason: "manual supersede (km-panic trial-off)" })
      console.log(`km-panic: gate-outcomes trial at ${root} -> ${JSON.stringify(result)} (baseline restored, ledger action=abandoned)`)
    }
TS
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
    usage >&2
    die "usage: unknown verb '${1:-}'"
    ;;
esac
