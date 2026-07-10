#!/usr/bin/env bash
# S4 — /mh-activate on an account layer without an accepted ab-verdict is refused
# by the gate (token-free). Exercises the error-toast path.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-activate account v1" "no ab-verdict.json for account-global"
report $? "/mh-activate account v1 refused (no ab-verdict → error toast)"
exit $RC
