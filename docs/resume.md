# RESUME — start here

**New session / new host: read this first.** (Personal memory is host-local and
does NOT transfer; this file + the repo are the source of truth.)

## SESSION END 2026-07-16 (leaving office) — loop-2 CALLED · Loop-3 shipped DARK · T1 shipped

**Everything is committed + pushed. `git status` clean, 0 unpushed. HEAD = `7e23797`.**
The sections below this one (office/v1/Phase-0) are HISTORICAL — superseded by the loops since.

**Is the necessary data saved?** YES — all code, docs, plans, the Loop-3 build, the T1
primitive, and the bug fix are in git (`origin/main`). Store note: the account store's
`active` is the EMPTY baseline (nothing promoted); the git snapshot `term-bench2/store/`
has `v0 v1`, which is all home needs. Dead candidates `v2` (superseded) and `v3` (loop-2,
called) are host-local and NOT needed — **do NOT store-export them** (blind export is the
data-loss trap; nothing new needs syncing anyway). To run anything at home: `git pull`
(+ `store-sync.sh import` only if you need the candidate store).

**What happened this session:**
1. **Loop-2 CALLED = `inconclusive / no-lift`** (user decision — grinding the rest was
   hours of timeout-dominated compute to confirm a near-certain reject). Candidate `v3`
   (the proposer-fix's output) vs active `v0`: 3 held-in TIES incl **tune-mjcf FAIL/FAIL
   (both ~600s timeout)**, a `v3` regression hint on distribution-search. `v3` NOT
   activated; active stays baseline. **Meta-win stands:** the proposer-fix (`679326f`)
   worked — `v3` self-corrected off `v1`'s reject. Full detail: memory `loop-2-outcome`
   (host-local) + `.superpowers/sdd/progress.md` ledger (host-local).
2. **Loop-3 (timeout blind-spot fix) T1–T5 SHIPPED DARK** — commits `062ca93..85fbfed`,
   final-reviewed (opus) merge-ready. Flag `recordTimeouts` **default-OFF = zero behavior
   change**. This is the priority self-improvement fix: makes agent timeouts a first-class,
   proposer-visible failure (today they're 0-turn results invisible to the proposer, so the
   loop can't learn its frontier failures — tune-mjcf above is the live proof).
   **To turn it ON (next session):** finish **T6+T7** (stamp `maxAgentTimeout`/
   `timeoutRecording` into verdictDict + `writeRunResults`; the MANUAL re-baseline op +
   runbook) + the **pre-flip checklist** (thread the real per-task `agentTimeout` — already
   captured as `agentElapsedSec` — into the proposer marker, which today uses the run-cap
   denominator; scope-gate the T4 steer to project layers), THEN set `recordTimeouts=true`
   in `config.json` + **re-baseline `v0`**, THEN a fresh loop-3 run. Plan:
   `docs/superpowers/plans/2026-07-16-loop3-timeout-fix.md`; pre-flip details in the ledger.
3. **T1 git-worktree primitive SHIPPED** (`144f31b..f536b6e`, reviewed-to-merge) — the
   fleet/self-hosting execution substrate (worktree-isolated squad-runs, ledger survives
   cleanup). Self-hosting build DAG: **T1 built; T3/T4/T6 + master + Loop-3 planned;
   T2/T5/T7 unplanned.** Also landed: **master build-plan** (`6c2ee4f`, 8-task deterministic
   orchestrator, §9+R1-R4), **R4 credit-assignment research** (`9e246d4`, closes the last
   master gap — exact-replay difference rewards). All mapped in `docs/INDEX.md`.
4. **Harness bug fixed** (`ac0cd18`): every chunked `ab --resume` was silently dying
   (`verdictDict` omitted the top-level `driver` field the resume-ident check requires).
   Fixed + regression-tested. NOTE: a partial written BEFORE `ac0cd18` still lacks the
   field — patch top-level `"driver":"opencode"` into `ab-verdict.partial.json` to resume
   it without a full restart.

**Next session — pick up any of:** (a) Loop-3 T6+T7 + pre-flip fixes → flip it ON →
re-baselined loop-3 run (the throughline); (b) execute a planned self-hosting task
(T3/T4/T6, SDD like T1); (c) write the remaining plans (T2/T5/T7); (d) resolve the
~30 open-questions accumulated across the new plans (each plan lists its own). The
current loop empirically produces NO task-pass lift yet — Loop-3 (honest signal on
frontier tasks) is the highest-leverage near-term fix; the self-hosting substrate is
the bigger structural bet after that.

---

## AT THE OFFICE (2026-07-16) — v1-into-git DONE ✅ (read the warning)

**DONE (commit `9bc5166`):** v1 is now in the git snapshot (`term-bench2/store/global/candidates/` = `v0 v1`).

⚠️ **The original instruction here (`store-sync.sh export` on the linux host) was a
DATA-LOSS TRAP and was NOT used.** By 2026-07-16 the hosts were split-brain: the
linux host had `v1` in its live store but was STALE on the overnight tier-2 work
(role stores `mh-analyzer/designer/evaluator/implementer`, config, calibration);
the git snapshot had the overnight work but not `v1`. `export` is `rsync --delete`
(store→snapshot), so it would have DELETED the overnight role stores from git.
Instead v1 was added SURGICALLY (`rsync` no `--delete`, only `global/candidates/v1`)
— zero deletions. **Lesson: always `store-sync.sh diff` first; if it shows
`*deleting` lines you care about, do NOT export — surgically copy just the new
candidate dir into `term-bench2/store/` and commit.** The import-before-work
discipline prevents this; it was skipped when linux made v1 before store-sync existed.

Next: `ab` can run on ANY host. The linux host can run it directly (its live store
already has `v0 v1`). Other hosts: `git pull && store-sync.sh import` (now safe —
the snapshot has v1 + the overnight roles).

## Where we are (2026-07-16)

First propose→ab improvement loop (#5). Done: baseline (haiku pass@5 **0.381**),
14-task band split, store-writing run, **propose → account-global `v1`**
(a real generalized playbook). The `ab` verdict (v0 vs v1) is the last step.

Landed overnight 2026-07-15→16 (MacBook, pushed to `main`):
- **Prompt-mining plan EXECUTED** (was saved-only) — `docs/external-prompts-cc-opencode.md`
  (17-row verdict table, 22-bullet dual-tagged seed corpus, 6 meta-prompt lessons),
  the two HIGH lessons applied to `buildProposerPrompt` (L1 untrusted-evidence,
  L2 evidence-gated rejection list — conditional on non-empty failures so fresh-layer
  bootstrap still writes a baseline; live propose smoke passed), and
  `docs/target-model-axis.md` spec (additive-only v1; build deferred,
  `explicitly-not-now.md` §2.4). Raw extraction scratch: `.superpowers/sdd/mining/`
  (host-local, MacBook). Seed corpus is measure-first: do NOT hand-seed until
  loop-1's ab shows what propose finds on its own.
- **Phase-0 self-score correlation run DONE** (best-of-k gate; MacBook, 2026-07-16
  morning): 43 baseline tasks × k=1 haiku `--self-check` →
  `term-bench2/results/phase0-selfscore-haiku.json`. **GATE: UNDERSIZED, not
  predictive on current data** — pass@1 5/43 (11.6%); capture rate 11/43 (26%,
  haiku usually skips the self-check); among captured pairs essentially every
  self-claim is 1.0 (no variance), so score-value lift is only +2.7pp (30% vs
  27.3% within-pairs base) with 7/10 self-PASS claims false-positive; N=11 < 30
  floor. Per the plan's stopping rule: do NOT build the k-loop on this. Two real
  findings: (1) the self-report VALUE is near-uninformative as-is; (2) writing a
  self-check at ALL correlates with success (27.3% vs 6.3% for non-compliant
  runs) — compliance is the stronger signal. NEXT (deliberate revision):
  strengthen `SELF_CHECK_INSTRUCTION` (`opencode-plugin/src/bench/self-score.ts`)
  to force compliance + honest fractions, then re-run the 43-task night.

Landed 2026-07-15 (all pushed to `main`):
- **Store is git-syncable** — `term-bench2/store-sync.sh` + `term-bench2/store/` snapshot (next section). No more scp.
- **Verifier-timeout bug fixed** — `--max-verifier-timeout` now bounds each attempt (was unbounded; `ab` command below already includes it).
- **Tier-2 machinery HARDENED** (`7503ae0`) — adversarial review of the office-host code found + fixed 2 Critical + 4 Important bugs before any loop leans on it: squad-run pins one def-version per slice (no mid-run-activation drift); `squad-trial` is now a PAIRED comparison with the tier-1 McNemar significance test (no promote-on-noise, default n=5 floor); Phase-0 self-score gate floors on self-PASS sample size (n=1 greenlight killed); `flow.reentry` frozen; failure retrieval blends importance×diversity. 916 tests green. Detail: `.superpowers/sdd/tier2-fix-report.md` + `selfscore-fix-report.md`.
- **Slack/OpenClaw fixed** (fleet, oc-test side) — root cause of "#oc doesn't answer" was `requireMention` defaulting true (plain messages dropped as `no-mention`), NOT agent provisioning. Fix: `requireMention:false` on #oc. Token-free patch + sanitized gateway template in `oc-test/agents-fleet/gateway/` for office-host bring-up (new bot). Live DM outbound proven.

**BLOCKER RESOLVED (2026-07-16, commit `9bc5166`):** `v1` is now in the git
snapshot (added surgically — see the office section above for why blind `export`
was NOT used). NEXT = run `ab` (v0 vs v1). Linux host can run it directly; other
hosts `git pull && store-sync.sh import` first.

Full detail + v1's diagnosis & playbook: **[loop-1-state.md](loop-1-state.md)**.

**Completed run data also travels via git now:** `term-bench2/results-archive/`
holds committed copies of final results (both baselines, phase-0 self-score,
gate/soak) — the working `term-bench2/results/` dir stays git-ignored.

## The store travels via git now (no scp)

The account store (`~/.config/meta-harness` — candidates v0/v1, active, playbooks,
traces, role/squad stores) is mirrored into the repo at **`term-bench2/store/`** by
`term-bench2/store-sync.sh`. So loop artifacts cross hosts by `git push`/`git pull`.

- **Host that HAS the new candidate** (e.g. linux with v1):
  ```
  git pull
  term-bench2/store-sync.sh export          # ~/.config/meta-harness -> term-bench2/store/
  git add term-bench2/store && git commit -m "store: loop-N candidates" && git push
  ```
- **Other host** (e.g. MacBook, to run `ab`):
  ```
  git pull
  term-bench2/store-sync.sh import          # term-bench2/store/ -> ~/.config/meta-harness (backs up existing to .bak)
  ls ~/.config/meta-harness/global/candidates/   # expect: v0 v1
  ```
Discipline (single-user serial, like the old scp-replace): **pull+import before working, export+push after.** `import` is a full mirror (`--delete`) but backs up the prior store to `.bak` first; `store-sync.sh diff` shows drift.

## Resume the loop (Path A — keeps this exact v1)

1. `cd ~/z2/meta-harness && git pull && term-bench2/store-sync.sh import` (brings v1 into the store).
2. Bench prereqs (macOS): `podman machine start` (if needed) → `bun term-bench2/runner.ts prep --apply`. Needs the TB2 task repo at `~/z2/terminal-bench-2`.
3. Run `ab` (detached, ~3–5 hr, resumable). **Bound each attempt** with the timeout flags (verifier was uncapped — fixed 2026-07-15):
   ```
   nohup bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
     --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
     --k 2 --max-agent-timeout 600 --max-verifier-timeout 300 --resume \
     > term-bench2/logs/loop1-ab.log 2>&1 &
   ```
4. Verdict: `bun term-bench2/runner.ts report-loop`; on accept → `/mh-activate account v1`, then `store-sync.sh export` + commit + push so every host has the new active.

**No committed v1 yet?** Path B (re-derives a DIFFERENT v1): store-writing run
`run --task-file term-bench2/splits/loop1-band.txt --k 2 --layers account --model anthropic/claude-haiku-4-5`,
then start opencode + `/mh-propose account` (the `external_directory` grant is already in `opencode.json`), then `ab` as above.

## Gotchas (already handled, don't re-hit)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (committed) — else the headless proposer hangs on a permission prompt.
- `--results-file` forces `--no-store` (a run feeds the store OR writes results, never both); store-writing runs aren't resumable; `ab` is.

## Landed 2026-07-16 evening (MacBook): bench resource-scheduler SHIPPED DARK
`--enforce-resources` + `--parallel` (budget-packed, D5 verdict-equivalent) +
`task-load` — all default-OFF, merged `d528ae5`. Spec/plan in docs/superpowers/
{specs,plans}/2026-07-16-bench-resource-scheduler*. applehv cgroup caps VERIFIED
live; serial enforce smoke green; parallel key-gate verified. **Flag-flip gate
(NOT merge gate): the 3-concurrent smoke needs ANTHROPIC_API_KEY** (parallel
forbids shared oauth mounts by design) — then flipping enforcement on is a
re-baseline event, bundled with Loop-3's recordTimeouts flip. Deferred
pre-first-sweep item: interior log-line prefixes under --parallel.

⚠️ **OPEN — the oauth-race rationale behind the --parallel key requirement is
UNTESTED (user-flagged as a big issue 2026-07-16).** The whole D4 design (no
oauth under --parallel; ANTHROPIC_API_KEY mandatory) rests on the pre-existing
`agent-auth.ts:32-37` comment ("plugin rotates the refresh token on use;
concurrent containers can race auth.json") — a code-grounded ASSUMPTION, never
reproduced by anyone. What IS verified: every container mounts the same rw
credential dir (fact, from code). What is NOT verified: that rotation actually
happens on use, or that concurrent rotations corrupt the store. We designed
around it without testing because the destructive test would race the REAL
credential store (asymmetric risk, cheap mitigation). **Safe experiment, defined
and pending:** copy the auth dir to scratch, point two containers at the COPY
(XDG override — same isolation the propose-smoke used), force both to refresh
concurrently (expire the access token in the copy), diff what survives.
Outcomes: (a) corruption reproduced → assumption confirmed, key requirement
stands, close the question; (b) no corruption → the key gate is over-strict —
consider relaxing D4 to allow oauth+parallel (spec + gate change + re-review).
Until tested, oauth+parallel stays FORBIDDEN (fail-safe default). Also note:
API keys CAN carry org-set expiry (CC shows remaining days) — check before an
overnight parallel sweep; mid-run expiry = fail-fast 401, ab resumes, run loses
in-flight tasks only.

## Pending decisions (not started, need a go)
- **Phase-0 re-run** (MacBook, overnight ~7h): strengthen `SELF_CHECK_INSTRUCTION`
  in `opencode-plugin/src/bench/self-score.ts` (force compliance + honest
  fractions — current one yields 26% capture, all-1.0 claims), then re-run the
  43-task `--self-check` night and re-check the gate.
- **Seed corpus** (`docs/external-prompts-cc-opencode.md`): measure-first — only
  after loop-1's `ab` verdict shows what propose finds on its own.

## Bigger map
`docs/INDEX.md` → all design docs. The prompt-mining plan
(`docs/superpowers/plans/2026-07-14-cc-opencode-prompt-mining.md`) was EXECUTED
2026-07-15→16 (see "Landed overnight" above) — no saved-but-unexecuted plans remain.
