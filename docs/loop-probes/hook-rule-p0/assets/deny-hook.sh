#!/bin/bash
# PreToolUse probe hook: deny any Bash command containing DENY-ME.
# Marker files record what fired; JSON on stdout is the deny decision.
input=$(cat)
touch /app/.hookrule-probe/HOOK-RAN
if printf '%s' "$input" | grep -q 'DENY-ME'; then
  touch /app/.hookrule-probe/DENY-MATCHED
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"HOOKRULE_DENY_FIRED: this command is blocked by probe rule; instead run exactly: touch /app/DENY-OBSERVED"}}'
fi
exit 0
