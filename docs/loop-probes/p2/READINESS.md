# P2 actuator-binding — Task 6 readiness report (no spend)

Plan: `docs/superpowers/plans/2026-08-06-p2-actuator-binding.md`. Tasks 1-5
merged (`worktree-p2-actuator-binding`, HEAD `05608fe`). This report computes
the EXACT sized-go table for the user's go and records the readiness
checklist. **No arm has been run. Nothing self-adopts.**

## Band + counts (verified against the repo)

- Band file: `term-bench2/splits/loop1-band.txt` — **14 lines** (`wc -l`).
- k = 2, 3 arms (a1, a3, a4). Model: `claude-haiku-4-5` (`anthropic/claude-haiku-4-5`
  as `--model`) everywhere, per plan §Arms.
- `expectedGoCount(numTasks, k, arm)` (`opencode-plugin/src/bench/p2/cmd-p2.ts`)
  = `numTasks * k * (arm === "a4" ? 2 : 1)` — verified directly:
  `expectedGoCount(14, 2, "a1") === 28`, `expectedGoCount(14, 2, "a3") === 28`,
  `expectedGoCount(14, 2, "a4") === 56` (asserted in
  `opencode-plugin/test/p2-cmd.test.ts` lines 109-119, all passing).
- `--go` is a **per-invocation** fence (`cmdP2` dies before any container
  work if `args.go !== expectedGo`) — each `p2-run` command line below
  carries its own exact `--go N`.
- a4 re-pass: at most ONE bounded re-pass per a4 attempt, fired only when
  the haiku review returns `complied: false`
  (`opencode-plugin/src/bench/p2/cmd-p2.ts` `runOneP2Attempt`). Cap = a4
  attempt count = 28, so a4's `--go 56` (28 base + ≤28 re-pass) already
  covers the worst case; unfired re-pass budget is never reallocated.
- a4 review calls: one `runReview` call per a4 attempt that reaches the
  a4 branch (host-side, `A4_MODEL = "claude-haiku-4-5"` in
  `opencode-plugin/src/bench/p2/a4-review.ts`) — ≤28, same cap as attempts.
- Probe spend (Task 1, `docs/loop-probes/p2/PROBE.md` "## Spend"): **2 of 4**
  authorized `claude-haiku-4-5` calls already used (Probe A live call +
  Probe B `--max-turns` live call). 2 of the 4-call probe budget remain
  unspent (not needed — Task 1's decision gates already resolved: Probe A
  confirmed A3's Stop-hook route, Probe B confirmed `--max-turns` is
  accepted by the CLI parser).

## Sized-go table

| item | executions | --go carried by |
|---|---|---|
| Task 1 probe (already spent) | 2 of ≤4 haiku calls | n/a — Task 1, done |
| a1 | 14 tasks × k=2 = 28 container executions | `--go 28` |
| a3 | 14 tasks × k=2 = 28 container executions | `--go 28` |
| a4 (first pass + ≤1 re-pass/attempt) | 28 + ≤28 = ≤56 container executions | `--go 56` |
| a4 review calls | ≤28 haiku warm-lane calls | n/a (no `--go` — see Global Constraints; review calls are host-side, not container executions) |
| **total (base + worst-case re-pass)** | **≤112 bench container executions** | 28 + 28 + 56 |
| **+ review calls** | **≤28 haiku warm-lane calls** | |
| **+ probe (already spent)** | **2 of ≤4 haiku calls** | |

## Planned invocation lines (exact, results-file convention verified)

Results-file default (Task 5, `scripts/p2-tally.ts` `armResultsPath`):
`docs/loop-probes/p2/<hostname>-p2-<arm>-results.json`
(env-overridable per arm: `KKAMAK_P2_A1_RESULTS` / `KKAMAK_P2_A3_RESULTS` /
`KKAMAK_P2_A4_RESULTS`). `os.hostname()` on this host resolves to
`yoo-mac.local` — the invocations below use that literal path (no env
override needed; matches Task 5's default exactly).

```
# Task 1 probe: ALREADY DONE (2/4 spent, docs/loop-probes/p2/PROBE.md) — no further probe calls planned.

bun opencode-plugin/src/bench/cli.ts p2-run --arm a1 \
  --task-file term-bench2/splits/loop1-band.txt --k 2 \
  --model anthropic/claude-haiku-4-5 \
  --results-file docs/loop-probes/p2/yoo-mac.local-p2-a1-results.json \
  --go 28

bun opencode-plugin/src/bench/cli.ts p2-run --arm a3 \
  --task-file term-bench2/splits/loop1-band.txt --k 2 \
  --model anthropic/claude-haiku-4-5 \
  --results-file docs/loop-probes/p2/yoo-mac.local-p2-a3-results.json \
  --go 28

bun opencode-plugin/src/bench/cli.ts p2-run --arm a4 \
  --task-file term-bench2/splits/loop1-band.txt --k 2 \
  --model anthropic/claude-haiku-4-5 \
  --results-file docs/loop-probes/p2/yoo-mac.local-p2-a4-results.json \
  --go 56

bun scripts/p2-tally.ts
# reads the three results files above via armResultsPath() defaults (same
# hostname convention), writes docs/loop-probes/p2/yoo-mac.local-p2-verdict.json
```

Run detached in tmux (standing rule — no bare background shell for a
multi-hour job).

## Wall-clock estimate — arithmetic

Source: `docs/resume.md` line 90 — `haiku-4-5 43 tasks k=1 = 3.0 h measured
(median 1.7 min, mean 4.2 min)`, serial.

- Per-attempt mean: `3.0 h / 43 tasks = 0.0698 h/attempt` ≈ 4.2 min/attempt
  (matches the recorded mean directly).
- Base executions (a1 + a3 + a4-first-pass): `14 × 2 × 3 = 84` attempts.
  `84 × 0.0698 h ≈ 5.86 h` serial.
- Worst case, ALL a4 re-passes fire: `+28` attempt-equivalents.
  `28 × 0.0698 h ≈ 1.95 h` — re-passes are turn-capped
  (`A4_TURN_CAP = 10` turns, `opencode-plugin/src/bench/p2/a4-review.ts`),
  so this is a conservative (upper-bound) addition, not a measured rate for
  a bounded re-pass.
- **Total serial wall-clock: ≈5.9 h base, ≤≈7.8 h worst case** (all a4
  re-passes fire). Consistent with the plan/brief's own precedent estimate
  of 4-6 h tmux for the base case.
- a4 review-call latency is incurred inside the same attempt's elapsed time
  (review runs host-side between the agent phase and copy-tests/verify,
  before any re-pass) — already inside the per-attempt mean above, not an
  additive term.

## Readiness checklist

- [x] `opencode-plugin` full suite: `bun test` → **1763 pass, 12 skip, 0
      fail**, 4650 expect() calls, 1775 tests / 117 files (45.67s). Includes
      the new drift test below.
- [x] `km-crank` full suite: `bun test` → **370 pass, 0 fail**, 822
      expect() calls, 370 tests / 21 files (48.39s). One test-level SKIP
      logged (sensor-contract advisory parity — unrelated kkamak fixture,
      not landed, not a failure).
- [x] `opencode-plugin` `bunx tsc --noEmit` → clean, exit 0, no output.
- [x] `cc-gate-plugin` untouched: `git diff --stat main -- cc-gate-plugin`
      → empty (no output).
- [x] Drift test (deferred item 1, progress.md Task 4 minor "DEADLINE
      before Task 6 sized-go"): added
      `opencode-plugin/test/p2-cmd.test.ts` — "A3 carrier: stop-gate-
      settings.json's hook message pins the frozen rule's load-bearing
      fragments" — asserts the hook message contains `DONE_CHECK_PATH`
      (`/app/DONE-CHECK.txt`) and the literal phrase `"does not count as
      verification"`. Passing (part of the 1763-pass total above).
- [x] Results-file naming convention (deferred item 2): the invocation
      lines above use exactly
      `docs/loop-probes/p2/<hostname>-p2-<arm>-results.json` — no silent
      divergence from `scripts/p2-tally.ts`'s `armResultsPath` default.
- [x] Probe verdicts: `docs/loop-probes/p2/PROBE.md` — Probe A (Stop hooks
      fire in-container under `claude -p`) → A3 confirmed as Task 4's
      built path. Probe B (`--max-turns` accepted by the CLI parser,
      enforcement unverified) → belt-and-suspenders reinject-text cap
      already wired in `cmd-p2.ts`'s a4 re-pass path (independent of
      `--max-turns` actually truncating).
- [x] Frozen Rule amendment in force: plan
      `docs/superpowers/plans/2026-08-06-p2-actuator-binding.md`
      §Frozen Rule "PRE-DATA AMENDMENT" block present (excludes Bash
      commands referencing `DONE_CHECK_PATH` from the anti-gaming match
      set). Landed in `rule.ts` at commit `2d23e06` (plan-doc amendment
      `49c43d9`), both pre-dating any run datum. `rule.ts`'s
      `isCompliant`/`referencesDoneCheckPath` implement the exclusion;
      covered by `opencode-plugin/test/p2-rule.test.ts`.
- [x] Warm lane armed for A4's review calls: `KKAMAK_SEAT_PROVIDER` key
      **present** in `~/.claude/settings.json`'s `env` block (value not
      reproduced here — presence check only, per scope).
- [x] Store isolation + cost fences tested:
      `opencode-plugin/test/p2-cmd.test.ts` — `resolveP2ResultsFile`
      (outside `docs/loop-probes/p2/` dies), `cmdP2` wrong-`--go` dies
      naming the expected count with `runOneAttempt` never called, a4's
      doubled `--go` accepted / un-doubled `--go` dies. `p2-run` never
      calls `record.ts`'s `recordToStores` and never mounts
      `term-bench2/store/**` (module header, `cmd-p2.ts`).

## Bars (pre-registered, Task 5 — for the eventual verdict, not this report)

`scripts/p2-tally.ts`: `COMPLIANCE_BAR = 0.75`, `PASS_DROP_BAR = 0.15`
(`a3earnsRouting`/`a4earnsRouting` computed against these; adoption stays a
separate ruling per the plan's §5 decision rule — this report does not
apply them to any data, since none exists yet).

## Bottom line

- Total planned bench container executions: **≤112** (28 + 28 + ≤56).
- Total planned A4 review calls: **≤28** (haiku, warm lane).
- Probe budget: 2 of ≤4 already spent (Task 1), 0 further probe calls
  planned.
- Estimated wall-clock: **≈5.9 h base, ≤≈7.8 h worst case**, serial, tmux
  detached.

**READY FOR SIZED-GO. No arm run. Nothing self-adopts.**
