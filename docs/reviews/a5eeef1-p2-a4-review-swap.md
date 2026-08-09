# Review artifact — p2-a4-review-swap (P2's A4 lane off the 4-slot pool)

reviewed-range: 9b40a96422b8b12f53a8c78497e844cddc3e13e5..a5eeef1
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 1

Moves `opencode-plugin/src/bench/p2/a4-review.ts` — the last consumer worth moving for
throughput — from the in-repo `cc-gate-plugin/src/acp/` client onto
`@th-yoo/cc-api-daemon` v0.3.0.

**Why this consumer specifically.** `A4_MODEL = "claude-haiku-4-5"`, and the package's
`routeBackend` sends haiku to its `api` lane where `ApiSession` bypasses the session pool
entirely. The in-repo client pools at `DEFAULT_MAX_SESSIONS = 4`, and that ceiling is the
actual problem being solved — four concurrent prompts is what makes a gated Stop slow.
This is the swap that frees a slot rather than merely tidying an import.

**`6e1e4ab`** — bumps `opencode-plugin`'s pin from `469456b` (v0.2.0) to `f99bcd6`
(v0.3.0), matching `cc-gate-plugin`. The repo now carries ONE version of the package
rather than two.

**`0c2cf4c`** — repoints the import, rewrites the stale prose (the header asserted "the
ACP warm lane is imported ONLY from cc-gate-plugin/src/acp/index.ts", false after this
change), and moves `test/p2-a4-review.test.ts`'s type-only `DaemonOutcome` import for
consistency. No call site needed adjusting — the signatures matched, as the review-sensor
precedent predicted.

**`a5eeef1`** — the finding, below.

**Deliberately NOT touched, and one of them is a trap.** A sibling session flagged three
remaining in-repo importers and framed the swap as "partial". Two were correct and are
done here. The third — `opencode-plugin/test/minimal-llm-acp.test.ts:25`'s
`envFingerprint` import from the deep internal `cc-gate-plugin/src/acp/acp-paths.ts` —
was left alone deliberately. That test drives `seatCall` -> `anthropic-cli-warm.ts` ->
the OLD client, which stays on the old stack. The two `envFingerprint` implementations
were measured directly: they AGREE on a plain env but DIVERGE once `ACP_IDLE_MS` is set
(the old one hashes it, the new one denylists it). Switching that import would pass today
and break silently the moment anyone sets `ACP_IDLE_MS` — which is exactly the knob
proposed for the sensor's idle/debounce race. A test's fake must match the client under
test. `cc-gate-plugin/src/gauge/providers/anthropic-cli-warm.ts` likewise stays on
`../../acp/index.ts`.

**THE FINDING (Important, documented not fixed — root cause is package-level).**
`call.ts:26` caps every api-lane turn at 2048 output tokens, and it is unreachable from
any consumer: `daemonCall`'s opts is `{ isolation, budgetMs? }`, the `session/prompt`
frame carries no such field, and `ApiSession` never passes one. `sendOne` *already*
accepts `opts.maxTokens` — nothing threads it through. The CLI lane A4 just left had no
cap at all, so this is a regression introduced purely by changing lanes.

Concretely: `buildA4ReviewPrompt` requests `{"complied": bool, "requiredEdits": [...]}`
with no bound on the array. Past 2048 output tokens the JSON truncates mid-object,
`parseA4Review` fails, `runA4Review` returns `undefined`, and the caller treats that as
`reviewFailed` and skips the re-pass. It fails safe — but silently.

That is more than a footnote because P2 is an experiment comparing rule-delivery
carriers, and A4-review-and-reinject is one of the arms. Silent truncation would make
that arm underperform for an instrumentation reason rather than a real one, biasing the
comparison. P2's spend go is still pending, so there is time to handle it before data
exists. Documented as a KNOWN LIMITATION in `a4-review.ts`'s header (failure chain
spelled out in the file's own `reviewFailed` terminology), and the root fix is specced
upstream at `cc-api-daemon/docs/plans/2026-08-08-maxtokens-passthrough.md` — thread
`maxTokens` through as a strictly additive optional param.

**Verified no other behavioral delta.** The reviewer checked against the installed
package, not the diff: outcome classification (`no-call`/`call-consumed`/`ok` and the
post-send error procedure) is byte-identical between old and new clients; `session/close`
correctly closes a never-pooled `ApiSession`; `ACP_BUDGET` values are identical and
`a4-review.ts` overrides none; all six imported names exist at v0.3.0 with matching
signatures; `WarmIsolation`'s field shape matches `A4_ISOLATION` field-for-field.

**P2 READINESS IS NOW STALE.** Its estimates were computed against the old stack. This
range changes A4's transport and lane. Re-derive before the pending bench spend go rather
than spending against figures that describe a configuration that no longer exists.

Verified: `opencode-plugin` tsc clean + 1863 pass / 1 pre-existing skip / 0 fail (117
files); `cc-gate-plugin` tsc clean + 1132 pass / 0 fail; `git diff cc-gate-plugin/src/acp/`
EMPTY. The full opencode-plugin suite was run deliberately — until `5d0e9be` the gate's
tier-1 never ran it, so this exact class of cross-package break was invisible to both tiers.
