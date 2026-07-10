#!/usr/bin/env bash
# S7 — /mh-curate acks with "curate cycle started ✓", and with a trial in flight
# its background trigger hits the trial guard and spawns NO curator (token-free).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
role_seed "active/.trial" "$TRIAL_JSON"   # trial in flight → curate guard, no spawn
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-curate role" "curate cycle started"
report $? "/mh-curate role acks (curate cycle started ✓)"
oc_settle
assert_no_spawn
report $? "/mh-curate role spawns no curator (trial-guarded, token-free)"
exit $RC
