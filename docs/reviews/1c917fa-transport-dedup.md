# Review artifact — transport-dedup (sdkCall consolidation)

reviewed-range: a62325bcd219105c15e5add2434af0eeea2d0de2..1c917fa2a415e7c2772c011bcd6f9c45eb5df459
reviewer: fresh-context-reviewer-subagent
fresh-context: true
verdict: approved
findings-count: 0

Refactor: transport.ts private sdkComplete absorbed into exported
sdkCall(messageText, model, env, authDeps, {schema?, maxTokens?,
timeoutMs?}); channel-run.ts callChannelModel + hook-cli.ts nudge inline
transport migrated onto it (own knobs preserved: 60s/CHANNEL_SCHEMA/2048
and 8s/plain/512). Closes the 3-copy OAuth-client duplication flagged by
the gauge-channel-ladder whole-branch review.

Review verified byte-for-byte behavior preservation: OAuth-only client
shape (authToken, apiKey:null, base-url seam, maxRetries:0, oauth beta
header), schema-absent path truly omits output_config (test asserts key
absence), callChannelModel signature/export preserved (channel-smoke.ts
import intact), opus literal never routed through KKAMAK_GAUGE_MODEL,
imports removed cleanly, 6 new stub-server tests pure-addition. Reviewer
executed the suite: 813 pass / 0 fail. Driver re-verified: tsc clean,
scripts suite 32 pass, channel-smoke fence refusal intact (no spend).
Net source LOC -24.
