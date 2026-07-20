# Workflow-Improvement Loop — Design Spec (2026-07-20)

## Overview
Pivot the self-improvement loop from tuning a supplementary prompt **playbook** to
optimizing an **enforced agent workflow**. This spec covers two subsystems, together:
(1) a **failure-taxonomy step** over saved agent trajectories, and (2) a **workflow-graph
engine** that wraps the agent run with harness-enforced control flow, shipping one
primitive — **checklist-extract + verify-retry**. A third subsystem, the
**proposer-over-workflow** (auto-generating the workflow config), is explicitly deferred to
its own spec.

**Goal:** make "the improvement" a harness-executed control-flow graph (not prompt text an
agent can gloss), versioned + A/B-gated by the existing machinery, and grounded in a
failure taxonomy — so the loop can lift pass@1 on failures that prompt-tuning structurally
cannot reach.

**Why (background):** the prompt-playbook loop plateaued (v0→v3, 0 pass-lift) because the
playbook is a thin additive layer on an already-capable agent (opencode+haiku, verified
minimal-config, no MCP, no CC). Deep research (24/25 confirmed, peer-reviewed) shows: on a
fixed model, **workflow structure > prompt** (Agentless, DirectSolve CoT 9→32%, best-of-N
+15); **intrinsic self-correction degrades** without external feedback (Huang ICLR24); the
bottleneck is **feedback generation, not refinement** (Kamoi TACL24); **self-generated
verifiers are gameable** (16.3% FP, Reflexion). See `docs/2026-07-20-next-direction.md` and
`docs/2026-07-20-deep-research-failure-analysis-workflow.md`.

## Scope
- **In:** failure-taxonomy step; workflow-graph engine + the checklist-extract+verify-retry
  primitive; the `workflow.json` candidate artifact; budget-identity extension; ab-gating
  reuse.
- **Out (own specs):** proposer-over-workflow; best-of-N + verifier selection; decompose
  scaffold; ATLAS-style induced taxonomy (this spec uses a fixed seeded schema).

## Architecture — wrap the agent phase (don't replace it)
Today `runTaskOnce` (cmd-run.ts) runs, per (task, attempt):
`stage → [agent run] → copyTests → verify(hidden grader) → cgroup read → teardown`.

The workflow engine inserts a graph around `[agent run]`, driven by the candidate's
workflow-config:
```
stage
  → [extract]    (agent: requirements → checklist + runnable check script)
  → [implement]  (opencode run — the existing agent phase)
  → [verify]     (HARNESS runs the agent's check script; nonzero exit → capture output)
  → fail? [feedback → fix] → [implement] …  (bounded by maxRetries)
  → copyTests → verify(hidden grader) → cgroup read → teardown
```
- Both `run` and `ab` go through `runTaskOnce`, so both inherit the workflow with no
  per-path wiring.
- **Empty workflow-config → today's one-shot, byte-identical.** Same back-compat discipline
  as `renderPlaybook`'s byte-identity: the engine is a no-op unless a config enables stages.
- Rejected alternatives: a separate "workflow driver" (more plumbing, diverges the two
  drivers); a general DAG interpreter like `fleet/dag.ts` (overkill — the shape is linear +
  one bounded loop, not an arbitrary DAG).

## Component 1 — Failure-taxonomy step
- **Input:** `candidates/vN/traj/*.ndjson` (saved agent trajectories — the real action
  stream), the task `instruction.md`, and the session pass/fail. **No task runs** — reads
  existing on-disk data.
- **Method:** MAST-style **LLM-as-judge** classification (the verified ~94%-accuracy
  approach) with a **fixed seeded schema**:
  - `spec-precision` — had the requirement (in the prompt), dropped a literal value / self-
    verified against its own interpretation (our verified openssl mode).
  - `comprehension` — misread or misunderstood the task.
  - `capability` — genuinely could not produce the solution (algorithmic/formal/numerical).
  - TRAIL single-agent leaves — `instruction-noncompliance`, `output-formatting`,
    `tool-selection`, `decision-making`, `config/API/resource` errors.
  - `infra` — setup_failed / transient (already handled elsewhere; labeled for completeness).
- **Output:** a per-trajectory mode label + aggregate **mode-fractions per version**,
  written to `candidates/vN/taxonomy.json`. CLI: `bench failure-taxonomy --version vN
  [--layer account-global]`.
- **Role in THIS spec:** (a) confirm with data (not just the single openssl datapoint) that
  spec-precision/looks-done is a material fraction that the first primitive addresses;
  (b) produce durable mode-labels as the substrate the deferred proposer-over-workflow will
  read; (c) a reusable diagnostic step.
- **Non-goal:** step-level attribution ("which turn caused it"). The research shows this is
  unsolved (~11–14%); the step classifies the trajectory's dominant MODE, and relies on the
  executable grader for ground truth.

## Component 2 — Workflow-graph engine + first primitive
### Representation
A small **declarative workflow-config** (JSON) that compiles to the control flow:
```json
{ "checklistExtract": true,
  "verifyRetry": { "maxRetries": 2 } }
```
- `{}` (or absent) = one-shot, byte-identical to today.
- The config is authored by hand in this spec; generated by the proposer in the deferred one.

### The checklist-extract + verify-retry primitive (Reflexion shape)
1. **`[extract]`** — a harness-inserted pre-step that prompts the agent to (i) extract the
   literal, checkable requirements from `instruction.md` into a checklist, and (ii) write a
   single runnable **check script** (`/app/.mh_check.sh`, or `.py`) that asserts each item
   and exits nonzero on any failure. This is a normal agent turn; its only job is producing
   the checklist + check script.
2. **`[implement]`** — the existing opencode run (the agent solves the task).
3. **`[verify]`** — the **harness executes** `/app/.mh_check.sh` in the container (like the
   verifier's `copyTests`/exec pattern). Exit 0 → proceed. Nonzero → capture stdout/stderr.
4. **`[retry]`** — feed the captured failure back to the agent as a follow-up turn ("Your
   own check failed: `<output>`. Fix the implementation so it passes."), then re-run
   `[implement]`+`[verify]`. Bounded by `maxRetries`.

### Feedback source + leakage boundary (load-bearing)
- Feedback = **agent-generated executable checks, harness-run.** Executable (research-favored
  over self-attestation) and generalizable (no per-task harness code).
- The checklist derives from `instruction.md` — a legitimate channel (it is the task prompt
  the agent already receives).
- **The hidden TB2 grader is NEVER exposed to the agent or the check.** It stays the separate
  ground-truth gate, run after the workflow completes (unchanged). A gamed/weak self-check
  only wastes that task's retries — it cannot corrupt the verdict, because acceptance is the
  hidden grader, not the agent's checks (per research F5: keep them separate).

## Data model — versioning + gating
- A candidate `vN` carries **both** `playbook.json` (the prompt layer) **and** `workflow.json`
  (the workflow-config). A candidate is thus a full *agent configuration* along two axes:
  prompt and workflow. `v0` = default prompt + empty workflow (= today). The current proposer
  evolves the prompt axis; the deferred proposer-over-workflow evolves the workflow axis;
  both are gated by the same ab.
- **Budget-identity extends** to include a hash of the workflow-config (retries + the extra
  extract turn change compute). A workflow change is therefore a budget-identity change →
  the existing **T6/T7 `/mh-activate` gate forces a re-baseline** (already built), keeping a
  "won by spending 3× compute" candidate honest.
- **Gating = unchanged ab machinery.** A workflow-config candidate vs the active version →
  held-in/held-out paired McNemar + speed-tiebreak + sentinels. The ab re-runs both arms
  live under identical caps, so it evaluates workflow candidates exactly like prompt
  candidates — no gate change needed.

## Compute bounds
`maxRetries` (default 2) caps the loop; each retry = one feedback message + one re-run of
`[implement]`+`[verify]`. The `[extract]` step adds one turn. The load-aware scheduler +
per-task timeouts already absorb the added wall-clock; budget-identity records the change.

## Error handling
- **Agent writes no check script / unparseable** → skip `[verify]`/`[retry]` for that
  attempt, fall through to the hidden grader (degrades to one-shot; logged, not fatal).
- **Check script errors for a non-assertion reason** (e.g. its own syntax error) → treated
  as a failed check → one retry with the error fed back; still bounded by `maxRetries`.
- **`[extract]` turn fails / times out** → proceed to `[implement]` without a checklist
  (degrade to one-shot); logged.
- **Retries exhausted** → proceed to the hidden grader with the last implementation (the
  agent's best effort), same as a one-shot fail.
- All degradations converge on "run the hidden grader on whatever exists" — the workflow can
  only help, never block a task from being graded.

## Testing strategy
- **Unit:** workflow-config parse/compile (`{}` → no-op; enabled stages → correct graph);
  checklist-extract output parse (checklist + check-script path); verify-retry loop with a
  mock agent + mock check — pass-first (no retry), fail-then-pass (1 retry), exhaust-retries
  (maxRetries then fall through); taxonomy schema + judge harness (mock LLM → label).
- **Integration:** one task through the graph with a mock opencode driver — assert the stage
  order (extract → implement → verify → retry) and that the hidden grader runs last and
  separate.
- **e2e (live, one task):** a real task with `workflow.json = {checklistExtract, verifyRetry}`
  vs empty; confirm the retry fires on a real self-check failure and the hidden grader is
  never fed the check output.
- **Back-compat invariant (critical):** empty workflow-config → byte-identical to today's
  one-shot `runTaskOnce` (mirrors the `renderPlaybook` byte-identity discipline). A dedicated
  test pins this.

## Deferred (each its own spec)
- **proposer-over-workflow** — read `taxonomy.json` → emit a `workflow.json` candidate
  (failure-mode → intervention mapping), gated by ab. The natural next spec.
- **best-of-N + verifier selection** — the biggest general lever (research F5); orthogonal to
  verify-retry, composable later.
- **decompose scaffold** (plan→implement→verify) for the comprehension mode.
- **ATLAS-style induced taxonomy** — induce a system-specific schema from our own traces,
  vs this spec's fixed seeded schema.

## Open questions (resolve during planning)
1. **Container path for the check script** — `/app/.mh_check.sh` collides with nothing in
   TB2 tasks? Confirm a dot-prefixed path the hidden verifier ignores, and that it's purged
   before grading (env-fidelity: the grader must not see harness artifacts).
2. **`[extract]` as a separate opencode invocation vs a prepended instruction to a single
   run** — separate invocation is cleaner to enforce but doubles container/agent startup;
   a prepended "first write your checklist+check, then solve" is one run but less enforceable.
   Prototype both; measure the enforcement/cost trade.
3. **Taxonomy judge model** — which model runs the LLM-as-judge (opus for accuracy vs haiku
   for cost)? MAST used o1-class; budget accordingly.
4. **workflow-config hash in budget-identity** — exact fields hashed (does `maxRetries`
   value change identity, or only the set of enabled stages?). Leaning: hash the full config
   so any compute-affecting change re-baselines.
