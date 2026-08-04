# Review artifact — agent-sdk-transport (§6d third derive transport, Tasks 1-7)

reviewed-range: 4dfd5a22e9ab243435bf6847ae8d91db460897a2..65626ba053654e44da5aacdd9fbe200a37b9be6b
reviewer: fresh-context-opus-whole-branch + per-task sonnet reviewers + scoped re-reviewers
fresh-context: true
verdict: approved
findings-count: 12

Branch delivers the §6d agent-sdk derive transport (Tasks 1-7 of
docs/superpowers/plans/2026-08-03-agent-sdk-transport.md): transport
literal + env-selected routing + provenance stamping, agentSdkCall with
wire-measured context isolation, binding exactly-one-call proof, pv
machinery parameterized for any-two-transport pairing (PvPairing/derivedOn/
arms), --pair CLI flag fail-closed. Live derive path pinned to "sdk" in
code with a revert-detecting test.

Process: every task had its own fresh-context review + fix rounds (SDD
ledger at .superpowers/sdd/2026-08-03-agent-sdk-transport/progress.md).
Whole-branch fresh-context opus review over 4dfd5a2..7ff1b76 verified the
binding constraints by direct execution (default-path byte-preservation,
pin revert test, toBe(1) call-count, --pair refusal with zero store touch,
committed pv-counts artifact back-compat) and returned 0 Critical /
5 Important / 7 Minor. Single fix wave (35ed797, 6a7bdac, cbac62b)
addressed: cls-ab liveEnv pin (provenance can no longer silently flip),
api_retry abort guard (CLI 5xx auto-retry measured live; exactly-one-call
preserved), lazy SDK import (~84ms/hook reclaimed), credential skip-guard
(credential-less hosts skip loud instead of failing), de-CLI'd pv operator
surface, dead maxTokens deleted, 62s test wait cut, arms provenance on
manifest/combined files. Scoped re-review verdicted all 8 ADDRESSED, no
new breakage, live-verified on this host (857 pass / 0 fail, tsc clean).
One residual deferred with ruling: --pair=x:y equals form unrecognized
(fails loud as bogus-cwd refusal, never silently defaults).

Trailing commit 65626ba is docs-only (§6d retry/output-cap pre-data
asymmetry notes + resume.md handoff refresh), controller-authored after
the code review closed; no source or test files touched in it.
