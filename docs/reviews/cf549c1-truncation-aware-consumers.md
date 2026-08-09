# Review artifact — truncation-aware-consumers

reviewed-range: 1b9d3eae246d30425b9133c09ab0a3d0cee24186..cf549c1
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

Teaches both JSON-emitting consumers to tell a TRUNCATED reply from a malformed one.

**The problem.** Both consumers ask the model for JSON and parse the reply. The api lane
caps output at 2048 tokens; past it the JSON truncates mid-object, the parse fails, and
each consumer folded that into a generic failure — indistinguishable from "the model
returned junk". Those need opposite fixes (bound the output vs. fix the prompt), and
nothing on the wire let them be told apart. `cc-api-daemon` v0.5.0 (`baee1c4`) fixed the
wire half by surfacing the API's real `stop_reason`; this range consumes it.

Note what was NOT done, deliberately: `maxTokens` was not raised. It is budget-bound —
`turnTimeoutMs` is 16 000 ms and `AUTH_RESOLVE_BUDGET_MS` (10 000) can consume much of it
on the api lane, so past roughly 2 000 output tokens a bigger cap trades a truncation for
a `call-consumed` TIMEOUT: spent AND ambiguous, strictly worse. Detectability was the fix.

**`cccea67`** — both packages pinned to `baee1c4b394c03e7b7d2a72ac40b38cbadfdd5cb`
(v0.5.0), same SHA, verified in both lockfiles (identical integrity hash) and both
installed `.bun-tag`s.

**`da2130e`** — review-sensor gains skip reason `"output-truncated"`, emitted when
`outcome.stopReason === "max_tokens"`, checked BEFORE `parseFindings`.

**`cf549c1`** — `runA4Review` returns a three-way union with `A4ReviewTruncated`
(narrowed by `isA4ReviewTruncated`), checked before `parseA4Review`; `cmd-p2.ts` threads
`reviewTruncated` onto `P2AttemptResult` so it reaches the committed results file, not
just stderr. A distinct return shape was chosen over a logged marker precisely because
P2's verdict is read from committed results, and a log-only signal would never reach them.

**THE SEMANTIC THAT MATTERED MOST — verified exhaustively.** v0.5.0's `stopReason?` is
OPTIONAL, and **absent means UNKNOWN, not "not truncated"** — the agent lane reports
nothing. Every branch in both consumers tests the literal `=== "max_tokens"`. The
reviewer confirmed there is no `!stopReason`, no falsy coercion, no `??`-defaulting
anywhere in the diff. A consumer inferring "complete" from absence would have been a
Critical finding; none exists.

**CHECK ORDER, proven rather than asserted.** A truncated reply ALSO fails to parse, so if
the parse ran first the specific signal would be swallowed by the generic one and the
whole feature would be dead code. Both consumers check truncation first, and each has a
test that passes **well-formed, parseable JSON** together with `stopReason: "max_tokens"`
and still expects the truncation outcome — which distinguishes "checked first" from
"fell through from a failed parse". Negative cases are pinned too: absent `stopReason`
with junk text, and `stopReason: "end_turn"` with junk text, both yield the GENERIC
reason.

**Test strengthened, not weakened.** The `SkipReason` enumeration test was a hand-copied
literal array; it became `Record<SkipReason, true>`, so a missing or excess reason now
fails `tsc` rather than silently drifting from the implementation. The sensor path is
additionally proven end to end through the package's published `fakeDaemon(...,
{ apiStopReason: "max_tokens" })` over a real WebSocket, so the field is known to survive
the wire and not merely the injected-fake unit tests.

**Follow-up, recorded not fixed (reviewer's observation, agreed).** `scripts/p2-tally.ts`
does not AGGREGATE `reviewTruncated` — it is committed to the results file but nothing
summarizes it, so a P2 run would need someone to grep raw `errors[]` JSON to see
truncation counts. The task's own rationale (an arm must not lose for an instrumentation
reason) is therefore only half-closed until a summarizer reads the field. Verified the
addition is safe for today's reader: `parseAttemptAnnotation` reads only
`compliant`/`reprompted`/`reviewFailed`/`error` behind explicit `typeof` checks, so the
extra key is ignored rather than reshaping an existing assertion.

**MERGE-ORDER NOTE for whoever lands `p2-judge-logging`.** That branch and this one both
modify `opencode-plugin/src/bench/p2/cmd-p2.ts` and `test/p2-cmd.test.ts`;
`git merge-tree` reports a real content conflict in both. User ruling (2026-08-09): this
range lands first, and `p2-judge-logging` resolves the conflict when it lands — its author
wrote the judge-logging changes and holds the most context for that file. Nothing else in
this range touches anything that branch touches.

Verified: `cc-gate-plugin` tsc clean + 1137 pass / 0 fail (baseline 1133, +4);
`opencode-plugin` tsc clean + 1871 pass / 1 pre-existing skip / 0 fail (baseline 1863,
+8); `git diff cc-gate-plugin/src/acp/` EMPTY; `anthropic-cli-warm.ts` and
`minimal-llm-acp.test.ts` untouched (both deliberately on the old in-repo client).
