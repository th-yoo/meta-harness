#!/usr/bin/env bash
# DIAGNOSTIC (manual, NOT part of the automated suite) — the interactive-mode
# triviality filter (Task 7 / Option A) end to end through the TUI, judge ENABLED.
#
#   bash smoke/diag/trivial-filter.sh    # needs MH auth + judge; ~2 Haiku calls, slow
#
# Why it is a manual diagnostic, not a run.sh gate: the "Score recorded" toast
# AWAITS the concurrent judge (a full LLM call, ~40-60 s), so the deterministic
# outcome is real but SLOW, and the fork-based wait's wall-clock is too
# environment-variable to budget reliably in an unattended suite (it would flake
# on timing, not logic). The deterministic exclusion math is covered by
# opencode-plugin/test/judge-trivial-fitness.test.ts; this script is the live
# TUI confirmation you run by hand.
#
# It reports whether the judge rated this single-file-read session trivial (toast
# suffix " — trivial: recorded, not counted toward fitness", index.ts:621).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up

mkdir -p "$OC_CONFIG/meta-harness"
printf '{"judgeModel":"anthropic/claude-haiku-4-5"}' \
  > "$OC_CONFIG/meta-harness/config.json"

oc_start --model anthropic/claude-haiku-4-5 >/dev/null || { report 1 "opencode failed to start"; exit 1; }

oc_type "read the file opencode.json and tell me its first line" >/dev/null
oc_submit

if ! oc_wait_for "/mh-score" 30000; then
  report 1 "session never scored (autofill absent)"
  exit $RC
fi

# Generous budget — the toast awaits the judge's full LLM call (~40-60 s). Run
# this WITHOUT a short outer `timeout` wrapper.
oc_submit
if oc_wait_for "Score recorded" 80000; then
  report 0 "judge-enabled scoring completes and renders in the TUI"
else
  report 1 "'Score recorded' toast did not render (judge slow — raise the wait budget)"
  exit $RC
fi

# Report (do not gate) the trivial classification.
if oc_capture | grep -q "trivial: recorded, not counted toward fitness"; then
  echo "  INFO  judge rated this session TRIVIAL — excluded from fitness (suffix rendered)"
else
  echo "  INFO  judge did NOT mark trivial this run (or verdict lost the race) — non-gating"
fi
exit $RC
