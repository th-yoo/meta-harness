# Review — fix-guard-backtick

reviewed-range: 16c230356b32529c3cb9e68a08248fb50fffcde3..893183b5644b4a72e4be26cc72e56e6278976263
reviewer: fresh-context-general-purpose-subagent (sonnet)
fresh-context: true
verdict: approved
findings-count: 1

One-commit branch closing the production half of the a3-routing T3 review
find: backtick command substitution defeated every word-anchored rule in
`cc-gate-plugin/src/gauge/guard.ts` (a verb immediately after an unspaced
backtick has no separator-class char before it — `` echo `rm f` `` passed
the guard while gauge shadow EXECUTES the command with user permissions).
Fix: first RULES entry `{reason: "backtick-substitution", re: /`/}`;
`minimal/guard.ts` mirrored byte-identically (guard-parity test enforces
lockstep); plugin 0.4.3 → 0.4.4 in the same commit (merging ≠ deploying —
version-keyed cache; pluginVersion stamps the gauge-refusal boundary on
sensor lines).

## Finding (advisory, addressed in-commit)

1. Blanket /`/ also refuses literal-backtick-as-data (e.g. grepping
   markdown code fences) — not quote-aware like sibling rules. Accepted
   per the file's own fail-toward-refusal policy and shadow-only blast
   radius (one M1 data point per refusal, never a gate decision); trade
   acknowledged in the rule's comment per the reviewer's ask.

## Verification

Rule ordering verified (RULES[0], first-match return). Both unsafeReason
consumers traced: gauge evaluate.ts (shadow-only `refused` counter — the
intended behavior change) and opencode-plugin check-screen.ts (no-op —
its own BACKTICK_RE rejects before unsafeReason is reached). Suites:
cc-gate-plugin 1038/0 · opencode-plugin 1976/1 skip/0 fail ·
gauge-guard 10/10 · guard-parity 2/2. gauge/ is F1-editable and not a
MECHANISM_PATH — no calibration duty. Deploy = separate step
(km-refresh per host); until refreshed, installed 0.4.3 keeps old
behavior — partition gauge refusals by pluginVersion.
