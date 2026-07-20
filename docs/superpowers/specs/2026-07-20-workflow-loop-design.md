# Workflow-Improvement Loop — Design Spec (2026-07-20)

> **⚠️ PARTIALLY SUPERSEDED 2026-07-20 (AHE prior-art pivot — `docs/2026-07-20-ahe-prior-art.md`).**
> **Component 2's first primitive changed from `verify-retry` → `memory + risk-hints`** (AHE's
> ablation: memory/middleware won, prompt regressed, and a self-graded verify-retry lost). The
> base agent changes haiku → **Opus 4.8**. **Still valid from this spec:** Component 1
> (failure-taxonomy, now upgraded to AHE's Agent-Debugger root-cause method), and ALL the
> machinery — wrap-`runTaskOnce`, `workflow.json`-style candidate axis, `readWorkflowConfig`
> threading, budget-identity extension + traps, ab-gate reuse, the `/logs/.mh` leakage
> boundary, and the two-plan split. **Deferred:** the verify-retry / adversarial-verifier
> engine (§ Component 2's primitive) — revisit only if the taxonomy shows a spec-precision
> fraction memory/risk-hints don't cover. Component 2 is re-specced separately as the
> memory/risk-hints component.

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
- **Structural win (review):** `copyTests` populates `/tests` only AFTER the agent phase
  returns (`verifier.ts:64-101` via `cmd-run.ts:329-353`), so the whole extract→implement→
  verify→retry graph runs while the hidden tests **cannot exist yet** — the grader is
  structurally unreachable during the workflow. `runWithOomRetry` (`cmd-run.ts:426-442`) reads
  the cumulative cgroup counter at teardown, so a 7-invocation attempt OOM-retries like a
  1-invocation one — no change.
- **NOT wiring-free (correction):** the *statistical* ab-gate (McNemar/splits/bootstrap) is
  candidate-agnostic → zero change. But harness CONSTRUCTION isn't: the `AgentConfig`/
  `EnvPolicy` store precedent is read only by `engine.ts` (live path), NEVER by `cmd-run.ts`/
  `cmd-ab.ts`. So add `readWorkflowConfig(layerRoot, version?)` + thread it in `cmdRun` AND
  `cmdAb` (mirror `harnessA`/`harnessB`, `cmd-ab.ts:294-295`); `RunOneTaskFn` (already 11
  positional params) grows a workflow param — use an **options-object**. `runAgent` hardcodes
  its instruction source (`agent-run.ts:147`) → add an optional `instructionOverride` (absent =
  byte-identical) to build the `[extract]`/`[verify]` prompts.
- **Empty workflow-config → today's one-shot, byte-identical.** Back-compat discipline as
  `renderPlaybook`; a dedicated test pins it.
- Rejected alternatives: a separate "workflow driver" (more plumbing, diverges the two
  drivers); a general DAG interpreter like `fleet/dag.ts` (overkill — the shape is linear +
  one bounded loop, not an arbitrary DAG).

## Component 1 — Failure-taxonomy step
- **Input:** `candidates/vN/traj/*.ndjson` + task `instruction.md` + session pass/fail. **No
  task runs.** Caveat (review): `pruneTrajectories(keepFailures=20, keepPasses=5)`
  (`harness-store.ts:593-608`) caps the store most-recent-first, so the step sees at most the
  20 most-recent failure trajectories per version — a **recency-biased sample**, not the full
  failure population. Document it as such (matters when the fractions later feed the proposer).
- **Method:** MAST-style **LLM-as-judge** classification (verified ~94% accuracy), reusing the
  existing **`runJudgeOpencode`** primitive (`opencode-run.ts:82-…`, host-side, no container,
  locked `judgeAgentConfig` persona — the same mechanism `judge-audit.ts` uses, default model
  `openrouter/google/gemini-2.5-flash`: cheap + proven). Fixed **seeded schema**:
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

1. **`[extract]`** — a SEPARATE agent invocation (own instruction, NOT `instruction.md`+budget
   line) that converts `instruction.md` into a **FROZEN CONTRACT** — 3–5 atomic, outcome-based
   **acceptance criteria** + a **verification plan** (per criterion: the action to run + the
   observations that MUST hold to pass; outcomes, not architecture). Persisted to
   **`/logs/.mh/plan.md`** (harness-owned area, outside `/app`, invisible to the hidden grader
   — see leakage boundary). The harness re-checks against this SAME plan every attempt — not
   re-derived per retry. Its `AGENTS.md`/harness-markdown auto-load must be **suppressed** for
   this invocation (see leakage boundary) so extract isn't skewed by the evolving playbook.
2. **`[implement]`** — the existing opencode run; the implementer solves the task AND produces
   **evidence** (runs its own checks per the verification plan, captures command output).
3. **`[verify]`** — a **SEPARATE adversarial verifier agent**, run as a **fresh `podman exec`
   in the implementer's ALREADY-STAGED container** (NOT a new container — there is no
   podman-commit/checkpoint primitive, so a fresh container would re-stage the whole dependency
   tree every retry round; exec-in-place has zero staging cost and sees the implementer's live
   filesystem + the frozen plan). It is a THIRD invocation shape — tool-using like
   `[implement]` (it runs builds/tests/probes), NOT the host-side locked-down judge shape.
   Distinct prompt; its `AGENTS.md`/harness-markdown auto-load is **suppressed/replaced** so it
   does not inherit the implementer's evolving playbook (independence is the whole point):
   - *Adversarial, default-to-refute:* "your job is to try to break it"; "default to
     `refuted: true` if uncertain — a false-positive is far worse than one more iteration."
   - *Audit-don't-author + no-test-theater:* audit the implementer's evidence against the
     frozen plan; refute if tests are hardcoded / mocked-out / skipped / `#[ignore]` /
     `todo!()`. Also runs its own build/test/adversarial probes (concurrency/boundary/
     idempotency/orphan).
   - *Anti-over-refute:* a criterion whose evidence holds is PASSED; do not invent scope
     beyond the contract.
   - *Cannot edit project files* — enforced **structurally** for the opencode driver via an
     `--agent` permission block that denies `write`/`edit`/`patch` (precedent:
     `judge-audit.ts`'s `judgeAgentConfig` denies tools on a real `opencode run`). The
     `AgentDriver` interface gains a restricted-permission hook; opencode gets structural
     enforcement, claude-code falls back to prompt-only (documented gap, v1). Any files the
     verifier does create go under `/logs/.mh/` or `/tmp`, never `/app`.
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
- **Harness artifacts live at `/logs/.mh/` (outside `/app`) — NO purge step.** `verifier.ts`
  only resets `/tests` and reads `/logs/verifier/reward.txt`; it never touches `/app` or
  `/logs/.mh`. So the frozen plan + any check scripts placed under `/logs/.mh/` are structurally
  invisible to the hidden grader without a fragile purge-before-teardown step (precedent:
  `self-score.ts`'s `/logs/self-check/score.txt`). This is why the artifacts do NOT go in
  `/app`.
- **`AGENTS.md` contamination (must-fix):** opencode auto-loads `AGENTS.md` from cwd, so a
  second `opencode run` in the same container silently inherits the implementer's *evolving
  playbook*. The `[extract]` and `[verify]` invocations must suppress or replace that file for
  their turn — otherwise the "independent" verifier reads the very playbook under evaluation,
  voiding the independence the research justification (external > intrinsic) depends on.
- **Verifier `/app` mutation guard:** the exec-in-place verifier could leave stray files/state
  in `/app` that persist into the grader's view. Snapshot `/app`'s file list + mtimes before
  `[verify]` and diff after; flag (or hard-fail) any verifier-caused mutation. "tmp allowed"
  must be *enforced*, not just stated.

## Data model — versioning + gating
- A candidate `vN` carries **both** `playbook.json` (the prompt layer) **and** `workflow.json`
  (the workflow-config). A candidate is thus a full *agent configuration* along two axes:
  prompt and workflow. `v0` = default prompt + empty workflow (= today). The current proposer
  evolves the prompt axis; the deferred proposer-over-workflow evolves the workflow axis;
  both are gated by the same ab.
- **Budget-identity extends** with a `workflowConfigHash` (the config changes compute). A
  workflow change → a budget-identity change → the **T6/T7 `/mh-activate` gate re-baselines**.
  Concrete change set (review): add `workflowConfigHash` to `EnvBlock` (`record.ts:190-215`)
  stamped in `envBlock()`; to `AbVerdict` (`harness-store.ts:260-293`) stamped by `verdictDict`
  (`cmd-ab.ts:504-560`); extend `budgetIdentityMatches`'s tuple (`harness-store.ts:369-407`) +
  the `/mh-activate` mismatch message (`engine.ts:755-769`) — following the
  `minAgentTimeout`/`resourceEnforcement` idiom exactly.
  - **Back-compat trap (must-fix, the `ac0cd18` lesson):** an absent `workflowConfigHash` on
    either side must coalesce to the **empty-config hash** (hash of `{}`), NOT `undefined`, or
    every pre-workflow verdict spuriously mismatches a workflow-bearing active baseline.
  - **`--resume` trap:** `resumeIdentCheck`'s `runIdent` (`cmd-ab.ts:356-365`) is a SEPARATE,
    stricter per-key match. If threaded through resume at all, `workflowConfigHash` must be a
    separate `?? default`-coalesced guard OUTSIDE `runIdent` (like `resourceEnforcement`), never
    folded in — folding it in breaks `--resume` for every pre-existing partial (the file's own
    comments record this being learned twice).
- **Statistical gate = unchanged; harness construction = NOT.** The McNemar/splits/bootstrap
  gate is candidate-agnostic (zero change). But `cmd-run.ts`/`cmd-ab.ts` need the new
  `readWorkflowConfig` read-and-thread step (§ Architecture) — the ab re-runs both arms live
  and must compose arm B's `workflow.json` the way it composes arm B's playbook today.

## Compute bounds
`maxRetries` (default 2) caps the loop. Per task the workflow runs, worst case: 1 `[extract]`
+ up to `maxRetries+1` `[implement]` + up to `maxRetries+1` `[verify]` invocations = **up to
7 agent invocations** at the default (NOT "~2×" — that earlier claim was wrong).
**Per-node timeout policy (REQUIRED, was an open question):** the single `agentTimeout`
scalar must NOT be handed in full to every node, or worst-case wall-clock is ~7×budget
(~105 min at 900s). `[extract]` and `[verify]` are bounded, non-open-ended tasks → cap them
LOW (e.g. a fixed few-minutes cap), and reserve the full per-task budget for `[implement]`.
Plan resolves the exact split; leaning: `implement` = full `agentTimeout`, `extract`/`verify`
= a small fixed cap each. The load-aware scheduler's per-task profile still sees one
container lifecycle (unchanged), just with more internal invocations. **Budget-identity
records the (compute-affecting) config**, so a candidate that wins by spending more
re-baselines via the T6/T7 gate.

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

## Resolved decisions (code-architect review, 2026-07-20)
Verdict: **needs-revision → resolved** (no blockers). The 6 open questions, decided:
1. **Artifact path** → `/logs/.mh/plan.md` (outside `/app`). `verifier.ts` never touches
   `/logs/.mh` → **no purge step needed** (self-score.ts precedent). Resolved, not deferred.
2. **Verifier isolation** → **exec-in-place** in the implementer's staged container (no
   podman-commit primitive exists → a fresh container re-stages the whole dep tree per retry).
   Can't-edit enforced structurally via opencode `--agent` write/edit/patch deny.
3. **Verifier model** → same as the implementer for v1 (single-model-per-loop convention,
   [[tb2-baseline-account-global]]), included in `workflowConfigHash`/budget-identity from day one.
4. **`[extract]` shape** → **separate invocation** (needs its own instruction + must not
   inherit the implementer's `AGENTS.md`; a prepended instruction isn't independently
   re-checkable/loggable, undercutting the frozen-contract goal).
5. **Taxonomy judge** → reuse `runJudgeOpencode` / `judgeAgentConfig` (host-side, default
   `gemini-2.5-flash`); escalate only if agreement-sampling shows it's unreliable for MODE
   classification.
6. **budget-identity hash** → full config; the real care is the **empty-config-hash
   coalescing** back-compat (§ Data model), not "which fields."

## Plan split (review)
**Two plans, not one** — Component 1 (taxonomy) and Component 2 (engine) have no code-level
dependency (taxonomy reads `traj/*.ndjson` → `taxonomy.json`; the engine needs none of it):
- **Plan A — Failure-taxonomy** (build FIRST: read-only, cheap, fast; confirms with data that
  spec-precision is a material fraction before investing in Plan B). Files: new
  `failure-taxonomy.ts` (pure prompt/parse, reusing `runJudgeOpencode`) + `read/writeTaxonomy`
  in `harness-store.ts` + `cmd-failure-taxonomy.ts` + `cli.ts` wiring (model on `cmd-judge-audit`).
- **Plan B — Workflow-graph engine** (build second, only after Plan A's data justifies it).
  Smallest gateable increment order: (1) `WorkflowConfig` store plumbing + activate/writeActive
  (copy `AgentConfig`/`EnvPolicy` shape); (2) `runAgent` `instructionOverride` param; (3)
  `runWorkflow` with `{}` → byte-identical test; (4) `[extract]` node alone (frozen-plan
  persist/reuse); (5) `[verify]`+`[retry]` with a MOCK verifier (VERDICT parse, retry-bound,
  fallthrough); (6) one live e2e with a real verifier; (7) budget-identity + `/mh-activate`
  extension last. Decide explicitly in Plan B: **do verifier events pollute the implementer's
  stored trajectory?** (Plan A reads that same store — tag or exclude verifier events.)
