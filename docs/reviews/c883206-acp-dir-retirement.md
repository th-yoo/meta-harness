# Review artifact — acp-dir-retirement (delete the src/acp mirror)

reviewed-range: 2a5e87389f7ae0a1e2ff8716fba3d7d201ad40cc..c883206db09169408386ea3ab1aa4e49a28536db
reviewer: fresh-context-opus-whole-branch (per-task: 3× fresh-context-sonnet)
fresh-context: true
verdict: approved
findings-count: 7 (2 Important comment-only + 5 assorted; all fixed in c883206, scoped re-review confirmed ADDRESSED ×5, deferred minors triaged leave)

The frozen historical mirror `cc-gate-plugin/src/acp/` is deleted. Before this range it
had zero runtime importers — every ACP consumer already ran on `@th-yoo/cc-api-daemon`
(pinned `git+…#baee1c4`, v0.5.0) — but four test files still reached into it and the
km-crank TIA policy tables still named its test files. This range cuts those last threads
and reverses the "src/acp/ stays" retention recorded in `docs/resume.md`.

**`63b7b06`** — docs: resume.md top block records the deletion + GAUGE_ISOLATION's new
home; `2026-08-05-warm-session-rss.md` measure-script pointer annotated retired,
retrievable via `git show 2a5e873:cc-gate-plugin/test/warm-session-rss-measure.ts`.

**`faf4aa3`** — km-crank: `SLOW_CCGATE_TEST_RE` shrinks to
`(anthropic-cli-warm|gauge-agent-transport)`; the five `SUITE_POLICY.ccgate` rules keyed
on deleted sources are removed and two surviving rules pruned of deleted test entries —
dead rules would have appended nonexistent paths to a `bun test` argv (hard error).
Necessary scope extension beyond the brief: `gate-check-cli.test.ts` fixtures sat on the
removed `acp-daemon.ts` rule; the reviewer confirmed the re-point to a surviving rule kept
the `scanFailed`-suppression path genuinely exercised instead of letting it go vacuous.

**`b6105c1`** — the deletion: 7 `src/acp/` files + 10 test/measure files, −6298 lines.
`GAUGE_ISOLATION` moves caller-side into `src/gauge/send-prompt.ts` (field-for-field
identical to the deleted literal — reviewer diffed the hunks directly; the package
deliberately does NOT export it, per its own acp-wire.ts comment). Both lock tests from
`acp-wire.test.ts:156-181` re-homed verbatim into `send-prompt.test.ts`, including the
field-for-field lock against the `agent-transport.ts:119-132` inline literal — verified
against the live file, not just the diff. `review-sensor-runner.test.ts` drops its
src/acp type import and the now-false "byte-identical by hard constraint" comment.
`acp-package-surface.test.ts` and `acp-client-singleton.test.ts` untouched by design —
they lock the package surface and matter more after the deletion.

**`c883206`** — final-review fix wave (all five findings ADDRESSED per scoped re-review):
the two Important ones were stale-claim comments in `km-crank/gate-check-core.ts` — a
2026-08-05 timing measurement quoting files that no longer exist (downgraded, marked
not-re-measured) and a "grep-verified 2026-08-05" claim re-verified 2026-08-09, now
honestly noting `anthropic-cli-warm.test.ts`'s unruled imports of `send-prompt.ts` /
`acp-client-singleton.ts` (deliberate: the GAUGE_ISOLATION lock runs in fast tier-0
`send-prompt.test.ts`). Plus: `agent-cli-stub.ts` header re-cited to surviving consumers
and two zero-consumer exports deleted (grep-proven), `NO_CREDENTIALS_SKIP_REASON`
un-exported (sole use is internal); rss doc's `gauge/acp-pool.ts` path — wrong even
pre-branch — corrected against `git ls-tree 2a5e873`; resume.md wording made
merge-survivable.

Repo-wide dangling-reference sweep (whole-branch reviewer, fresh context): zero live
references to any deleted path — every remaining mention is prose, an archival doc, or a
deliberate negative test (`gate-check-core.test.ts` asserting `pullInsFor(...) === []`).
`opencode-plugin/test/minimal-llm-acp.test.ts:23` imports the *sibling*
`src/acp-client-singleton.ts`, which survives. Root `gate-check.ts` discovers test files
by readdir, so deletions drop out of the fast argv automatically.

## Live smoke — first production call through the package (user go, 2026-08-09)

Everything above is test-verified; until today NOTHING on this stack had made a real
model call. `bun scripts/smoke.ts` in `~/z2/cc-api-daemon` (@ `baee1c4`, = the pin):
`ensureDaemon: true` · `outcome.kind: ok` · `text: "ok"` ·
`model: claude-haiku-4-5-20251001` (canonical same) · `provenance: true` ·
sessionId `75b2423c-a3dc-4dc8-a42b-465ff7045ea4`. One haiku call, api lane. `stopReason`
not surfaced by the smoke script (absent = unknown, per v0.5.0 semantics — not "not
truncated").

Verified: cc-gate-plugin 994/0 (57 files, post-deletion tree), km-crank 372/0 (re-run
after fix wave), gauge-agent-transport 13/0, root `bun scripts/gate-check.ts` exit 0,
doc-check 0 violations. Suites run serially per the standing concurrency flake note in
`520022a-gauge-cliwarm-swap.md`.
