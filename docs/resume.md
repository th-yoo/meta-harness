# RESUME — start here

**New session / new host: read this first.** (Personal memory is host-local and
does NOT transfer; this file + the repo are the source of truth.)

## ⏸ SESSION END 2026-07-22 (MacBook) — LOOP-2 COMPLETE: v9 lift CERTIFIED (p=0.020) but GUARD-REJECTED (spec-overtrust regression) — active=v7 — RESUME HERE

**Read [`docs/reboot.md`](reboot.md) LOOP-2 VERDICT section (bottom) first. MacBook box
clean: no tmux, no containers, active=v7 (v9 NOT adopted — guards + certification pending).
v9 snapshot committed to `term-bench2/store/global/candidates/v9/` (system.md, playbook.json,
score.json). ⚠ TOKEN WEEKLY LIMIT NEAR.**

**LOOP-2 RESULT (sparql-university k=10, MacBook):** v9 (= v7 + interpretation-enumeration
bullet b7) **7/10 vs v7's 3/10** (office, 07-21). Forensics clean (0 auth, all turns=1,
no artifacts). All 3 v9 failures show explicit lesson engagement in traj — the advisory
actuator GRIPPED this lesson (vs loop-1's ignored 7/8): grip is content-dependent, "prose
never grips" falsified. ~~Honest limits: p=0.18 cross-host~~ **SUPERSEDED same session:
the v7 same-host re-run (1/10) certified the lift — see phase A below. Remaining limit:
held-in single task (loop-4's question).**

**⏭ NEXT (in order, token-budget-gated; one manipulated variable per loop — the 07-22
discussion pruned loop-3 scope creep into the loop-3/loop-4 split below):**

**A. Certify/kill v9 first (decides every later baseline):**
1. ~~v7 re-run k=10 on the MacBook~~ **DONE 07-22: v7 = 1/10 same-host, forensics clean →
   v9 lift CERTIFIED (Fisher two-sided p=0.020 same-host; p=0.015 pooled 4/20 vs 7/10;
   host effect none, p=0.58 — MacBook trends harder). Log `loop2-v7-sparql.log`; v7
   MacBook score.json synced to `term-bench2/store/global/candidates/v7/`.**
2. ~~Guards~~ **DONE 07-22: v9 adoption REJECTED — configure-git-webserver 0/3 (office
   v0 ace 3/3), count-dataset-tokens 3/3 held. Trajectory-proven lesson cost: b7's
   "literal wording" made agents TRUST the task's false "I'll setup login" promise →
   skipped sshd the verifier secretly requires. b7 trades interpretation-overfit for
   spec-overtrust; no universal interpretation policy across graders. v7 stays active;
   v9 = certified-on-sparql, guard-rejected. See reboot.md GUARDS VERDICT.**
   → **Loop-3 target sharpened: v10 = scoped b7** (trigger on ambiguous TERMS only;
   explicit env promises still get verified — "trust but verify what the grader can
   test"). Both sparql lift AND guard must pass for adoption this time.

**B. Wire the proposer (code work, no trials — fresh-budget session):**
wire the enhanced prompt (proposer-lesson-prompt.md, incl. the new Verifier-contract input
extraction) into propose.ts, TDD. Prereq for loop-3, zero system effect until loop-3 calls it.

**C. LOOP-3 — ONE question: does the AUTOMATED pipeline produce a SECOND gated lift?**
- Zero-trial pre-checks (attribution firewalls, NOT experiments): (a) wired-vs-manual
  proposer desk-compare on the SAME evidence — clears automation quality before any trial
  can confound it; (b) verifier desk-check of whatever task the new lesson targets
  (standing rule since loop-1).
- The experiment: candidate = baseline + ONE new bullet from the WIRED proposer, targeting
  the fresh taxonomy's dominant mode; held-IN gate on that mode's tasks + guards. Delta =
  one bullet, same structure as loop-2. Composition (two bullets coexisting) is NOT a
  separate variable — the guards catch interference; that is what they are for.
- Free bookkeeping after verdict: score the proposer's falsify_if against the outcome
  (first calibration data point — doc open-question 2).

**D. LOOP-4 — ONE question: does the accumulated playbook GENERALIZE?**
Held-OUT reserved set (build-pmars, cancel-async-tasks, polyglot-rust-c) — the playbook
that won two held-in gates vs baseline, nothing else changed. Property of the accumulated
playbook, not of any single lesson; deliberately NOT mixed into loop-3 (would make a null
unattributable across lesson-quality / mode-difficulty / held-out-difficulty).

**Supporting queue (slot between loops as budget allows):** pass-side traj persistence +
taxonomy-v2 divergence (feeds loop-3's proposer input); office-box v8 harness-size check
(settles loop-1's record); binding actuator DEPRIORITIZED (its premise — advisory prose
can't grip — is falsified for content-matched lessons).

**Setup trap caught this session (recipe fix):** naive `createCandidate(v0-system.md,
playbook+bullet)` SILENTLY DROPS the bullet from the assembled harness (composeHarness
faithful-render fallback → flat system.md). Correct recipe: candidate system.md must
CONTAIN the lesson line (v9 = v0 flat text + "\n- " + lesson → same flat path as baseline
arm, delta = exactly one line). Check "Harness assembled (N chars)" at launch: v0/v7=394,
v9=717. First launch was aborted for this (`loop2-v9-sparql.aborted-badharness.log`);
bad harness burned ~1 trial-minute, no store residue.

## PREVIOUS: SESSION END 2026-07-21 (night) — LOOP-1 NULL + POST-MORTEM REVERSAL; LOOP-2 = ONE TEST (v9)

**Read [`docs/reboot.md`](reboot.md) FIRST (ACTIVE PLAN + LOOP-1 VERDICT + POST-MORTEM sections
at bottom), then [`docs/proposer-lesson-prompt.md`](proposer-lesson-prompt.md). All pushed
(HEAD `95c3e8c`). Box clean: no tmux, no containers, active=v7 (v8 rolled back).
⚠ TOKEN WEEKLY LIMIT NEAR at close — loop-2 is deliberately ONE cheap test.**

**LOOP-1 RESULT (sparql-university, user-scoped single-task):** v7 3/10 vs v8 (=v7 + ORDER-BY/
determinism lesson b7) 2/10 = **PROVABLE NULL**, rolled back. Lesson ignored in 7/8 failing
trajectories. First gated verdict in project history.

**POST-MORTEM DESK-CHECK REVERSED THE DIAGNOSIS** (read reboot.md post-mortem section):
sparql verifier compares results as a SET (order IGNORED — ORDER-BY theory dead) and runs the
agent's query on a **HELD-OUT graph** with different expected answers → real failure mechanism =
**interpretation-overfit self-validated on dev data**. The taxonomy-fed lesson (interpretation-
enumeration + discriminating checks) was the RIGHT fix-class all along; the agentic run's
divergence analysis chased a dev-data confound. Meta-lesson recorded: neither proposer input
mode dominates; the free verifier desk-check beat both — **desk-check the verifier BEFORE
distilling any lesson from now on**.

**LOOP-2 = EXACTLY ONE TEST (nothing else runs first):**
Create **v9 = v7 + the interpretation-enumeration bullet** (text = the enhanced-prompt run's
proposal, saved at `/mnt/d/tmp/proposer-enhanced.json` on office box; text also quoted in
proposer-lesson-prompt.md's empirical section; VERBATIM for cross-host:
> "When acceptance depends on a term the prompt leaves ambiguous, do not treat your query reproducing your own predicted answer as confirmation. List the plausible interpretations, run checks against the raw data that would give different results under each, and pick the interpretation matching the spec's literal wording."
) → sparql k=10 under v9 (store-writing, tmux,
`META_HARNESS_HOME=$PWD/.meta-harness`, `--no-pack-measured`) → compare vs v7's 3/10.
- LIFT → lesson content was the variable; first certified win; then guards before adopting.
- NULL + lesson-ignored trajectories (grep traj for lesson language) → actuator falsified
  WITH a correct lesson → next tech = BINDING actuator (middleware/finish-hook, AHE's winner);
  prose lessons retired as an actuator.
~10 trials ≈ 20 min. Judge/proposer calls NOT needed (lesson text already exists).

**Queued AFTER v9 verdict only:** pass-side trajectory persistence + taxonomy-v2 divergence;
wire enhanced proposer prompt into propose.ts; binding-actuator build (if v9 nulls).

**⚠ OFFICE-BOX CHECK (next time it's reachable, BEFORE building the binding actuator):**
`grep "Harness assembled" <loop-1 v8-arm log>` (host-local, term-bench2/logs/ or /mnt/d/tmp/).
**~394 chars → loop-1's v8 harness never contained the lesson** (composeHarness falls back to
flat system.md when it doesn't faithfully render from the playbook — exactly the bug caught on
the MacBook 07-22, where naive createCandidate(v0 system.md + playbook-with-bullet) silently
dropped b7) **→ the "lesson ignored 7/8 = actuator weakness" finding is VOID** (confounded).
**~680+ chars → lesson rode, finding stands.** Repo evidence leans "stands": the "+290 bytes
only delta" matches a system.md-appended lesson line (playbook.json-only delta would be
~+460; bad-v9-style would be 0), and propose.ts:337/:1215 render system.md from the playbook
at write time — but the log line is the direct proof. The binding-actuator decision rests on
this finding, so confirm before investing.

**Env notes:** v7/v8 stores host-local (office box); v7 taxonomy synced to
`term-bench2/store/global/candidates/v7-taxonomy.json`. tmux-only detach rule stands.
`META_HARNESS_HOME=<repo>/.meta-harness` required for ALL store-touching commands (missing
export silently reads the ~/.config default store — bit us twice today). Guards on null
verdicts = moot, kill early (nothing to protect when not adopting).

## PREVIOUS: SESSION END 2026-07-21 (office/linux) — SCREEN COMPLETE, PLAN A MERGED, K-BOOST PENDING — RESUME HERE

**All pushed (HEAD `eda3dae`). Office box: tmux sessions closed after screen finished, orphans
reaped.** Two standing rules distilled with user this session (memory is host-local → restated
here): **(1) "I only value self improvable agent"** — every task must advance the
self-improvement loop or be deferred; **(2) distance-to-verdict rule** — tooling freeze until
loop-1 reaches a gated verdict (SPRT spec already deferred to `explicitly-not-now.md §7.5`).

**DONE this session:**
1. **Plan A SHIPPED + MERGED** (`e648a04`): `bench failure-taxonomy` subcommand (TDD, opus-reviewed
   per task, final review mergeable). Judge via `--model anthropic/claude-opus-4-8` (oauth). Field
   is `modeCounts` (renamed from plan's modeFractions — counts, divide by nClassified). Haiku
   v0/v3 taxonomies in `term-bench2/store/global/candidates/{v0,v3}/taxonomy.json`: **v3 n=19 =
   incomplete 13 / looks_done 4** — but HAIKU modes; opus fails differently (fast confident
   one-shots + long grinds), so **don't pre-commit the lesson — the v7 opus taxonomy decides**.
2. **Cat-A screen COMPLETE** (26 tasks × k=3, opus-4-8, width ~6 tmux, 78 trials, R2-audited
   clean): **BAND=10** → `term-bench2/splits/opus-band.txt` (build-pmars 1/3, cancel-async 1/3,
   path-tracing-reverse 2/3, mailman 2/3, headless-terminal 1/3, sanitize-git-repo 2/3,
   query-optimize 2/3, financial-document-processor 2/3, sparql-university 1/3, polyglot-rust-c
   1/3); **ACE=6 (guards)**: chess-best-move, configure-git-webserver, count-dataset-tokens,
   path-tracing(!), write-compressor, feal-linear-cryptanalysis; **FAIL=8** (0/3, incl 3 genuine
   3600s timeouts); **EXCLUDED=2 env-artifacts**: qemu-startup (apt `netcat` no candidate on newer
   base — qemu itself PROVEN working via TCG smoke test) + pytorch-model-recovery (opencode exits
   0.6-1.1s turns=0 ×3, agent never engaged, cause undiagnosed). Final snapshot committed:
   `term-bench2/rebaseline/opus-A-20260721.final.json`.
3. **v7 created + activated** on the OFFICE box store (content byte-identical to v0) = clean
   provenance for the opus baseline. **⚠ HOST-LOCAL — MacBook must recreate it** (recipe below).

**⏭ NEXT — K-BOOST (awaiting user go; the step that closes the loop):** store-writing run
(NO --results-file → sessions+trajectories land in the store under active v7), 10 band tasks ×
k=5 = 50 trials, est 3-6 hr (band tasks grind 30-60 min sometimes). Then: opus taxonomy on v7 →
ONE lesson → v8 candidate → **McNemar+held-out gated A/B (fixed-k; SPRT deferred) = loop-1
self-improvement verdict**. Power caveat (be honest in the writeup): 50 pairs/arm detects
~20pp+ lift; smaller real effects will read null — null is still provable knowledge (the edge).

**MacBook continuation recipe (cross-host: git + this file ONLY; store/scripts are host-local):**
1. `git pull`. Verify oauth (`claude` login) + podman.
2. Recreate v7 from the COMMITTED snapshot (deterministic — do NOT read the host-local store's
   v0, which may have drifted):
```
cd <repo> && export META_HARNESS_HOME=$PWD/.meta-harness && bun -e '
import { createCandidate, activateCandidate, activeVersion } from "./opencode-plugin/src/harness-store.ts"
const fs=require("fs"); const root=process.env.META_HARNESS_HOME+"/global"
const snap="term-bench2/store/global/candidates/v0"
const sys=fs.readFileSync(snap+"/system.md","utf8")
const pb=JSON.parse(fs.readFileSync(snap+"/playbook.json","utf8"))
createCandidate(root,"v7",sys,"",pb); activateCandidate(root,"v7")
console.log("active:",activeVersion(root))'
```
3. Launch k-boost **inside tmux** (NEVER setsid — silent-kill incident, see warning below):
```
tmux new-session -d -s kboost 'cd <repo> && export META_HARNESS_HOME=$PWD/.meta-harness && \
  bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-band.txt --model anthropic/claude-opus-4-8 \
  --k 5 --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --no-oauth-gate \
  --no-pack-measured >> <logpath> 2>&1; echo DONE_EXIT=$? >> <logpath>'
```
   (MacBook: add `PATH=/opt/podman/bin:$PATH` if needed; store-writing runs are NOT resumable —
   plan for the full run. `--no-pack-measured` mandatory: poisoned resource profiles.)
4. After: `bun term-bench2/runner.ts failure-taxonomy --layer account-global --candidate v7
   --limit 20 --model anthropic/claude-opus-4-8` (in tmux; ~90s/failure). Eyeball `modeCounts` +
   `general_mechanism` fields → distill ONE lesson → v8 = v7 + lesson bullet → ab v8-vs-v7 on
   held-in/held-out band split + ace guards. Surgical-sync v7 taxonomy.json into
   `term-bench2/store/` + commit (cross-host rule).
5. **Post-run audit before ANY band/gate math** (r2-audit is host-local — steps): grep log for
   `authentication error`; flag turns:0 trials — elapsed≈0 = setup/env artifact (EXCLUDE task),
   elapsed <60s = suspected auth-race (strip + re-roll), elapsed ≈3600s = genuine timeout (keep).
   Also check errors[] for setup_failed; results-file errors[] does NOT record agent_no_output
   (known gap).

## PREVIOUS (2026-07-21 early AM): CAT-A RE-BASELINE START (MacBook) — superseded by the block above

**The Cat-A re-baseline (26 tasks × k=3, opus-4-8, MY harness) RAN 00:20–01:20 KST on the
MacBook, then user-stopped for the commute; orphan containers reaped, machine clean.**
15/78 trials banked. **Partial results are COMMITTED (results/ is gitignored) at
`term-bench2/rebaseline/opus-A-20260721.partial.json`** (+ .log beside it).
**Banked (5 tasks complete):**
- **build-pmars 1/3 · cancel-async-tasks 1/3 → the evolvable band is REAL** (0<pass<1 on 4.8)
- chess-best-move 3/3 · configure-git-webserver 3/3 → 4.8 aces them, drop out (leaderboard pool was 4.5)
- break-filter-js-from-html 0/3 → hard even for 4.8 (capability-watch)
- count-dataset-tokens [1] partial (trial 1 pass, incomplete — re-rolls on resume)
**RESUME AT OFFICE (REVISED PLAN 2026-07-21 — speed review):** `git pull`, copy the partial back
to the live (gitignored) path:
`cp term-bench2/rebaseline/opus-A-20260721.partial.json term-bench2/results/opus-rebaseline-A-20260721.json`
then launch (office/linux: no `PATH=/opt/podman/bin` prefix; fresh oauth; `--no-oauth-gate` per
standing ruling). **Changes vs original: (a) width 2→4** (`--min-cpus 2 --cpu-budget 12` — trials
are LLM-latency-bound per cgroup data; ~3hr→~1.5hr), **(b) on-thesis-first task ordering**
(`opus-candidates-A-ordered.txt` — count-dataset re-roll + db-wal/path-tracing×2/openssl first) so
first failures land ~30min in → **start taxonomy DURING the screen** (pipeline overlap = the real
cadence win):
```
META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-candidates-A-ordered.txt --model anthropic/claude-opus-4-8 \
  --k 3 --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --no-oauth-gate \
  --no-pack-measured \
  --results-file term-bench2/results/opus-rebaseline-A-20260721.json --resume
```

**⚠ CODE-ARCHITECT REVIEW (2026-07-21, applied — GO-WITH-CHANGES):**
- **B1 (BLOCKER, fixed):** `--resume` marks a task done on ANY non-empty rewards (`results.ts`
  resumeCarryForward) — partial tasks are FROZEN, never topped up. The earlier "re-rolls on
  resume" claim was FALSE. Fix applied: stripped `count-dataset-tokens` (1/3) from the live
  results copy → clean fresh k=3. If pausing mid-run again: strip ALL partial tasks on resume.
- **R1 (fixed via `--no-pack-measured`):** host resource-profile
  (`resource-profiles/x64-8c-…-i5-14400.json`) is POISONED — 8 tasks with impossible avgCpu
  (openssl 98, extract-elf 127, sqlite-with-gcov 235 "cores"; all peakRssMb=0) from a
  WSL2/rootless-podman shared-cgroup read bug. Without the flag, packer runs those tasks SOLO
  (width 1). Cross-cutting: load-aware-scheduler's captured data on this host = garbage until the
  cgroup read is fixed; packer-flip increment blocked on that.
- **R2 (post-run audit, DO IT before computing the band):** auth-race trial = silent reward=0
  with `error:"agent_no_output"`, indistinguishable in results.json. Grep run log for
  `authentication error` (AUTH_FAIL_MARK) + flag any `turns:0` with anomalously LOW elapsed
  (genuine 0-turn burns retries/timeout; auth-fail returns instantly). Manually re-roll matches.
- **Methodology note:** k=3 screen false-excludes a p≈0.5 task 25% of the time (3/3 or 0/3 by
  variance) and it's never revisited — accepted bounded blind spot, traded for speed.
**Speed-review verdicts (don't relitigate):** width 6 = HOLD (build-heavy tasks can contend on
8-core WSL2; resource-starved trial = FAKE band member → polluted band costs a whole loop
iteration; check measured cgroup load after this width-4 run first). Adaptive-k screen = SKIP
(real saving ~15% not ~half — 1/1 pass is worthless ace evidence, needs confirm trial anyway).
SPRT/sequential McNemar for the recurring GATE stage = YES but needs a small pre-registered-
boundaries spec + tests first (ad-hoc peeking inflates alpha = torches our one claimed edge);
spec it while screens run. Two-host split = reserve. "Overnight" premise was WRONG: 62 trials ≈
3hr at width 2 (MacBook measured 15 trials/hr).
AFTER the run: keep `0<pass<1` tasks = evolvable band → failure-taxonomy → memory/risk-hints
lesson → inject → McNemar + held-out gate (band k≥5; screen k=3 is provisional). Copy completed
results back into `term-bench2/rebaseline/` + commit so they transfer across hosts.

## SESSION END 2026-07-20 (PM) — opus test done + leaderboard pivot (context for the run above)

**Prior AM session context preserved below (AHE pivot, Plan A, detection+haiku prototypes).**
This PM session: ran the pending **opus improvement test**, then a **course-correction** off the TB2
leaderboard (user pushed for playwright ground truth). Net: **openssl is a bad target; the real
target is a leaderboard-derived candidate band.** New artifacts committed under repo.

**1. OPUS improvement test (openssl, k=2) = DIRECTIONAL LIFT but discarded as artifact.**
`baseline 0/2 → +lesson 1/2` (all turns=1; opus one-shots too). Contrast haiku 0/2→0/2. Looked like
the pivot's cross-model win — BUT n=2, and then the leaderboard showed it's a **harness-deficiency
artifact**, not a strong-model lift. Did NOT scale k (killed the k=10 run mid-flight). Log:
`/mnt/d/tmp/opus-improve-20260720.log`.

**2. LEADERBOARD PIVOT (`docs/2026-07-20-opus-candidate-tasks.md` — READ IT).** Scraped 2 TB2 2.0
entries via playwright (WebFetch summary was WRONG on several tasks — use playwright):
- **OpenCode / Opus-4.5 / 51.7% / 1-trial** = my-harness family (driver=opencode). openssl = **0/1 FAIL**.
- **WOZCODE / Opus-4.7 / 80.2% / 5-trial** = strong-harness ref. openssl = **5/5 PASS**.
- **Headline: opencode 51.7% vs wozcode 80.2% = same model class, ~28pp gap ≈ ALL harness/workflow.
  THAT gap is the research target.** openssl = 1 of 26 such tasks (workflow-fixable, not capability).
- **Candidate band** (opencode-FAIL ∩ wozcode-rate): **Cat A = 26 tasks** (wozcode ≥80%, HIGH
  headroom) → `term-bench2/splits/opus-candidates-A.txt`; **Cat B = 9** (wozcode 20-60%, partial) →
  `opus-candidates-B.txt`; **SKIP = 8** (wozcode <20%, capability-bound = the haiku trap).
  Detection-proto's 3 tasks (openssl, db-wal-recovery, path-tracing) all ∈ A = validates.

**⏭ NEXT (resume here) — OPUS-4.8 RE-BASELINE of Category A (user was about to approve/trim).**
Run opus-4.8 across the 26 Cat-A tasks (k≥3-5) in MY harness → **keep tasks landing `0 < pass < 1` =
the evolvable band** (opus-4-8 > 4.5 → some A may now pass unprompted; 1-trial leaderboard = noisy
POOL, not final band). Then: failure-taxonomy → distilled lesson (memory/risk-hints) → inject →
**McNemar + held-out gate** (our edge). Open question user raised: trim A to ~12 (drop crypto/build-
heavy) vs run all 26 (~2hr detached). Recipe below.

**Re-baseline command (detached, per CLAUDE.md host-local caveat):**
```
META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account \
  --task-file term-bench2/splits/opus-candidates-A.txt --model anthropic/claude-opus-4-8 \
  --k 3 --parallel --enforce-resources --min-cpus 2 --max-agent-timeout 3600 --results-file <out.json>
```
(or reuse the throwaway `runTaskOnce` harness from the improvement recipe below, looping the A list.)

**Prior prototypes (AM, throwaway in HOST-LOCAL `/tmp` — recreate from recipes below):**
1. **DETECTION = WORKS.** AHE root-cause taxonomy (opus-4.8 judge via oauth, `runJudgeOpencode`) on
   3 real v0 failing traj: openssl→`looks_done`, path-tracing→`other` (time-mgmt/incomplete), db-wal→
   `looks_done`. Root causes accurate; **`general_mechanism` field = ready-made memory lessons** (the
   pivot's Component 2). Refinement: add an `incomplete`/time-management mode to the seed schema.
2. **IMPROVEMENT (haiku) = NO LIFT.** openssl on haiku, baseline vs +lesson (lesson = the taxonomy's
   own `general_mechanism` "re-read every produced file vs every literal requirement"), k=2 each →
   **baseline 0/2, +lesson 0/2, no change** (all turns=1 — haiku one-shots + ignores the lesson).
   Evidence FOR the opus pivot: a distilled lesson doesn't lift a capability-bound one-shot model.
   (Superseded framing: opus 0/2→1/2 later shown to be harness artifact — see #1/#2 above.)

**Prototype recipes (recreate the host-local scripts):**
- *Detection:* bun script importing `readTrajectory` + `renderJudgeAuditEvents` (bench/judge-audit.ts,
  both exported) + `runJudgeOpencode` (bench/opencode-run.ts); build the taxonomy prompt (Plan A Task 1
  in the failure-taxonomy plan); judge=`anthropic/claude-opus-4-8`; run on `.meta-harness/global`
  candidates/v0 failing traj/*.ndjson.
- *Improvement:* bun script importing `runTaskOnce` (bench/cmd-run.ts) + `makeBenchPaths` (bench/paths.ts,
  `{tbRoot:"~/z2/terminal-bench-2"}`) + `assembleAgentsMd` (bench/record.ts) + `taskTimeouts` (bench/tasks.ts).
  baseline harness = `assembleAgentsMd("account", paths.metaRoot, "", {}, model)`; +lesson = baseline +
  the `general_mechanism` text. `runTaskOnce(paths, task, model, "", harness, agentTimeout, verifierTimeout)`;
  model=`anthropic/claude-opus-4-8`; k≥2; compare `.reward`. `META_HARNESS_HOME=<repo>/.meta-harness`;
  needs oauth (`claude` login) + podman; reap `mh-*` orphans between; Bash-tool 2min cap → run detached.
  **⚠ DETACH = tmux ONLY (2026-07-21):** setsid-detached runners get SILENTLY KILLED mid-flight
  (screen died ~35min in, taxonomy judge ~5min in; no OOM, no API error; orphan containers mask it
  as "slow trials"). Launch long runs as `tmux new-session -d -s <name> "<cmd> >> <log> 2>&1"`.
  After any mid-run death: strip partial (rewards.length<k) AND empty-array tasks from the live
  results file before `--resume` (B1 freeze trap).

## ➡️ NEXT DIRECTION (2026-07-20) — READ THIS FIRST: harness-evolution, Opus 4.8 base, memory/risk-hints first

**⚠️ 2026-07-20 PIVOT (AHE prior-art — [`docs/2026-07-20-ahe-prior-art.md`](2026-07-20-ahe-prior-art.md), our exact problem, #3 on TB2):**
(1) **base agent haiku → Opus 4.8** (haiku capability-bound = no harness headroom; AHE's gains came on a strong model → re-baseline v0 on opus);
(2) **first evolvable component → memory (boundary-case lessons) + risk-hints middleware** (AHE ablation winners; NOT verify-retry — AHE's `ralph_loop` lost — NOT prompt — regressed −2.3pp).
Our **statistical gate stays the edge** (it's the regression-blindness AHE names as its #1 limit). Adopt: four-field predict-and-falsify contract (as gate-power/calibration input), one-component-per-edit, k≥2, AHE's Agent-Debugger root-cause taxonomy. Workflow-loop spec's Component-1 (taxonomy) + machinery still valid; Component-2 verify-retry DEFERRED. Next: Plan A (taxonomy, AHE method) → re-baseline on opus → spec+build the memory/risk-hints component.

**Full doc: [`docs/2026-07-20-next-direction.md`](2026-07-20-next-direction.md)** ·
**deep-research report (24/25 confirmed, peer-reviewed): [`docs/2026-07-20-deep-research-failure-analysis-workflow.md`](2026-07-20-deep-research-failure-analysis-workflow.md)** — validates the pivot: failure-taxonomy as MODE classification (MAST 94%, not step-attribution ~14%); workflow>prompt on a fixed model (Agentless, DirectSolve CoT 9→32%, best-of-N +15); the looks-done gap is named (Huang ICLR24 intrinsic self-correct degrades; gate on executable ground truth).

The loop is **validated** (correctly rejects — v3 killed after held-in: 2 pass-regressions,
0 improvement, speed-only win on a tie → negative delta blocked the tiebreak; active stays
**v0**). But the **target has no headroom**: bench = **opencode+haiku, minimal config, NO
MCP, NO CC** (verified live) → our playbook is a thin veneer on an already-capable agent →
v0–v3 = **0 pass-lift.** Stop tuning prompt-bullets.

**Pivot (concrete, in the doc):**
1. **Failure taxonomy — no new runs.** Read `candidates/vN/traj/*.ndjson`; classify each
   failing task: spec-precision / capability / comprehension. VERIFIED example:
   openssl-selfsigned-cert = **spec-precision, workflow-fixable** (haiku had the required
   values in `instruction.md`, dropped them, self-verified against its own interpretation;
   a passive prompt bullet didn't fix it — advice ≠ enforcement).
2. **Optimize WORKFLOW, not playbook** — enforced verify-retry loop / extract-spec
   checklist / tool-feedback / best-of-k. Structure changes outcomes; bullets don't.
3. **OR change target for headroom** — raw model / stronger model (haiku→sonnet) / routing.
4. **Cheapest gate before v4:** no-injection vs v0 diagnostic (if equal, the playbook does ≈0).

Reframe: on a near-ceiling target the loop's honest output = convergence + speed +
not-regressing, NOT pass-lift. The validated **machinery is the asset** — point it at real
mass, not feathers.

---

## ➡️ K=5 AB PAUSED MID-FLIGHT (2026-07-19 ~22:00 KST) — RESUME HERE (SUPERSEDED — v3 rejected, ab killed 07-20; see NEXT DIRECTION above)

**The v3-vs-v0 k=5 `--speed-tiebreak` ab ran 19:20–~22:00 KST 07-19, then was STOPPED
(user); orphaned containers reaped; partial is resume-compatible.** State =
`candidates/v3/ab-verdict.partial.json` (status in_progress).
**Banked: constraints-scheduling 5/5 pairs — BOTH arms 5/5 pass** (pass-tie; v3 slightly
faster on most pairs — speed-tiebreak fodder). In-flight pairs were lost to task-level
resume granularity (db-wal was at pair 5/5, distribution-search mid, path-tracing +
tune-mjcf grinding 1h-timeout pairs — those two are the wall-clock bottleneck: several
quiet-machine hours for held-in, more for held-out ×10).
**RESUME (exact, this Mac):**
`META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
 --layer account-global --candidate v3 --split-file term-bench2/splits/loop1.json \
 --model anthropic/claude-haiku-4-5 --k 5 --parallel --enforce-resources --min-cpus 2 \
 --cpu-budget 4 --mem-budget 7000 --min-agent-timeout 3600 --max-agent-timeout 3600 \
 --host-pressure on --speed-tiebreak --resume --no-oauth-gate`
(idle machine preferred — shared 1.4GB opencode.db makes bootstrap load-sensitive;
casualty discipline per memory `no-token-expiry-engineering`: rotation-straddling
containers 0-turn — re-roll them, never build prevention.)

## K=5 AB LAUNCH CONTEXT (2026-07-19 evening) — three-way settled: NO v3 regression

**Three-way k=1 reference (same-day, all-real-attempts, after casualty re-runs): v3 5/14
(passElapsed 2231s) > v0-TODAY 4/14 (1963s) > v2 3/14 (2401s).** Yesterday's v0 8/14 was
day-variance (v0 itself dropped to 4/14 today) — NO v3 regression; v3 also uniquely passes
large-scale-text-editing (521s; v0's real attempt today failed at 2138s). Screen-favor
condition MET → **k=5 `--speed-tiebreak` ab LAUNCHED** (log
`term-bench2/logs/ab-v3-k5-20260719.log`, partial in `candidates/v3/ab-verdict.partial.json`,
chunk via `--resume`; recipe = (c) below + `--no-oauth-gate`). Casualty discipline:
rotation-straddling containers 0-turn — just re-run them (memory
`no-token-expiry-engineering`). tune-mjcf note: 0-turned/timed-out for ALL versions today —
watch it in the ab.

## SCREEN VERDICT (2026-07-19 afternoon) — v3 ADVANCES (5/14 vs v2 3/14, clean)

**(a)+(b) DONE.** v3 proposed (opus, off honest evidence: dropped v2's 2 bullets as harmful,
added read-the-on-disk-spec + never-declare-done-with-unmet-criteria; synced to store
snapshot). Screen tournament v2-vs-v3 (k=1, loop1 band, `--no-oauth-gate`) FINAL after
infra-noise re-runs (6 tasks re-run: 5×v2 + 1×v3 — morning casualties from a CC-token
rotation race killing pre-rotation containers + load-100+ starvation 0-turns; all patched
into `results/screens/account-global/*.json` [gitignored] with rerunNote):
**v3 5/14 (passElapsed 2231s) > v2 3/14 (2401s)** — v3 wins pass count AND speed.
v3 passes: sqlite-with-gcov 158s · merge-diff 188s · constraints-scheduling 164s ·
**large-scale-text-editing 521s (v0 TIMEOUTs this at 4264s!)** · distribution-search 1200s.
Screen ≠ verdict (k=1): absolute rates not comparable to v0's 8/14.
**NEXT = (c): k=5 `--speed-tiebreak` ab for v3** (recipe below; add `--no-oauth-gate`;
run on an IDLE machine — the 1.4GB shared opencode.db makes container bootstrap
load-sensitive: ~1min quiet vs ~10min under load; USER RULING: no token-expiry
engineering, opencode handles refresh; re-run casualties instead).

## CURRENT STATE (2026-07-19) — ENV FIXED · v0 RE-BASELINED HONEST 8/14 · loop unblocked

**Merged + pushed, tip ≥ `1f77f11`. Suite 1503/0/1 skip.**
1. **Env-leakage FIXED** (`dfb2f4b..9440391`): agent containers get NO `/tb`/`/mh` mounts and
   no `TB_ROOT`; staging + verifier tests + patches via rc-checked `podman cp` (stage-then-
   purge); `rm`/`find -delete` Dockerfile lines now EXECUTE (best-effort; apt-cache cleanup
   still dropped). Oracle path unchanged + test-pinned. Live-verified: oracle path-tracing
   PASS ×2; container probe /tb absent, orig.c deleted. copyTests failures now surface as
   setup_failed (never silent reward=0).
2. **v0 RE-BASELINED on the honest env: 8/14 (57.1%)** — was 12/14 (85.7%) inflated. Leakage
   predictions CONFIRMED: db-wal-recovery FAIL(442s), path-tracing FAIL(1832s). Other deltas
   (k=1 noise vs real): write-compressor TIMEOUT(3658), large-scale-text-editing
   TIMEOUT(4264), llm-inference-batching-scheduler FAIL(1360) — all former passes;
   extract-elf FLIPPED TO PASS(741s); openssl-selfsigned-cert FAIL (consistent). Old
   baseline backed up: `.meta-harness/backups/v0-pre-envfix-20260719/` + git history.
   Store synced+pushed (`1f77f11`). NOTE: post-envfix sessions distinguishable by env
   pluginSha stamp; pre-envfix data must not mix into rates.
3. **NEXT (loop unblocked, honest instruments) — exact recipes, this Mac:**
   (a) **Propose v3**: fresh traj evidence is thin post-reset (score has 14 new sessions but
   traj pruning applies) — proposer reads score + traj under `.meta-harness`; start opencode
   in the repo, `/mh-propose account` → verify a NEW vN ≠ v0 in
   `.meta-harness/global/candidates/`. Proposer now sees the 6 honest fails (incl.
   ex-leakage db-wal/path-tracing), SLOW-PASS markers, and v1/v2's rejected history.
   Optional: enable the external-evidence seam first (config `externalEvidenceDir:
   "evidence/tb2-leaderboard"` + distill per docs/tb2-evidence-mining.md — held-in only).
   (b) **Screen tournament (k=1, cheap)**:
   `META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts \
    screen --layer account-global --candidates v2,v3 --task-file term-bench2/splits/loop1-band.txt \
    --model anthropic/claude-haiku-4-5 --parallel --enforce-resources --min-cpus 2 \
    --cpu-budget 4 --mem-budget 7000 --host-pressure on \
    --min-agent-timeout 3600 --max-agent-timeout 3600`
   (explicit timeout envelope REQUIRED — oauth+parallel pre-flight errors without
   `--max-agent-timeout`, and hard-rejects if the token has < max-agent-timeout+5min left.
   USER RULING 2026-07-19: add `--no-oauth-gate` — the host auto-rotates the token during
   active CC/opencode use, so the freshness gate is over-strict; the flag skips the
   pre-flight + launch-guard (oauth gates like key-auth). Prints ADVANCE line; store
   never written.)
   (c) **Winner → k=5 verdict ab** (needs fresh oauth; freshness gate is task-item-level —
   see pt-4 learnings; prefer starting on a fresh ~8h token):
   `... runner.ts ab --layer account-global --candidate <winner> --split-file
    term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 --k 5 --parallel
    --enforce-resources --min-cpus 2 --cpu-budget 4 --mem-budget 7000
    --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on --speed-tiebreak --resume`
   (~24-40h on this Mac — chunk across days via --resume, or office box when available.)
   (d) **Phase-6 loop2 curation now legal**: full 75-sub matrix in git
   (`term-bench2/leaderboard/matrix.json`); follow plan Phase 6 (band probe with the NEW
   honest rates → curate-band → `split make ... --split-file term-bench2/splits/loop2.json
   --sentinels 3`; set MhConfig.activeSplitFile when loop2 goes live).
   Caveats: v2's old k=2 screen verdict (inconclusive-negative) AND all pre-envfix evidence
   are old-regime — never mix into rates; k=5 remains the only verdict grade
   (memory `k5-verdict-standard`).

(pt-5 and older blocks below are HISTORICAL.)

## CURRENT STATE (2026-07-18 pt 5 — HISTORICAL; env since FIXED + re-baselined, see 07-19 block) — VELOCITY LEVERS MERGED · ENV SOFTNESS FOUND · v2 screen NEGATIVE

**Everything MERGED + PUSHED to main (tip ≥ `69b4ff0`). Suite 1486/0/1 skip, both tscs clean.**
Built via subagent-driven dev off the 3×-architect-reviewed plan
(`~/.claude/plans/plan-to-follow-your-purrfect-diffie.md`); every phase task-reviewed to
Approved; final whole-branch review MERGE-READY. Ledger: `.superpowers/sdd/progress.md`.

**Shipped (all default-off / additive; NOT budget-identity changes):**
1. **Time-to-resolve metric** — agent-phase elapsed (agentElapsedSec on every completion
   path) → ab `candidateElapsed/activeElapsed` arrays → `speed` block in verdict/meta-metrics/
   report-loop (`pairedSpeedStats`: both-pass pairs only, median of per-pair ratios, exact
   sign test). SLOW-PASS proposer marker + section. **`--speed-tiebreak`**: guarded
   inconclusive→accept upgrade (structural: ho!==null excl. legacy, !earlyStopped, delta≥0,
   nPairs≥8/p≤.05/ratio≤.8); part of the standard k=5 recipe going forward.
2. **`bench screen`** — k=1 candidate tournament (layer-scoped outDir + provenance stamp,
   passing-only elapsed tiebreak, parallel+floor threading, error isolation). Winner → k=5 ab.
3. **Leaderboard tooling** — `term-bench2/leaderboard/pull-leaderboard.ts` (all-76 sweep,
   atomic resumable cache) + pure `src/bench/leaderboard.ts` curation (harnessVariance,
   minSubs=4 floor) + curate-band driver. NOTE: committed matrix.json is a 2-sub placeholder;
   the full sweep was RUNNING in background at session end — on completion run
   `bun pull-leaderboard.ts --merge` + commit matrix/submissions.
4. **traj-replay helper** (`extractShellCommands`, truncation-flagged, newline-safe) +
   **external-evidence seam** (`evidence/tb2-leaderboard/`, MhConfig.externalEvidenceDir +
   activeSplitFile, LIVE held-out contamination guard, index-only UNTRUSTED injection after
   the L1 guard, cwd-independent path resolution). Distill procedure: docs/tb2-evidence-mining.md.

**🚨 ENV-FIDELITY VERDICT (docs/env-fidelity-spotcheck.md): `untrusted` — the bench is SOFT.**
Our db-wal-recovery + path-tracing passes are ENVIRONMENT LEAKAGE, proven by official-image
replays (both failed): (1) `cmd-run.ts:212` mounts the whole task source RO at `/tb` — agents
read fixtures/answer material; (2) `staging.ts` drops `rm`-only RUN lines, so answer-key
deletions (e.g. path-tracing `rm /app/orig.c`) never happen. **Consequences: v0's 12/14
baseline is partially inflated; leaderboard-fail band picks gated untrusted; loop2/Phase-6
curation BLOCKED. USER DECISION needed: fix the two bugs (small, localized) → re-baseline v0
(measurement-regime change) → then loop2.**

**v2 k=2 SCREEN — FINAL (test-grade, k=2): inconclusive-NEGATIVE.** Full held-in 7 tasks:
b=0/c=3 all favoring v0 (v2 lost prove-plus-comm 0/2, tune-mjcf 1/2 — tune-mjcf REVERSED vs
the earlier discarded chunk; haiku variance is huge = the k=5 argument). Held-out never ran
(freshness gate). Speed signal consistent: v2 much faster on tie pairs (e.g. tune-mjcf 485s vs
2536s). **k=5-confirm condition ("screen favors v2") UNMET — do NOT k=5 v2.** Recommended:
`/mh-propose` v3 off this evidence (proposer now sees SLOW-PASS + rejected verdicts; env
evidence optional via the new seam), then `bench screen` v2-vs-v3(-vs-v4), winner → k=5
`--speed-tiebreak` ab — AFTER the env fix + re-baseline above.

**Deferred/open:** env-bug fix + re-baseline (USER DECISION, blocks loop2) · full-sweep
--merge + commit · Phase-6 loop2 split (blocked) · trajectory distillation (manual,
docs/tb2-evidence-mining.md) · host-sharded abs · Axis-2 vendor leg (openrouter =
oauth-TTL-free too) · pressure-threshold default-flip · capture-cap raise for replayability
(300-char args made write/edit trajectories unreplayable).

## CURRENT STATE (2026-07-18 pt 4 — HISTORICAL; ab finished as k=2 screen, see pt 5) — (b) ab LIVE, 4/7 held-in banked · resume at home

**The (b) ab (v2 vs v0) is MID-FLIGHT.** Ran at the office in two chunks (05:35–06:52 and
07:06–08:40 UTC), stopped cleanly for the commute. State =
`.meta-harness/global/candidates/v2/ab-verdict.partial.json` (status `in_progress`, ident
`minAgentTimeout:3600` + `env.resourceEnforcement:true` — resume-compatible with the recipe
below by construction). Doc-only commit; code tree unchanged from pt 3, suite untouched.

**Banked (4/7 held-in, k=2):** constraints-scheduling A[1,1]/B[1,1] · path-tracing A[1,1]/B[1,1]
· distribution-search A[1,0]/B[1,0] (pair-2 both-arm genuine fails) · db-wal-recovery
A[1,1]/B[1,1]. All ties so far in banked data.

**Headline (in DISCARDED work):** tune-mjcf pair 1 = **v0 FAIL(1197s) / v2 PASS(2867.6s)** —
a discordant c=1 for v2, now **2-for-2 across attempts** (the aborted no-floor run also had v2
winning its only discordant). The pass took 2868s — impossible under the old 900s TB2 cap;
the 1h floor bought it. The task was mid-pair-2 at the departure stop → whole task re-rolls
(task-level resume granularity keeps only all-k-pairs-complete tasks). If real, it reproduces.

**RESUME AT HOME:** exact pt-3 recipe below + `--resume` (skips the 4 banked tasks). Token
fresh until **15:02 UTC** (midnight KST) — NO login needed tonight. Remaining: tune-mjcf,
prove-plus-comm, openssl-selfsigned-cert (held-in), then held-out ×10. Re-arm the monitors
(completion + pressure watchers, resource sampler). See memory `ab-v2-chunk-state`.

**Live validation of this week's shipped features (all confirmed on real runs):**
- **Measured packing → width-3** on the 4-CPU VM from the first scan (pt 0.86c + cs 0.88c +
  cold 2c = 3.74/4 packed; declared-int would have pinned width-2). `[pack] measured` lines live.
- **1h floor changed outcomes**: pt arm A passed at 1810.5s (past its 1800s TB2 cap) and the
  tune-mjcf 2868s pass above. Also the first HONEST recorded timeout: tune-mjcf v0-arm
  3600s/reward=0 in chunk 1 (then a 1197s genuine fail on the re-roll — haiku variance).
- **`--host-pressure on`: ZERO false pauses** across observed load 0.3–3.4/core (sampler CSV
  `term-bench2/logs/loop1-ab-v2.resources.log`). First calibration point for the default-flip.
- Profile store warmed further (ds/db-wal/tune-mjcf samples added) — packing gets more measured
  next run.

**Discoveries / follow-ups (new):**
- **`canLaunch` freshness gate is task-ITEM-level** (`scheduler.ts` — checked per scan for NEW
  items only): a k=2 ab task = up to 4 sequential sessions, so in-flight tasks STRADDLE token
  expiry. Tonight's mitigation = kill the chunk before the ~5-min pre-expiry refresh window
  (a straddling container's plugin could race the host refresh with the copied refresh token).
  FOLLOW-UP: per-arm/per-session canLaunch check.
- **"No locking in CC" is STALE**: the reconstructed CC source (github
  yasasbanukaofficial/claude-code) shows host CC refresh uses a proper-lockfile on `~/.claude`
  + post-lock re-read + race recovery. Host-side concurrent sessions are SAFE; the real
  remaining race is container-copy divergence (darwin Keychain export can't write back).
  Correct `agent-auth.ts` header + `auth-delegation-design.md` when convenient. Also: refresh
  fires only within ~5 min of expiry (`isOAuthTokenExpired` buffer) — any active session
  rotates it automatically at that point; a Keychain `expiresAt` watcher is a clean launch
  trigger (used tonight, worked).
- ab-verdict gap noted: an all-4-transient-retries or gate-slipped auth 0-turn session pushes
  reward 0 into the VERDICT (store self-protects, verdict doesn't; only `setup_failed`
  excludes). Remedy = delete the task from `taskResults` in the partial + `--resume`.
  `retry-provider.ts` wrapper exists for sustained provider outage (tonight ran unwrapped).

**Deferred/open (unchanged from pt 3):** (d) Axis-2 vendor content + panel — note a keyed
openrouter/xai/etc. leg would ALSO kill the whole oauth-TTL fragility class (needs its own
model re-baseline first); host-class stamping; sensor stale-cache nit; pressure-threshold
default-flip; capRaised-into-TaskFootprint; per-arm canLaunch (above).

## CURRENT STATE (2026-07-18 pt 3 — HISTORICAL; the (b) ab is now LIVE, see pt 4) — #3 SHIPPED · v0 baseline KEPT · next = the (b) ab

**Everything PUSHED — tip ≥ `969f418`, tree clean** (this block commits after). Suite **1367 / 0
fail**. No background runs; no orphan containers; podman machine still up.

**Session outcomes since pt 2:**
1. **v0 re-baseline SKIPPED — USER RULING**: no session in v0's baseline was time-clipped
   (max elapsed 789s vs 900s budget; both fails genuine completions), so a 1h floor changes
   nothing → the 14-session Linux baseline is outcome-equivalent and KEPT. Consequence: v0's
   stamps are floor-absent while new runs stamp `minAgentTimeout:3600` → **`/mh-activate` will
   flag identity mismatch — use `--force`** with this rationale.
2. **Load-aware #3 SHIPPED + MERGED** (`26fb293..969f418`): `--host-pressure observe|on` — see
   the pt-2.5 block below for full detail. LIVE-SMOKED: real-spike pause/resume cycle PASS.
   Final review caught 1 BLOCKER pre-merge (unref'd pause timer → silent process exit;
   fixed + subprocess regression test).
3. **First (b) ab attempt #2 ABORTED for host load** (loadavg 149 — the episode that motivated
   #3). Partial evidence before abort: 4 pairs consumed, **candidate v2 led c=1/b=0** (won the
   path-tracing discordant pair; tune-mjcf F/F both-arm timeouts under the OLD no-floor
   envelope). Aborted partial set aside as
   `candidates/v2/ab-verdict.partial.superseded-no-floor.json` — do NOT resume it (identity
   mismatch, correctly rejected).
4. **v2 candidate synced into the git snapshot** (`term-bench2/store/global/candidates/v2/`,
   surgical) — v2 = v0 + 2 proposer bullets targeting the spec-misread fails (derive
   under-specified formats from task text; verify against stated criteria, not self-checks).

**NEXT SESSION = run the (b) ab, updated recipe (this Mac):**
```
# fresh oauth first: claude, login, ctrl-D (freshness gate needs token > 1 task)
META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
  --layer account-global --candidate v2 --split-file term-bench2/splits/loop1.json \
  --model anthropic/claude-haiku-4-5 --k 2 --parallel --enforce-resources \
  --min-cpus 2 --cpu-budget 4 --mem-budget 7000 \
  --min-agent-timeout 3600 --max-agent-timeout 3600 \
  --host-pressure on --resume
```
- `--min-agent-timeout 3600` = the 1h/task floor (user's loosest-envelope ruling — budget-identity
  `{max:3600, min:3600, timeoutRecording:true, resourceEnforcement:true}`).
- `--host-pressure on` = the new gate; the run coexists with laptop use (launches pause under
  real host pressure, resume on recovery). First real run doubles as threshold calibration —
  watch `[pressure]` lines for false pauses. Daytime alternative: `--cpu-budget 2`; or run
  overnight / on the office box (v2 is in the git snapshot now; office would cold-start
  profiles + floor matters less there).
- Profiles are warm on this Mac (cs n=4, pt n≥3 → measured packing + raised caps kick in at
  start — expect the `[pack] measured` lines and possibly width-3).
- On accept: `/mh-activate account v2 --force` (identity mismatch is adjudicated — see #1),
  then SURGICAL sync of v2 (incl. new score/verdict) into `term-bench2/store/` + push.
- Also new since pt 2: **on-host sensor sanity** `cd opencode-plugin && bun -e
  'import {createHostPressure} from "./src/bench/host-pressure.ts"; const
  hp=createHostPressure({}); console.log(hp.underPressure(), hp.state())'`.

**Deferred/open (unchanged):** (d) Axis-2 vendor content + panel; host-class stamping of score
sessions (cross-host mixing); sensor stale-cache-after-error nit; `--host-pressure` threshold
calibration then default-flip; `capRaised`-into-TaskFootprint cleanup.

## CURRENT STATE (2026-07-18 pt 2 — HISTORICAL; re-baseline was SKIPPED per ruling above) — TIMEOUT FLOOR shipped

**USER CORRECTION (recorded as feedback memory):** the standing decision is **1 hour per task**
(loosest envelope; load-aware scheduling compensates) — NOT TB2-exact budgets. The code's
cap-only-lowers semantics (`min(TB2, --max-agent-timeout)`) was a design misreading: on this
3×-slower 4-CPU VM, TB2 budgets are artificial limits → live-observed tune-mjcf 0-for-4 timeouts
at 900s (Linux passed in 267s) during the first (b) `ab` attempt.

**Shipped: `--min-agent-timeout` floor** (`248fe8f` + fix `d22ecb0`, suite 1327/0): effective
per-task agent time = `min(max(TB2, floor), cap)` — time-domain mirror of `--min-cpus`. Floor
threaded through ALL budget-identity sites (env stamp, ab verdict + resume-ident, T6/T7 tuple,
/mh-activate gate); absent=0 keeps old records comparable. Verifier stays TB2-exact. Review
caught a CRITICAL before merge: cmd-ab never passed the floor to taskTimeouts (stamped-but-inert
on the ab path) — fixed + execution-tested.

**Budget-identity is now `{maxAgentTimeout:3600, minAgentTimeout:3600, timeoutRecording:true,
resourceEnforcement:true}`** → the Linux v0 baseline (floor-absent, and host-mismatched anyway) is
superseded. **Re-baseline #2 runs ON THIS MacBook** (v0 score reset per the established
procedure; old baseline preserved in git history): 14-task band, k=1, parallel,
`--min-agent-timeout 3600 --max-agent-timeout 3600 --enforce-resources --min-cpus 2 --cpu-budget 4
--mem-budget 7000`. This also warms the resource-profile store → measured packing kicks in for
the subsequent ab re-run (v2 vs re-baselined v0).

**Aborted first (b) ab attempt (partial evidence, superseded):** 4 pairs consumed, candidate v2
led c=1/b=0 (won the path-tracing discordant pair; the rest ties incl. tune-mjcf F/F both-arm
timeouts). v2 = v0 + 2 proposer bullets targeting the spec-misread fails (derive under-specified
formats from authoritative sources; verify against stated criteria, not self-checks). v2 stays a
candidate; ab re-runs after the re-baseline.

## CURRENT STATE (2026-07-18 pt 1 — superseded above where they conflict)

**Everything PUSHED — `git pull` fast-forwards.** Tip ≥ `dca27be` (this doc commits after code).
Tree clean. Suite **1310 pass / 0 fail**, tsc clean. Loop store (MacBook: repo `.meta-harness`,
mirrored to `~/.config/meta-harness`): **active = v0, 12 PASS / 2 FAIL / 14 sessions (85.7%)**,
budget-identity `{maxAgentTimeout:3600, timeoutRecording:true, resourceEnforcement:true}`.

Shipped since the 07-17 pickup: **load-aware scheduler increment #2** — measured packing
default-ON + raise-only cap lift + OOM-escalation retry + cap provenance (full detail in the
"LOAD-AWARE #2 SHIPPED" section below). NOT a budget-identity change → the v0 baseline stays valid.

**OPEN WORK (pick any):**
- **(b) first real loop `ab`** — the throughline, AND load-aware #2's first live validation
  (fills n≥3 profiles for the whole band → packing goes measured automatically). Recipe: the
  "(b) recipe, MacBook-adapted" steps below. Needs fresh oauth (`claude`, login, ctrl-D).
- **(d) Axis-2** — seed/propose vendor content so routing does something; multi-model panel needs
  a 2nd vendor model.
- **load-aware #3 — SHIPPED (2026-07-18)**: `--host-pressure observe|on` (default OFF =
  byte-identical). Sensor `bench/host-pressure.ts` (per-signal hysteresis: load/core 2.0/1.2 +
  darwin memory_pressure / linux PSI w/ MemAvailable fallback, 20s cache, tick=sample,
  fail-safe never-throws); TRANSIENT `pauseGate`+`pausePollMs` on `schedule()` (checked AFTER
  the terminal oauth gate; timer only when inFlight=0, keep-alive — NO unref, that was a
  final-review BLOCKER with subprocess regression test; timer-clear at both settle points);
  `buildPressureGate` (one sensor/command, shared across ab phases). Suite 1367/0.
  **LIVE-SMOKED on this Mac**: real 34-spinner spike → `[pressure] paused launches (load/core
  8.9…)` → 0 leaked launches → decay+dwell 190s → `[pressure] resumed` → all tasks ran, exit 0.
  Observe-mode caveat CONFIRMED live: with sparse scans (2 long tasks) a mid-run spike is
  invisible — sampling rides scan events by design. NOT a budget-identity change. Follow-ups
  deferred: sensor stale-cache-after-error coherence nit; threshold calibration via observe
  mode on real sweeps. Spec: `docs/superpowers/specs/2026-07-18-load-aware-3-host-pressure.md`
- Post-merge cleanup candidate: fold `capRaised` into `TaskFootprint` (dedupes the two
  `capRaisedFor` closures in cmd-run/cmd-ab).

---

## ✅ MACBOOK PICKUP DONE (2026-07-17) — open work (a) COMPLETE, band hole FILLED

Home steps 1–3 executed clean: suite **1250 pass / 0 fail** on macOS; store diff showed exactly the
expected v0-re-baseline drift; surgically imported (no `--delete`) + activated v0 in **BOTH** local
stores — `~/.config/meta-harness` AND the repo `.meta-harness` (which existed on the MacBook but was
STALE: old v1, pre-rebaseline active, no config.json — the open-work recipes point `META_HARNESS_HOME`
at it, so it had to be brought current too).

**(a) write-compressor re-run — DONE, PASSED.** Serial (no `--parallel`, oauth-race dodged),
reward=1 in 788.9s (turns=1, verifier clean). Store: **v0 = 12 PASS / 2 FAIL over 14 sessions
(85.7%)** — the 13/14 band hole is filled; fails remain extract-elf + openssl-selfsigned-cert
(genuine). Synced to `term-bench2/store/` (surgical) + mirrored to `~/.config/meta-harness`.
Recipe fix: **`--cpu-budget`/`--mem-budget` are `--parallel`-only** — drop them for serial runs
(the runner errors out otherwise).

**FIRST resource profile written** (load-aware scheduler #1 live-proven on macOS/applehv):
`<repo>/resource-profiles/x64-12c-intel-r-core-tm-i7-8850h-cpu-2-60ghz.json` → write-compressor
`{avgCpu: 0.43, peakRssMb: 1217, wall: 788.9}`. Declared/floored 4 cpus vs measured 0.43 sustained
cores = the over-declaration increment #2 will exploit. `resource-profiles/` is now GITIGNORED
(host-local by design — `readResourceProfile` keys by the CURRENT host class, so profiles don't
transfer meaningfully).

**MacBook host notes:** podman = official installer at `/opt/podman/bin` (NOT on default PATH —
prefix `PATH=/opt/podman/bin:$PATH`); machine applehv **4 CPUs / 8 GiB** → parallel budgets must be
scaled down from the 8-core Linux recipes (a `--cpu-budget 8`/`--min-cpus 4` parallel run degenerates
to width-1 here).

**REMAINING OPEN WORK:** (b) first real loop `ab` — propose a NEW candidate ≠ v0, same
budget-identity — now runs on the MEASURED packer (below) and fills profiles for all 14 band
tasks; (d) Axis-2 vendor content + panel. Details in the handoff block below.

## ✅ LOAD-AWARE #2 SHIPPED (2026-07-18) — measured packing DEFAULT-ON + OOM-escalation retry

Open-work (c) is DONE and merged (branch `feat/loadaware-2`, 10 commits, suite **1310 pass / 0
fail**). Built via parallel subagent waves (3∥ → 2∥ → serial ×3), per-task spec+quality reviews,
final whole-branch review = MERGE-READY. Plan (3× architect-reviewed to FLAWLESS before build):
`~/.claude/plans/plan-to-flip-2-tidy-aurora.md`.

**What changed:**
- **Packing weight = measured profile** (default-ON): `packingWeight` (resource-profile.ts) —
  avgCpu (floor 0.5) / peakRssMb×1.2 (floor 256MB), gated `n≥3 && avgCpu>0`; declared/floored =
  cold-start prior. `packingFootprints` (tasks.ts) splits `{cap, pack}` — containers ALWAYS get
  the generous cap, the scheduler packs the honest weight. scheduler.ts itself unchanged.
- **Cap raise-only lift**: `raiseCapMeasured` — cap.memoryMb = max(declared/floored, peak×1.5) at
  n≥3, parallel AND serial enforce paths (cmd-oracle excluded, test-pinned). Closes the
  chronic-OOM loop (measured demand > declared cap no longer kills every run).
- **OOM-escalation retry**: cgroup `memory.events oom_kill` (cumulative-counter caveat → trigger
  is `oomKilled && reward !== 1` — an OOM'd-then-recovered PASS is kept); single retry in a fresh
  container at 2× memory (clamped to mem-budget under parallel); carry-forward across k-repeats
  and both ab arms; killed attempt never recorded (infra noise, like the auth-skip); oomKilled
  samples never memorized into profiles.
- **Escape hatch**: `--no-pack-measured` (run+ab, legal with AND without `--parallel`) disables
  ALL measured decisions. **Provenance**: per-session `capMemoryMb`/`capRaised` on SessionRecord
  (threaded like cpuSeconds/peakRssMb). **task-load**: MeasCPU/MeasMB/n columns + a second
  "measured packing" co-run preview block.
- **NOT a budget-identity change** (packing width is verdict-equivalent; ab re-runs both arms
  under identical caps) → no re-baseline needed.

**Deferred to increment #3**: online wall-clock back-pressure (the real fix for burst-phase
contention — avgCpu is a whole-run median; watch first live sweeps for timeout upticks), CPU
escalation, scheduler-visible escalated footprints. Post-merge cleanup candidate (final-review
minor): fold `capRaised` into `TaskFootprint` to delete the duplicated `capRaisedFor` closures.

**First live validation** = the (b) loop `ab`: it accumulates n≥3 profiles for the whole band,
after which packing goes measured automatically. On this 4-CPU VM expect width to rise from 1-2
toward ~4 as profiles mature (mem-bounded).

**(b) recipe, MacBook-adapted** (the Linux `run-loop3-ab.sh` assumed 8 cores; this VM is 4c/8GiB):
1. Propose off the fresh 14-session evidence: store-writing history is already in the loop store —
   start opencode in the repo, `/mh-propose account` → emits a NEW candidate vN (with Axis-2
   generality tags — first live capture data). Verify vN ≠ active: `ls .meta-harness/global/candidates/`.
2. `ab`, detached + logged (`term-bench2/logs/`), oauth fine (freshness gate), fresh token first (`claude`, login, ctrl-D):
   ```
   META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
     --layer account-global --candidate vN --split-file term-bench2/splits/loop1.json \
     --model anthropic/claude-haiku-4-5 --k 2 --parallel --enforce-resources \
     --min-cpus 2 --cpu-budget 4 --mem-budget 7000 --max-agent-timeout 3600 --resume
   ```
   (`--min-cpus 2 --cpu-budget 4` = width-2 on the 4-cpu VM — the Linux `--min-cpus 4 --cpu-budget 8`
   pins width-1 here. Serial alternative: drop `--parallel`/`--cpu-budget`/`--mem-budget`, keep the rest.
   Same budget-identity either way: {3600, timeoutRecording:true, resourceEnforcement:true}.)
3. Verdict `report-loop`; on accept `/mh-activate account vN` (T6 gate checks budget-identity), then
   SURGICAL sync of `candidates/vN/` into `term-bench2/store/` + commit + push (never blind export).

---

## ➡️ MACBOOK HOME PICKUP (handoff 2026-07-16 evening) — DONE 2026-07-17, see block above

**Everything is PUSHED — `git pull` fast-forwards to the latest `origin/main`.** Clean tree (only a stray untracked `oom` — ignore). Recent commits (newest last): `2a8fda5` v0 re-baseline snapshot · `e113f43` cgroup capture+memorize · `e0e6e7c` ab-path cgroup capture · then this handoff on top. (Don't assert an exact tip hash — this doc commits after the code, so the tip is always ≥ the hashes listed.)

**What did NOT transfer from the Linux box (git-only cross-host — [[tmp-dir-mnt-d]]):** the `.meta-harness` runtime store (active=v0 pointer + `config.json recordTimeouts=true`), the `/mnt/d/tmp/*.sh` scripts (rebaseline-v0 / -sync / run-loop3-ab — recreate from the procedures below), and `~/.claude` memories (their content is folded into THIS file). The v0 baseline itself IS in git (`term-bench2/store/global/candidates/v0/`).

**Home steps, in order:**
1. `git pull` (fast-forwards to the latest origin/main).
2. `cd opencode-plugin && bun test` → expect **1250 pass / 0 fail** (confirms the cgroup-capture code lands clean on macOS). NOTE: `readCgroupStats`/live bench needs Linux+podman cgroup v2 — macOS podman runs in a Linux VM so the container cgroup read still works; but the UNIT tests are pure/mocked and pass anywhere.
3. **Store import — DIFF FIRST, never blind export** (the export-trap fired TWICE on the stale MacBook store — [[tmp-dir-mnt-d]]): `term-bench2/store-sync.sh diff`. Only if it shows the v0 re-baseline missing, surgically import (NO --delete): `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json`, then ACTIVATE v0 (the active pointer is host-local, not in the snapshot).
4. Pick up the open work below.

**OPEN WORK (pick any):**
- **(a) write-compressor re-run** — fill the 13/14 band hole. It dropped as an oauth-parallel-race 0-turn (auth/transient skip, not a timeout). Re-run SERIALLY (drop `--parallel`) or with a fresh token: `run --layers account --tasks write-compressor --model anthropic/claude-haiku-4-5 --enforce-resources --min-cpus 4 --cpu-budget 8 --max-agent-timeout 3600` under `META_HARNESS_HOME=<repo>/.meta-harness`. This also writes the FIRST resource profile.
- **(b) first real loop `ab`** — propose a NEW candidate ≠ active(v0), same budget-identity → valid comparison. `ab` dies "nothing to compare" if candidate==active (`cmd-ab.ts`). Recipe: `/mnt/d/tmp/run-loop3-ab.sh <candidate>` (recreate — see LINUX block below).
- **(c) load-aware scheduler increment #2** — flip the packer input from declared `cpus` int → measured `avgCpu` (`readResourceProfile`), declared int + `--min-cpus` kept only as cold-start prior. NEEDS profile data first → run the loop live (step a/b) to accumulate, THEN flip. See the Load-aware section in the LINUX block + [[load-aware-scheduler]].
- **(d) Axis-2** — seed/propose vendor content so routing does something; multi-model panel needs a 2nd vendor model.

---

## LINUX SESSION (2026-07-16 cont.) — MASTER SHIPPED · Axis-2 tag CAPTURE+ROUTING shipped · TB2-timeout fixed · cgroup-capture shipped

**HEAD `2a8fda5`, PUSHED to `origin/main` (`origin/main..HEAD` empty, `git ls-remote` confirms). Tree clean** (except a stray empty `oom` file, untracked — ignore). **Loop-3 v0 re-baseline DONE + synced — see the "Re-baseline v0" section at the end of this block.**

**Shipped to main (local) this session:**
1. **MASTER BUILT + MERGED** — the 8-module deterministic boundary/orchestration layer under `opencode-plugin/src/fleet/master/` (gate-state · transport · frozen-gate · namespace · relay · scheduler · reconcile · master) + a `master` CLI case + hermetic E2E. Executed the master DAG as parallel subagent waves (wave0 4∥ · wave1 3∥ · wave2 1), TDD per task, per-task code-architect review + a final whole-branch review (merge-ready, 0 crit/imp). Review-driven fixes: T4 frozen-gate `testsRun` parse (was reading pass-count not `Ran N tests` → blinded the DGM-114 gaming detector); T1 gate-state made **kind-aware** (`resolveGate`/`markRelayed` take a `GateKind` — HUMAN-approved interface change, guards co-pending different-kind gates); T5 upsert test. The 4 open Qs settled in-build (masterRoot = injected param; grammar `approve|revise <project>/<sliceId>` + `status`; gateRoot injected; lock TTL deferred). Plan `docs/superpowers/plans/2026-07-16-master-build.md`. Suite 1214 pass.
2. **TB2-timeout fix** — the loop `ab` recipe was capping tasks BELOW their real TB2 budgets: `--max-agent-timeout 1800` halved distribution-search (TB2 3600), `--max-verifier-timeout 300` starved nearly every verifier (TB2 verifiers 900–3600s). `taskTimeouts` (tasks.ts) ALREADY reads exact TB2 `task.toml` timeouts; a cap only LOWERS. Fix = agent cap **3600** (split max), **DROP** the verifier cap. The "oauth+parallel recipe" section below already reflects this; `/mnt/d/tmp/run-loop3-ab.sh` fixed too.
3. **Axis-2 generality tag CAPTURE** (`ecc6874`) — per-bullet `generality?: "universal"|"vendor"|"model"` + `slice?` on `PlaybookBullet`; proposer emits it per op; `applyPlaybookOps` coerces invalid→universal + caps slice; no-op guard now playbook-aware (a pure re-tag is no longer silently dropped); `generalityRollup` in candidate meta + `/mh-status gen[u v m]`. `renderPlaybook` UNCHANGED → injection byte-identical. Promote left untouched (pre-existing playbook-null-on-activate, documented `explicitly-not-now §2.4.1`). Docs: `target-model-axis.md §7.0` + research fold `§0.1`.
4. **Axis-2 generality tag ROUTING** (`4b13060..bbca3e4`) — a bullet tagged `vendor:anthropic` now INJECTS only for Anthropic sessions, via ONE shared `renderPlaybookRouted` + `composeHarness(model?)` with a **faithful-render guard** (`renderPlaybook(pb).trim()===flat.trim()` — absorbs `seedPlaybook`'s non-format-preserving migration → byte-identical by construction). Threaded through ALL 4 injection entry points: runtime `composeInjection` (session model), bench `cmd-ab`/`cmd-run` (`--model`), fleet `renderRole` (role's fixed model). Spec `2026-07-16-generality-routing-design.md` (SUPERSEDES `target-model-axis §4`'s separate-coordinate approach for delivery — the tag lives on the bullet, routing is a render filter); plan `2026-07-16-generality-routing.md`. 2 code-architect rounds to production-flawless. Suite 1233 pass.

**Loop-2 timeout-mirage CONFIRMED live:** tune-mjcf + distribution-search both PASS at generous budgets (`--min-cpus 4`). Loop-2's "no lift" was compute/timeout starvation, not real regression.

**Loop-3 re-baseline — flipped + DONE + synced (2026-07-16 21:49):**
- **`recordTimeouts` FLIPPED ON** — `<repo>/.meta-harness/config.json` = `{"recordTimeouts": true}`. That is the REPO store (loop runs point `META_HARNESS_HOME` there); `~/.config/meta-harness` is NOT the loop store. Budget-identity is now `{maxAgentTimeout:3600, timeoutRecording:true, resourceEnforcement:true}`.
- **Baseline reset v6→v0.** Active WAS the untested v6 (drift, no verdict). Reverted: v0 migrated to a 6-bullet playbook from its `DEFAULT_SYSTEM_PROMPT` (its header line becomes a `- ` bullet — a NON-faithful migration, so routing's faithful-render guard falls back to flat = v0's EXACT original prompt, byte-identical) + activated NON-destructively (v6 preserved as a candidate) + `score.json` reset to `{nPass:0,nFail:0,sessions:[]}` (its old score was 5 degenerate all-None placeholder rows, not real data). **active = v0.**
- **Re-baseline DONE + synced + pushed (`2a8fda5`).** Stored v0 baseline = **11 PASS / 2 FAIL over 13 sessions (84.6%), 0 timeouts** — budget-identity stamped `{maxAgentTimeout:3600, resourceEnforcement:true}`. Fails: extract-elf, openssl-selfsigned-cert (genuine, no timeout). Timeout fix CONFIRMED live: distribution-search (426s) + tune-mjcf (267s) both PASS where they used to time out under the old caps.
  - **⚠️ write-compressor MISSING from the 14-task band** — ran 602s but `opencode done turns=0` → store logged `skip store record: 0 agent turns (auth/transient agent failure)` = the oauth-parallel race, NOT a timeout. So the band is 13/14; runner's own summary counts it as a fail (11/14 = 78.6%), the STORE correctly excludes it as infra noise (11/13 = 84.6%). **`recordTimeouts` does NOT cover this skip path** — it records timeout 0-turn runs, but "auth/transient agent failure" 0-turn runs are a SEPARATE skip in the runner. write-compressor needs a re-run (serial, or fresh token to dodge the oauth-race) to fill the hole. See [[loop-blind-spots]].

**STILL dark / deferred:**
- **Axis-2 not fully APPLIED** — CAPTURE + ROUTING shipped, but (a) NO content is tagged vendor/model yet (a fresh propose emits tags, or hand-seed the documented Anthropic rules); (b) NO multi-model PANEL to VALIDATE a tag (needs a 2nd vendor model). Routing delivers the CLAIM, doesn't prove it. Deferred: `target-model-axis §6` (panel) + promote-playbook-preservation (`explicitly-not-now §2.4.1`).
- **No meaningful loop `ab` YET** — needs (i) the v0 re-baseline above to FINISH, THEN (ii) a NEW candidate ≠ active to compare. `ab` = candidate-vs-ACTIVE; a candidate == active dies "nothing to compare" (`cmd-ab.ts:184`). v0–v6 all pre-date the new budget-identity → only the re-baselined v0 is a valid baseline. `META_HARNESS_HOME=<repo>/.meta-harness`, detached+logged (`/mnt/d/tmp/run-loop3-ab.sh <candidate>`).

### Re-baseline v0 — procedure (scripts are HOST-LOCAL `/mnt/d/tmp`; recreate from these steps at home)
Prereq: fresh oauth (`claude`, login, ctrl-D — `--parallel` needs a live token). `run` (NOT `ab`) re-scores the ACTIVE version; store-writing by default (no `--results-file`/`--no-store`). `run` takes `--task-file`, NOT `--split-file` (that flag is `ab`-only).
1. **Baseline run** (`/mnt/d/tmp/rebaseline-v0.sh`): guards `active==v0` → extracts loop1's 14 tasks to a plain task-file → launches detached
   `META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account --task-file <14tasks> --model anthropic/claude-haiku-4-5 --k 1 --parallel --enforce-resources --min-cpus 4 --cpu-budget 8 --mem-budget 16000 --max-agent-timeout 3600`
   → 14 v0 sessions land in `candidates/v0/score.json` stamped the new budget-identity. k=1 fits the ~1h window; bump `--k 2/5` later for a robust baseline.
2. **Sync** (`/mnt/d/tmp/rebaseline-v0-sync.sh`, run SEPARATELY after eyeballing the log): SURGICAL — `rsync -a` (NO `--delete`) of `candidates/v0/` + `config.json` from the `.meta-harness` store → `term-bench2/store/` snapshot → `git add term-bench2/store` → commit → push. Do NOT `store-sync.sh export` (a full `--delete` mirror → would drag the dead v2–v6 into the snapshot). Self-guards on v0 sessions > 0.
3. **At home:** `git pull` → `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json` → activate v0 (the active pointer + active playbook are host-local, NOT in the snapshot — activate separately on the home host).

**NEXT:** (a) a real loop `ab` — propose a NEW candidate vs the re-baselined v0 (same budget-identity → valid comparison); (b) re-run write-compressor SERIALLY to fill the 13/14 band hole; (c) seed/propose vendor content so routing does something; (d) the multi-model panel (needs a 2nd vendor model) to validate tags. [re-baseline + sync DONE — origin/main @ `2a8fda5`]

**Load-aware scheduler — increment #1 (capture+memorize) WIRED + COMMITTED + PUSHED (`e113f43` capture+memorize, `e0e6e7c` ab-path), tests green:**
- **Problem (user critique):** the bench packer (`scheduler.ts`, `d528ae5`) IS load-aware (`fitsBudget` sums per-task `cpus`≤budget) but packs on a STATIC declared int (task.toml default `cpus=1`); `--min-cpus 4` floors every task → on the 8-core box `--cpu-budget 8` degenerates to fixed width-2. A declared count is meaningless across P/E cores / hosts (and inside WSL2 the topology is invisible); most tasks are LLM-latency-bound anyway. Only in-env MEASUREMENT is ground truth.
- **Shipped (behavior-neutral — packer UNCHANGED, only collects):** `bench/cgroup.ts` `readCgroupStats` reads the container's OWN cgroup v2 (`/sys/fs/cgroup/cpu.stat usage_usec` + `memory.peak`) via `podman exec` just before teardown (mirrors `readSelfScore`; null on any fail). `bench/resource-profile.ts` MEMORIZES a per-task × per-host-class profile at `<metaRoot>/resource-profiles/<hostClass>.json` (`hostClass()` = `<arch>-<Ncpu>c-<model-slug>`; rolling window 5; `avgCpu = median(cpuSeconds/wall)` = sustained core-demand; `readResourceProfile` for the future packer). `SessionRecord` gains `cpuSeconds?`/`peakRssMb?`, threaded through `record.ts`; wired in BOTH `cmd-run.ts` (serial+parallel) AND `cmd-ab.ts` (memorizes BOTH arms A+B — a footprint is a task×host property, ~prompt-independent; stamps arm-B score too). tsc clean, **1250 pass / 0 fail** (+17). Live-verified against a real container. (Test-hygiene note: profile tests MUST isolate metaRoot — the cmd-ab harness sets `metaRoot=dirname(termBenchDir)`, which collapses to `os.tmpdir()` when termBenchDir is the tmpDir itself; other tests survive it via createCandidate reset, the profile store has none → `isolatedPaths()` nests termBenchDir.)
- **NEXT for this feature:** (i) increment #2 = flip the packer input `enforcedResources` declared-int → measured `avgCpu`, declared int + `--min-cpus` kept only as cold-start prior (needs profile data → run the loop with #1 live first); (ii) increment #3 = online wall-clock back-pressure. Capture now covers both run + ab paths. See [[load-aware-scheduler]].

---

## OFFICE PICKUP (2026-07-16 evening, MacBook session end)

**Everything pushed, `git status` clean, HEAD = `ce54fd3`.** Discipline first:
`git pull && term-bench2/store-sync.sh diff` (import only if drift — the
export-trap nearly fired again today on the stale MacBook store; that's twice).

MacBook session shipped today (details in sections below):
1. **Bench resource-scheduler SHIPPED DARK** (`d528ae5`) — see its section +
   the ⚠️ UNTESTED oauth-race block (user-flagged big issue).
2. Office-runnable pickups, any order:
   (a) **3-concurrent smoke** = the --parallel flag-flip gate — needs an
       ANTHROPIC_API_KEY in env; keyOnly mode is platform-independent, linux OK.
   (b) **oauth-race sandbox experiment** (defined in the ⚠️ block) — settles
       whether the key requirement is genuinely needed or over-strict.
   (c) **Loop-3 T6+T7 + pre-flip checklist** (the standing throughline) → then
       ONE combined re-baseline: recordTimeouts + --enforce-resources together.
3. Still pending a go (unchanged): Phase-0 SELF_CHECK_INSTRUCTION re-run;
   seed-corpus stays measure-first behind loop-1's ab.

## HOME SESSION pt 2 (2026-07-16) — Loop-3 COMPLETE · oauth-parallel SHIPPED+VALIDATED · T3 built · master DAG

Everything committed + pushed. HEAD `f37ec51` (see `git log`). Loop-2 stays inconclusive (v0 active). Recipe: the "oauth+parallel recipe" section above.

**Shipped (all pushed):**
1. **Loop-3 FUNCTIONALLY COMPLETE** (was T1-T5 dark) — T6 (`0c9f2be`, `/mh-activate` budget-identity gate) + T7 (`f598d08`, report-loop segmentation) + emission (`cc64dea`, ab+trial meta-metric events stamp the {maxAgentTimeout,timeoutRecording,resourceEnforcement} tuple → segmentation LIVE, proven by an integration test) + pre-flip (`da0e107`: per-task timeout-marker denominator via `SessionRecord.agentTimeout`, project-scope steer gate, clearer undefined-active toast). **`recordTimeouts` STILL default-OFF.** To flip: `config.json recordTimeouts=true` + re-baseline v0 (budget-identity change → T6/T7 handle it).
2. **oauth-parallel freshness gate SHIPPED+VALIDATED** (`0a823bd`+`ec3b31f`+`aeabef1`) — run `--parallel` on oauth, **NO API KEY**, safe by construction (no task runs across the ~8h token refresh → no auth.json race). = pre-flight (token must outlive one task; oauth+parallel REQUIRES explicit `--max-agent-timeout`) + scheduler `canLaunch` launch-guard (stops launching near expiry, graceful resolve, `--resume` continues) + oauth mount under parallel (`useKeyOnlyForParallel`: keyOnly only if key present). Validated LIVE 2-concurrent.
3. **`--min-cpus`/`--min-mem-mb` resource floor** (`f37ec51`) — generous per-task cgroup cap `max(declared,floor)` so `--enforce-resources` doesn't starve compute-heavy tasks. Default off = byte-identical.
4. **VALIDATION (live runs):** tune-mjcf + distribution-search (both loop-2 timeout-fails @600s) → **2/2 PASS serial @1800s**. Parallel @1-cpu-cap → 1/2 (distribution-search STARVED: 1367s+fail vs 446s serial). Parallel GENEROUS (`--min-cpus 4`, 8-cpu machine) → distribution-search recovered (196s+pass partial at handoff; **CHECK `term-bench2/results/validate-parallel-generous.json` for the full result**). LESSON: artificial resource limits (time OR cpu) → false fails → weaker loop signal; loop wants the loosest envelope that fits the machine. Loop-2's "no improvement" was partly a **timeout mirage**. USER DECISION: parallel + generous footprints.
5. **Self-hosting T3 BUILT** (`a39c1db`..`71216b0`) — `fleet/dag.ts` DagNode{id,task,deps[],files?,mutatesDeps?} + total validator + PLANNER_SQUAD + gate2-reuse. **DAG: T1+T3 built; T4/T5/T6sh/T2/T7sh/master planned.**
6. **oauth-race fully resolved+documented** — `oauth-parallel-race-research.md` + `auth-delegation-design.md` (UPDATED: freshness gate SUPERSEDES the old "surface don't handle / key-or-serial" decision).
7. **MASTER decomposed into a parallel task-DAG** (max-parallelism, expressed in the `fleet/dag.ts` TaskDag format = dogfood): **Wave0 (4∥):** gate-state · transport · frozen-gate · namespace. **Wave1 (3∥):** relay(gs,tr) · scheduler(ns) · reconcile(gs,ns). **Wave2:** daemon+CLI+E2E(all). Each node = a distinct `master/*.ts` file → no intra-wave conflict. Build-plan `docs/superpowers/plans/2026-07-16-master-build.md` (8 tasks), **4 open Qs** (masterRoot convention, inbound grammar, gateRoot provisioning, singleton-lock TTL) to settle before building.

**NEXT:** (a) check the generous-validation result; (b) settle master's 4 open Qs → execute master DAG **wave-0 as 4 parallel subagents** (distinct files, no worktree needed); (c) OR flip Loop-3 `recordTimeouts` + re-baseline v0 + a real loop `ab` run (parallel+generous, `--min-cpus 4 --cpu-budget 8`). grok-build = xAI leaf-agent coding TUI (possible future `--driver`, not orchestration prior-art).

---

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

## oauth+parallel recipe (2026-07-16 — NEW, no API key needed)

The bench can now run `--parallel` on your subscription oauth (no `ANTHROPIC_API_KEY`),
**safe by construction** — the freshness gate guarantees no task runs across the ~8h token
refresh, so the shared `auth.json` is read-only during the parallel window (no race).
Commits `0a823bd` + `ec3b31f` + `aeabef1`. **Validated live** (2 concurrent, oauth, 2/2 pass).

Also loosen the agent timeout: the loop-2 **600s cap was artificially clipping** tasks below
their declared budgets (tune-mjcf declares 900s, distribution-search 3600s) → false timeouts.
Run at the real budget.

```
# 1. fresh token (the gate refuses if it can't outlive one task; re-login if stale)
claude          # or: opencode auth login   (~8h TTL)
# 2. run parallel on oauth, no key — TB2-EXACT per-task timeouts (NO sub-TB2 cap):
#    vN must be a REAL, NON-ACTIVE version (else cmd-ab.ts:184 "nothing to compare")
bun term-bench2/runner.ts ab --layer account-global --candidate vN \
  --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
  --k 2 --parallel --enforce-resources --max-agent-timeout 3600 --resume
```
- **`taskTimeouts` (tasks.ts) ALREADY reads each task's exact TB2 `[agent]/[verifier] timeout_sec`**
  from `<tbRoot>/<task>/task.toml`; a `--max-*-timeout` flag only ever LOWERS it, never raises.
  So "take timeout from TB2" = set the agent cap AT OR ABOVE the split's per-task max, and OMIT
  the verifier cap. (TB2 agent budgets across the 89 tasks: 48×900, 17×1800, 12×3600, 1×7200, 1×12000.)
- `--parallel`+oauth REQUIRES an explicit `--max-agent-timeout` (freshness math). Set it to the
  split's MAX real TB2 agent budget — loop1 = **3600** (distribution-search) — so NO task is
  shortened below TB2; a ~8h token easily outlives 3600s. **Do NOT set it below TB2** — the old
  `1800` halved distribution-search (3600→1800).
- **No `--max-verifier-timeout`.** The verifier runs AFTER the agent and never touches the oauth
  token, so it needs no cap. Omit it → each task's exact TB2 `[verifier] timeout_sec` (up to 3600)
  is used. The old `300` STARVED nearly every verifier (TB2 verifiers are 900–3600s) — the real
  false-timeout source on heavy tasks.
- Self-limiting: as the token nears expiry the scheduler stops launching new tasks, lets
  in-flight finish, ends the chunk → re-login + `--resume` continues.
- Raising `--max-agent-timeout` (→3600) is a **budget-identity change** → Loop-3 T6/T7 re-baseline
  it (re-score the active version at the new budget first).
- With a static `ANTHROPIC_API_KEY` set, `--parallel` uses keyOnly (no token TTL → omit
  `--max-agent-timeout` entirely for fully-exact TB2 timeouts).

**VALIDATION (2026-07-16):** tune-mjcf + distribution-search (both loop-2 timeout-fails at
600s) → **2/2 PASS** at loosened timeout, serial AND 2-concurrent oauth+parallel. Loop-2's
"no improvement" was partly a **timeout mirage** (the artificial 600s cap), not harness
quality — validates Loop-3's thesis.

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

✅ **RESOLVED 2026-07-16 (home session): the oauth-race rationale is CONFIRMED,
not just assumed** — Anthropic's own tracker (claude-code #22600/#48786) + local
`~/.claude` `expiresAt` ≈ 8h show the refresh token is single-use, rotated on
refresh (~8h expiry, NOT per task), with no locking in CC or the harness → the
`--parallel` shared-credential race is real. DECISION recorded in
`docs/auth-delegation-design.md`: **surface, don't handle** — the `--parallel`
guard rejects oauth+parallel up front, user chooses serial (safe) or a static key
(keyOnly). The destructive live experiment is NOT needed (existence proven; a real
refresh would rotate + invalidate the live token). Now TESTED (`46131ec`: ab-guard
fires + keyOnly removes the race surface). The block below is the original OPEN
framing, kept for context.

⚠️ **(historical) the oauth-race rationale behind the --parallel key requirement was
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
