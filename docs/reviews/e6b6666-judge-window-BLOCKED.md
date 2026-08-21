# Review — fix/judge-window @ e6b6666: BLOCKED

Not a gate artifact (the gate requires `verdict: approved|fix-first|blocked`
with `fresh-context: true`; this records a BLOCKED outcome so the findings
survive the session). Reviewer: fresh-context subagent, no session history,
non-author. Suite at review time: 2183 pass / 0 fail / 12 skip.

**verdict: blocked · findings-count: 8 · three BLOCKERS, all introduced by the
repair itself.**

## Blockers

1. **`stdin: "inherit"` regresses EVERY `runHost` caller.** Bun's real default is
   `"ignore"` (`/proc/self/fd/0 -> /dev/null`), not `inherit`. The commit message
   claims "every existing caller untouched" — **false**. Verified independently
   here with the parent's stdin held open:
   `ignore: rc=0 out="drained" ms=3` vs `inherit: HUNG until killed`.
   Affects podman create/start/exec/cp/build, `fleet/run.ts`, `squad-propose.ts`;
   children can now consume the runner's terminal input. Correct value: `"ignore"`.
2. **The stdin write is outside the timeout and before the drain**, violating
   this module's own documented "parity trap #4" invariant. Measured hangs at
   220,000 bytes with `timeoutSec=2` ignored. `DEFAULT_TRAJ_CAP` is 200,000
   **chars** against a measured assembled prompt of **202,770** — ~5% under the
   hang threshold for ASCII, PAST it for multi-byte content. The 176 KB
   end-to-end proof landed just below the cliff.
3. **Typecheck regression**: main 2 errors -> branch 5. `opencode-run.ts:121`
   is substantive — `stdin` is absent from `HostExecFn`'s opts type, so the
   injected-`execFn` seam cannot carry the prompt and every test double is blind
   to it.

## Two findings previously reported CLOSED are not closed

4. **The stdin transport has ZERO coverage.** Deleting the whole
   `proc.stdin.write/end` block fails **0 tests**; restoring the original argv
   defect fails **0 tests**. The two "transport" tests cannot fail —
   `buildJudgeArgv` takes no prompt parameter, so asserting the prompt is absent
   from argv is vacuous by construction.
5. **Prior #5 not closed**: replacing `cap = DEFAULT_TRAJ_CAP` with a hardcoded
   `200_000` in `judge.ts` still passes all 17 tests in that file.
6. **Prior #4 half closed, plus a NEW vacuous assertion in the same commit**:
   appending an imperative to the in-data marker leaves the "marker is NEUTRAL"
   test PASSING. `judge-prompt.test.ts:159` asserts a property of an unused local.

## Correctness and scope

7. The documented `cap < marker` exception makes the TRUSTED notice state a
   falsehood: `renderJudgeAuditEvents([], 5)` yields "you are seeing the first 35
   of 24 characters". The asserted invariant (`shownChars === text.length`) is
   the WRONG one — `shownChars` must count trajectory chars (`room`).
8. **The branch does not achieve its stated goal.** `drivers/opencode.ts:63`
   (args->300, output/text/error->800) and `engine.ts:466,474,475` bare-slice
   events UPSTREAM with no marker, so unannounced truncation still reaches
   judges by exactly the documented mechanism.

## Standing

`main` is UNAFFECTED — the branch is unmerged (4 commits ahead) and `main`'s
`exec.ts` contains no stdin change. The hang exists only on `fix/judge-window`.

**Recommendation on file:** revert the stdin/transport half of `9218f0f`, keep
the truncation-disclosure work (sound), and redo the argv ceiling as a separate
change with real tests. The repair introduced worse defects than the bug it
fixed — the original silently truncated evidence; this version can hang the
runner. The gate blocked it three times and was right each time.
