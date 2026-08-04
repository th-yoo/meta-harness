# Review artifact — wire-warm-lane (env-gated seat wiring for anthropic-cli-warm)

reviewed-range: b5357132d4da60ac62b2741053b29763dacc2ea9..9663129f66067ef4fcca302e013b09eb94e6552c
reviewer: fresh-context-sonnet-task-review
fresh-context: true
verdict: approved
findings-count: 1

Single-node branch: `seatCall` (minimal/llm-acp.ts) gains provider selection
via `KKAMAK_SEAT_PROVIDER` read from the call's own env object. Absent or
`anthropic-api` ⇒ byte-identical default path (warm code structurally
unreachable, existing 10 tests byte-unedited). `anthropic-cli-warm` ⇒ warm
lane first; `no-call` falls back to one anthropic-api attempt with identical
options (spec-legal: nothing was sent); **`call-consumed` throws before any
api registration or call — never falls back** (the §6e double-spend line,
proven at the wire by a zero-captured-HTTP-requests test after a -32001).
Garbage env values fail loud before any provider is constructed.

Review independently traced the consumed path end to end (fake daemon
-32001/callConsumed:true → client L3 step-i → provider pass-through → throw
naming kind+provider), verified the default path structurally cannot touch
daemon code, and validated the declared test deviation (unwritable-parent
socket path — a plain nonexistent dir would be silently created by
ensureSocketDir's recursive mkdir, and test 3 would spawn a real daemon)
including a live EACCES trace. All 5 new tests assert stub-captured request
counts, not return values. cc-gate-plugin 1043/0 untouched; opencode-plugin
1776/1 skip (+5); tsc clean both.

Verdict findings: 0 Critical, 0 Important, 1 Minor deferred (fallback
exhaustiveness is structural — a comment on a closed 2-kind union — rather
than a compile-failing `never` assertion; noted for the next time the file
opens).

NOT an activation: no boundary ts. The instrument moves only when
`KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` is set in a live environment —
that flip is a separately-logged decision (adoption-ledger activation-log
entry, §4b precedent).
