# Deep Research — Failure-Analysis + Workflow Optimization for Coding Agents (2026-07-20)

**Method:** deep-research harness (6 search angles → 28 sources fetched → 132 claims →
25 adversarially verified, 3-vote). **24/25 confirmed, 1 refuted, 0 unverified.** Nearly
all findings rest on peer-reviewed primary sources (ICML 2025, ICLR 2024, TACL 2024,
NeurIPS 2023, FSE 2025, ICLR 2026). Companion to `2026-07-20-next-direction.md` (the
synthesis + plan); this file is the full cited record (the workflow's raw output lives in
volatile `/tmp` — this is the durable copy).

## Question
SOTA techniques + academic research (2023–2026) for improving LLM coding agents through
**failure analysis** and **workflow/scaffold optimization**, as opposed to prompt-tuning —
scoped to our plateaued loop (propose→A/B-gate→activate tuning a supplementary playbook on
opencode+Haiku; 0 pass-lift over 3 iterations; remaining failures capability-bound or
"spec-precision"). Five sub-areas: (1) failure taxonomy / error attribution, (2) workflow vs
prompt, (3) self-improving agents & what they improve, (4) verification gap / spec-compliance,
(5) coding-benchmark SOTA ablations.

## Executive summary
Three convergent conclusions:
1. **Failure taxonomies are reusable and automatable as MODE classification (≈94%), but
   step-level "who/when/where" attribution is unsolved even for frontier models (~11–14%).**
   → do trace-level mode labeling + executable ground truth, not LLM step-pinpointing.
2. **On a fixed model, structural WORKFLOW choices move coding pass-rate far more than prompt
   tuning** (Agentless, DirectSolve CoT 9→32%, best-of-N reproduction-test selection +15).
   → directly explains our redundant-prompt-layer plateau.
3. **The "looks-done" verification gap is a named result** — intrinsic self-correction
   degrades without an oracle; the bottleneck is feedback *generation*, not refinement.
   → gate on external/executable ground truth; self-generated verifiers are gameable.

## Findings (verified)

### F1 — Reusable failure taxonomies exist + one ships a ~94% LLM-judge annotator (high, 3-0)
- **MAST** (arXiv 2503.13657, Berkeley/Stanford): 14 modes / 3 categories (system-design,
  inter-agent-misalignment, verification/termination); 1600+ traces / 7 frameworks,
  κ=0.88; category split 41.8/36.9/21.3%. Ships an o1 few-shot LLM-as-judge annotator at
  **94% accuracy, Cohen's κ=0.77** → scalable trace-level MODE classification without human
  labels. Caveat: inter-agent-misalignment (~37%) is inapplicable to a single coding agent.
- **TRAIL** (arXiv 2505.08638, Patronus): hierarchical 3-tier — Reasoning (hallucination,
  info-processing, decision/tool-selection, output-generation incl. formatting +
  **instruction-noncompliance**), System Execution (config, API, resource), Planning &
  Coordination. Built over GAIA+SWE-bench traces; the reasoning/output leaves transfer
  cleanly to a single agent and seed our "spec-precision" leaf.
- (Surfaced, unverified-tier: **ATLAS** — induces a 15–30-code taxonomy from the agent's
  OWN traces; **AgentErrorTaxonomy** — memory/reflection/planning/action/system.)
- Sources: arXiv 2503.13657, 2505.08638.

### F2 — Step-level attribution is unsolved even for SOTA reasoners (high, 3-0)
- **Who&When** (Zhang et al., ICML 2025 Spotlight, PMLR v267 / arXiv 2505.00212): 127
  annotated failure logs; best automated method **53.5% agent / 14.2% step**; o1 ~10–14%
  step, R1 ~3–7% step (some below random).
- **TRAIL**: best long-context model (Gemini-2.5-Pro) ~**11% joint** (category+location);
  GAIA joint — Gemini-2.5-Pro 0.183, o3 0.092, Claude-3.7 0.047, GPT-4.1 0.028; 3/8 models
  couldn't finish due to context limits.
- **Implication:** MODE classification reliable (~94%, F1); WHO/WHEN/WHERE localization not.
- Sources: PMLR v267/zhang25cq, arXiv 2505.08638, 2505.00212.

### F3 — Purpose-built attribution tools beat general reasoners + can close the loop (high, 3-0)
- **AgenTracer** (arXiv 2509.03312, ICLR 2026): counterfactual-replay + fault-injection
  annotation → TracerTraj dataset; **AgenTracer-8B** gives feedback that improves off-the-shelf
  multi-agent systems (MetaGPT, MaAS) by **4.8–14.2%**. Caveats: self-reported, unreplicated,
  math/reasoning (not coding), multi-agent.
- Source: arXiv 2509.03312.

### F4 — On a fixed model, WORKFLOW/scaffold structure drives coding pass-rate (high, 3-0 / 2-1)
- **Agentless** (arXiv 2407.01489, FSE 2025): non-agentic fixed 3-phase (localize→repair→
  validate), never lets the LLM choose next actions; **32.0% SWE-Lite (96/300, ~$0.70), 38.8%
  SWE-Verified (194/500)** — best open-source at publication.
- **DirectSolve** (arXiv 2505.08120): scaffolding-free long-context; CoT-decomposition +
  code-restatement took Gemini-1.5-Pro **9%→32%**; removing CoT alone → back to 9% (**23-pt
  structural lever**). Beat Agentless on same model +6% (2-1 vote; ~10× cost caveat).
- **Load-bearing unanimous point:** structural/workflow choices, not the supplementary prompt
  layer, own the large pass-rate movements → explains our plateau.
- Sources: arXiv 2407.01489, 2505.08120.

### F5 — best-of-N via self-generated reproduction tests = biggest lever; but verifiers are gameable (high, 3-0)
- **Agentless ablation** (SWE-Lite, 300): patch selection majority-vote 77 → +regression-tests
  81 (+4) → **+reproduction-tests 96 (+15)** — "the most significant performance improvement."
- **Reflexion** (NeurIPS 2023, arXiv 2303.11366): CoT generates + AST-filters unit tests,
  execution feedback drives retries; removing test-gen drops Rust 68%→52%.
- **False-positive risk:** in Reflexion, P(fails hidden test | passes ALL self-gen tests) =
  **16.3% on MBPP** vs 1.4% HumanEval → the looks-done/reward-hacking risk, quantified.
- **Consequence:** verifier as best-of-N SELECTOR, ground-truth acceptance SEPARATE from the
  agent's own tests, prefer executable over LLM verifiers.
- Sources: arXiv 2407.01489, 2303.11366.

### F6 — Intrinsic self-correction degrades; bottleneck is feedback generation (high, 3-0)
- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet"** (arXiv 2310.01798, ICLR 2024,
  DeepMind): intrinsic self-correction (no external signal) **degrades** accuracy (GPT-4
  GSM8K **95.5%→91.5%**; GPT-3.5 75.9%→74.7%); the prior +8.4 gain came entirely from an
  **oracle stop-signal** — remove it and the improvement goes negative.
- **Kamoi et al.** (TACL 2024, arXiv 2406.01297): no prior work shows successful self-correction
  from prompted-LLM feedback except tasks "exceptionally suited"; bottleneck = **feedback
  GENERATION, not refinement**.
- **This names our exact failure:** an agent self-verifying against its own interpretation
  rather than ground truth is unreliable and can make things worse.
- Sources: arXiv 2310.01798, 2406.01297.

### F7 — Self-correction works with reliable EXTERNAL feedback; scaffold loops lift a frozen model (high, 3-0)
- **Kamoi (TACL 2024):** effective specifically with reliable external feedback (code
  interpreters, simulation environments).
- **Reflexion (NeurIPS 2023):** verbal reflection stored in episodic memory ("not by updating
  weights") → **HumanEval pass@1 91% (+11 over the 80% GPT-4 SOTA)** on a fixed model. Caveat:
  uses self-generated tests + multiple trials (more inference compute) → F5's false-positive risk.
- Sources: arXiv 2406.01297, 2303.11366.

## Refuted
- "SOTA reasoners are strikingly inadequate at attribution, accuracy generally <10%" — **1-2,
  refuted** (overstated; Who&When agent-level reaches ~53%, AgenTracer-8B ~69% agent-level;
  it's STEP-level that's ~11–14%). Source: arXiv 2509.03312.

## Most transferable design lessons
- (a) Failure-taxonomy step = **trace-level MODE classification** (seed MAST single-agent modes
  + TRAIL reasoning/execution/output leaves; MAST LLM-judge ~94%/κ0.77) — NOT step-localization
  (~11–14%, unreliable).
- (b) Add a dedicated **spec-precision** leaf ("dropped literal spec value / self-verified
  against own interpretation") — TRAIL's instruction-noncompliance + output-generation seed it.
- (c) **Prefer WORKFLOW interventions over playbook prompt-tuning** — largest fixed-model coding
  gains are structural (Agentless phases, CoT decomposition, best-of-N test-guided selection).
- (d) Do **NOT** trust intrinsic self-verification; gate activation/retries on EXTERNAL/
  executable ground truth (intrinsic self-correction degrades without an oracle).
- (e) Verifier as a **best-of-N SELECTOR** (reproduction tests + regression tests + execution) —
  the single biggest ablated component.
- (f) Treat self-generated tests as **gameable** (16.3% MBPP FP); keep hidden/ground-truth
  acceptance SEPARATE; prefer executable over LLM verifiers; watch reward-hacking.
- (g) Add **requirement/checklist-extraction + literal self-check** that feeds execution
  feedback (Reflexion-style) — external feedback loops, not one-shot prompts, lift pass@1.

## Caveats
- **Part-3 scope gap (most important):** NO verified claim on the evolving-agent frameworks
  (DGM, ADAS, AlphaEvolve, Gödel Agent, GEPA, DSPy/MIPROv2, PromptBreeder, OPRO). Cannot say
  from verified evidence whether their gains are prompt-space vs workflow/module search, or
  whether they plateau on a strong base. The DGM search result asserts "gains from
  workflow/tools, not weights" (freezes model, self-modifies agent code) but didn't clear
  verification. **Needs a dedicated follow-up search.**
- **Multi-agent scoping:** MAST / Who&When / AgenTracer are multi-agent; a single opencode+Haiku
  agent maps only partially. TRAIL + Agentless/SWE-bench transfer more directly.
- **Time-sensitivity:** Reflexion 91% (2023), Agentless 32/38.8% (2024) are historical
  mechanism/magnitude evidence, not current leaderboard SOTA.
- **Self-reported/unreplicated:** AgenTracer's 4.8–14.2% is authors' own, math/reasoning, no
  coding eval.
- **Not directly measured:** no surviving claim quantifies the specific intervention we're most
  considering — requirement/checklist-extraction + literal self-check as an isolated component;
  its marginal pass@1 is inferred, not measured.

## Open questions (for follow-up)
1. Do DGM/ADAS/AlphaEvolve/GEPA/DSPy get gains from workflow/module vs prompt-space search, and
   do they plateau on a strong base? (Part-3 gap — dedicated search.)
2. Can a MAST-style ~94% trace judge reliably detect the *spec-precision* mode, or does it need
   executable checking? (Detection accuracy on this exact mode unmeasured.)
3. Marginal pass@1 of a dedicated requirement/checklist-extraction + literal self-check, isolated
   from generated-tests/execution feedback, on an already-capable agent?
4. What makes a verifier trustworthy enough to GATE a self-improving loop — combining executable
   + LLM verifiers, detecting reward-hacking of self-generated tests (beyond the 16.3% FP)?

## Primary sources
- arXiv 2503.13657 (MAST) · 2505.08638 (TRAIL) · PMLR v267 / 2505.00212 (Who&When) ·
  2509.03312 (AgenTracer) · 2407.01489 (Agentless) · 2505.08120 (DirectSolve) ·
  2310.01798 (Huang, ICLR24) · 2406.01297 (Kamoi, TACL24) · 2303.11366 (Reflexion) ·
  2504.07164 (R2E-Gym, COLM25) · github ATLAS · sakana.ai/dgm (DGM, unverified).
