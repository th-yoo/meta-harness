# Enhancement Roadmap: "modest" → "promising"

Research-driven roadmap (2026-07-09) for the evolution loop described in
[evolution-loop.md](evolution-loop.md). Status: **planned, not yet implemented** —
phases are independently shippable and should land in order, Phase 1 first.

Sources researched: Lilian Weng, "Harness Engineering for Self-Improvement" (Jul 2026)
and its key citations (Self-Harness, ACE, GEPA, ShinkaEvolve, STOP, ADAS, DGM,
AlphaEvolve); ai-boost/awesome-harness-engineering; walkinglabs/awesome-harness-engineering;
walkinglabs/learn-harness-engineering; and the methods/eval-rigor literature
(digests below).

## Context

The evolution loop has sound plumbing (selection gate, promotion, TB2 `ab` referee, version store — branch fix-evolution-loop). An honest assessment identified six weaknesses that cap it at "modest":

1. **Noisy fitness signal** — pass@1 flips run-to-run; the 5-session trial gate and small-task `ab` runs select on noise.
2. **Prompt-rule-only search space** — the big levers (tools, context management, memory, workflow structure) are outside the evolution loop; generic behavioral rules have a low ceiling.
3. **Proposer lacks causal insight** — it pattern-matches truncated summaries, doesn't know *why* a task failed.
4. **Benchmark overfit** — account layers optimize against 43 fixed TB2 tasks with no held-out set (Goodhart).
5. **Prompt bloat** — monotonic rule accumulation dilutes/interferes.
6. **Sparse everyday signal** — solo-dev `/mh-score` volume too thin to drive project-layer evolution.

Goal: use what the field has learned to close those six gaps.

## Research digests

### A. Lilian Weng — Harness Engineering for Self-Improvement (digested, incl. 4 key citations)

**Central thesis — search-target progression:** `instruction prompts → structured context → workflow → harness code → optimizer code`. Each step = strictly larger search space, higher ceiling. meta-harness currently sits entirely at the leftmost node.

**Three design patterns:** (1) workflow automation (plan-execute-test-improve loops that analyze own trajectories); (2) filesystem as persistent memory (logs, diffs, traces as durable inspectable state); (3) sub-agents/backend jobs (parallelism explicit, outputs as files not context pollution).

**Named systems by search space:**
- Prompt-space: PromptBreeder (self-referential mutation), **GEPA** [2507.19457] (reflective NL diagnosis over trajectories + evolutionary search + Pareto frontier of candidates; beats GRPO by ~6-20% with **35× fewer rollouts**; beats MIPROv2 +12%), Self-Refine.
- Workflow: **ADAS** [2408.08435] (meta-agent programs agents in code), **AFlow** (workflow-as-graph + MCTS, beats ADAS).
- Harness-code: **STOP** [2310.02304] (self-improving improver; **caveat: loop degraded with weaker proposer models** — GPT-4 helped, GPT-3.5/Mixtral hurt), **Self-Harness** [2606.09498] (weakness mining → bounded minimal harness proposal → held-in AND held-out validation; **on Terminal-Bench-2.0 lifted MiniMax M2.5 40.5→61.9, Qwen3.5 23.8→38.1, GLM-5 42.9→57.1 via CODE changes, not prompt rules**), Meta-Harness [2603.28052] (the namesake — optimizing the optimizer's info storage/retrieval), DGM (evolvable harness repo).
- Evolution engines: AlphaEvolve (candidate pool + LLM diffs + **bounded edit regions**), **ShinkaaEvolve** [2509.19349] (sample-efficiency: parent sampling, **code-novelty rejection sampling** — don't re-evaluate near-duplicates, bandit LLM-ensemble; SOTA with 150 samples vs thousands).
- Context engineering: **ACE** [2510.04618] (context = *evolving playbook* of itemized bullets w/ IDs; generator/reflector/**curator** roles; **delta updates** not full rewrites — avoids "context collapse"; **+10.6% agents while cutting cost** — de-bloating raised accuracy), MCE [2601.21557] (evolve the context-management *mechanism*, separate from content).

**Eval rigor:** "p-hacking and eureka-ing … numerical duct tape … declare victory when signals are still noise" = exactly our 5-session gate. Reward hacking systemic: "if the reward comes from unit tests, the agent may overfit to tests." **"The evaluator and permission control should sit outside the loop that evolves harness, with held-out tests, trace audits, and human review at decision points that matter."** Self-improvement "works best when evaluation metrics are measurable and objective."

**What the post argues against that we currently do:** (1) prompt-rule-only optimization; (2) monotonic generic-instruction accumulation (named anti-pattern, contra ACE/Self-Harness); (3) tiny noisy fitness gates; (4) evaluator inside the loop / no held-out split; (5) fixed judge as dense fitness; (6) assuming the proposer is strong enough (STOP: weak proposer → net-negative loop).

### B. Awesome-harness-engineering repos survey — digested

**Reframing find:** both awesome lists are 2026 "harness-engineering-native" — the classic canon (DSPy/GEPA/ADAS/AlphaEvolve/Reflexion/Voyager) is absent; they index newer harness-specific analogues. **walkinglabs links "Harness Evolver" (github.com/raphaelchristi/harness-evolver) — an open-source reference implementation of the Meta-Harness paper (arXiv 2603.28052)** — this project's concept already has a public running implementation to learn from.

**Harness Evolver's design** (most applicable single artifact): six-agent loop Preflight → Analyze → **Propose** (edits code in isolated git worktrees; two waves: fresh + archive-branching from losers) → **Evaluate** (rubric-aware LLM judge, justification-before-score, few-shot calibration) → Select (**Pareto front** + constraint + **cost/latency efficiency gates** + stagnation detection) → Learn (cross-iteration consolidation) + a **Critic agent specifically detecting evaluator gaming** + TestGen (adversarial tests). Search space: prompts + tools (add/remove, retry logic) + retrieval architecture + actual Python code.

**Other unique systems:** SkillOpt (Microsoft — skill files as optimizable parameters, validation-gated updates → deployable best_skill.md); AIP (arXiv 2606.04781 — compile skill prose into execution graphs; Sonnet 53→67%); AutoHarness (DeepMind — synthesize runtime constraint-harness code from tool schemas); Life-Harness (adapt interface layers, transfers across 18 backbones); OpenHands trajectory critics (learned scores over trajectories for reranking + early stopping — improves the fitness signal itself); deepset failure-mode→harness-component classification; AgentDoG root-cause taxonomy.

**Eval-practice signal (neither list covers statistics per se, but):** **Anthropic "Quantifying infrastructure noise in agentic coding evals"** — on TB2, most- vs least-resourced setups differ **~6 percentage points (p<0.01)**, exceeding many model gaps; infra error rate 5.8→0.5% with headroom; **"leaderboard differences below 3 percentage points deserve skepticism"**; average across times-of-day/days; treat resource config as a first-class experimental variable. HAL leaderboard weights reliability + cost, not just accuracy.

**learn-harness-engineering curriculum:** harness = 5 subsystems (Instructions/State/Verification/Scope/Session-Lifecycle). Most relevant lessons: L04 **progressive disclosure** ("give a map, not an encyclopedia" — anti-bloat); L09/L10 verification-gated completion ("confidence ≠ correctness"; only full-pipeline runs count); L11+P06 observability + **ablation-based attribution** (measure each mechanism's effect); L13+P07 maker-checker separation + goal/timer loops.

## Comparison of approaches

Convergent findings across all three digests (independent sources agreeing = high confidence):

| Theme | Weng/citations | Methods lit | Awesome ecosystem | Verdict |
|---|---|---|---|---|
| Fitness noise | "p-hacking/numerical duct tape" | SD>1.5pp @ temp0; 2.2–6pp run swings; McNemar/bootstrap/sequential | Anthropic: ~6pp infra swing; distrust <3pp | **Unanimous: current gates select noise. Statistical gate = #1 fix** |
| Search space | progression thesis; Self-Harness +15-21pp on TB2 via CODE | ADAS/DGM/AlphaEvolve archives + bounded diffs | Harness Evolver/SkillOpt/AIP/AutoHarness all beyond prompts | **Unanimous: prompt-only = lowest ceiling. Widen to tools/context/workflow** |
| Proposer input | GEPA reflection; Self-Harness weakness mining | AGENTRX first-unrecoverable-step + taxonomy | deepset failure→component map; Learn stage | **Unanimous: full traces + root-cause diagnosis before proposing** |
| Held-out | "evaluator outside the loop" | "Harness Updating ≠ Harness Benefit" | Harness Evolver held-out pairwise | **Unanimous: disjoint held-out split, no-regression rule** |
| Anti-bloat | ACE playbook + curator (+10.6% while cutting cost) | ACE counters + dedup/prune; AWM/Voyager off-prompt libraries | L04 progressive disclosure; efficiency gates in selection | **Unanimous: curated playbook w/ prune ≥ append-only; consider off-prompt skills** |
| Human signal | humans at "decision points that matter" | calibrated verifier-grounded judge densifies | maker-checker approval gates on writes | **Consistent: human = gate/auditor, judge = dense signal (grounded, gamed-checked)** |
| Proposer strength | STOP: weak proposer → net-negative | same caveat | Critic detects evaluator gaming | **Use strong model for proposer; add gaming check** |

Divergence/notes: GEPA-style per-instance Pareto (keep candidates best on ≥1 task) vs single active-vs-candidate — literature favors Pareto archives for diversity; DGM parent-sampling ∝1/offspring for exploration. ShinkaEvolve novelty-rejection saves evals. Infra noise (resource config, time-of-day) is a *controllable* confound our bwrap sandbox partially tames — should still pin/document it.

### C. Methods literature (prompt/agent optimization + eval rigor) — digested

**Eval noise, quantified** ("On Randomness in Agentic Evals", arXiv 2602.07150, ~60k SWE-bench trajectories): single-run pass@1 shifts **2.2–6.0 points** run-to-run; **SD > 1.5 points even at temperature 0**. → our 2–3-point deltas are frequently pure noise; 5-session gates and small-task A/Bs select noise.

**Statistical toolkit to adopt:** paired same-task (same-seed where possible) comparison, never vs a separately-measured baseline; **McNemar's test on discordant pairs** for binary pass/fail on a shared task set; **bootstrap over tasks** for a CI on the pass-rate difference (accept only if CI lower bound > 0); **sequential / anytime-valid testing** (SPRT-style) + successive-halving to stop early and kill bad candidates cheaply; power analysis to size runs.

**Prompt optimization:** **GEPA** = reflective NL diagnosis over full trajectories + **per-instance Pareto frontier** (candidate survives if best on ≥1 task — preserves diverse partial wins, resists lucky-config collapse); MIPROv2 = minibatch + Bayesian optimization screening (good pattern, weaker proposer input); TextGrad = critique→targeted-edit concept; PromptBreeder = token-hungry, skip.

**Architecture search:** ADAS (meta-agent writes agents as code, archive); **DGM** (rewrites own harness repo; parent sampling ∝ performance and ∝ 1/(offspring count) for open-ended exploration; SWE-bench 20→50%; archive ablation stalls at 23%); AlphaEvolve (diffs to marked EVOLVE-BLOCK regions, evaluator cascade); ShinkaEvolve (embedding-cosine **novelty rejection** — don't spend evals on near-duplicates).

**Memory/anti-bloat:** **ACE playbook**: bullets = `(id, text, helpful_count, harmful_count)`; grow-and-refine = append OR update OR delete + embedding dedup + prune net-harmful; Reflexion (verbal reflection buffer); **AWM** (induce reusable workflows from trajectories, inject only relevant ones — +24.6/+51.1% rel. on web benchmarks); Voyager (executable skill library outside the prompt); ExpeL (contrast success-vs-fail trajectory pairs → inspectable insights).

**Failure analysis:** **AGENTRX** (executable constraints from tool schema + policy, step-by-step violation log, 9-category taxonomy, "**first unrecoverable step**"); AgenTracer + MAST taxonomy; counterfactual attribution (swap one suspect action, keep prefix — outcome flip = critical step). Generic LLM-as-judge is weak at step-level localization — must be grounded in verifier logs.

**Goodhart, named:** "Harness Updating Is Not Harness Benefit" (arXiv 2605.30621) — self-evolution gains are often overfit to the eval harness; mandates a held-out set fully disjoint from the loop + transfer testing.

**Their top-7 (ranked for solo-dev budget):** (1) sequential statistical gate (paired minibatch screen → survivors to full eval → McNemar/bootstrap acceptance); (2) proposer gets full failing trajectories + reflective root-cause step (GEPA/AGENTRX); (3) held-out no-regression split (Self-Harness recipe); (4) ACE counting-bullets grow-and-refine; (5) widen search space to tool descriptions + context policy first (bounded edits, archive w/ DGM parent selection); (6) verifier-grounded LLM judge to densify project-layer feedback (calibrated to human scores); (7) AWM/Voyager retrievable workflow library off the hot prompt.

## Comparison of approaches
TBD

## Enhancement roadmap (4 phases, each independently shippable)

### Phase 1 — Statistical gate + held-out split (ships first, alone; gates everything)

> **Status: IMPLEMENTED (2026-07-09).** `term-bench2/ab_stats.py` (+ `test_ab_stats.py`,
> 16/16), `splits.json` + `split make|rotate|show` + `load_active_split`, reworked
> `cmd_ab` (split-based, held-in-first futility, held-out arm-B never recorded, verdict
> schema v2), provenance `env` block (harnessHash/pluginSha/opencodeVersion/provider/
> maxAgentTimeout) on bench SessionRecords + verdict, and TS `AbVerdict` v2 +
> `abAccepted` gate + `/mh-status` + same-model `resolveTrial`. **Deferred:** the
> score.json concurrent-writer flock (from the Storage decision below) — the race
> loses ≤1 entry and is recoverable from per-session `traces/`; land it when a real
> concurrent-writer scenario appears.

**Honest power analysis (design constraint):** paired McNemar at ~20% discordance: 43 pairs detect ~14pp; 33 held-in × k=2 (66 pairs) ~11pp; k=3 ~9pp; a 5pp effect needs ~500 pairs (unaffordable). Consequence: single `ab` can't certify small wins → three-way `decision: accept|reject|inconclusive`; gate's job = reject regressions/noise cheaply, accept only large effects, surface CI to the human otherwise.

- **New `term-bench2/ab_stats.py`** (pure, no I/O, no scipy): `paired_run_stats(task_results) -> PairStats {n_tasks,n_pairs,b,c,delta,task_deltas}`; `mcnemar_exact_one_sided(b,c)` (binomial tail); `bootstrap_task_ci(task_deltas, n_boot=10k, alpha=.10)`; `futility_stop(b,c,tasks_done,min_tasks=12,net_behind=3)` (early-KILL only — no early-accept, no alpha inflation); `decide(held_in, held_out, cfg) -> (decision, reasons)`.
  - Pairing: unit = run-pairs (interleaved arm A/B run i of same task — already produced by cmd_ab). McNemar on run-pairs = screen; **bootstrap-over-tasks CI = confirmatory** (respects within-task clustering). Task-majority rejected (less power).
  - Accept iff: held-in `delta>0` AND McNemar p≤α(.05), AND held-out `delta ≥ -0.05` AND held-out not significantly worse.
- **Held-out split**: new checked-in `term-bench2/splits.json` — K-fold (4 folds) over baseline-tasks.txt, `activeFold` = held-out (10-11 tasks), rest held-in (32-33). **Rotate on acceptance** (one candidate judged on one fixed split). Held-out arm-B sessions NEVER written to score.json (proposer can never see them — evaluator outside the loop). New CLI: `runner.py split make|rotate|show`, `load_active_split()`.
- **cmd_ab rework**: default task source = active split (explicit --tasks = legacy mode, can never `accept`); held-in first (futility check per task), held-out only if not early-killed; `--k` default 1→2; new flags --alpha, --nonregress-margin, --min-tasks-before-stop, --no-early-stop, --split-file.
- **Verdict schema v2** (backward compat — all old fields keep semantics; `winner` derived from decision): adds `schemaVersion:2, decision, reasons[], split{}, heldIn{nTasks,nPairs,b,c,delta,mcnemarP,bootCI90}, heldOut{...}, earlyStopped`.
- **TS**: `AbVerdict` gains optional v2 fields + `abAccepted(v)` helper (decision==="accept" ?? winner fallback); `/mh-activate` gate switches to `abAccepted`; `/mh-status` prints decision+CI.

**Provenance & confound control (added 2026-07-09).** Model/variant tags are already
recorded per SessionRecord but nothing *uses* them — aggregates mix models, so a
model switch masquerades as a rule effect, and Self-Harness showed harness gains are
model-specific. Additions:
- `resolveTrial` compares **same-model sessions only** (trial sessions filtered to the
  model mix of the baseline; sessions from other models still recorded, just excluded
  from the gate). `ab` is already safe (both arms share one pinned model per run).
- SessionRecord + ab-verdict gain an `env` block:
  `{opencodeVersion, pluginSha, harnessHash (sha256 of the injected AGENTS.md/system
  text), maxAgentTimeout, provider}` — the infra-noise study's "config is a
  first-class experimental variable" applied to our records. `harnessHash` pins the
  exact rendered bytes (pins alone don't).
- Phase 3 note: ACE bullet counters should accumulate per-model (or the curator must
  see the model mix behind each counter) — rules can be model-conditional.

**Verify:** `test_ab_stats.py` unit tests (McNemar hand-values: b=6,c=0→p≈.0156; decide() truth table; futility boundaries); **null-candidate test** (candidate = copy of active → must NOT accept; noise-floor smoke); old-verdict back-compat; split partition/rotation mechanics; trial gate ignores sessions from a different model than the baseline mix.

### Phase 1b — Pin the proposer model (small, ships with Phase 1 or alone)

Today `triggerPropose`/`triggerPromote` create sessions with **no model specified** —
the proposer inherits whatever model the user happens to be running interactively.
STOP (arXiv 2310.02304) showed self-improvement loops go **net-negative with a weak
proposer** (GPT-4 helped, GPT-3.5/Mixtral hurt), so a daily-driver cheap model would
silently poison the loop. Pinning also removes proposal-quality variance (another
noise confound alongside Phase 1's fitness noise) and gives rule provenance.

- Config: `~/.config/opencode/.meta-harness/config.json` →
  `{"proposerModel": "anthropic/claude-opus-4-8", "proposerVariant": "high"}`;
  constant fallback in `propose.ts`. Read via a `readMhConfig()` helper in
  harness-store.ts.
- `triggerPropose` / `triggerPromote` (and later `triggerCurate`, Phase 3) pass the
  pinned model + thinking variant into `client.session.prompt` (verify the exact
  model-spec field in the opencode plugin API at impl time; fall back to
  session-create options if prompt-level model isn't supported).
- Stamp `proposerModel`/`proposerVariant` into candidate metadata
  (`candidates/vN/diagnosis.json` once Phase 2 lands; until then a
  `candidates/vN/meta.json`) — so regressions are attributable to a proposer change.
- Role/model policy: proposer/promoter/curator = pinned strong + high thinking
  (calls are rare — cost negligible); task agent under evaluation = the optimization
  target model (already pinned via `ab --model`); Phase 4 judge = pinned and ideally
  a *different* model from the proposer (anti-gaming).
- **Concrete pin (decided 2026-07-09): `anthropic/claude-opus-4-8`, variant `high`**,
  via the existing oauth subscription. Fable 5 rejected for this role despite higher
  capability: its cyber safety classifiers risk false-positive refusals on TB2
  security-flavored trajectories (feal-cryptanalysis, password-recovery,
  git-leak-recovery, model-extraction), its minutes-long turns collide with
  triggerPropose's 10-min waitForFile staging timeout, and it requires 30-day data
  retention at 2× the price. Sonnet 5 viable but wrong economy (STOP: weak proposer
  → net-negative loop; proposer calls are rare). The available OpenRouter key is
  reserved for: (a) the Phase-4 judge on a *different vendor* (cross-vendor
  judge ≠ proposer ≠ task-agent = strongest anti-gaming), (b) a provider-outage
  fallback proposer config (Anthropic degradation on 2026-07-09 stalled the loop).

**Verify:** /mh-propose with an intentionally cheap interactive session model →
proposer session logs the pinned model, not the session model; candidate metadata
carries proposerModel.

### Phase 2 — Trajectory persistence + causal proposer

Today run_opencode discards the NDJSON stream; proposer sees 200-char summaries.

- **Bench side**: `normalize_events(ndjson_text) -> list[TrajEvent]` ({"t":"tool",tool,args≤300,output≤800,error} / {"t":"text"} / {"t":"error"}); run_opencode returns events; bench_store gains `traj_path/write_trajectory/prune_trajectories(keep_failures=20, keep_passes=5)` → `candidates/vN/traj/<sid>.ndjson`. Write failures always, passes only with --save-all-traj (~3MB cap/candidate). Held-out trajectories never stored.
- **Plugin side**: `sessionTrajectory` buffer (cap 500 events, drop-oldest) fed from tool.execute.after + text.complete; on scoring write failures' trajectories to all 4 layers; TS mirrors of traj fns.
- **Reflective proposer**: `buildFailureExcerpts(storeRoot, version, {maxSessions:3, headEvents:5, tailEvents:30, cap 5KB/session})`; proposer prompt gains full failing-trajectory section + **mandatory two-stage output**: (1) `diagnosis.json` {failures:[{sessionID, taxonomy∈[wrong-plan,spec-misread,env-misread,tool-misuse,premature-termination,verifier-mismatch,resource-limit,flaky-infra], rootCause, firstUnrecoverableStep}]}, (2) system.md citing which diagnosis each rule addresses. Diagnosis stored at `candidates/vN/diagnosis.json`, surfaced to later generations + /mh-status. Soft-required first (warn if missing), hard later.

**Verify:** known-failing task run → traj file exists, valid, truncated; prune test (26 fakes → 20 remain); interactive fail + /mh-score bad → traj in 4 stores, buffer cleared; /mh-propose → diagnosis.json valid enum + prompt-size log under cap.

### Phase 3 — ACE playbook (anti-bloat)

- **Data model**: `playbook.json` = authoritative; **system.md becomes a rendered artifact** (render at write time → every existing reader unchanged = whole back-compat story). `PlaybookBullet {id, text, helpful, harmful, addedBy, status: active|pruned, timestamps}`. Render = active bullets as "- text" lines (ids/counters excluded from injected prompt; proposer sees full JSON).
- **TS fns**: readPlaybook/renderPlaybook/migrateSystemToPlaybook (counters 0)/applyPlaybookOps (ops: add|update|delete; delete = status pruned, audit-kept)/applyBulletAssessments. createCandidate + writeActive/activateCandidate/startTrial/resolveTrial carry playbook.json alongside (TrialState gains optional baselinePlaybook).
- **Proposer → editor**: when playbook exists, proposer outputs `ops.json` (≤3 ops) instead of whole system.md (legacy fallback kept). Counter attribution rides Phase 2 diagnosis: `bulletAssessments [{id, verdict: helpful|harmful}]` from failing-trajectory reflection (no uninformative per-session ++).
- **Curator**: `triggerCurate` + `/mh-curate [scope]` — LLM dedup/merge + prune (harmful>helpful && harmful≥2) + per-layer budget (25 active bullets). **Curation output = a candidate through the same gates** (trial / ab) — never a silent mutation. Progressive-disclosure render knob (top-N by helpful−harmful) default-off.

**Verify:** migrate round-trip (render(migrate(x)) ≡ normalized x); ops invariants; e2e propose→ops→rendered candidate→`--pin` injection unchanged (assemble_agents_md needs zero changes = the test); curate on seeded dupes/harmful → merged/pruned via trial; no-playbook store still works.

### Phase 4 — Widened search space + dense judge (sketch)

- Evolvable **env-snapshot policy** (`active/env-policy.json`, whitelisted knob schema only — EVOLVE-BLOCK pattern; rides normal candidate/trial/ab lifecycle).
- Evolvable **agent-config knobs** (`agent-config.json`: bash timeout default, permission mode) consumed by existing hooks.
- **Judge-based dense scoring** for project layers: judge scores sessions vs rubric + Phase 2 trajectory; shadow-mode calibration vs human /mh-score until ≥80% agreement over ≥20 sessions; then judge proposes + human approves (maker-checker; score.ts pre-fill = one-line change). Anti-gaming audit: replay judge on bench sessions with verifier ground truth, alarm on divergence. This is the proper fix for the noisy 5-session trial gate.
- **Explicitly NOT now**: full harness-code self-modification (unreviewable blast radius); DGM parent-sampling/Pareto archives (<100 candidates = pointless); embedding novelty rejection (LLM curator covers it at this scale).

### Cross-cutting observability — does the loop work?

Append-only `term-bench2/results/meta-metrics.jsonl`: {ts, event: ab|trial|activate|curate|rotate, layer, candidate, decision, heldInDelta, heldOutDelta, mcnemarP, activeBefore/After, splitFold, nPairs}. Writers in bench_store + harness-store. Reporter `runner.py report-loop`: held-out pass-rate trajectory over generations, accept/reject/inconclusive counts. Loop "works" iff held-out trend ↑ across rotations AND null-candidate accept rate stays ≈ α. `/mh-status` gains last-decision/generation summary.

## Storage decision (2026-07-09)

Plain files (md/JSON/JSONL) stay the source of truth — no SQLite. Rationale: scale is
KBs–MBs with no joins in any hot path; the project store is git-versioned (diff/blame/
revert of evolved rules for free); human inspectability is load-bearing for the
audit/maker-checker role; and files are the zero-dependency cross-language contract
between the TS plugin and the Python runner. The literature endorses the pattern
(filesystem-as-memory; the Meta-Harness paper stores candidates as files for
inspection). The one real gap — the concurrent score.json read-modify-write race —
gets the proportionate fix: atomic writes (already in place for verdicts) plus an
advisory flock around score.json updates, not a database. If analytics over
meta-metrics.jsonl/traces ever get annoying, mirror into DuckDB/SQLite as a derived,
read-only analysis layer — never as source of truth. Revisit triggers: >~50k session
records, routinely concurrent writers, or measurably slow stratified queries.

## Sequencing

Phase 1 → ship alone (immediately changes what /mh-activate accepts). Phase 2 before 3 (diagnosis.json is the substrate for bullet assessments; rework the proposer prompt once). Everything additive on disk; only semantic change = the activation gate (the point).

## Critical files

- `term-bench2/ab_stats.py` (new), `term-bench2/runner.py` (cmd_ab rework, split cmd, normalize_events, traj hooks), `term-bench2/bench_store.py` (traj fns, meta-metrics), `term-bench2/splits.json` (new)
- `opencode-plugin/src/harness-store.ts` (AbVerdict v2, traj API, playbook model), `propose.ts` (reflective prompt, diagnosis, ops proposer, curator), `index.ts` (gate switch, traj capture, /mh-curate, /mh-status)
- `docs/evolution-loop.md` (update after each phase)
