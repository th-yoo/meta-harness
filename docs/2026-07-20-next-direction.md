# Next Direction — from prompt-tuning to failure-analysis + workflow (2026-07-20)

## ⚠️ 2026-07-20 PIVOT (after AHE prior-art review) — read this first
The AHE deep-dive (`docs/2026-07-20-ahe-prior-art.md`, our exact problem, #3 on TB2) reshaped
the plan on hard evidence. **Two decisions:**
1. **Base agent → Opus 4.8** (was haiku). haiku's failures were capability-bound (no
   harness-fixable headroom); AHE's gains came on a strong model (GPT-5.4) where failures are
   scaffolding-fixable. TB2 stays hard enough for signal. **Re-baseline v0 on opus.**
2. **First evolvable component → memory (boundary-case lessons) + risk-hints middleware**
   (AHE's ablation winners: memory +5.6pp, middleware +2.2pp), **NOT verify-retry** (AHE
   shipped it as `ralph_loop.py` and evolution rejected it — self-graded tests are proxies)
   and **NOT the prompt** (regressed −2.3pp).
The workflow-loop spec (`docs/superpowers/specs/2026-07-20-workflow-loop-design.md`) keeps its
**Component 1 (taxonomy)** + all the store/gate/budget-identity machinery; its **Component 2
(verify-retry) is DEFERRED** and re-specced as memory/risk-hints. Our **statistical gate stays
the edge** — it's exactly the regression-blindness (11% recall) AHE names as its #1 limitation.
Adopt from AHE: the four-field predict-and-falsify contract (as gate-power + calibration input),
one-component-per-edit, k≥2 rollouts, the Agent-Debugger root-cause taxonomy method.

## TL;DR
The improvement loop is **validated** (it correctly rejects non-improvements) but the
**target has no headroom**: we've been tuning a thin playbook on an already-capable
agent. v0→v3 = 3 iterations, **0 pass-rate lift**. The pivot: stop tuning prompt-bullets,
start **analyzing failures** and building **enforced workflows** (verify-retry, spec-
extraction, tool-feedback) — the lever prompting structurally can't reach — and/or point
the same loop at a **target with real headroom** (raw model, stronger model, routing).

## Where we are (verified this session)
- **Loop machinery works.** propose→ab→activate with paired McNemar + held-out fold +
  sentinels + speed-tiebreak + budget-identity gating correctly rejects. v1/v2/v3 all
  rejected/inconclusive. v3 killed mid-held-out (2 pass-regressions on prove-plus-comm +
  tune-mjcf, zero pass-improvement, speed win only on a *tie* → negative held-in delta
  −0.08 blocked the tiebreak). **Not accepting garbage is the hard part, and it holds.**
- **Instruments are honest.** env-fidelity fix (v0 inflated 12/14 → honest 8/14),
  recordTimeouts, measured load-aware scheduler, staging-retry — all shipped.
- **But the results are flat.** No task-pass lift across the whole project.

## Why the target has no headroom (verified live)
The bench agent = **opencode + haiku, MINIMAL config, NO MCP, NO Claude Code.** Verified
by exec into a live bench container: one `opencode run … --model haiku` process, config =
`{"plugin":["opencode-claude-auth@latest"]}` (plugin-only, no `mcp:`). The
`claude-code-auth` plugin supplies only the oauth **token** (CC subscription credential) —
it does **not** run Claude Code or its MCP servers. (The Serena/MCP you see interactively
is your separate `claude -r` sessions, not opencode; interactive opencode loads its own
`mcp:[playwright]`, but the bench strips all of it.)

So our account-global playbook is a thin **additive** `AGENTS.md` on top of opencode's own
capable system-prompt + read/write/edit/bash loop. Largely **redundant** with what
opencode already does → near-zero marginal effect → the plateau.

## The diagnostic pivot: read WHY haiku fails, don't guess prompts
Failures split into classes, and the class determines the lever. Read the saved
trajectories (`candidates/vN/traj/*.ndjson`) — the agent's real actions — not the metadata.

- **spec-precision — WORKFLOW-FIXABLE (VERIFIED, openssl-selfsigned-cert).** haiku *had*
  the required values in the prompt (`instruction.md`: `dev-internal.company.local`,
  `devops team`, exactly 365 days), generated a *valid but generic* cert (invented subject
  `O = Dev…`), self-verified against its **own interpretation** ("Perfect!"), and scored 0.
  Not capability — it can make a cert. The **one-shot, no-feedback loop** is the failure.
  A passive prompt bullet ("verify against criteria", v3's rule) did **not** fix it (v3
  still 0/5): **advice ≠ enforcement.**
- **capability — NOT fixable by prompt or workflow** (likely: path-tracing, tune-mjcf,
  prove-plus-comm). Hard algorithmic / formal / numerical; haiku can't produce the
  solution regardless. Needs a stronger model or task-specific tools.
- **comprehension — TBD** (misread the task) → decomposition scaffold.

## Next direction (concrete)
1. **Build the full failure taxonomy first — no new runs.** Read every failing task's
   `traj/*.ndjson`, classify each as spec-precision / capability / comprehension. Output =
   the **addressable fraction**: how many band failures a workflow could flip vs how many
   are hard-capped. This decides whether a workflow intervention is worth building.
2. **Shift the optimization surface: prompt-bullets → WORKFLOW (enforced structure).**
   The loop's real product isn't a playbook; it's:
   - **verify-retry loop** — harness runs the check, feeds the failure back, agent fixes,
     loops (the openssl fix; tension: give the agent the SPEC/criteria, not the answer key
     — the env-fidelity fix removed both, needs a legitimate spec channel).
   - **extract-spec checklist** — force literal-requirement extraction → verify each item
     against actual output before "done."
   - **tool-feedback** — give the agent the objective signal it lacks (image-diff score for
     path-tracing, sim-time for tune-mjcf) so it can iterate to the target.
   - **best-of-k selection** — only for variance-bound (not systematic) failures; useless
     for spec-mismatch (all k attempts miss the same detail).
3. **OR change the target for headroom** (orthogonal, higher-leverage than v4/v5):
   - **raw model** (prompt = the whole scaffold) — the clean self-improvement experiment;
   - **stronger model** (haiku→sonnet) — different capability ceiling;
   - **task-routed rules** (the generality axis) — a rule that helps one task without
     fighting another.
4. **Cheapest gate before spending on v4: no-injection vs v0 diagnostic.** If they score
   the same, the playbook contributes ≈0 on opencode and *no* vN moves pass-rate — proving
   the veneer hypothesis and forcing the pivot.

## Reframe of success
On a near-ceiling target, the loop's honest output is **convergence + speed-wins +
not-regressing** (correctly plateau), NOT monotonic pass gains. The validated **loop
machinery is the reusable asset** — point it at a surface with real mass (workflow, or a
headroom target), not at feathers (a playbook on an already-good agent).

## Literature backing (deep-research 2026-07-20, 24/25 claims confirmed, peer-reviewed)
**Full cited report: [`2026-07-20-deep-research-failure-analysis-workflow.md`](2026-07-20-deep-research-failure-analysis-workflow.md)** (all 7 findings + evidence + sources + caveats + open questions). Condensed here:

The 2023–2026 literature strongly supports this pivot. Three convergent conclusions:

**1. A failure-taxonomy step is buildable — but do MODE classification, NOT step-attribution.**
- **MAST** (Multi-Agent System Failure Taxonomy, arXiv 2503.13657, Berkeley/Stanford): 14
  modes / 3 categories; ships an LLM-as-judge annotator at **94% accuracy, κ=0.77** vs
  experts → trace-level MODE labeling is reliable without human labels. (Caveat: its
  inter-agent category ~37% is inapplicable to a single agent.)
- **TRAIL** (arXiv 2505.08638, Patronus): 3-tier schema (reasoning / execution / planning);
  its reasoning + output-generation leaves — incl. **instruction-noncompliance,
  output-formatting** — directly seed our "spec-precision" leaf.
- **ATLAS** (github multi-agent-systems-failure-taxonomy/ATLAS): *induces* a system-specific
  taxonomy (15–30 codes) from the agent's OWN traces — best fit for our loop (learn the
  taxonomy from our trajectories, don't impose one). Also: AgentErrorTaxonomy (memory/
  reflection/planning/action/system).
- **BUT step-level "who/when/where" attribution is UNSOLVED**: Who&When (ICML 2025) best
  = **53.5% agent / 14.2% step**; TRAIL best (Gemini-2.5-Pro) = **~11% joint**; frontier
  reasoners (o1, R1) near-random at step-pinpointing. Specialized AgenTracer-8B hits 69%
  agent-level but is multi-agent + unreplicated. → **classify the failure MODE + rely on
  the executable verifier for ground truth; do not ask an LLM to pinpoint the decisive step.**

**2. On a FIXED model, WORKFLOW structure beats prompt-tuning — directly explains our plateau.**
- **Agentless** (arXiv 2407.01489, FSE 2025): a deliberately *non-agentic* fixed 3-phase
  pipeline (localize → repair → validate) beat **all** open-source agents at publication —
  32.0% SWE-Lite / 38.8% SWE-Verified, ~$0.70/instance.
- **DirectSolve** (arXiv 2505.08120): CoT-decomposition + code-restatement took Gemini-1.5-Pro
  **9% → 32%** pass@1; removing the CoT step alone collapsed it back to 9% — a **23-point
  structural lever**, not a playbook tweak.
- **best-of-N patch selection via self-generated reproduction tests** = the single biggest
  ablated component in Agentless: majority-vote 77 → +regression-tests 81 → **+reproduction-
  tests 96 fixes (+15)**. → structural/workflow choices, not a supplementary prompt layer,
  own the large pass-rate movements. This is our redundant-veneer plateau, named.

**3. The "looks-done" verification gap is a NAMED result — our diagnosis is exactly right.**
- **Huang et al., "LLMs Cannot Self-Correct Reasoning Yet"** (arXiv 2310.01798, ICLR 2024,
  DeepMind): *intrinsic* self-correction (no external signal) **degrades** accuracy (GPT-4
  GSM8K 95.5% → 91.5%); the prior +8.4 "gain" came entirely from an **oracle stop-signal** —
  remove it and the improvement goes negative.
- **Kamoi et al.** (TACL 2024, arXiv 2406.01297): the bottleneck is **feedback generation,
  not refinement** — models fix errors *given* reliable feedback but can't reliably generate
  it on their own output. Self-correction works only with **external/executable** feedback
  (interpreter, environment). → an agent self-verifying against its own interpretation is
  the literature's exact failure; **gate on external ground truth.**
- **Reflexion** (NeurIPS 2023, arXiv 2303.11366): verbal-reinforcement over episodic memory
  + execution feedback → **HumanEval pass@1 91% (+11)** on a frozen model. BUT self-generated
  verifiers are **gameable — 16.3% false-positive on MBPP** (submission passes all its own
  tests yet fails the hidden test). R2E-Gym (COLM 2025) + "Verification Horizon" (proxy
  divergence widens under optimization pressure) confirm: **keep ground-truth acceptance
  separate from the agent's own tests; prefer executable verifiers; watch reward-hacking.**

**Gap:** Part 3 (DGM/ADAS/AlphaEvolve/GEPA/DSPy — do gains come from workflow vs prompt
search, do they plateau on a strong base?) yielded **no verified claim** — the DGM search
result asserts "gains come from workflow/tools, not weights" (DGM freezes the model,
self-modifies its agent *code*) but it didn't survive the top-25 verify cut. Needs a
dedicated follow-up.

## Sharpened plan (research-informed)
1. **Failure-taxonomy step = trace-level MODE classification** (MAST-style LLM-judge, ~94%
   feasible), seeded with TRAIL's single-agent leaves + a dedicated **spec-precision** leaf
   ("dropped literal spec value / self-verified against own interpretation"). Optionally
   ATLAS-style: induce the taxonomy from our own `traj/*.ndjson`. **Not** step-pinpointing.
2. **Loop optimizes WORKFLOW, not the playbook.** The same validated ab-gate + budget-identity
   machinery can gate workflow variants (retry policy, decomposition, verifier config,
   best-of-N k) exactly as it gates prompt candidates — the high-leverage reuse of what we built.
3. **Give the agent a LEGITIMATE feedback channel** (the env-fidelity fix removed the answer
   key — correctly). Options, in leverage order: **best-of-N with self-generated reproduction
   tests** (biggest ablated lever) → **requirement/checklist extraction + literal self-check**
   → **execution/tool feedback** (Reflexion-style). Keep the harness's hidden verifier as the
   SEPARATE ground-truth gate; never let the agent's own tests be the acceptance signal.
4. **Cheapest confirmation first:** no-injection vs v0 diagnostic.

Sources (primary): arXiv 2503.13657 (MAST), 2505.08638 (TRAIL), 2505.00212 / PMLR v267
(Who&When), 2509.03312 (AgenTracer), 2407.01489 (Agentless), 2505.08120 (DirectSolve),
2310.01798 (Huang/ICLR24), 2406.01297 (Kamoi/TACL24), 2303.11366 (Reflexion), 2504.07164
(R2E-Gym), ATLAS (github).

## Status at time of writing
- v3 ab killed after held-in (not accepted; active stays v0). Held-in result checkpointed
  to git (`71b3cf5`). All code pushed; podman reboot-fix permanent (`events_logger=file`).
