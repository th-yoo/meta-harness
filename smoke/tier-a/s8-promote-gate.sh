#!/usr/bin/env bash
# S8 — /mh-promote acks with "promote cycle started ✓", and with the baseline
# project-role at 0 scored sessions its background trigger hits the evidence gate
# (need ≥3 sessions with ≥1 pass) and spawns NO promoter (token-free).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-promote role" "promote cycle started"
report $? "/mh-promote role acks (promote cycle started ✓)"
oc_settle
assert_no_spawn
report $? "/mh-promote role spawns no promoter (evidence-gated, token-free)"
exit $RC
