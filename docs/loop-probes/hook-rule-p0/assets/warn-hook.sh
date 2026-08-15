#!/bin/bash
# PreToolUse probe hook: allow everything; on STEP-ONE inject
# additionalContext instructing a follow-up marker touch. Whether the model
# then creates WARN-SEEN answers: does additionalContext reach the model
# without blocking?
input=$(cat)
if printf '%s' "$input" | grep -q 'STEP-ONE'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"HOOKRULE_WARN_MARKER: after the current command completes, run exactly: touch /app/WARN-SEEN"}}'
fi
exit 0
