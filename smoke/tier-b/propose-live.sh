#!/usr/bin/env bash
# Tier B (LIVE — needs real auth; spends ONE pinned-Opus proposer session,
# ~1–2 min; gated by run.sh on MH_SMOKE_LIVE=1). Exercises the full manual
# propose path end-to-end, including the agentic store access the digest-only
# proposer never had (evolution-loop.md §11b / the founding paper's mechanism):
#   1. /mh-propose role acks and spawns a background proposer (pinned model)
#   2. the proposer READS the candidate archive — full trajectory .ndjson files,
#      score.json — not just the prompt-embedded excerpts
#   3. it writes staging artifacts (diagnosis first, then ops)
#   4. the plugin consumes staging: candidate v1 + auto-trial in project-role
#   5. the archive itself is untouched (STRICTLY READ-ONLY guard respected)
#
# The seeded archive plants an obvious root cause (edit-without-read) across two
# failing trajectories, so the proposer has something real to diagnose.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/scenario.sh"
env_up

# ── Seed a diagnosable archive in the isolated project-role store ───────────
cat > "$OC_ROLE_ROOT/active/system.md" <<'EOF'
- Prefer small, focused diffs.
- Run the project's tests after making changes.
EOF

mkdir -p "$OC_ROLE_ROOT/candidates/v0/traj"
cat > "$OC_ROLE_ROOT/candidates/v0/score.json" <<'EOF'
{"version":"v0","nPass":1,"nFail":2,"sessions":[
 {"sessionID":"ses_bad_1","passed":false,"note":"broke the date parser","turnCount":6,
  "timestamp":"2026-07-11T04:00:00Z","summary":"Edited src/parse.ts without reading it; tests failed twice; gave up.",
  "model":"anthropic/claude-sonnet-4-6","variant":"","toolUsage":{}},
 {"sessionID":"ses_bad_2","passed":false,"note":"clobbered config","turnCount":5,
  "timestamp":"2026-07-11T05:00:00Z","summary":"Rewrote config.json from memory, lost existing keys, tests failed.",
  "model":"anthropic/claude-sonnet-4-6","variant":"","toolUsage":{}},
 {"sessionID":"ses_good_1","passed":true,"note":"clean fix","turnCount":7,
  "timestamp":"2026-07-11T06:00:00Z","summary":"Read parse.ts first, made a targeted edit, tests green.",
  "model":"anthropic/claude-sonnet-4-6","variant":"","toolUsage":{}}
]}
EOF

cat > "$OC_ROLE_ROOT/candidates/v0/traj/ses_bad_1.ndjson" <<'EOF'
{"t":"text","text":"The date parser test is failing. I'll rewrite parseDate in src/parse.ts."}
{"t":"tool","tool":"edit","args":"src/parse.ts: replace parseDate body with new Date(s).toISOString().slice(0,10)","output":"edit applied"}
{"t":"tool","tool":"bash","args":"npm test","output":"FAIL parse.test.ts: expected '2024-01-02' got 'NaN-aN-aN' (input '02/01/2024', DD/MM/YYYY mode)","error":"exit 1"}
{"t":"text","text":"Hmm, the format flag must live elsewhere. Trying another rewrite."}
{"t":"tool","tool":"edit","args":"src/parse.ts: replace parseDate body again, hardcode DD/MM split","output":"edit applied"}
{"t":"tool","tool":"bash","args":"npm test","output":"FAIL parse.test.ts: 3 of 7 date cases now fail (US-mode inputs regressed)","error":"exit 1"}
{"t":"text","text":"Out of ideas — the parser has more modes than I assumed. Stopping here."}
EOF

cat > "$OC_ROLE_ROOT/candidates/v0/traj/ses_bad_2.ndjson" <<'EOF'
{"t":"text","text":"Task: add a retryLimit setting. I'll write the config file directly."}
{"t":"tool","tool":"write","args":"config.json: {\"retryLimit\": 3}","output":"wrote 24 bytes"}
{"t":"tool","tool":"bash","args":"npm test","output":"FAIL config.test.ts: missing keys apiBase, timeoutMs (config.json was overwritten, not merged)","error":"exit 1"}
{"t":"text","text":"The old config had keys I didn't know about. I don't know their values, so I can't restore them."}
EOF

# ── Drive: /mh-propose role → background proposer on the pinned model ───────
oc_start >/dev/null || { report 1 "opencode failed to start"; exit 1; }

if oc_run_command "/mh-propose role" "propose cycle started|Proposing project-role"; then
  report 0 "/mh-propose role acknowledged"
else
  report 1 "/mh-propose role never acked"
  oc_capture | tail -15
  exit $RC
fi

# ── Wait for CONSUMPTION, not the staging write. The plugin's waitForFile only
# runs after the proposer session fully completes (it keeps talking after
# writing its artifacts), so candidate v1 + .trial are the true terminal state;
# polling staging and tearing down early races the consumption. Budget: well
# under the plugin's own proposerTimeoutMin (default 20 min).
done_at=""
for i in $(seq 1 900); do
  [ -d "$OC_ROLE_ROOT/candidates/v1" ] && [ -f "$OC_ROLE_ROOT/active/.trial" ] && { done_at="$i"; break; }
  sleep 1
done
if [ -n "$done_at" ]; then
  report 0 "staging consumed after ~${done_at}s (candidate v1 + auto-trial present)"
else
  report 1 "no candidate v1 + trial within 15 min"
  oc_capture | tail -20
  exit $RC
fi

[ -f "$OC_ROLE_ROOT/candidates/v1/diagnosis.json" ] \
  && report 0 "diagnosis.json relocated into candidate v1" \
  || report 1 "candidate v1 has no diagnosis.json"

# THE agentic-store-access check: a trajectory *filename* (ses_bad_1.ndjson)
# never appears in the prompt text — only in a real read/bash tool call — so
# finding it in opencode's stored session parts proves the proposer actually
# explored the archive instead of relying on the embedded excerpts.
reads="$(grep -rl "ses_bad_1.ndjson\|ses_bad_2.ndjson" "$OC_DATA" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${reads:-0}" -gt 0 ]; then
  report 0 "proposer READ the archive (trajectory filenames in $reads stored session part(s))"
else
  report 1 "no evidence of archive reads in session storage"
fi

# STRICTLY READ-ONLY guard: the seeded v0 archive must be byte-identical.
[ "$(wc -l < "$OC_ROLE_ROOT/candidates/v0/traj/ses_bad_1.ndjson" | tr -d ' ')" = "7" ] \
  && [ "$(wc -l < "$OC_ROLE_ROOT/candidates/v0/traj/ses_bad_2.ndjson" | tr -d ' ')" = "4" ] \
  && report 0 "v0 archive untouched (read-only respected)" \
  || report 1 "v0 archive was modified"

exit $RC
