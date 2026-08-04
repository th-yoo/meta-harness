# Review artifact — acp-session-pool (ACP warm lane + send-prompt interface, T1-T5a/N1-N5/N3a-N3c-iv)

reviewed-range: 6c0f1c8a7c32eae16dcedbe1c21ba2bcf10d2684..95cfa8238753410ac1c5d29a14359ee0fb247f0d
reviewer: fresh-context-opus-whole-branch + per-node sonnet/opus task reviewers + scoped re-reviewers
fresh-context: true
verdict: approved
findings-count: 16

Branch delivers the ACP warm-CLI lane end to end under the 2026-08-04 user
ruling ("sessions are keep-alive — callers never see an ACP session",
docs/superpowers/specs/2026-08-04-send-prompt-interface.md): acp-wire
(framing, error codes, `_meta.kkamak` + OnlyKkamak type guards,
modelProvenBy), WarmSession (sequenced /clear recycle consuming both
conversation_reset and the measured synthetic result), acp-paths
(fingerprint/locks), the ACP daemon (scoped cancel via daemon-minted tags,
probe-first-under-lock takeover — Bun 1.3.1 never raises EADDRINUSE on unix
sockets, measured — idle reaper, re-locked shutdown unlink), acp-client
(write-callback send boundary, L3 three-step classification, spawn-under-lock
ensureDaemon), SessionPool (isolation-value keying, cap 4 measured at
~330 MB/session — docs/2026-08-05-warm-session-rss.md), daemon-onto-pool with
isolation crossing the wire, the sendPrompt interface (never-throws,
no-call/call-consumed at top level, pre-data maxTokens amendment) with
anthropic-api and anthropic-cli-warm providers (modelProvenBy adjudicated at
the provider), and the minimal/ design-time seats migrated onto sendPrompt
with explicit REASONING_ISOLATION.

Process: every node had a fresh-context task review; 7 fix rounds total, each
ending in a scoped re-review (SDD ledger:
.superpowers/sdd/2026-08-04-acp-session-pool/progress.md, host-local).
Notable loop catches: Bun's silent unix-socket steal, the acp-client
connect-listener same-tick race, the SessionPool opts.max NaN cap bypass, a
cancel-scoping test that lost determinism under the pool (measured 1016/1,
fixed via same-chunk frame writes with an independently traced synchronous
chain), and the KKAMAK_ACP_TURN_TIMEOUT_MS instrument knob the pool would
have silently dropped (caught by the implementer's own stop clause).

Whole-branch fresh-context opus review over 6c0f1c8..768bf6e traced the §6e
boundary law end to end (no layer can launder call-consumed into no-call),
proved the cap→fallback double-bill structurally impossible from both ends,
verified isolation parity across lanes (documented asymmetries: maxTokens,
thinking:enabled), confirmed S1-S4 surface genuinely deleted, and reproduced
1029/0 + 1770/0 independently. Verdict: 0 Critical / 6 Important / 10 Minor,
ready-with-fixes. Single fix wave (21ad9d8, ad98487, 0d0adae, 1098493)
closed: isolation validator hardened to field-for-field structural checks,
classifyPostSendError non-object-data laundering, silent max_tokens
truncation on the live seat path (stopReason → onTruncation → seatCall
throws), RSS provenance moved into the repo. Scoped re-review verdicted
F2/F3/F4 addressed and F1 partially open (array-content gap); one
user-sanctioned closing fix (95cfa82) enforced the empty-tuple and
thinking-union contracts, verified live (31/0 daemon file, 1043/0 suite,
tsc clean both packages).

Remaining, recorded not hidden: 25+ deferred minors triaged 28/30
OK-to-merge by the final review (two promoted and fixed above); the warm
lane ships UNWIRED (no production caller registers anthropic-cli-warm —
per spec §5, wiring is a later explicit decision); the proposer boundary-ts
is stamped in docs/2026-08-01-gauntlet-adoption-ledger.md at merge, not on
the branch.
