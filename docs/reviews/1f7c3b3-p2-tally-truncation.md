# Review artifact — p2-tally-truncation (aggregate reviewTruncated + rePassHardFail)

reviewed-range: 2c51d0704ffcb45845172a95a949c2e37cea20d0..1f7c3b3f4519c8cd3fd7dfe57bd3a3cfd15c9c3d
reviewer: fresh-context-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One commit, two files (`scripts/p2-tally.ts`, `km-crank/test/p2-tally.test.ts`).
Closes the recorded gap ("p2-tally still does not aggregate reviewTruncated —
manual grep after the run", resume.md item (b) / 05e3d1d artifact): the two
instrumentation-failure booleans ff8dbb8/083aa07 put into the per-attempt
annotation now reach the committed verdict json as counts
(`reviewTruncatedCount`, `rePassHardFailCount` on the a4 arm), so A4's
compliance/reviewFailed numbers are never read without knowing how many
failures were the lane's fault rather than the model's.

The reviewer worked in the isolated worktree, opened every file itself, and
verified point by point:

- **Producer/consumer parity:** `cmd-p2.ts:549-550` (`attemptLabel`) writes
  `reviewTruncated`/`rePassHardFail`; `p2-tally.ts:103-104` reads the same
  keys. Exact spelling match — a typo'd key would have counted zero forever.
- **Tolerant parse NOT tightened:** the required-field `typeof` gate
  (`p2-tally.ts:92-97`) is untouched; the new fields read via `=== true`, so
  absent/wrong-typed resolves to `false`, never a parse failure. A legacy
  annotation without the fields still parses and still contributes its
  `compliant` bit — pinned by test (`p2-tally.test.ts:198-208`). The
  alternative (requiring the fields) would have silently dropped every
  legacy line's compliance — worse than the gap being fixed.
- **Reaches the verdict file:** `{ ...stats.a4, ...computeA4Extra(docs.a4) }`
  (`p2-tally.ts:444`) spreads straight into the object that is
  `JSON.stringify`'d to disk (`:460`); grep confirms no schema/whitelist
  layer strips unknown fields.
- **Counting semantics:** `reviewTruncatedCount` is deliberately a subset of
  `reviewFailedCount` (truncation implies reviewFailed per `cmd-p2.ts`
  212-220) — the subset/superset relationship is the point, not double
  counting. `rePassRate` byte-for-byte unchanged.
- **a1/a3 isolation:** `computeA4Extra` is called only at the a4 key; a1/a3
  stats paths never touch the new fields. `computeArmStats` ignores them.
- **F2:** booleans in, counts out — no text enters the committed verdict.
- **Refusal path:** the all-three-results-files existence refusal
  (`p2-tally.ts:380-384`) runs before any doc read — unaffected, still
  covered by its own tests.
- **Tests are real pins:** each of the three new tests fails under a
  plausible regression (flag dropped, flags swapped, parse tightened); the
  one pre-existing exact-shape test update is a legitimate contract
  widening, and the malformed/wrong-shape negative tests are untouched.

**Division of verification labor, recorded:** the reviewer's session had no
exec tool, so it traced every assertion by hand rather than running the
suite; the suite runs were done by the author and are part of this record:
`km-crank/test/p2-tally.test.ts` 30 pass / 0 fail; full km-crank 386 pass /
0 fail; km-crank `tsc --noEmit` shows zero p2-tally errors (remaining lines
pre-exist on main). TDD: the three new tests were watched failing before the
implementation (3 fail / 27 pass), then green.
