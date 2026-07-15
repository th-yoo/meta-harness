# Loop-1 state (first propose→ab, #5) — cross-host continuation note

Written 2026-07-14 to resume on another host. The bench code + splits + plan are
git-tracked (transfer); the **account store and personal memory are host-local
(do NOT transfer)** — see "What's host-local" below.

## Status

| step | state |
|------|-------|
| baseline (haiku, --layers account, k5) | ✅ **pass@5 = 16/42 = 0.381** (42/43; results file gitignored) |
| `split make --band 0.2,0.8 --sentinels 3 --folds 2` | ✅ `term-bench2/splits/loop1.json` — **14 band tasks** (2 folds ×7) + 3 sentinels |
| store-writing band run (k2, feeds proposer) | ✅ 4 failure trajectories into `account-global` v0 |
| **propose → account-global v1** | ✅ opus-4-8; playbook + diagnosis below |
| `ab` v0 vs v1 (paired McNemar) | ✅ **DECISION: REJECT** (2026-07-16) — v1 76.5% vs v0 82.4% |
| activate on accept | ✅ N/A — rejected; v0 stays active |

## LOOP-1 OUTCOME (2026-07-16) — REJECT, and that PROVES #5

`ab-verdict.json`: **decision=reject, winner=active v0.** candidateRate 0.7647 vs activeRate 0.8235 (v0 better ~6pp). held-in Δ=−0.071 (b=2,c=3,p=0.81); held-out Δ=−0.071 (b=0,c=1,p=1.0, **held-out-regression** flag); **sentinels Δ=0 (clean)**. Not statistically significant either way — the gate rejects because there is NO gain + a held-out regression + the non-regress margin isn't cleared.

**#5 is proven.** The full loop ran end-to-end (baseline→split→store-write→propose→v1→ab→verdict); every mechanism fired; the gate **correctly declined a non-improving candidate** and kept v0. Monotone-or-halt confirmed: it halted, didn't degrade.

**The killer empirical finding:** v1 **regressed on `large-scale-text-editing` — the exact task its rule targeted.** v0 [1,0]=1 pass; v1 [0,0]=0 pass. v1's "satisfy the literal spec, don't substitute" bullet **backfired** (made the agent grind on the required `:%normal! @a` and fail, where v0 substituted `:@a` and passed). A hand-curator would have SHIPPED that rule — it reads as obviously correct. **The gate caught it empirically.** This is the "regressed in 5 of 7 iterations" failure mode (external surveys) prevented by construction.

## Lessons → LOOP-2 recipe
1. **Thin diet caused it.** Loop-1's store-writing run was cut short → only **4 failure trajectories → 3 GENERIC bullets**, not sharply task-targeted. **Loop-2: run the store-writing band run to COMPLETION** (all 14 band × k≥3) for a richer, sharper proposer diet.
2. **Plausible ≠ helpful.** The literal-spec bullet backfired on timeout-bound tasks. v1's `ab-verdict.json` (a reject) now lives in the store as **proposer evidence** — loop-2's propose sees it and should refine/avoid that rule (the loop's self-correction).
3. **The gate works — trust it.** Don't hand-seed bullets that "sound right" (the OpenClaw failure mode); let propose→ab decide. Matches `[[external-practices-openclaw]]` + `[[ai-dev-automation-survey]]` (selector≠grader).
4. Loop-2 = re-run store-write (full) → `/mh-propose account` (→ v2, sees v1's reject) → `ab` v0 vs v2.

## v1 content (preserved here — the candidate itself is host-local)

**diagnosis.json** (3 failures):
- `large-scale-text-editing` — **spec-misread**: substituted `:@a` for the required `:%normal! @a`, rationalized the explicit requirement as "just examples".
- `harness-store count` — **tool-misuse**: unscoped repo-wide grep → reported an ungrounded "57".
- `kv-store-grpc` — **tool-misuse**: backgrounded server (`python server.py &`) held the shell's stdio → bash tool blocked to timeout.

**v1 playbook (rendered system.md):**
- **Satisfy the literal, checkable spec** — when a task names an exact mechanism/command/syntax/format, satisfy it literally; equivalent output a different way is a failure; debug the required mechanism instead of swapping your own; re-read the request and confirm every constraint before declaring done.
- **Ground every factual claim in tool output** — no estimated/guessed counts; run a command that produces the exact number; scope searches to exactly the target file/path.
- **Don't let a single command consume the whole budget** — never run a long-lived/blocking process in the foreground of a shell tool; detach from stdio so the command returns immediately, verify separately.

## To resume `ab` on this (Linux) host

```
bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
  --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 --k 2 --resume
```
Defaults: alpha 0.05, nonregress-margin 0.05, min-tasks-before-stop 12, early-stop on. Then `report-loop`; `/mh-activate account v1` on accept (needs the accepted ab-verdict).

## What's host-local (NOT in git — blocks a clean MacBook continuation of ab)

- **Account store** `~/.config/meta-harness/global/` — v0 diet + **the v1 candidate**. The MacBook won't have v1.
- Baseline results file (gitignored).
- Personal memory `~/.claude/projects/.../memory/` (incl. `[[static-loop-mechanics]]`).

**On the MacBook, to run `ab` you need v1 in its store. Either:** (a) `scp -r ~/.config/meta-harness` from this host to the MacBook (fastest — carries v0 diet + v1); or (b) re-run the loop from the git-tracked split: store-writing band run → `/mh-propose account` (re-derives a v1 from fresh trajectories — will differ). Option (a) preserves THIS v1.

## BUG — `--max-agent-timeout` does NOT bound total attempt time (found 2026-07-14, ab smoke) — FIXED 2026-07-15

**FIXED:** added `--max-verifier-timeout SEC`, threaded exactly as the fix sketch below
(`cli.ts` parse for both run+ab, `tasks.ts` `taskTimeouts` gains an optional
`maxVerifierTimeout` param that caps `verifierTimeout` with a `capping verifier timeout
Xs → Ys` log, `cmd-run.ts`/`cmd-ab.ts` pass-through). Optional (default 0 = uncapped)
so every existing caller is byte-unchanged. To bound an attempt now, pass BOTH:
`--max-agent-timeout 600 --max-verifier-timeout 300` → attempt ≤ ~900s. Tests:
`bench-oracle-unit.test.ts` (verifier cap + uncapped-when-0). Original analysis below.

`taskTimeouts` (`opencode-plugin/src/bench/tasks.ts:120-134`) applies `maxAgentTimeout`
to the **agent only** (`:129-132`); `verifierTimeout` (`:127`, from `task.toml`
`verifier.timeout_sec`, else 300) is **never capped**. So one attempt's wall-time =
agentCap + verifierCap. Evidence (ab smoke, `large-scale-text-editing` arm B): agent
timed out at 600s (no "done in" line → `agent-run.ts:181-184` fail-fast, NOT a retry),
then `verifier (timeout=1200s)` ran ~600s → `elapsed=1209.6s` despite `--max-agent-timeout 600`.
NOT a retry-multiply (timeouts don't retry; only transient provider errors do, `agent-run.ts:209`).

**Impact:** time-boxed runs (like a 1-hr smoke) can't be bounded — a task with a large
`verifier.timeout_sec` blows the budget. **Fix:** add a `--max-verifier-timeout` flag
threaded into `taskTimeouts` (mirror `maxAgentTimeout`, cap `verifierTimeout`) — or a
single `--max-attempt-timeout` bounding the sum. Touch: `bench/cli.ts` (parse), `tasks.ts:120`
(cap), `cmd-run.ts:381`/`cmd-ab.ts:308` (pass through). **DONE 2026-07-15** (`--max-verifier-timeout`, commit `d282e9f`) — see the FIXED banner at the top of this section.

## Gotchas that bit us (also in `improvement-loops.md` §3)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (the account store is outside the worktree; without it the headless proposer hangs on a permission prompt). **Committed to `opencode.json`.**
- `--results-file` forces `--no-store`; store-writing runs aren't resumable; Phase-0 self-check can't piggyback.
