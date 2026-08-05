#!/bin/bash
# channel-chain.sh — probe-gated auto-fire chain for the verification-channel
# instrument (spec: docs/superpowers/specs/2026-08-03-gauge-verification-
# channel-ladder-preregistration.md).
#
#   opus wall lift -> channel-smoke (--go 14, go granted 2026-08-03)
#   -> MECHANICAL bar gate (barMet && nudgeProof.pass from the smoke json)
#   -> channel base-rate run (replay-cli channel --go 301, sized go granted
#      2026-08-05 "run it"; fence re-verifies the count at fire time).
#
# Stops cold (exit 1) on smoke bar failure — the base-rate run never fires
# on an unverified instrument. Run inside tmux (detached runs die outside
# it — repo standing rule). Total spend when it fires: 14 + 301 opus calls.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="docs/gauge-channel/$(hostname)-channel-smoke.json"
mkdir -p docs/gauge-channel

echo "[chain] armed $(date -Is) — probing opus every 10min"
while true; do
  # shellcheck source=scripts/probe-models.sh
  source scripts/probe-models.sh
  if probe_models claude-opus-5 2>/dev/null | grep -q "claude-opus-5=OK"; then break; fi
  sleep 600
done
echo "[chain] opus clear $(date -Is) — firing channel-smoke --go 14"

bun scripts/channel-smoke.ts --go 14 --out "$OUT"

if ! bun -e "const j=JSON.parse(require('fs').readFileSync('$OUT','utf8')); process.exit(j.barMet===true && j.nudgeProof?.pass===true ? 0 : 1)"; then
  echo "[chain] SMOKE BAR FAILED (see $OUT) — STOPPING before base-rate run"
  exit 1
fi
echo "[chain] smoke bar met — firing channel base-rate (--go 301)"

bun cc-gate-plugin/src/gauge/replay-cli.ts channel --go 301

echo "[chain] DONE $(date -Is) — base-rate run complete; tally + commit are the operator's model-free duties"
