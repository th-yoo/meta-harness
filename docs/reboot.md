# REBOOT — Gall's-law restart (2026-07-21)

**User decision (2026-07-21): restart the project on a Gall's-law basis.** We keep everything
*proven* (the lab), delete/ignore everything *unproven-by-running* (the design sprawl), and grow
the system one proven increment at a time. Standing values: **"I only value self improvable
agent"** + the distance-to-verdict rule (tooling freeze until a gated verdict).

## Why reboot (diagnosis, agreed)

Weeks in, zero demonstrated improvement. Root cause = **breadth-before-proof sequencing**: an
architecture city-plan (fleet/squad D1–D9, self-hosting, singleton master, Phase-4 riders,
credit-assignment groundwork) designed before any simple loop had ever produced certified lift —
a textbook Gall's-law violation ("a complex system designed from scratch never works"). Three
loop iterations ran on the wrong platform (haiku, capability-bound) while the decisive prior art
(AHE, #3 on TB2) sat unread on the leaderboard. Full technique inventory + evidence audit:
[`techs.md`](techs.md).

What survives the reboot (Gall: evolve from the simple system that WORKS — the proven kernel):
runner + podman bench, versioned store, `bench failure-taxonomy`, the McNemar gate machinery,
env-artifact forensics, the 10-task opus band. What is explicitly NOT carried forward as active
work: everything in [`explicitly-not-now.md`](explicitly-not-now.md) plus all fleet/self-hosting
build work (paper stays as reference).

## The loop (user's formulation, amended)

> 1. Pick task(s) from TB2.0 shown solvable by another Anthropic-LLM harness.
> 2. Pick ONE tech known-working (evidence-cited), prove it with the gate.
> 3. Goto 2 with the next tech.

**Amendment (adopted):** the proof unit is a SMALL BAND (2–3 tasks), not a single task — our own
openssl episode proved single-task/small-n "lift" is variance+artifact (0/2→1/2, discarded), and
single-binomial power math makes one-task proof *expensive*, not simple (~20 trials/arm for a
0.3→0.7 shift). Step-1's "another Anthropic harness solves it" = an **achievability certificate**
(wozcode ≥80%) that structurally excludes the capability-bound trap; success labels age safely
across model versions (failure labels don't — 6 of 26 leaderboard "fails" were opus-4.8 aces).

## The kernel — component definitions & roles

| Component | What it is | Role in the loop |
|---|---|---|
| **runner** | `bun term-bench2/runner.ts` (code: `opencode-plugin/src/bench/`) — CLI with subcommands `run / ab / oracle / failure-taxonomy / report-loop`. Spawns one podman container per trial, stages the task, injects the harness, drives the agent + verifier, records outcomes. | The experiment executor. Produces every reward bit the loop reasons about. |
| **store** | `.meta-harness/global/` (host-local; committed snapshot at `term-bench2/store/`): versioned candidates `v0…vN`, each = `system.md` (rendered harness) + `playbook.json` (authoritative bullets) + `score.json` (per-session pass/fail) + `traj/*.ndjson` (trajectories, recency-capped ~20 failures) + `taxonomy.json`. One `active` pointer. | The agent's evolvable memory + full provenance. A "version" of the agent = a store candidate. Lessons live here as playbook bullets. |
| **band** | Task subset where the CURRENT model+harness scores `0 < pass < 1` (measured, e.g. `splits/opus-band.txt` from the k=3 screen). Aces (k/k) = regression guards; 0/k = excluded (no signal). | Defines WHERE improvement is measurable. Band trials generate the discordant pairs the gate feeds on; guards catch regressions. |
| **taxonomy** | `bench failure-taxonomy`: for each FAILING stored trajectory, a host-side LLM judge (locked-down `mh-judge` persona, no container) receives instruction + trajectory (as untrusted data) + the verifier verdict the agent never saw, and must output `mode / failure_point / root_cause / general_mechanism`. Aggregated to `modeCounts` in `taxonomy.json`. | The diagnosis step — converts raw failures into a dominant failure MODE + structural fix candidates (`general_mechanism` = the lesson feedstock). |
| **gate** | The `ab` machinery + verdict rule: paired trials candidate-vs-active on identical tasks, McNemar on discordant pairs, plus guard non-regression (and, from loop-2, held-out generalization). Pass → `activate` new version; fail → reject, keep old, record verdict. | The proof step — no edit enters the agent without statistical evidence it helps and doesn't harm. Gall's "works" check, made executable. |
| **forensics** | Post-run audit before any statistics: grep run log for `authentication error`; classify every `turns=0` trial by elapsed signature (≈0s = setup/env artifact → EXCLUDE task; <60s = suspected auth-race → strip + re-roll; ≈timeout = genuine, keep); check `setup_failed` errors. | The contamination filter — keeps fake labels (env bugs, auth races) out of band/gate math. Caught 2/26 fake labels in the Cat-A screen. |

## Mechanics — loop-1 end-to-end flow

*(tmux wraps the RUNNER process — ops rule after the setsid silent-kill incident; the task
reaches opencode via container staging, not via tmux.)*

**Phase A — baseline arm (store-writing, active = v7):**
1. Operator: `tmux new-session -d -s loop1 "bun term-bench2/runner.ts run --layers account --task-file <3-task file> --k 10 …"` (NO `--results-file` → store-writing mode).
2. Runner's scheduler packs trials to width (`cpu-budget / min-cpus`, `--no-pack-measured`); host-pressure gate pauses new launches if load spikes.
3. Per trial: runner `podman create/start`s a fresh container from `localhost/mh-bench:latest` with auth mounts only (oauth credentials + opencode config + shared opencode data dir; NO task-repo or store mounts — env-fidelity).
4. Staging: task files (instruction, fixtures, setup) are copied INTO the container via `podman cp`; task setup script runs (apt deps etc. — where the qemu netcat bug lived).
5. Harness injection: `assembleAgentsMd` renders the ACTIVE store candidate (v7's playbook/system.md) → written into the container as `AGENTS.md` — **this is the only channel a lesson travels**.
6. Agent phase: runner execs `opencode run` inside the container (model `anthropic/claude-opus-4-8` via oauth, timeout 3600s, ≤4 retry attempts on transient/auth). opencode reads AGENTS.md + instruction, works the task.
7. Verifier phase: runner copies the task's tests in and runs the verifier (its own timeout) → **reward 0/1**. The agent never sees this verdict.
8. Teardown + record: cgroup stats (best-effort), `podman rm`, auth-mount cleanup; session appended to v7's `score.json` + trajectory written to `traj/` (prune keeps last ~20 failures).
9. After all 30 trials: **forensics audit** (step definitions above) → clean baseline table.

**Phase B — diagnose + edit:**
10. `bench failure-taxonomy --candidate v7 --model anthropic/claude-opus-4-8` → host-side judge classifies each failing trajectory → `taxonomy.json` (modes + general_mechanisms).
11. Distill ONE lesson from the dominant mode (near-verbatim from `general_mechanism`) → `createCandidate v8 = v7 + one playbook bullet` → `activate v8`.

**Phase C — candidate arm + verdict:**
12. Same as Phase A but active = v8: 3 tasks × k=10 + guards (2 aces × k=3). Lesson now rides in AGENTS.md (step 5) — the only difference between arms.
13. Forensics audit again.
14. **Gate**: pair v8-vs-v7 trials per task → discordant counts → McNemar; guards must not regress. Pass → v8 stays active (first certified self-improvement). Fail/null → reject, v7 restored, verdict recorded (provable null).
15. Surgical-sync v7/v8 snapshots (`score.json`, `taxonomy.json`, playbook) into `term-bench2/store/` + commit; write verdict into this doc.

## Loop-1 task pick (2026-07-21, data-driven — token/time budget is the binding constraint)

Selected from the measured opus band (`term-bench2/splits/opus-band.txt`,
`term-bench2/rebaseline/opus-A-20260721.final.json`) on trial-cost × lift-room × mode-family:

| Task | Baseline (k=3) | Mean trial | Rationale |
|---|---|---|---|
| **sparql-university** | 1/3 | **90s** (cheapest in band) | Max lift-room; 3/10→7+/10 at k=10 = unmistakable demonstration |
| **financial-document-processor** | 2/3 | 116s | Near-flip; literal field/format requirements = spec-precision/looks_done family (the lesson tech's best-evidenced class) |
| **sanitize-git-repo** | 2/3 | 148s | Near-flip; rule-compliance per literal criteria — same mode family |

**Built-in bet:** all three are precision/rule-compliance-flavored → plausibly one shared failure
mode → ONE lesson lifts ≥1 visibly (the user's requirement: at least one task must *show* the
agent improved).

**Rejected on data:** mailman, path-tracing-reverse (3600s timeout tails = budget bombs);
query-optimize (704s ≈ 6× sparql per trial); build-pmars, cancel-async-tasks, polyglot-rust-c
(2–4× cost) — **reserved as the loop-2 held-out set** (budget cut converted into design win).

**Guards:** configure-git-webserver + count-dataset-tokens (cheap aces, k=3 each) — regression
check, the anti-AHE edge.

## Loop-1 protocol (~2 hr wall, ~75 trials total)

1. **Baseline arm**: store-writing run (NO `--results-file`) under active **v7** (byte-identical
   to v0; recreate from the committed snapshot per [`resume.md`](resume.md) recipe), 3 tasks ×
   k=10 — captures opus failing trajectories + gate-grade baseline. tmux only.
2. **Taxonomy**: `bench failure-taxonomy --layer account-global --candidate v7 --limit 20
   --model anthropic/claude-opus-4-8` → modes + `general_mechanism` per failure.
3. **ONE lesson** distilled from the dominant mode → **v8 = v7 + one playbook bullet** (single
   component edit, nothing rewritten).
4. **Candidate arm**: activate v8, same 3 tasks × k=10 + guards k=3.
5. **Verdict**: McNemar on ~30 pairs + per-task deltas + guard non-regression. Post-run audit
   before any math (auth-race grep, turns=0/elapsed forensics, setup_failed check).

**Honest limits, stated in advance:** (a) all 3 tasks are lesson-source (held-in) — loop-1 buys
*demonstration + guards*, NOT held-out generalization (that's loop-2 on the reserved tasks);
(b) ~30 pairs detects large effects (~20pp+); smaller true lifts may read null — a null here is
a provable "no large effect", which is still the differentiating claim (AHE cannot prove null).

## Tech queue for step-3 iterations (each evidence-cited, one at a time)

1. **Memory lesson (taxonomy-distilled)** — loop-1, running. Evidence: AHE ablation winner + our
   detection validation.
2. **AgentConfig knobs** (timeouts/budgets rider — machinery shipped in Phase 4). Evidence: our
   timeout-mode data (haiku v3: incomplete 13/19; opus band timeout tails).
3. **Verify/self-check workflow variants** (best-of-N with self-generated repro tests). Evidence:
   deep-research (best-of-N +15pp; workflow > prompt on fixed model). Deferred until 1–2 prove
   or null out.

Each iteration: same protocol, next tech, one component, gated. Complexity only ever enters
through a passed gate — Gall's law with statistics.

## LOOP-1 VERDICT (2026-07-21, sparql-university only per user scope-cut) — PROVABLE NULL, rich diagnostics

**Arms:** v7 (baseline) 3/10 · v8 (= v7 + lesson bullet b7, +290 bytes, only delta) **2/10**.
No lift; guards aborted as moot (null → no adoption → nothing to protect; token budget).
v7 re-activated (rollback). Falsify_if fired as pre-registered.

**Decisive instrumentation findings (why this null is worth its cost):**
1. **Actuator weakness proven:** 7/8 v8 failing trajectories never used ORDER BY and carried
   zero lesson language — the advisory context bullet was largely IGNORED by opus one-shots.
   AHE's "system-prompt prose doesn't transfer (−2.3pp)" reproduced in miniature under OUR gate.
2. **Diagnosis uncertainty:** the single lesson-compliant trial (added ORDER BY) still failed —
   ORDER-BY may be necessary-but-insufficient or wrong.
3. **Proposer A/B (same v7 data, both prompts, neutral transport):** existing-agentic found the
   deep candidate cause (nondeterministic output vs exact-match grader) via UNPROMPTED pass-vs-
   fail divergence comparison; candidate-taxonomy prompt produced a disciplined but shallower
   lesson; ENHANCED candidate prompt on the same starved input STILL missed it → **divergence
   evidence is load-bearing for diagnosis, doubly proven**. Enhanced prompt also abstained
   correctly on empty evidence and independently flagged bullet b5 as followed_harmful
   (converging with the agentic run — credible credit-assignment signal).

**Loop-2 implications (ranked):**
1. Persist PASS-side trajectories for band tasks + taxonomy-v2 divergence analysis (storage
   change + judge upgrade) — the diagnosis bottleneck.
2. Actuator escalation is now evidence-backed: advisory prose gripped 1/8 — next candidates =
   binding actuators (middleware/finish-hook forcing the contract check — AHE's middleware
   cleared ALL Easy; or verify-workflow), NOT more prose lessons. Rule-9/actuator-switch
   fires: looks_done mode + lesson attempt + null → switch component level.
3. Verify A's ORDER-BY theory cheaply before any next candidate: read the grader
   (term-bench-2 sparql-university verifier) — desk check, zero trials.

**Cost of loop-1:** ~26 opus trials (10+10+6 aborted guards/partials) + ~12 judge/proposer calls.
Bought: first gated verdict in project history, actuator-grip instrumentation, divergence-input
proof, credit-assignment convergence on b5. The lab works; the first arm swung and missed;
the miss is measured, attributed, and rolled back. That IS the self-improvement loop operating.
