#!/usr/bin/env bash
# S3 — /mh-status shows the PAUSED line when the plateau pause flag exists
# (token-free). The flag is normally written by runner.py report-loop.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
seed_file ".meta-harness/paused" '{"ts":"2026-07-10T00:00:00Z"}'
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-status" "PAUSED"
report $? "/mh-status shows PAUSED with the pause flag present"
exit $RC
