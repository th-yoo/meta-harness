#!/usr/bin/env bash
# S6 — /mh-propose acks with "propose cycle started ✓", and with a trial already
# in flight its background trigger hits the trial guard and spawns NO proposer
# (token-free). assert_no_spawn enforces the no-opus invariant.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
role_seed "active/.trial" "$TRIAL_JSON"   # trial in flight → propose guard, no spawn
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-propose role" "propose cycle started"
report $? "/mh-propose role acks (propose cycle started ✓)"
oc_settle
assert_no_spawn
report $? "/mh-propose role spawns no proposer (trial-guarded, token-free)"
exit $RC
