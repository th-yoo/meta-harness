#!/usr/bin/env bash
# S5 — /mh-activate on a PROJECT layer skips the ab-gate (project scopes activate
# directly) and succeeds when the candidate exists (token-free). Seed candidate v1.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up
role_seed "candidates/v1/system.md" "# candidate v1 system prompt"
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }
oc_run_command "/mh-activate role v1" "activated project-role v1"
report $? "/mh-activate role v1 succeeds for a project candidate"
exit $RC
