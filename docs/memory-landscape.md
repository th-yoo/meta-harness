# Agent memory — where meta-harness sits in the literature

Maps this project onto the agent-memory research landscape (survey list:
[TsinghuaC3I/Awesome-Memory-for-Agents](https://github.com/TsinghuaC3I/Awesome-Memory-for-Agents),
tracked through 2026-04). Purpose: name our category, our nearest prior art,
our gaps-with-a-paper-attached, and the memory upgrade path for the fleet.

## 1. The taxonomy we're classified under

Two axes from the survey:

- **Persistence** — Short-Term (in-context, one task) vs Long-Term (external,
  across tasks).
- **Outcome-dependence** (within Long-Term) — **Experience** = knowledge
  *validated by task success/failure*; **Memory** = info stored *without*
  outcome reference.

**meta-harness = Long-Term / Experience / "Learning from Experience."** The
whole loop is outcome-validated: run → verifier or gate says pass/fail →
distill a lesson → curate into the store → the selection gate (ab / trial)
admits it only if it measurably helps. Nothing enters the durable store
un-adjudicated. This is the defining property of the Experience category and
it is exactly what separates us from a plain RAG "Memory" system.

## 2. Nearest prior art (same bucket — read these)

| Paper | arXiv | Relation to us |
|---|---|---|
| ACE — Agentic Context Engineering | 2510.04618 | The evolving-playbook method we implement (Reflector=diagnosis, Curator=`applyPlaybookOps`, delta-not-rewrite, grow-and-refine, helpful/harmful counters). Paper baseline we beat 73.1 vs 70.2. |
| ReasoningBank | 2509.25140 | Reasoning-memory for self-evolving agents; closest to our diagnosis→playbook distillation. |
| Memp | 2508.06433 | Procedural memory, explicitly — our system.md/playbook IS procedural memory. |
| Memento | 2508.16153 | "Fine-tuning agents without fine-tuning LLMs" = the non-parametric self-improvement thesis we embody. |
| Metacognitive Reuse | 2509.13237 | Recurring reasoning → concise behaviors = the curator's job. |
| How Memory Management Impacts LLM Agents | 2505.16067 | Empirical "experience-following" study — relevant to candidate-vs-active dynamics. |
| MemEvolve | 2512.18746 | Meta-evolution of memory systems — the meta-of-us. |

## 3. What SOTA has that we don't (gap → paper)

Each gap already appears in `explicitly-not-now.md`; here it's paired with the
literature that solves it.

- **Retrieval by relevance, not recency.** PARTIALLY ADOPTED (2026-07-14,
  `failure-retrieval.ts`): the proposer's `buildFailureExcerpts` now ranks by
  **importance × taxonomy-diversity across ALL candidate versions** (was:
  active-version last-3 recency tail). Non-parametric — structured signals
  (taxonomy via a global diagnosis map, tool-error counts, judge confidence,
  recency) + diversity coverage, no embeddings. Squad side stays minimal
  (recency + dedupe-by-sliceId). STILL DEFERRED: query-driven *semantic
  similarity* (needs task-identity + embeddings) — see §… deferred list; SOTA
  there is **AssoMem** (2510.10397, multi-signal associative), **SwiftMem**
  (2601.08160, query-aware indexing), **SYNAPSE** (2601.02744, spreading
  activation), Generative-Agents recency×importance×relevance scoring.
- **Temporal / graph memory + consolidation.** No cross-role KG, no
  temporal-validity ("which rule worked *when*"), no sleep-time compaction
  across the store. **Zep/Graphiti** (2501.13956, bi-temporal KG), **MemOS**
  (2507.03724, memory OS), **A-MEM** (2502.12110, Zettelkasten links — same
  `[[name]]` idea as our own memory files).
- **RL-learned memory management** vs our hand-coded thresholds
  (PROJECT_ROLE_THRESHOLD, keep-last-N). **Memory-R1** (2508.19828),
  **MEM-α** (2509.25911), **Memory-T1** (2512.20092): the agent *learns what
  to store*.

## 4. The fleet's future = multi-agent memory

The squad is a multi-agent system; its memory story is barely begun (member
role stores + squad-def outcomes). The literature to mine before building
tier-2 memory beyond flow knobs:

- **LEGOMem** (2510.04851) — *modular procedural memory for multi-agent
  workflow automation*. Almost exactly the squad's shape (per-role procedural
  memory in a workflow). **Read first.**
- **G-Memory** (2506.07398) — hierarchical memory for multi-agent systems;
  maps onto our node-tree / nodePath provenance.
- **MIRIX** (2507.07957), **BMAS** (PFC-coordination + hippocampus/neocortex
  dual memory) — multi-agent memory architectures.

This is the "cross-session credit assignment" the project memory already
flags as the future unlock: pool per-role Experience across depths and slices,
retrieve the relevant past failure for the current one.

## 5. Honest placement

Deep on **one** memory type (procedural / Experience, done well, gated,
beats the ACE baseline). Deliberately shallow on the other three (episodic
retrieval, semantic/graph, consolidation) — appropriate for the goal *evolve
the harness*, not *remember conversations*. The literature-shaped next layer,
in order: (1) relevance retrieval over the failure corpus, (2) LEGOMem-style
per-role procedural memory for the fleet, (3) a consolidation pass.

---

## 6. How we keep memory under a bounded context window

The context window is a **working set / cache**, never the source of truth.
The durable memory lives on disk; context holds pointers and the current
excerpt. Every layer of this system already applies the same discipline —
**externalize + retrieve, don't cram** (the "filesystem-as-context" pattern,
now the dominant practical approach; e.g. FileGram 2604.04901).

**System-level (the harness):**
- **The store IS the memory.** `harness-store.ts` layers (system.md,
  playbook.json, score.json, trajectories) on disk are the long-term memory;
  a run loads only the composed active layers, not the history.
- **Bounded working context for the proposer.** `buildFailureExcerpts`:
  keep-last-N sessions, per-session char cap; `squad-propose`
  MAX_SESSIONS_SHOWN=20. The prompt gets a capped *excerpt*, not the corpus.
- **Agentic on-demand reads.** The proposer has filesystem access to the
  store (tier-B proven) — it *reads what it needs when it needs it* rather
  than us pre-stuffing everything into one prompt. This is the paper's own
  10M-token-context discipline: navigable store + small resident excerpt.
- **Star-topology squad drives.** Each drive is a fresh stateless session
  fed only its `inputFor` artifact — no transcript accumulates across A→D→I→E.
  (Gap: `inputFor` sends full artifacts uncapped and delta re-entry is
  unimplemented — the one place squad context can grow unbounded; registered
  §3.7-2 / context-management note.)

**Session-level (the operator loop, incl. this assistant):**
- **Offload state to files continuously** — SDD ledger
  (`.superpowers/sdd/progress.md`), per-task reports, the deferral register,
  the `memory/` files. The context can be summarized or lost; the files
  survive.
- **Proven by the mid-session reboot** (2026-07-14): the OS rebooted, the
  whole in-memory context was gone, yet ~zero work was lost — the baseline
  results file, the store, and the ledger held everything load-bearing, and
  the run resumed via `runner.ts run --resume` reading the results file.
- **The `--resume` contract** everywhere (bench run, ab, squad-run
  checkpoint) is the same principle: durable checkpoint on disk, reconstruct
  working state from it.

Rule of thumb, one line: **context window = cache; disk = truth; retrieve the
relevant slice, never the whole history.**
