#!/bin/bash
# Model-availability probe — the 429 gate for every sized-go chain.
#
# WHY THIS EXISTS (2026-08-03 finding): Anthropic quotas are PER MODEL TIER.
# Measured on yoo-dev, one token, one client, same second:
#   claude-haiku-4-5 = OK · claude-sonnet-5 = 429 · claude-opus-5 = 429
# So a premium wall does NOT block haiku work, and "is the API up?" is the
# wrong question — the right one is "is the model MY batch calls available?"
#
# PROBE-FIDELITY RULE (violated once, cost a stalled chain): a launcher must
# probe exactly the model(s) its own batch calls, with the SAME single-shot
# transport (maxRetries:0). An opus probe gating haiku work blocks work that
# could run; a retrying or CLI-shaped probe reports "clear" falsely because
# it rides a different quota than a bare-SDK batch.
#
# Usage:
#   source scripts/probe-models.sh
#   probe_models claude-haiku-4-5 claude-sonnet-5   # prints "<model>=OK|ERR<code>"
#   all_ok claude-opus-5 && echo "clear"            # exit 0 iff ALL probe OK
#
# Cost: one ~20-token call per model. A 429 is rejected pre-inference and
# costs nothing, so polling is free; only a success spends (~20 tokens).
# Auth: same seams as the gauge transport (KKAMAK_GAUGE_AUTH_TOKEN override,
# else keychain on darwin / ~/.claude/.credentials.json elsewhere).
KKAMAK_PROBE_REPO=${KKAMAK_PROBE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

probe_models() {
  # Stock darwin ships no `timeout` (coreutils' gtimeout only via brew) —
  # exit 127 on the MacBook otherwise. Probe without a wrapper there; the
  # SDK call itself fails fast (maxRetries: 0) so the wrapper is belt only.
  local TO=""
  if command -v timeout >/dev/null 2>&1; then TO="timeout 90"
  elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 90"; fi
  ( cd "$KKAMAK_PROBE_REPO/cc-gate-plugin" && $TO bun -e '
const t = require("./src/gauge/transport.ts");
const A = require("@anthropic-ai/sdk");
const An = A.default || A.Anthropic || A;
const tok = t.readAuthToken(process.env);
if (!tok) { for (const m of process.argv.slice(1)) console.log(m + "=ERR-noauth"); process.exit(0); }
const c = new An({authToken: tok, apiKey: null, maxRetries: 0,
                  defaultHeaders: {"anthropic-beta": "oauth-2025-04-20"}});
for (const m of process.argv.slice(1)) {
  await c.messages.create({model: m, max_tokens: 10, messages:[{role:"user",content:"say ok"}]})
    .then(() => console.log(m + "=OK"))
    .catch(e => console.log(m + "=ERR" + (e.status ?? "")));
}
' "$@" 2>/dev/null )
}

all_ok() {
  local out
  out=$(probe_models "$@")
  echo "$out" | sed 's/^/  probe /'
  [ -n "$out" ] && ! echo "$out" | grep -q "=ERR"
}
