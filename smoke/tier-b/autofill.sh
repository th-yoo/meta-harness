#!/usr/bin/env bash
# Tier B (LIVE — needs real auth, spends a few Haiku cents; gated by run.sh on
# MH_SMOKE_LIVE=1). Exercises the two surfaces that require a real interactive
# session and cannot be reached token-free:
#   1. the /mh-score AUTOFILL — the plugin injects "/mh-score good" into the
#      input box (client.tui.appendPrompt) when a substantive mh-* session goes
#      idle. This is the one PERSISTENT surface (safe to poll late).
#   2. the "Score recorded" toast after the human submits the score.
#
# Judge is left DISABLED (no config.json) so the prefill is the deterministic
# default "/mh-score good", not a judge-calibrated variant.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up

oc_start --model anthropic/claude-haiku-4-5 >/dev/null || { report 1 "opencode failed to start"; exit 1; }

# Give the agent a trivial one-tool task so the session is substantive (not
# skipped as degenerate) but cheap. Keep the prompt SHORT and free of backticks
# so it does not wrap across input-box lines (which breaks oc_type's verify).
oc_type "list files with ls and say how many" >/dev/null
oc_submit

# The agent works, then the session goes idle and the plugin injects the prefill.
# Wait generously (a real Haiku turn). The autofill is persistent, so a late
# match is fine.
if oc_wait_for "/mh-score good" 30000; then
  report 0 "autofill: plugin prefilled '/mh-score good' into the input box on idle"
else
  report 1 "autofill: '/mh-score good' never appeared (session skipped as degenerate?)"
  oc_capture | tail -20
  exit $RC
fi

# Submit the prefilled score command; the plugin records it and toasts.
oc_submit
if oc_wait_for "Score recorded" 8000; then
  report 0 "scoring: 'Score recorded' toast rendered after submitting the score"
else
  report 1 "scoring: 'Score recorded' toast did not render"
fi

# Token-free invariant does NOT apply here (this tier intentionally runs one
# model turn), but assert no PROPOSER/curator spawned (project-role is at 1
# session, below the 5-session auto-propose threshold).
exit $RC
