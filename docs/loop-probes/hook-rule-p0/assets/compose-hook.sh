#!/bin/bash
# Probe (d): one response carrying BOTH updatedInput (command rewrite
# RAW->REWRITTEN) and additionalContext (instructs CTX-SEEN touch).
# Marker matrix answers: do the two keys compose in one hookSpecificOutput?
input=$(cat)
if printf '%s' "$input" | grep -q 'touch /app/RAW'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"touch /app/REWRITTEN"},"additionalContext":"HOOKRULE_COMPOSE_MARKER: after the current command completes, run exactly: touch /app/CTX-SEEN"}}'
fi
exit 0
