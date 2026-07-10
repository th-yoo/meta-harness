#!/usr/bin/env bash
# S1 — /mh-status renders the 4-layer report (token-free). Baseline seed only.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-status" "project-role: active=v0"
report $? "/mh-status renders the 4-layer report (project-role: active=v0)"
exit $RC
