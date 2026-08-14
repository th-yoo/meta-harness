# Review artifact — daemon-carrier-migration (claude -p elimination from production LLM seats)

reviewed-range: 3716ea8ba6006d2bc530720f8db2d11311fe29fc..77288bc2498347f197aa3a5560a60debad1e3b86
reviewer: fresh-context-fable-code-reviewer (whole-branch, post-merge post-sweep)
fresh-context: true
verdict: approved
findings-count: 0

Twelve commits, two parallel tracks merged to main: judge seat
(runClaudeCodeTextAgent) body-swapped to a toolless cc-api-daemon call
(B1+B2, sibling session, worktree feat/daemon-judge); proposer/promoter/
curator seat (runClaudeCodeTaskAgent) restructured to a detached bun
worker — harness assembles the prompt (json-reply outputMode fork of the
three prompt builders), one daemonCall with OUR system prompt under a
hard deadline provably inside the proposer-lock horizon, harness
validates the JSON reply and writes every staging file itself
(primary-last), provenance json + persisted prompt.md per cycle
(T0-T5 + one fix round, this session, feat/daemon-proposer). Dead-code
sweep (M1b) removed the entire claude -p spawn machinery from cc-host.ts.
Bench driver + p2 probes keep claude -p by explicit user ruling (the
measured specimen). cc-api-daemon dependency unchanged at pin 33f74db
(0.8.0); its toolless warm-lane isolation guard untouched.

Review independently traced (final whole-branch pass, on top of five
clean per-task SDD reviews and one architect-ratified fix round):
staging-path consistency worker-write vs apply-read across all three
kinds; deadline math cc-host spawnedAt -> worker deadline -> lock
reclaim horizon (margin holds); maxTokens lane-gating (daemon
hard-rejects maxTokens on the agent lane — seatMaxTokens is the only
source, gated on routeBackend); bare-vs-prefixed model-id convention at
every seam; opencode-host byte-same behavior (isCC discriminator +
type-only WorkerStagingPaths import); review-gate reviewModel threading
+ type widening; end-state grep (zero "claude" argv construction outside
bench specimen sites).

Verification evidence:
- full suite post-merge post-sweep: 2025 pass / 0 fail / 1 skip (bun
  test, opencode-plugin, serial)
- pre-merge: feat/daemon-judge 1996/0; rebased feat/daemon-proposer
  2031/0
- one real defect caught by full suite during the loop and fixed +
  re-reviewed: CC-path prompt.md persist ENOENT on fresh staging dir
  (writeTextAtomic swap, 3 trigger sites)

Deferred minors (ledger-recorded, triaged acceptable by the final
reviewer):
- test tmp-dir leak in pure-builder goldens (matches pre-existing
  convention in proposer-prompt-ledger.test.ts)
- no trigger-level wiring tests for triggerPromote/triggerCurate
  (manually traced correct; close before next structural edit there)
- informational: judge-side "unrecognized model spec" warn text still
  says "letting claude use its default model" — stale wording, no
  functional impact

Process: spec 13b9938 (user-refined brainstorm, per-site disposition
table), plan 3716ea8 (3-round code-architect review, 2 BLOCKERs +
1 CRITICAL fixed pre-execution), SDD per-task implement->review->fix
loop, two-session allocation (A=proposer, B=judge) with file-ownership
partition + deferred shared-prelude sweep. Boundary timestamps for
proposer-environment + judge-transport changes: see adoption ledger
(M3).
