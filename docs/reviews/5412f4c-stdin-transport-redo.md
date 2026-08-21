# Review — fix/judge-window @ 5412f4c: stdin-transport redo + review wave

reviewer: fresh-context-opus-subagent (lane B) + 5-lens-multi-agent (lane A sibling session)
fresh-context: true
verdict: fix-first
findings-count: 9
reviewed-range: 983fe2d..5412f4c

Two independent fresh-context reviews, neither authored by the range's author,
each with empirical mutation runs (lane B: 1 spot-check + 6 delta
reproductions; lane A: 5 lenses, 38 raw findings, adversarial verification in
isolated worktrees, 33 survived). Scribe: lane-B controller session (not an
author of any commit in range). Suite at tip, measured independently by both:
opencode-plugin 2191 pass / 0 fail / 12 skip (2203 tests, 5887 expects);
tsc 2 errors byte-identical to main's pre-existing pair.

## Blockers from the prior BLOCKED review (e6b6666 record, ecde549) — ALL DISCHARGED

1. `stdin: "inherit"` regression → opt-in `"ignore"` default (exec.ts:86);
   kill-verified: flip to "inherit" times out test 6 (now PATH-independent via
   process.execPath).
2. Write outside the timer → created after timer armed, awaited inside the
   same Promise.all as both drains; kill-verified both directions (awaited
   pre-timer form reproduces the hang; the measured rule — do not AWAIT before
   arming — is now what the comment states).
3. tsc parity → exact: 2 pre-existing errors, identical text to main.
Bonus: prior "zero transport coverage" closed — deleting the write/end block
fails 4 named tests.

## Review-wave fixes at 5412f4c (all 7 verified ADDRESSED by delta re-review)

macOS platform guard (linux-gated argv-throw assertion; stdin half runs
everywhere) · write awaited (closes the backpressure unhandled-rejection
class; write() measured returning number | Promise | boolean) · honest Bun
ambient decl (dropping the `!` guard yields TS18048 ×2; decl matches measured
runtime incl. the boolean case absent from Bun's own types) ·
process.execPath in the inherit-guard test · kill-map corrected to measured
rules with explicit kill-NOTHING rows · judge call-site disclosure: the stdin
move changed the exact prompt bytes vs main (installed 1.17.20 quote-wraps
argv messages with escaped internal quotes; stdin arrives verbatim) — judge
verdicts across this merge boundary are not directly comparable · retry
attempts 2..N stdin assertion (kill-verified).

## Open findings at this verdict (9)

1. **ecde549 #5 (the fix-first hinge)**: DEFAULT_TRAJ_CAP=100_000 makes
   judge-prompt.test.ts's named mutation (hardcode 100_000 in judge.ts:65)
   undetectable — re-verified at tip: 17/17 green under the mutation. NOT a
   regression of this branch; recorded open in ecde549 and deferred by scope
   ruling (see Deferral note). Two-line fix in files this range never opens.
2. ecde549 #6: vacuous assertion, judge-prompt.test.ts:155,160.
3. ecde549 #7: truncationNotice off-by-marker ("first 35 of 24 characters").
4. ecde549 #8: drivers/opencode.ts:63 + engine.ts:466/475 bare-slice, no marker.
5. F8 (lane A): delivery unobservable — write()/end() returns cannot audit
   delivery; child stderr captured then discarded. Hardening, out of scope.
6. F9 residual: nothing spawns a real opencode in tests — an opencode upgrade
   that stops reading stdin turns judges into silent nulls with a green suite.
   (The premise itself was live-verified on installed 1.17.20 at zero spend.)
7. Silent `.catch(()=>{})` on the write (crash insurance; mutation-untestable
   — no probe produced a rejection; stated as insurance in situ).
8. D1 (delta re-review, minor): exec.ts paragraph 1 still says concurrent
   stdout/stderr "can deadlock" while the delta's own 1b measurement
   (1 MB/1 MB, 397 ms, no deadlock) points the other way; one clause.
9. Driver argv prompt paths (out of range, queued as own change): drivers/
   opencode.ts:172 and drivers/claude-code.ts:276 still pass instruction via
   argv; the container path also needs `podman exec -i` before stdin works
   there.

## Refuted (recorded so nobody re-litigates)

"test 4 has zero kill power" (soft-rc wrap reds it) · "fixture-arithmetic
expects can never fail" (they audit the fixture premise) · "deleting the 125k
guard removed a fail-closed path" (it was pre-flight only; net exposure
strictly lower than main) · "agent-run.ts:130 misleads" (stale umbrella
clause, operative reason survives, errs restrictive).

## Deferral note (the verdict hinge)

Both reviews mark the delta standalone APPROVED. The fix-first verdict
attaches to open finding 1 (ecde549 #5), which predates this branch, is
recorded open in the committed review record ecde549 on main, and was
explicitly left out of this branch's scope ("its own decision with its own
evidence" — acd58aa commit message). The merge decision therefore rests on
that recorded deferral plus the user's explicit merge instruction, not on a
claim that the range is defect-free.
