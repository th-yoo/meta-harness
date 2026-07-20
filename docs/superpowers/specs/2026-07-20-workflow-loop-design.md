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
  → [extract]    (agent → FROZEN contract: acceptance criteria + verification plan, persisted)
  → [implement]  (opencode run — the existing agent phase)
  → [verify]     (SEPARATE adversarial verifier AGENT: audits work + evidence against the
                  frozen plan → machine-parseable VERDICT: PASS|FAIL|PARTIAL; cannot edit
                  project files)
  → FAIL? [feed verifier gaps → implementer fixes] → [implement] → [verify] …  (bounded by maxRetries)
  → copyTests → verify(HIDDEN grader) → cgroup read → teardown
```
Design note: `[verify]` is a **separate adversarial agent**, not the implementer
self-checking — the design both Claude Code (`verificationAgent.ts`) and grok-build
(`goal_verifier_prompt.md`) independently converged on, and what the research favors
(independent/external > intrinsic self-correction). Node wording is lifted from those
sources — see `docs/2026-07-20-reference-prompts-cc-grok.md`.
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
{ "extract": true,
  "verify": { "mode": "adversarial-agent", "maxRetries": 2 } }
```
- `{}` (or absent) = one-shot, byte-identical to today.
- The config is authored by hand in this spec; generated by the proposer in the deferred one.

### The extract → implement → adversarial-verify → retry primitive
Node wording lifted from `docs/2026-07-20-reference-prompts-cc-grok.md` (CC + grok converged
on this exact loop). Four nodes:

1. **`[extract]`** — harness-inserted pre-step: prompt the IMPLEMENTER to convert
   `instruction.md` into a **FROZEN CONTRACT** — 3–5 atomic, outcome-based **acceptance
   criteria** + a **verification plan** (per criterion: the action to run + the observations
   that MUST hold to pass; outcomes, not architecture). Persisted to `/app/.mh/plan.md`. The
   harness re-checks against this SAME plan every attempt — it is not re-derived per retry.
2. **`[implement]`** — the existing opencode run; the implementer solves the task AND produces
   **evidence** (runs its own checks per the verification plan, captures command output).
3. **`[verify]`** — a **SEPARATE adversarial verifier agent** (its own opencode run, distinct
   prompt, distinct container or a fresh exec):
   - *Adversarial, default-to-refute:* "your job is to try to break it"; "default to
     `refuted: true` if uncertain — a false-positive is far worse than one more iteration."
   - *Audit-don't-author + no-test-theater:* audit the implementer's evidence against the
     frozen plan; refute if tests are hardcoded / mocked-out / skipped / `#[ignore]` /
     `todo!()`. Also runs its own build/test/adversarial probes (concurrency/boundary/
     idempotency/orphan).
   - *Anti-over-refute:* a criterion whose evidence holds is PASSED; do not invent scope
     beyond the contract.
   - *Cannot edit project files* (verification-only; tmp allowed for ephemeral scripts).
   - Emits a **machine-parseable** result: per check a `Command run` + `Output observed`
     block ("a check without a command block is a skip"), ending `VERDICT: PASS|FAIL|PARTIAL`.
     The harness parses the terminal VERDICT line.
4. **`[retry]`** — on `FAIL`: the harness feeds the verifier's **gaps** back to the
   implementer — "Verification REJECTED your completion claim. Fix every gap below before
   claiming done again: `<gaps>`" — and re-runs `[implement]` → `[verify]` against the SAME
   frozen plan. Bounded by `maxRetries`. *Deferred escalation:* after N stalled rounds, a
   strategist step recommending one structural change (grok `goal_strategist`).

### Feedback + leakage boundary (load-bearing)
- The verifier judges against the **frozen plan** (derived from `instruction.md` — a
  legitimate channel, the task prompt) + the implementer's evidence + its own executable
  probes. Executable + **independent** (research F6/F7: external > intrinsic).
- The verifier is itself an LLM → gameable. The **no-test-theater + default-to-refute +
  Command-run-evidence** requirements are the mitigations (counter research F5's 16.3%
  self-verifier false-positive rate).
- **The HIDDEN TB2 grader is NEVER exposed to the implementer OR the verifier.** It stays the
  separate ground-truth gate, run after the workflow completes (unchanged). A gamed verify
  only wastes that task's retries — it cannot corrupt the verdict, because acceptance is the
  hidden grader, not the agent's or verifier's checks.

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
`maxRetries` (default 2) caps the loop. Per task the workflow adds, worst case: 1 `[extract]`
turn + up to `maxRetries+1` `[implement]` runs + up to `maxRetries+1` `[verify]`
**verifier-agent runs**. The separate verifier agent is the dominant added cost (~2× the
agent invocations of a one-shot at the ceiling). The load-aware scheduler + per-task
timeouts absorb the wall-clock; **budget-identity records the (compute-affecting) config**, so
a candidate that wins by spending more is re-baselined honestly via the T6/T7 gate.

## Error handling
Every degradation converges on "run the hidden grader on whatever exists" — the workflow can
only help, never block a task from being graded.
- **`[extract]` fails / times out** → no frozen plan → skip `[verify]`/`[retry]`, fall
  through to the hidden grader (degrade to one-shot); logged.
- **Verifier emits no parseable `VERDICT` line** → treat as `PARTIAL` (do NOT retry on an
  ambiguous verdict — retrying on noise wastes budget) → fall through to the hidden grader;
  logged.
- **`VERDICT: PARTIAL`** (environmental limitation the verifier declares) → no retry, fall
  through with the current implementation.
- **Verifier agent itself fails (setup/transient/0-turn)** → skip verify for that attempt
  (treat like extract-fail); the staging-retry (deed593) + agent-run retry already handle
  transient infra.
- **Retries exhausted** (`maxRetries` FAILs) → fall through to the hidden grader with the
  last implementation (best effort), same as a one-shot fail.

## Testing strategy
- **Unit:** workflow-config parse/compile (`{}` → no-op; enabled stages → correct graph);
  frozen-plan persist/reuse (same plan re-checked each attempt, not re-derived); **VERDICT
  parse** (`PASS`/`FAIL`/`PARTIAL`/unparseable→PARTIAL); the verify-retry loop with a mock
  implementer + **mock verifier agent** — PASS-first (no retry), FAIL-then-PASS (1 retry,
  gaps fed back), exhaust-retries (maxRetries FAILs → fall through), PARTIAL/unparseable (no
  retry → fall through); taxonomy schema + judge harness (mock LLM → label).
- **Integration:** one task through the graph with a mock opencode driver for BOTH the
  implementer and the verifier — assert stage order (extract → implement → verify → retry),
  that the verifier gets the frozen plan + implementer evidence (not the hidden grader), and
  that the hidden grader runs last + separate + sees no `.mh` artifacts.
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
  verify-retry, composable later (each of the N attempts can be verify-retried).
- **strategist escalation** — after N stalled verify rounds, a step that recommends one
  structural change (grok `goal_strategist`); the tail of the bounded retry loop.
- **decompose scaffold** (plan→implement→verify) for the comprehension mode.
- **ATLAS-style induced taxonomy** — induce a system-specific schema from our own traces,
  vs this spec's fixed seeded schema.
- **cheaper implementer-self-check verify** — the fork's other branch (implementer runs its
  own executable checks, no separate verifier agent). Kept as a documented fallback if the
  separate-verifier cost proves prohibitive on the band; the adversarial/no-test-theater
  wording transfers to the self-check prompt.

## Open questions (resolve during planning)
1. **Harness-artifact paths + purge** — the frozen plan (`/app/.mh/plan.md`) and any
   ephemeral check scripts must be dot-/`.mh`-namespaced AND **purged before the hidden
   grader runs** (env-fidelity: the grader must never see harness artifacts, and the agent
   must not read the grader). Confirm no TB2 task collides with `/app/.mh/`.
2. **Verifier isolation** — the separate verifier agent in its OWN fresh container
   (clean-room; can't-edit enforced structurally, but 2× container startup) vs a fresh
   `podman exec` in the implementer's container with a verification-only prompt (cheaper;
   can't-edit enforced only by prompt). Prototype both; the container is safer, the exec is
   cheaper.
3. **Verifier model** — same haiku as the implementer, or a stronger model for the audit?
   The verifier's quality gates the whole loop (a weak verifier rubber-stamps). Note: a
   stronger verifier model changes the budget-identity/model provenance — decide whether the
   verifier model is part of the candidate's identity.
4. **`[extract]` shape** — separate opencode invocation (cleaner enforcement, +startup) vs a
   prepended instruction to the implement run ("first write the plan to /app/.mh/plan.md,
   then solve"). Prototype the enforcement/cost trade.
5. **Taxonomy judge model** — opus (accuracy, MAST used o1-class) vs haiku (cost) for the
   failure-taxonomy LLM-as-judge.
6. **workflow-config hash in budget-identity** — hash the full config (any compute-affecting
   change, incl. `maxRetries` and verifier model, re-baselines). Leaning: yes, full config.
