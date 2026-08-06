# P2 actuator-binding — final-review C1 fix wave report

Plan: `docs/superpowers/plans/2026-08-06-p2-actuator-binding.md`.
Worktree: `worktree-agent-a4c12de8dbd81afd8` (merged `worktree-p2-actuator-binding`
at merge time, then fixed here). Trigger: ONE Critical finding from the
final whole-branch review (C1, confidence 95).

## The finding

`opencode-plugin/src/bench/p2/assets/stop-gate-settings.json` used `exit 1`
in its Stop-hook command. Claude Code hook semantics: only **exit 2**
blocks a Stop event and feeds stderr back to the agent as continuation
instructions; exit 1 is non-blocking (agent stops normally, stderr goes to
the user only). In-repo precedent: `cc-gate-plugin/src/output.ts:45`
(`exit2-stderr` delivery mode returns `exitCode: 2`) and
`cc-gate-plugin/src/hook-cli.ts:10-11` ("the only non-zero exit is an
intentional block delivered via KKAMAK_DELIVERY=exit2-stderr"). As shipped,
the A3 arm's Stop-gate never blocked — the entire binding mechanism was a
no-op.

## Part 1 — asset + test fix

- `opencode-plugin/src/bench/p2/assets/stop-gate-settings.json`: `exit 1` →
  `exit 2` in the Stop hook's command string (the rest of the message is
  unchanged).
- `opencode-plugin/test/p2-cmd.test.ts` — extended the existing "A3
  carrier" drift test (`A3 carrier: stop-gate-settings.json's hook message
  pins the frozen rule's load-bearing fragments`) with two more
  assertions: `hookMessage` contains `"exit 2"` and does NOT contain
  `"exit 1"`. A regression back to exit 1 now fails CI.

## Part 2 — plan correction (pre-data, recorded)

`docs/superpowers/plans/2026-08-06-p2-actuator-binding.md`:

- Task 4's arm description (§Task 4, the `a3:` bullet, previously line 166)
  said a "nonzero" hook exit blocks the Stop event. Corrected to name
  `exit 2` specifically and note exit 1 is non-blocking.
- Appended a new bullet to the Frozen Rule section (after the existing
  "Production note" bullet, same block that holds the
  2026-08-06 PRE-DATA AMENDMENT) titled **PRE-DATA CORRECTION
  (2026-08-06, source: final whole-branch review finding C1, confidence
  95)** recording the wrong claim, the corrected semantics, that the asset
  shipped with the bug and was fixed in the same commit, and the two
  in-repo precedent citations as evidence. No other frozen text was
  touched.
- `cmd-p2.ts`'s header comment was checked for the same wrong claim (per
  the task's instruction to check it) — it does not restate the "nonzero
  blocks" claim anywhere (its Stop-hook/A3 wording lives only in the plan
  file), so no edit was needed there.

## Part 3 — blocking-consequence probe (Probe C, real spend)

Extended `docs/loop-probes/p2/PROBE.md` with a new "Probe C (blocking
consequence, post-C1 fix)" section, reusing Task 1's exact container/auth
recipe verbatim via the actual library functions
(`prepareClaudeCodeAuth()`, `sandbox.ts`'s `buildCreateArgv`/
`buildStartArgv`/`buildExecArgv`/`buildCpToArgv`/`buildRmArgv`, the
claude-code driver's `buildArgv` argv shape) rather than hand-typed podman
commands.

Procedure: container with the CORRECTED settings copied to
`/app/.claude/settings.json` (via `podman cp` of the real, post-fix asset
file — confirmed by `cat` to contain `exit 2` and not `exit 1` before the
model call), one `claude -p "reply with the word ok"` call (an instruction
that does NOT ask the agent to write `DONE-CHECK.txt`).

**Result: the corrected gate blocks.** `/app/DONE-CHECK.txt` exists after
the run even though the instruction never mentioned it — the Stop hook
fired, blocked the first stop attempt, and the agent then acted to satisfy
the gate. NDJSON shape: 38 lines, `num_turns: 4`, `subtype: "success"`
(vs. the Probe A/B control shape: 8 lines, `num_turns: 1`, immediate
stop). Full command table, exit codes, and event-type counts are in
`docs/loop-probes/p2/PROBE.md`'s "Probe C" section (F2 — no reply/
transcript text recorded, counts and marker/exit-code observations only).

Verdict: **NOT BLOCKED** (i.e., the probe's negative-outcome branch did
NOT occur) — no user ruling needed on this axis; A3's binding mechanism is
confirmed live post-fix.

Cleanup: container `mh-p2-probec-run-1786024920924-3063` removed via
`podman rm -f -t 0`; `prepareClaudeCodeAuth()`'s `cleanup()` shredded the
Keychain-exported `.credentials.json` and removed the per-run temp dir.
Verified post-run: no `p2-probe*`/`p2-probec*` container remains on the
host; no non-test `mh-bench-cc-auth-*` temp dir newer than the probe
remains.

## Spend

3 of the 4 total authorized `claude-haiku-4-5` probe calls now consumed
(2 from Task 1's Probe A/B, 1 from this task's Probe C). 1 call remains
unspent — not needed; a single Probe C call was sufficient to observe the
blocking effect unambiguously (num_turns 4 vs. 1, DONE-CHECK.txt present
with no instruction to write it).

## Verification

- `cd opencode-plugin && bun test test/p2-cmd.test.ts` — 24 pass, 0 fail,
  64 expect() calls, including the two new exit-code assertions.
- `cd opencode-plugin && bun test` (full suite) — 1763 pass, 12 skip, 0
  fail, 4652 expect() calls across 117 files (unrelated pre-existing
  suites unaffected by this change).
- `cd opencode-plugin && bunx tsc --noEmit` — clean, no output, exit 0.

## Concerns / follow-ups

- None blocking. The A3 arm is now load-bearing as originally intended;
  the plan's Task 6 sized-go table and readiness checklist
  (`docs/loop-probes/p2/READINESS.md`) were not re-derived here (out of
  this fix wave's scope — no arm counts or `--go` math changed by this
  fix) but should be re-read before any real arm run, since A3 attempts
  will now actually incur the block-and-reprompt turn cost this probe
  demonstrated (up to CC's own consecutive-block bound), which the
  original sized-go table's timing assumptions may not have accounted for
  given the asset was previously a no-op.
