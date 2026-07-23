# AHE (Agentic Harness Engineering) — prior art + what we adopt (2026-07-20)

**AHE** (arXiv 2604.25850, repo `china-qijizhifeng/agentic-harness-engineering`, MIT) is the
closest prior art to this project: **automatically evolves a coding agent's harness with the
base model FIXED**, on **Terminal-Bench 2** (our benchmark), ranked **#3 (84.7%, GPT-5.5)**;
paper campaign **69.7 → 77.0%** over 10 iterations on GPT-5.4. It both **validates our
direction** and **reshapes our first component**. Extracted from paper + code; this is the
durable capture (repo was a volatile `/tmp` clone).

## How AHE works
Base model fixed; evolve the **harness** = 7 git-tracked, file-level components (NexAU):
`system_rules, tool_descriptions, tool_implementations, middleware, skills, sub_agents,
long_term_memory`. Loop `evaluate → analyze → improve`, three observability layers:
- **Component** (git-tracked, revertible edits) · **Experience** (Agent Debugger: ~10M-token
  traces → sourced root-cause reports) · **Decision** (Evolve Agent: evidence-backed edits +
  predicted impact, falsified next iteration).
- The **trace, not the pass rate, is the unit** everything operates on.

**Improve = a falsifiable four-field edit contract** (`change_manifest.json`,
`evolve_prompt.md:201-218`; schema `change-manifest-schema.json`): each change carries
`failure_pattern`, root-cause `description`, `files` + `constraint_level` (one component),
`predicted_fixes[]`, `risk_tasks[]`, `why_this_component`. One iteration later
`evaluate_changes` (`evolve.py:2239-2329`) does set-intersection:
`actually_fixed = predicted_fixes ∩ diff.flipped`; `risk_realized = risk_tasks ∩ diff.regressed`;
5-way verdict HARMFUL/MIXED/EFFECTIVE/PARTIALLY_EFFECTIVE/INEFFECTIVE, plus
`unattributed_regressions` = collateral the proposer never named.

## Ablations — what moved the needle (paper §4.4.1, Table 3; NexAU0 seed = 69.7%)
| + component only | pass@1 | note |
|---|---|---|
| **memory** | **75.3** | best on Hard (+11.6); 12 boundary-case lessons |
| tool (1364-line shell) | 73.0 | best on Medium; auto-surfaces contract hints |
| middleware (risk-hints) | 71.9 | cleared ALL Easy; finish-hook + risk hints |
| **system-prompt** | **67.4** | **REGRESSES −2.3pp** |
| AHE full | 77.0 | |
- **"Prose-level strategy alone regresses; factual harness structure transfers."**
- **Non-additivity:** singles sum +11.1pp, full nets +7.3pp — components that all push
  "closure verification" INTERFERE (spend turns on redundant re-checks). memory-only *beats*
  full AHE on Hard.
- **Transfer:** frozen harness → SWE-bench-verified (best aggregate, −12% tokens vs seed) +
  cross-model +5.1–10.1pp → components encode general engineering experience, not tuning.
  (Caveat: step-budget fitted to GPT-5.4 → cross-model conflates portability w/ operating point.)

## The verify-retry finding (reshapes our spec)
AHE **ships** our exact adversarial-verify→retry as `middleware/ralph_loop.py` (intercept
`complete_task`, block if no passing verification, ask agent to write+run tests, `max_blocks`)
— **and evolution REJECTED it.** The winning 77% harness converged on softer *"mirror the
evaluator"* prompt discipline + a risk-hint middleware. Why: *"the agent's self-written test is
itself a proxy (the very failure class the debugger flags), so gating on it adds turns without
adding evaluator-isomorphism."* The dominant failure class AHE names is **"proxy validation
instead of evaluator-isomorphic validation."**

## AHE's own #1 limitation = our gate's win (paper §4.4.2, Fig 4)
AHE measured its attribution: fix precision **33.7%** / recall **51.4%** (~5× random), but
regression precision **11.8%** / recall **11.1%** (~2× random). *"The agent can justify why an
edit should help, but it cannot reliably name the tasks the same edit is about to break…
Closing this gap is the clearest direction for future self-evolution loops."* AHE attributes by
single-run set-membership on k=2 with **no significance test** and blindness to unnamed
collateral. **Our McNemar + held-out statistical gate is exactly that fix** — task-name-
agnostic over the whole held-out set, catches regressions the proposer never predicted. This
is our validated edge over the #3-on-TB2 system.

## Decisions for our project (2026-07-20)
1. **Base agent → Opus 4.8** (was haiku): capability-bound haiku had no harness-fixable
   headroom; AHE's gains came on a strong model where failures are scaffolding-fixable. TB2
   stays hard enough for signal.
2. **First evolvable component → memory (boundary-case lessons) + risk-hints middleware**
   (AHE's ablation winners); **NOT** verify-retry (their equivalent lost) and **NOT** prompt
   (regressed).
3. **verify-retry / workflow-graph → deferred**; revisit only if our taxonomy shows a
   spec-precision fraction memory/risk-hints don't cover — and then the verifier checks the
   LITERAL contract (evaluator-isomorphic), never a proxy.
4. **Keep our statistical gate** (McNemar + held-out + sentinels + budget-identity) — the edge.
5. **Adopt:** the four-field predict-and-falsify contract as **inputs to gate power +
   proposer-calibration measurement** (their Fig 4), NOT as the attribution; one-component-
   per-edit; k≥2 rollouts (pass-rate not a bit); minimal seed (a benchmark-fitted seed
   contaminates attribution).
6. **Component 1 taxonomy = AHE's Agent-Debugger method**: root-cause prompt (FAILURE POINT /
   ROOT CAUSE [thought-it-passed vs errored] / WHAT SHOULD / GENERAL MECHANISM, not
   task-specific); feed the verifier's real output the agent never saw + force
   cross-referencing; compare pass-vs-fail rollouts of the same task.

## Interference caution (must design around)
If we later stack memory + risk-hints + a workflow verifier, AHE predicts they converge on the
same "closure verification" and interfere (their +11.1→+7.3 ceiling). **Gate components
against EACH OTHER on held-out, not just each against baseline.**

## Key files (in the clone, for future reference)
`evolve.py` (loop 4145-4638, attribution 2239-2329, diff 830-914, ADB prompts 1103-1157) ·
`agents/evolve_agent/evolve_prompt.md` · `change-manifest-schema.json` ·
`agents/evolve_agent/middleware/ralph_loop.py` (the rejected verify-retry) ·
`experiments/evolved_harness/{systemprompt.md, LongTermMEMORY.md, middleware/execution_risk_hints.py}`.

## 2026-07-21 ADDENDUM — paper read (arXiv 2604.25850v4, 18 May 2026), repo-doc verified

All numbers in this doc confirmed against the paper. NEW decision-relevant findings:
1. **Debugger compares pass-vs-fail rollouts of the SAME task** ("partial-pass tasks are the most
   valuable... find the divergence point"). Our taxonomy reads failures only → taxonomy-v2 upgrade:
   divergence-point analysis on band tasks (we have both sides at k≥2).
2. **Memory lessons HURT Easy tasks** (superfluous re-verification; components non-additive:
   single-component sum +11.1pp vs full +7.3pp) → ace guards are load-bearing, not decoration.
3. **Evolve prompt verbatim (Appx B.2)** + manifest schema {failure_pattern, predicted_fixes,
   risk_tasks, constraint_level, why_this_component}; safety rules incl. "do NOT reverse-engineer
   test cases from trajectories" and **"LLM Config Hands-Off Rule"** (config changes cause broad
   hard-to-diagnose regressions — tempers our AgentConfig queue item).
4. **Cross-benchmark transfer weak** (SWE-bench +0.4pp, tokens −12%); cross-model strong
   (+5.1..+10.1pp, larger further from saturation).
5. **No statistical testing anywhere** (k=2, mean pass@1) — the gate gap is real. Fig 4:
   fix-precision 33.7%/recall 51.4% vs regression-precision 11.8%/recall 11.1%.
6. Anti-pattern rule for the proposer: same failure class persists 2+ iterations at one component
   level → rollback + re-approach from a DIFFERENT component level.
7. Their case study trajectory #1 = db-wal-recovery (our 0/3 fail) — §C.1.1 directly readable for loop-2.
8. Name-twin located: "Meta-harness: End-to-end optimization of model harnesses" (Lee…Khattab,
   Finn), arXiv 2603.28052 (their ref [16]).
Setup parity notes: k=2 rollouts, 1hr per-task timeout, timeouts-count-as-failures, minimal seed
to protect attribution — all match our conventions independently.

## 2026-07-23 ADDENDUM — Appendix A Table 4 (hyperparameters; HTML-only, PDF has no appendices)

Config snapshot of the reference run (all agents GPT-5.4): Code Agent = reasoning high,
**temperature 0.7, top-p 0.95**, 200k ctx, 32k/turn, 300 turns. Evolve Agent = xhigh, temp 0.7,
500 turns, 3 skill packages, compaction 0.75. Debugger = 16 concurrent, 600s/task, 3 retries.
Explore = xhigh, 60min, 10 web + 1 code source. Outer loop = 10 iterations, k=2 rollouts,
96 concurrent, E2B sandbox 3600s lifetime, TB2 89 tasks.

Temperature IS explicitly set (0.7) as a human-chosen fixed operating point — the Evolve Agent
just can't EDIT it (read-only LLM config, §3.3). Their per-rollout stochasticity at temp 0.7 with
only k=2 is all the signal their (statistics-free) loop gets. Fetch recipe: appendices exist only
in the HTML render (`arxiv.org/html/2604.25850v4`); the arXiv PDF is main-text-only (10 pages).
