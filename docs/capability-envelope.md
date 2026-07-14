# Capability envelope — what the loop can and cannot improve

External-adviser assessment (2026-07-14) of the system's capability set, with
the *cause* at the top and the derived gap-map below. The gap list is the
symptom; the envelope is the cause — and it generates the next gaps too.

## 0. The envelope principle (the cause)

> **discoverable = mutable ∩ exercised-by-benchmark**

The evolution loop can only improve a capability that is BOTH (a) in the mutable
search space AND (b) exercised during benchmark evaluation. Two of our own
decisions carve holes in that intersection:

- **Tier-3 structure freeze** (`explicitly-not-now §2.1`) removes the entire
  *structural* class — within-task search, backtracking, multi-candidate
  generation. So the loop's inner-loop reach is limited to context/prompt
  tricks (env-snapshot-shaped, low-ceiling).
- **Off-benchmark deferral triggers** (e.g. LSP wiring gated on "real-repo
  fleet", §5.06) keep a capability wire-able but **never present during
  evolution** — so prompts/playbook can't co-adapt to having it. LSP is
  simultaneously "route (b) available" and "route (c) invisible."

**Inner-loop correctness is delegated three ways** — (a) base agent
(opencode/CC), (b) bolt-on tools (serena for LSP), (c) discoverable by the loop
— **but route (c) is mostly void for high-ceiling inner-loop** because the
envelope excludes it. Consequence: the *evolvable* ceiling is
`base-agent × fixed-squad-structure + evolvable-context`. The squad is
hand-built inner-loop structure (a real fixed multiplier), but the only axis
the loop can move is context.

**The fixed multiplier is co-adapted to the CURRENT base model.** The squad
structure was hand-tuned to haiku/sonnet failure modes (the entire
evaluator-verdict-format saga was haiku-specific). On a base-model swap the
multiplier is not guaranteed ≥1 everywhere — structure that patched old blind
spots can be dead weight or worse against new ones, and because the structural
tier is frozen from evolution it CANNOT re-adapt. So the freeze is a standing
*liability* on model swaps, not merely a ceiling.

**Strategic exposure (not a footnote):** our benchmark score is capped at
base-agent inner-loop quality + low-ceiling context tricks + the fixed squad
multiplier. A competitor who hand-builds inner-loop *structure* (search,
LSP-editing, MCTS) around the same base model can pass us on the exact metric
we ground against. Closing the highest-leverage structural gap is therefore a
competitive necessity, not polish.

## 1. Gap map (the symptom)

Framing: my original 7 "features" were all outer-loop / lifecycle. This maps
the INNER loop (write-correct-code-fast) — where most SWE-bench-moving SOTA
lives.

| Capability | Status | Notes |
|---|---|---|
| Verification-in-loop | **partial** | Squad HAS it (implementer dev-test + Evaluator test-spec/build/lint→VERDICT→FAIL-routes-back). Solo benched agent: delegated to the agent + task tests. |
| Search-with-verifier (best-of-N, MCTS) | **absent** | Cross-*generation* selection exists (the loop); within-*task* candidate gen + verifier-select does NOT. k>1 today = repeated measurement, not best-of-k. THE sharpest gap. |
| Semantic code intelligence (LSP/AST) | **available, unwired** | serena MCP (find_symbol/find_referencing_symbols/replace_symbol_body). Deferred §5.06. String-replace editing today = silent-breakage source. |
| Within-task reflection (Reflexion) | **partial** | Squad self-check + adversarial evaluator = actor-critic-within-run. Reflexion's defining move (verbal reflection STORED + reused across attempts) exists on the PROPOSER side (diagnosis.json, cross-generation), not within-task worker side. |
| Skill/tool synthesis (Voyager) | **absent** | We bank prompt guidance (playbook), not executable reusable skills. |
| Parallel write isolation + merge (fleet scale) | **absent** | Single-squad star topology dodges concurrent writes; 20+ squads editing one tree + merge reconciliation not built. |
| Cost/latency routing | **partial** | Static per-slot model pinning (haiku/sonnet) + prompt caching. Dynamic try-cheap-escalate cascade absent. |
| Sandbox + capability gating + checkpoint/rollback | **present** | podman, sandboxEnv scrub, role permissions, --resume checkpoints, trial-gate auto-revert. |
| Exact determinism / replay | **partial** | Trajectories recorded (replayable as data); no exact multi-agent-run replay for debugging. |
| Live HITL steering | **partial** | Gated HITL (gate1/2/merge, escalation bubble-up); no mid-run interrupt/redirect. |

## 2. Reordered priorities (value / cost)

1. **Search-with-verifier — serial, verdict→score.** A CONTAINED structural
   add (bounded loop around the existing implementer→evaluator edge, star
   intact) — hand-build once, expose `k` + rank as a tier-2 knob (NOT a general
   tier-3 thaw). Missing pieces shrink to: verdict binary→score (test-pass
   count, lint delta) + select-and-isolate. Reuses the Evaluator we already own.

   **Diversity source — TWO axes, crossed (not free, and not either-or):**
   - The Designer's `## Alternatives` are **ranked-lower** diversity, not free:
     Gate② already judged them worse. Best-of-k over {Recommended + discarded}
     bets that `P(alternative beats Recommended under execution | Gate② ranked
     it lower)` is high enough to pay — a payoff **inversely coupled to Gate②
     quality** (better gate → rarer upset → best-of-k collapses toward
     best-of-1). So: **measure the upset rate FIRST, don't bank it.** That
     measurement doubles as a Gate② audit — frequent upsets = real lift AND a
     weak ranker to fix; near-zero = the plan-diversity was illusory, lean on
     the other axis.
   - Plan-diversity decorrelates **strategic** errors (wrong approach) and is
     *gate-limited*; impl-diversity decorrelates **tactical** errors (bug in a
     right approach) and is *correlation-limited* (temperature-only k is near
     worthless alone — correlated tactical failures). They catch DIFFERENT
     failures. The strong cheap config is the small cross-product:
     **top-2 plans × 2 implementations each = 4 candidates spanning both** —
     not either axis alone (plan-only is bounded by the very gate we're trying
     to keep honest).

   **Goodhart guard — OPEN, not solved (harder than cross-generation).** The
   held-out *discipline* transfers but the *statistics do not*: cross-generation
   folds across many tasks; within a task there may be 3–5 tests total
   (SWE-bench fail-to-pass + pass-to-pass), so holding some out (a) guts the
   verifier's discriminating power on the one task that matters and (b) often
   can't split at all. The fallback — agent-*synthesized* held-out tests —
   reintroduces the trust problem (tests by the same agent being selected share
   its blind spots and get gamed). Flag as an OPEN problem to solve before
   committing, not a free reuse.

   **Bonus:** parallel best-of-k (k worktrees / one task / merge winner)
   prototypes the fleet write-merge mechanism — two gaps, one primitive.
2. **LSP → implementer, EARLY.** Cheap, kills string-replace breakage. Pull the
   trigger *before* the evolution regime, not at "real-repo fleet" — else the
   loop never co-adapts to it (envelope point).
3. **Skill synthesis / replay / live steering** — genuine, lower urgency.

## 3. What to do with this

- The tier-3 freeze was the right call for GENERAL structure search
  (unreviewable blast radius). But best-of-k is a *bounded, single-primitive*
  structural add whose evolvable surface is one knob — it does not reopen the
  general search. Treat it as its own scoped decision, not a §2.1 reversal.
- LSP's deferral trigger should move from "real-repo fleet" to "present during
  the next evolution regime" so route (c) can co-adapt.
- Re-run the envelope check on every future deferral: if a capability is
  wire-able but its trigger is off-benchmark, the loop is structurally blind to
  it — decide that on purpose.

## 4. Two claims held OPEN (do not enshrine as solved)

Recorded so they are not quietly assumed true later:
- **best-of-k diversity is gate-coupled, not free.** The Designer's discarded
  alternatives are ranked-lower, so the lift depends on execution-truth
  disagreeing with Gate②. MEASURE the upset rate before committing; cross the
  plan × impl axes (§2 #1). Do not record as banked value.
- **Within-task Goodhart defense is unsolved.** Cross-generation held-out folds
  do not transfer statistically to a 3–5-test single task; synthesized held-out
  tests reintroduce same-agent blind spots. Open problem, needed before
  verifier-select can be trusted to still mean generalization.
