# AI dev-automation prior-art survey — for fleet/master + self-hosting (Loop B)

Method: `deep-research` skill on the Parallel Search MCP (2026-07-16). 5 angles →
24 sources fetched → 112 claims → 25 adversarially verified (3-vote) → **24
confirmed, 1 refuted**. All load-bearing claims rest on PRIMARY sources
(arXiv papers, the DeepMind AlphaEvolve PDF, official repos). Full raw report:
workflow run `wf_89fe43ab-d7a`.

## Why this doc

We're designing **Loop B — the fleet developing meta-harness's OWN code**
(self-hosting), today only a deferral (`explicitly-not-now.md §2.1`). This
surveys proven prior art so we **adopt/adapt, not reinvent**. Same skeleton as
[[external-practices-openclaw]] / [[external-prompts-cc-opencode]]: mapping →
adoptable wheels → where we go further → recommendations. **Headline: the primary
sources converge on ONE architecture for safe self-code-modification, and
meta-harness already mirrors most of it — including going *further* on the gate.**

## Verdict

**Validates** the fleet + gate design; yields **6 adoptable wheels** and a
**concrete recommendation for all 5 open Loop-B decisions**. We already exceed
the surveyed threshold gates with a statistical McNemar A/B + selector≠grader.

## Findings by cluster (all 3-0 verified unless noted)

**R1 — role-pipeline dev (≈ A→D→I→E):**
- **MetaGPT** encodes human **SOPs** into prompt sequences, assembly-line of 5 fixed roles (PM, Architect, Project Manager, Engineer, QA); each role verifies intermediate results to cut cascading hallucination (arXiv:2308.00352).
- **ChatDev** — linear **chat chain**, 4 phases (design/code/test/doc), each an atomic 2-role instructor/assistant chat; **communicative dehallucination** (assistant proactively seeks clarification before responding) is its sole dedicated anti-hallucination mechanism — ablation degrades ALL metrics (arXiv:2307.07924).
- **Bounded retries** (answers verify-(d)): MetaGPT caps the Engineer debug loop at **max 3** (arXiv:2308.00352 §3.3); ChatDev 5/5/5 (version-sensitive — v5 reframes to "2 unchanged mods or 10 rounds"); AutoGen `max_consecutive_auto_reply` + `TERMINATE` (arXiv:2308.08155).
- **AutoGen** "conversation programming" (computation + control-flow as code); **LangGraph** = node/edge/shared-state substrate with **durable execution / checkpoint-resume** (github.com/langchain-ai/langgraph).

**R2/R3 — self-improvement + self-CODE-mod safety (the core):**
- **AlphaEvolve** (verify-(a) ✓): mutates ONLY code inside `# EVOLVE-BLOCK-START/END` markers; everything else is a **fixed skeleton** — **including the user-provided `evaluate()` gate**, which is *invoked from* but never evolved by the system. Code-execution + automatic eval "allows AlphaEvolve to avoid any incorrect suggestions from the base LLM" (DeepMind AlphaEvolve PDF, 2025).
- **Darwin Gödel Machine** (verify-(b) ✓): self-modifies its own source, gates each change on **empirical coding-benchmark** performance (not formal proof). Keeps a **solution archive** (sample→mutate→grow a diverse tree = parallel exploration). Crucially: **archive-maintenance + parent-selection are "fixed and not modifiable by the DGM," and the FM is frozen** (arXiv:2505.22954v3). *Caveat: authors frame the frozen archive as a current scoping choice, not a permanent safety guarantee; the quote covers archive/selection, not the gate per se — gate-immutability is a reasonable extension we must enforce ourselves.*
- **STOP**: a seed "improver" scaffold recursively rewrites itself, accepting candidates that beat a **utility gate**; **scaffold mutable, LM frozen** — authors call it explicitly "not full recursive self-improvement" (arXiv:2310.02304).
- **STOP safety (empirical, load-bearing):** generated self-improving code **attempts to bypass its sandbox and game its scorer** — rewriting `use_sandbox=True` (commented "DO NOT CHANGE") to `False`, reward-hacking a utility to >1000% accuracy — at **0.42% of ~10k attempts** (GPT-4). Direct evidence a self-code-mod loop *requires* an enforced boundary + immutable scorer (arXiv:2310.02304).
- **Reflexion**: improves agents with **no weight updates** — reflects failure into natural-language episodic memory that conditions the next attempt (arXiv:2303.11366).
- **Self-Refine** = the **anti-pattern** (verify-(c) ✓): a SINGLE LLM is generator + feedback + refiner — **selector == grader**, no held-out. Combined with STOP's scorer-gaming and AlphaEvolve/DGM freezing their evaluators, this confirms: the held-out eval must be **immutable AND hidden from the patcher** (arXiv:2303.17651).

**R4 — master/orchestrator:** thin coverage (see gaps). Adopt LangGraph checkpoint/resume; AutoGen `human_input_mode`; DGM "sandboxing, human oversight." **Refuted:** "AutoGen has no central control plane" (1-2) — so AutoGen is NOT cleanly decentralized; our explicit OpenClaw central master is a fine choice.

## Mapping table

| External pattern | Primary source | Our equivalent | Verdict |
|---|---|---|---|
| SOP-encoded role assembly line | MetaGPT 2308.00352 | fleet **A→D→I→E** | already-have (MetaGPT's PM role has no A/D/I/E counterpart) |
| Chat-chain phases + **communicative dehallucination** | ChatDev 2307.07924 | squad hand-offs | **adopt**: proactive-clarification handshake at D→I, I→E |
| Bounded per-role retry ceiling | MetaGPT max-3 / AutoGen | R1/R2/R3 retry bounds (spec) | already-have — validated (cap the I/E loops) |
| Conversation-programming / graph substrate | AutoGen 2308.08155 / LangGraph | OpenClaw master (central control plane) | already-have (reference substrate) |
| Durable execution / checkpoint-resume | LangGraph | master loop | **adopt**: persistent checkpointer so a crash mid-cycle resumes |
| **EVOLVE-BLOCK whitelist + frozen `evaluate()`** | AlphaEvolve PDF | Loop-B freeze line | **adopt** (top priority) |
| Frozen archive/selection + solution archive | DGM 2505.22954 | store + candidate archive | **adopt**: archive + permanently-frozen store/gate code |
| Utility-gated recursive self-improve, model frozen | STOP 2310.02304 | propose→ab, model frozen | already-have |
| Empirical scorer-gaming / sandbox-bypass | STOP 2310.02304 | boundary enforcement | **adopt**: worktree/container isolation + immutable scorer |
| Verbal-reflection retry (no weights) | Reflexion 2303.11366 | E-reject→reflect→I-retry | **adopt** (cheap) |
| Selector==grader (single LLM) | Self-Refine 2303.17651 | — | **anti-pattern — we avoid it** |

## Adoptable wheels (concrete)
1. **Freeze-line/EVOLVE-BLOCK whitelist** (AlphaEvolve) — only marked regions of designated files mutable.
2. **Bounded per-role retry ceiling** (MetaGPT/AutoGen) — cap I and E loops.
3. **Solution/candidate archive** (DGM) — keep all candidates for parallel exploration + unbiased fitness.
4. **Persistent checkpoint/resume** (LangGraph) — for the master's self-improve loop.
5. **Verbal-reflection retry** (Reflexion) — failure→text→next attempt, no retraining.
6. **Proactive-clarification handshake** (ChatDev) — at role hand-offs.

## Where we already go further
Every surveyed self-improver gates on a **threshold** (best-of-N utility, single benchmark score, or — worst — a single LLM grading itself). Meta-harness's **exact McNemar A/B over a held-out fold + sentinels + non-regress margin**, with **selector≠grader** by construction, is *stronger* than all of them — it catches behavior regressions a threshold misses and structurally prevents the Self-Refine scorer-gaming the survey documents. Keep it as the Loop-B gate.

## RECOMMENDATIONS — the 5 open Loop-B decisions

1. **Freeze-line / EVOLVE-BLOCK whitelist** — adopt AlphaEvolve's marker model: only explicitly-marked regions of *designated* fleet files are mutable; the **`ab`/McNemar gate code AND the benchmark store live permanently OUTSIDE any mutable region** (AlphaEvolve frozen `evaluate()` + DGM frozen archive/selection). *We must enforce gate-immutability ourselves — no source states it verbatim (open Q).*
2. **Code-quality gate composition** — layer an **automatic code-execution eval** (AlphaEvolve/STOP: run it, reject broken/hallucinated candidates) *underneath* the statistical McNemar A/B over held-out tasks; keep the utility/gate frozen. I.e. tests+typecheck+smoke (fast reject) → then McNemar (statistical accept).
3. **Human gate points / auto-merge** — retain human oversight as a required precaution (DGM "sandboxing, human oversight"; AutoGen `human_input_mode`); **auto-promote only candidates that pass the frozen automatic gate; a human approves merges to the frozen core.** Never auto-merge into the trusted base.
4. **Worktree isolation** — isolate every candidate self-mod in a throwaway **git worktree / container**, because self-modifiers *empirically try to disable their sandbox* (STOP 0.42%). (Reuse the best-of-k B1 worktree primitive.)
5. **Selector-trust / held-out immutability** — the eval must be **immutable and hidden from the patcher** (avoid Self-Refine; STOP scorer-gaming). Meta-harness's selector≠grader + McNemar held-out already satisfies this — **inherit it unchanged**.

## Caveats & coverage gaps (honest)
- **Version-sensitivity:** ChatDev 5/5/5 numbers are from an early preprint; AutoGen v0.4 moved to an event-driven actor model post-paper; LangGraph resume is node/super-step granularity (needs a persistent checkpointer).
- **Inference boundaries:** DGM's frozen archive is an author scoping choice, not a stated permanent guarantee; extending "frozen archive/selection" to "frozen gate" is our inference.
- **Under-covered (NO surviving confirmed claims):** CrewAI, CodeSwarm, AgentForge (R1/R2); and the **entire R4 human-gate/merge cluster** (OpenClaw gateway internals, Cursor multi-agent judge, OpenHands, Devin). **R4 needs a dedicated follow-up survey** before the master merge-policy is finalized.

## Open questions (carry into the Loop-B design)
1. Does ANY system freeze the **scoring gate itself** (vs just the archive)? None found verbatim → we must decide + enforce gate-code immutability (decisions [i]/[v]).
2. Concrete self-mod isolation: git worktree vs container/VM? Need established; no primary system's exact mechanism captured (decision [iv]).
3. R4 human-gate / parallel-agent collision / merge policy — needs the follow-up survey.
4. **Anti-overfitting across REPEATED McNemar cycles** (held-out rotation / staleness) — the survey established the *requirement* (immutable+hidden) but no concrete multi-cycle protocol; our own decision.

## Action
This survey SEEDS the **Loop-B design** (a D-series like the fleet spec) — the separate next step. Start there from recommendations 1–5; run the R4 follow-up survey before finalizing the master merge-policy.

## Sources (primary)
MetaGPT arXiv:2308.00352 · ChatDev arXiv:2307.07924 · AutoGen arXiv:2308.08155 · LangGraph github.com/langchain-ai/langgraph · AlphaEvolve (DeepMind PDF) · DGM arXiv:2505.22954 · STOP arXiv:2310.02304 · Reflexion arXiv:2303.11366 · Self-Refine arXiv:2303.17651.
