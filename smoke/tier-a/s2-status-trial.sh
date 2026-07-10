#!/usr/bin/env bash
# S2 — /mh-status shows the TRIAL marker when a trial is in flight (token-free).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
role_seed "active/.trial" "$TRIAL_JSON"
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-status" "TRIAL v1 vs"
report $? "/mh-status shows TRIAL v1 vs v0 with .trial seeded"
exit $RC
