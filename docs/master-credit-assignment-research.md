# Master credit-assignment research (2026-07-16) — R4 follow-up

Companion to `master-open-questions-research.md`. That doc left **R4 —
orchestrator/manager credit assignment — UNRESOLVED (gap)**: no claim survived
3-vote verification, and the interim note ("a deterministic master likely needs
no LLM-fitness at all") flagged the need for a dedicated pass. This is that pass.

Scope: how the fleet master attributes **credit/blame for a global outcome**
(a task passes/fails a verifier; a harness candidate wins/loses the A/B gate; a
squad slice merges or doesn't) **to the individual contributions** — which
role, which node, which proposal/candidate — so the evolution loop reinforces
what actually helped, **across sessions**.

**Hard constraint (from R4 / D8, decided):** the master is a **DETERMINISTIC
orchestrator with NO LLM-fitness in its own decision path**. So the
credit-assignment mechanism must be **groundable** — derivable from objective
signals (pass/fail, diffs, gate verdicts, trajectories) — NOT "an LLM judges who
did well." An LLM may be a leaf that *produces* a groundable artifact, but must
never *be* the fitness authority.

Convention (as in the parent doc): **this-system facts** are stated from the
repo; **literature** claims carry a source URL, and where sources disagree it is
said so. Speculative extensions are flagged `[SPECULATIVE]`.

---

## 1. Problem framing — the gap in THIS system, precisely

### 1.1 What is ALREADY solved (do not rebuild it)

Two of the three attribution granularities the question names are already
grounded and deterministic in the shipped code:

**(a) Credit to a PROPOSAL/CANDIDATE = the A/B gate delta. Shipped.** The `ab`
gate is *already a difference-reward machine*. `candidates/<vN>/ab-verdict.json`
carries `taskResults[taskId] = { candidate: [k pass/fail rounds], active: [k
rounds], phase, sentinel }` — the **same frozen task split** run *with* the
proposed rule (`candidate`) versus *without* it (`active` baseline), k rounds
each. `opencode-plugin/src/bench/ab-stats.ts::pairedRunStats()` returns the
per-task paired delta `taskDeltas` = (candidate − active), plus discordant-pair
counts `b`/`c`; `mcnemarExactOneSided(b,c)` and `bootstrapTaskCi()` give the
p-value and CI; `cmd-ab.ts` pins the split by `splitHash`, stratifies
held-in / held-out / **sentinels**, supports `resume`, and futility-early-kills
a losing candidate after `minTasks`. **A candidate's credit is therefore already
a deterministic, CI'd difference reward** — no LLM judges it. This is the anchor
the rest of the design reuses.

**(b) Credit to a ROLE within a squad = local-gate process scoring. Decided
(§6).** The squad runner is a **deterministic** A→D→I→E state machine (no LLM
orchestrator). §6's rule — "**one score per DRIVE, adjudicated by the drive's
natural judge**" — maps typed runner events to per-role good/bad via a fixed,
objective table (payload-lint fail → that slot bad; Gate 1 approve/revise →
analyzer; Gate 2 → designer; VERDICT PASS/FAIL → implementer; **FAIL-design →
implementer NEUTRAL / absolved**; evaluator payload well-formed → evaluator).
This is *process supervision* (§4), and it is already groundable: the "judge" is
a lint check or a gate transition, not an LLM verdict.

### 1.2 What is NOT solved — the actual R4 gap

Three things remain open, and they are the subject of this doc:

1. **Outcome-vs-process miscalibration (per-node).** §6's local-gate scoring is
   a *process* signal. A role can pass its local gate yet the slice fails
   downstream (a "convincing wrong" — good process, bad outcome), or vice-versa.
   §6 already sees this: evaluator-**v2** proposes confusion-matrix scoring of
   the evaluator against the *merge* outcome (PASS+merge-accept = good,
   PASS+merge-reject = missed defect, FAIL+override = false alarm). That is
   exactly the PRM-vs-ORM calibration problem (§4), currently deferred and only
   sketched for one role.

2. **Global-outcome → multi-contributor attribution.** When a single global
   outcome (a whole slice's final merge, or a harness candidate that bundles
   several changed bullets) depends on *many* contributions, how much credit
   does each get? §6 deliberately does **no retroactive scoring** — a
   late-discovered defect lands as an *upstream-hop meta-metric*, never a
   re-score. That keeps attribution unambiguous and append-only, but it means
   the loop does not currently push outcome credit *back* onto the specific
   upstream role/bullet/node that caused it. This is the classic multi-agent
   credit-assignment problem (§3), and §6 currently side-steps it by design.

3. **Cross-session accumulation ("the future unlock").** Today only
   `nPass`/`nFail` accumulate per candidate version, and bullets carry
   LLM-authored `helpful`/`harmful` counters (`propose.ts`,
   `applyBulletAssessments`). There is no persistent, *gate-derived*
   per-contributor **credit ledger** that sums a bullet's / role's / node's
   measured contribution across every session and slice it participated in. D6
   ("one store per role NAME across all depths; nodePath = provenance") is the
   substrate for it, but the ledger itself is unbuilt.

The deterministic constraint sharpens the gap: we may **not** close it by
bolting an "LLM-as-judge who did well" onto the master. Everything below must
reduce to arithmetic over objective gate verdicts.

---

## 2. Literature survey — mechanisms, cited, with fit verdicts

Umbrella: a April-2026 survey ("From Reasoning to Agentic: Credit Assignment in
RL for LLMs", Zhang et al.) catalogs **47 CA methods (2024–early 2026)** on a 2-D
taxonomy — *granularity* (token / segment / step / turn / multi-agent) × *method*
(Monte-Carlo / TD / model-based / game-theoretic / information-theoretic). *(Seen
via ResearchGate listing; not independently fetched — treat as a pointer, not a
verified claim.)* The families the R4 brief names sit in the multi-agent row and
the game-theoretic/model-based columns; they are surveyed below.

### 2.1 Difference rewards / Wonderful-Life / Aristocrat utility (Wolpert & Tumer)

**Core idea.** Give agent *i* a *shaped* reward = global reward minus the reward
the system would have gotten had *i* taken a **default action** (its action
"clamped" out): `D_i = G(z) − G(z_{-i})`. If the system is *factored*, raising
`D_i` cannot lower the global objective — so difference rewards align local and
global optima. The "Wonderful Life Utility" is the variant that removes the agent
entirely; "Aristocrat utility" clamps to the expected action.
Source (primary): Wolpert & Tumer, "Optimal Wonderful Life Utility Functions in
Multi-Agent Systems", NASA NTRS
<https://ntrs.nasa.gov/api/citations/20010071848/downloads/20010071848.pdf>.
**Cost/needs:** a way to evaluate the counterfactual `G(z_{-i})` — a simulator, a
learned reward model, or (in a replayable system) an actual re-run. Choosing the
default action is the hard part in general RL.
**Fit: STRONG and directly compatible.** A difference reward *is* an ablation:
candidate-with vs candidate-without on the same input, scored by an objective
gate. Our `ab` `taskDeltas` (§1.1) is exactly `D` for a whole candidate. The
"default action" for us is unambiguous — the **active baseline** (the rule
absent) — which dissolves the usual default-action difficulty.

### 2.2 COMA — counterfactual multi-agent policy gradients (Foerster et al.)

**Core idea.** A centralised critic estimates `Q(s, a)`; each agent's advantage
uses a **counterfactual baseline** that *marginalises out that one agent's
action while holding the others fixed* — an aristocrat-utility difference reward
computed by the critic in a single forward pass, avoiding an explicit simulator.
Sources (primary, verified): arXiv <https://arxiv.org/abs/1705.08926>; AAAI-18
<https://ojs.aaai.org/index.php/AAAI/article/view/11794>. Difference-reward
policy-gradient variant without a critic: Castellini et al., "Difference Rewards
Policy Gradients" <https://arxiv.org/abs/2012.11258>.
**Cost/needs:** a learned centralised critic (an approximator) — precisely the
"parametric approximation" that a deterministic master must avoid *as a fitness
authority*.
**Fit: idea YES, mechanism NO.** The *counterfactual-baseline* idea is exactly
right; the *learned critic* is not — it would smuggle a fitted (non-groundable)
scorer into the credit path. We keep COMA's counterfactual and replace its critic
with an **actual gate re-run** (feasible because our system is replayable — see
§2.7 / §5).

### 2.3 Value decomposition — VDN / QMIX (implicit credit assignment)

**Core idea.** Learn per-agent value functions `Q_i` whose **sum (VDN)** or
**monotonic mix (QMIX)** reconstructs the team `Q_tot`; individual credit is read
off the decomposition. Solves the "lazy agent" / spurious-reward problem.
Sources (primary): VDN, Sunehag et al. <https://arxiv.org/abs/1706.05296>; QMIX,
Rashid et al., PMLR v80
<https://proceedings.mlr.press/v80/rashid18a/rashid18a.pdf>.
**Cost/needs:** deep networks trained end-to-end over many episodes; credit is
*implicit* (a learned factorisation, IGM assumption).
**Fit: NO (for the master's credit authority).** It is a learned model with no
groundable read-out; and it needs a training regime we don't have (we have tens
of gate runs, not millions of episodes). Useful only as conceptual contrast:
value decomposition is the *implicit* pole; our need is the *explicit*,
gate-grounded pole (difference rewards / Shapley).

### 2.4 Shapley-value attribution (game-theoretic, explicit)

**Core idea.** The unique credit split satisfying efficiency, symmetry, dummy,
additivity: agent *i*'s credit = its **average marginal contribution over all
orderings/coalitions**, `φ_i = Σ_S [v(S∪{i}) − v(S)] · weight(S)`. Unlike
leave-one-out (a *single* coalition), Shapley accounts for **interactions**
(components that only help together).
Sources: general/cost — Molnar, *Interpretable ML*, Shapley chapter
<https://christophm.github.io/interpretable-ml-book/shapley.html> ("exact
requires evaluating all `2^p` coalitions"; Monte-Carlo sampling approximation of
Štrumbelj & Kononenko). SHAP origin: Lundberg & Lee, NeurIPS 2017 (cited therein).
MARL: "Shapley Counterfactual Credits for MARL"
<https://arxiv.org/abs/2106.00285> — Monte-Carlo sampling reduces cost
factorial→polynomial; the authors report **~4–5 samples/step sufficed** on
StarCraft II. LLM multi-agent: **SHARP**, "Who Deserves the Reward?"
<https://arxiv.org/abs/2602.08335> (2026) — a Shapley-based per-agent
marginal-credit reward + global + tool-process reward, +23.7%/+14.1% over
single/multi-agent baselines. Faster estimators: Witter et al.,
"Regression-adjusted Monte-Carlo Estimators for Shapley Values"
<https://arxiv.org/abs/2506.11849>.
**Cost/needs:** exact = `2^N` coalition evaluations; sampled = `O(M·N)` with
small `M`. Each "evaluation" for us is a **gate re-run** — so cost is the real
constraint (§5.3).
**Fit: PARTIAL, deferrable.** Shapley over *gate re-runs* stays deterministic
(each coalition is an objective evaluation; the aggregation is arithmetic — no
learned scorer). But it is `2^N`/`O(MN)` gate runs where leave-one-out is `N`.
Adopt only *if* interactions between components prove to matter — an
evidence-gated escalation, consistent with §6's "no weights = premature
sophistication with zero evidence."

### 2.5 Temporal / hierarchical credit assignment (RUDDER, Hindsight CA)

**Core idea.** Assign credit *across time / a DAG* when reward is delayed.
**RUDDER** (Arjona-Medina et al. <https://arxiv.org/abs/1806.07857>,
<https://ml-jku.github.io/rudder/>) trains a sequence model to predict the
episodic return, then **redistributes** it to the steps whose contribution
analysis moved the prediction (`c_t = R(s_{0:t}) − R(s_{0:t−1})`) — turning
delayed-reward credit into a regression problem, aiming for zero expected future
reward. **Hindsight Credit Assignment** (Harutyunyan et al., NeurIPS 2019
<https://arxiv.org/abs/1912.02503>) assigns credit to past decisions by the
*likelihood they led to the observed outcome* — using time as evidence, not as a
proxy; explicitly attacks "Issue 4: no counterfactuals" of TD(λ).
**Cost/needs:** a learned return-decomposition / hindsight model.
**Fit: idea relevant, mechanism NO.** Confirms that a DAG-wide backward credit
signal is a *real* capability gap (the thing §6's "no retroactive scoring"
declines to build). But both use learned models. If we ever want DAG-backward
credit, the deterministic analogue is again **re-run-based return decomposition**
(replay the DAG with one node clamped to baseline; the outcome delta is that
node's redistributed return) — RUDDER's decomposition made exact by replay rather
than regressed.

### 2.6 Process vs outcome supervision (PRM vs ORM)

**Core idea.** ORM scores only the **final result**; PRM scores **each step**.
PRM gives precise localisation and better credit assignment; ORM is cheap and
robust-to-step-hacking but sparse. Sources (primary): Lightman et al., "Let's
Verify Step by Step" <https://arxiv.org/abs/2305.20050> (PRM solves 78.2% vs ORM
72.4% on a MATH subset; PRM800K); Uesato et al., "Solving Math Word Problems with
Process- and Outcome-based Feedback"
<https://mathai2022.github.io/papers/26.pdf> (arXiv 2211.14275); framing — Ought,
"Supervise Process, not Outcomes" <https://ought.org/updates/2022-04-06-process>.
**Consensus vs contested:** *Contested / domain-dependent.* Lightman found PRM
**clearly** better (MATH, strong model, lots of labels); Uesato found PRM and ORM
gave **similar final-answer accuracy** on GSM8K (PRM's win was on *reasoning*
correctness). Recent surveys report **hybrid** `αR_process + βR_outcome` as the
emerging default (e.g. Zheng et al., "A Survey of Process Reward Models", Oct
2025). So: neither dominates; the win is combining them.
**Fit: DIRECTLY maps to §6.** §6 local-gate role scores = process supervision;
`ab` verdict + final merge = outcome supervision. The meta-harness is *already*
the hybrid the literature endorses. The R4 refinement (§1.2 item 1) is exactly
evaluator-v2: **calibrate the process gate against the outcome** — deterministically.

### 2.7 Credit assignment in LLM-agent / multi-agent pipelines (the on-point work)

This is the newest and most directly relevant cluster.

- **C3 — "Exact Is Easier: Credit Assignment for Cooperative LLM Agents"**,
  Chen et al., arXiv <https://arxiv.org/abs/2603.06859> (2026; code
  github.com/EIT-EAST-Lab/C3). **THE strongest source for our setting** (verified
  via abstract fetch). Claim: standard MARL assumes exact counterfactual
  evaluation needs *privileged environment access* and is therefore approximated
  (learned critics, agent-removal). **In cooperative LLM systems this premise is
  false** — "interaction histories are **deterministic functions of observable
  text with no hidden state**, so any decision point can be **restored exactly**,
  making direct causal measurement possible without parametric approximation."
  C3 fixes the complete history at a decision point, re-samples alternatives under
  a **frozen behavior policy**, and computes **unbiased per-decision advantages
  via a parameter-free leave-one-out baseline**. It beats all learned/approximate
  baselines across 6 benchmarks (math + code), and **checkpoint restoration
  reduces token cost**. Bonus: "the same structural property that enables exact
  credit enables **exact verification** — three independently computable
  diagnostics (credit fidelity, within-group variance, inter-agent influence) —
  the first method-agnostic **auditing** tool." *(One paper, 2026, not yet
  widely replicated — flag as recent; but it is the theoretical license for our
  approach.)*
- **"Which Agent Causes Task Failures and When?" (Who&When)**, Zhang et al.,
  ICML 2025 Spotlight, arXiv <https://arxiv.org/abs/2505.00212>, PMLR v267
  <https://proceedings.mlr.press/v267/zhang25cq.html>. Benchmarks *automated
  failure attribution*. **Best method: 53.5% accuracy naming the responsible
  agent, only 14.2% pinpointing the step; some methods below random; even o1 /
  DeepSeek-R1 are not practically usable.** **This is the empirical case for the
  deterministic constraint:** an LLM-judge asked "who failed / at which step" is
  near-random on steps. Do NOT make an LLM the fitness authority.
- **MAST — "Why Do Multi-Agent LLM Systems Fail?"**, Cemri et al., arXiv
  <https://arxiv.org/abs/2503.13657>. 14 failure modes in 3 categories (a
  taxonomy; e.g. "1.2 Disobey Role Specification"). Relevant as a *blame-category
  vocabulary* — a cousin of `propose.ts`'s `FAILURE_TAXONOMY`.
- **"Unifying Temporal and Structural Credit Assignment in LLM-Based Multi-Agent
  Prompt Optimization"**, arXiv <https://arxiv.org/abs/2605.30227> (2026).
  Decomposes multi-agent LLM trajectories along **rounds (temporal) × roles
  (structural)**, gives component-level attribution *without altering inference or
  parameters*, then does **credit-guided prompt optimization** — focusing prompt
  edits on the weak components, reducing regressions vs black-box edits. **This is
  the closest analogue to the meta-harness's own loop** (evolve per-role
  `system.md` from a credit signal); it validates "attribute, then edit only the
  culpable component."
- **Traceability & Accountability in Role-Specialized LLM Pipelines** (survey;
  Barrak, Oct 2025)
  <https://www.emergentmind.com/topics/traceability-and-accountability-in-role-specialized-multi-agent-llm-pipelines>
  (*secondary/aggregator source*). Formalises `origin(i) ∈ {NONE, PLANNER,
  EXECUTOR, CRITIC}` — localise the *earliest unsolved error* to a role-stage —
  over immutable audit trails / provenance graphs. Maps to our `nodePath`
  provenance + trajectory store.
- **Anti-pattern to name explicitly:** "Speaking the Language of Teamwork:
  LLM-Guided Credit Assignment in MARL", Lin et al., NeurIPS 2025 workshop
  <https://neurips.cc/virtual/2025/136076> — an **LLM generates dense per-agent
  rewards** from a task description. Effective in their setting, but it is
  precisely the design our deterministic constraint **forbids for the master**:
  the LLM becomes the fitness authority.

### 2.8 Survey verdict table

| Mechanism | Needs as input | Deterministic-master compatible? | Cost |
|---|---|---|---|
| Difference reward / WLU (§2.1) | counterfactual eval of `G(z_{-i})` | **YES** — clamp = active baseline, gate = authority | 1 re-eval per component |
| COMA counterfactual (§2.2) | learned centralised critic | idea yes, **critic no** | — |
| VDN / QMIX (§2.3) | end-to-end training, IGM | **NO** — learned, implicit | huge data |
| Shapley (§2.4) | coalition evals | **YES** if evals = gate runs; aggregation is arithmetic | `2^N` exact / `O(MN)` sampled |
| RUDDER / Hindsight (§2.5) | learned return/​hindsight model | idea yes, **model no** (replay analogue instead) | — |
| PRM vs ORM (§2.6) | step vs final labels | **YES** — both already groundable in §6 | cheap |
| C3 exact LLM credit (§2.7) | deterministic replay + frozen policy | **YES — this is our license** | leave-one-out gate re-runs |
| Failure-attribution LLM judge (§2.7 Who&When) | an LLM judge | **NO** (near-random; forbidden authority) | — |

---

## 3. Mapping to the meta-harness — build ON the shipped signals

Groundable signals that already exist (no parallel infra needed):

| Signal | Where | Granularity | What it grounds |
|---|---|---|---|
| `taskResults` + `pairedRunStats().taskDeltas` | `ab-stats.ts` / `ab-verdict.json` | per-task, per-**candidate** | **difference reward** of a candidate vs active on a frozen split (with − without) |
| McNemar `b,c` + `mcnemarExactOneSided`, `bootstrapTaskCi` | `ab-stats.ts` | per-set | significance/CI on the delta (paired, cluster-aware) |
| frozen split + `splitHash` + **sentinels** + `resume` + futility early-stop | `cmd-ab.ts` | run-level | reproducible re-runs on identical tasks; cheap bounding levers |
| §6 event→score table | squad runner | per-**role drive** | process credit (gate/​lint/​verdict), FAIL-design absolution |
| evaluator-v2 confusion matrix | §6 (deferred) | per-role vs merge | outcome-calibration of a process gate |
| `score.json` `SessionRecord` (`passed`,`turnCount`,`toolUsage`) + `traj/*.ndjson` | store | per-session | replayable evidence; proposer input |
| `nodePath` provenance, D6 one-store-per-role-NAME | store topology | cross-depth/​session | the accumulation substrate |
| candidate `meta.json`, `diagnosis.json`, bullet `helpful`/`harmful` | `propose.ts` | per-candidate/​bullet | provenance + (LLM-authored, **advisory**) assessments |

**The key realization:** difference-reward credit is *already implemented* — it
is `pairedRunStats().taskDeltas`. The R4 work is not to invent a scorer; it is to
(1) run that same primitive on **ablated** inputs to get *per-component* credit
below the candidate level, (2) calibrate the §6 process gates against outcomes,
and (3) persist the deltas into a cross-session ledger. All three reuse the ab /
split / provenance machinery.

Two ablation "axes" the master can exercise, both scored by the *identical* gate:
- **Bullet/rule ablation (cheap, tier-1, shippable):** take a *winning* candidate
  whose diff added/updated ≥2 bullets, rebuild a variant with one bullet reverted
  to baseline, re-run `ab` on the **same frozen split** → `taskDeltas` of that
  variant vs full candidate = that bullet's leave-one-out credit.
- **Role/node ablation (tier-2, gated on squad-on-bench):** swap one role's
  `system.md` back to baseline (or one node to a default), re-drive the slice/arm
  → outcome delta = that role/node's contribution. Feasible *only* once a squad
  node is driveable as a bench arm (§1 squad-on-bench contract — currently a
  deferred one-paragraph interface, not built) — see Open Questions.

---

## 4. Recommendation — staged, groundable, bounded

**Headline:** adopt **exact-by-replay counterfactual difference rewards** —
ablate a component, re-run the *same frozen gate split*, take the paired delta —
as the credit primitive. This is COMA's counterfactual baseline (§2.2) and
Wolpert–Tumer's difference reward (§2.1) with the learned critic replaced by an
actual gate re-run, which is sound **because our system is deterministic and
replayable** (C3, §2.7). The **master schedules** the ablation gate-runs and
**derives** credit arithmetically from the verdicts; it never scores anything.

### Stage 0 — name what's already there (zero build)

- **Per-candidate credit := the `ab` `taskDeltas`** (with-rule − without-rule),
  significance from McNemar/bootstrap. Already the activation gate; just *label*
  it the credit signal in the master's vocabulary.
- **Per-role process credit := §6 local-gate scores.** Already deterministic.

### Stage 1 — leave-one-out ablation credit + outcome calibration (cheap, tier-1)

1. **Per-bullet difference reward (bullet ablation).** After a candidate **wins**
   its `ab` gate and its diff touched ≥2 bullets, the master schedules ≤`N`
   leave-one-out re-runs (`N` = changed bullets, already capped at ≤3 by the
   proposer's `≤3 ops`). Each re-run reuses the **same `splitHash`**; credit of
   bullet *j* = `pairedRunStats(fullCandidate) − pairedRunStats(candidate∖j)` on
   that split. Deterministic; the CI/p-value machinery already exists.
2. **Outcome-calibrate the process gates (build evaluator-v2, generalise it).**
   Turn the §6 evaluator-v2 sketch on: score every role's local-gate verdict
   against the eventual **merge outcome** via the confusion matrix
   (PASS+merge-accept = TP … FAIL+override = FP). This is the deterministic
   PRM→ORM calibration (§2.6) — the process gate stays the fast signal, the
   outcome corrects its miscalibration, all from objective events.

### Stage 2 — Shapley only on evidence (future, gated)

Leave-one-out ignores **interactions** (two bullets that only help together get
mis-credited). *If and only if* leave-one-out credit is observed to disagree with
outcomes for a layer, escalate that layer to **sampled Shapley over gate re-runs**
(`M≈5` per §2.4's MARL result) — still deterministic (each coalition = one gate
run; aggregation = arithmetic). Register as deferred; do not build pre-evidence.

### Stage 3 — DAG-backward credit (future, likely out-of-scope)

Re-run-based return decomposition (RUDDER-by-replay, §2.5) for cross-node
backward credit. This **contradicts §6's deliberate "no retroactive scoring."**
Flag as a genuine design fork for the human (Open Q2); do not adopt silently.

### Where it plugs into the master build-plan

The master's three credit jobs are all deterministic and sit beside its existing
`.fleet/state.json` / slice-stamp / `squad-run` duties:

1. **Stamp** every drive / candidate / node with provenance (session, `nodePath`,
   version) — mostly already done.
2. **Schedule** the ablation gate-runs when a global outcome resolves and
   per-component credit is wanted — a new deterministic scheduling job, same shape
   as scheduling an `ab` run today.
3. **Derive + append** credit = arithmetic over the returned verdicts → the
   cross-session ledger (§6-cross-session).

The **fitness authority remains the `ab`/gate verdict**, never the master and
never an LLM. LLM leaves only *produce* candidates/diagnoses (groundable
artifacts); the gate and the ablation delta decide credit. R4/D8 satisfied by
construction.

### Cost, and how to bound it (do not hand-wave)

Ablation costs extra gate runs. Concrete bounding, using shipped levers:

- **Only ablate winners with ≥2 changed components.** Losers already rejected;
  single-bullet candidates need no decomposition (their credit = the whole
  verdict). The proposer's `≤3 ops` cap makes `N ≤ 3` → **≤3 re-runs**, usually 1.
- **Re-run only the discordant tasks.** Credit lives entirely in the McNemar
  discordant pairs (`b`,`c` in `pairedRunStats`) — the tasks where candidate and
  baseline *differed*. Ablate over just those tasks, not the whole band. On the
  loop-1 numbers (band ≈ 14 tasks, typically a handful discordant) this is a
  large cut.
- **Reuse the frozen split + sentinels; futility early-stop.** Same `splitHash`,
  same k; `cmd-ab.ts`'s `resume` + `netBehind` early-kill stop an ablation as soon
  as a component's contribution is decided.
- **Best-effort under the D8.3 global resource cap.** Credit refinement is
  *deferrable* — it never blocks the main loop; the master schedules it as
  fair-share fill under the one global LLM/disk/quota cap. A busy fleet simply
  accrues per-candidate credit (Stage 0, free) and back-fills per-bullet credit
  when idle.
- **Shapley stays off** until Stage-2 evidence, so `2^N` never bites by default.

Net: default overhead is **0–3 short gate re-runs per accepted candidate, over
only the discordant tasks, deferrable** — not a new benchmark pass.

---

## 5. Cross-session angle — the "future unlock"

**Persist gate-derived deltas into a per-contributor credit ledger, append-only,
keyed by D6 provenance.** Concretely: extend the per-version `score.json` /
`meta.json` with a **contribution ledger** keyed by
`(role-name store, bullet-id | candidate-version, nodePath)` that accumulates the
Stage-1 `taskDeltas` (and, where present, the outcome-calibrated per-role
scores). Because D6 pools by **role NAME across all depths and sessions** and
`nodePath` is provenance (not a store split), a bullet's credit **sums across
every slice and session it participated in** — so the loop reinforces what helps
*generally*, filtering per-session noise. This is precisely the
"cross-session credit assignment is the future unlock" from prior design.

Wiring it in:
- **Curator prune signal.** The curator already prunes on `helpful − harmful`
  (`CURATOR_BUDGET`, `propose.ts`). Replace/override that with **accumulated
  gate-Δ credit** wherever a bullet has been ablated — an objective keep/prune
  criterion instead of the LLM's advisory guess.
- **Proposer prior.** Feed accumulated Δ-credit alongside the existing
  rejected-candidate ab-verdicts already fed to the proposer — so it learns which
  *kinds* of rule earn positive measured credit, not just which got rejected.
- **Append-only, provenance-tagged** — consistent with §6's "scores stay
  append-only, attribution unambiguous."

`[SPECULATIVE]` Longer term, the C3 "exact verification" diagnostics (credit
fidelity / within-group variance / inter-agent influence, §2.7) could be computed
over the ledger as a deterministic **audit** that the credit signal is healthy —
a natural fit for the master's "expose your state" posture (R1).

---

## 6. Re-check against the deterministic constraint (self-review)

Guarding against an LLM-fitness backdoor:

- **Credit number = a paired pass/fail delta from gate re-runs.** No LLM scores
  it. The aggregation (leave-one-out subtraction; optional Shapley averaging) is
  arithmetic. ✓
- **The proposer/diagnoser LLM writes `bulletAssessments {helpful|harmful}` — but
  those are ADVISORY.** The ledger's *authoritative* credit is the gate-derived Δ.
  **Risk:** if `applyBulletAssessments` were allowed to drive pruning *unchecked*,
  that would be an LLM-fitness backdoor. **Mitigation (explicit):** gate-Δ
  **overrides** the LLM assessment wherever both exist; the LLM assessment is only
  a *fallback prior* for components never ablated. State this in the build-plan.
- **Empirical backstop:** Who&When (§2.7) shows LLM-judge step attribution is
  near-random (14.2%). The ablation-delta sidesteps LLM judgment entirely — the
  strongest external reason to keep the authority deterministic.
- **§6 process gates are already deterministic** (lint, gate transitions, VERDICT
  PASS/FAIL); evaluator-v2 calibrates them against an objective merge outcome. No
  LLM fitness introduced. ✓
- **The master schedules and derives; it does not judge.** Its correctness stays
  *operationally verifiable* (did it stamp provenance? schedule the ablations on
  the frozen split? append the arithmetic result?) — exactly the R4 interim
  insight, now made concrete. ✓

**Honest limit on "exact":** C3's *point-exact* per-decision credit relies on
deterministic single-history restoration under a frozen policy. Our gate runs are
**stochastic** (LLM temperature — the very reason k-rounds + McNemar + bootstrap
CI exist). So our ablation credit is **exact in the counterfactual *setup*** (same
split, same baseline clamp, only the component changed) but a **statistical**
difference reward in its *estimate*. Do not overstate it as point-exact; the
ab machinery's CI/p-value is exactly the right tool for a statistical difference
reward, and pinning to discordant tasks + k-rounds keeps variance bounded.

---

## 7. Open questions for the human (before buildable)

1. **Granularity need.** Is per-**candidate** credit (Stage 0, free) enough for
   now, or do we actually need per-**bullet** credit (Stage 1, the extra gate
   runs)? All ablation cost lives below the candidate level.
2. **Retroactive/DAG-backward credit — a real fork.** §6 decided **no retroactive
   scoring** (append-only, unambiguous). Stage 3 (RUDDER-by-replay) would push a
   late-discovered defect's blame *back* onto the upstream node. Do we want that,
   accepting the ambiguity/append-only cost — or keep the meta-metric-only
   approach? This is a design decision, not a research finding.
3. **Role/node ablation feasibility.** Bullet ablation re-runs a bench task
   (cheap, reproducible). Role/node ablation re-drives a **slice** — far more
   expensive, and possibly non-reproducible if human gates sit in the loop. Is
   role-level ablation therefore gated entirely on the **squad-on-bench** contract
   (§1, currently deferred/unbuilt)? Recommend yes.
4. **Ablation budget.** What fraction of the D8.3 global resource cap may
   best-effort credit-refinement consume? It is deferrable, but needs a number
   (e.g. "≤X% of idle capacity; never preempt a live slice").
5. **Advisory-vs-authoritative bullet assessments.** Confirm the override rule:
   gate-Δ authoritative, LLM `helpful`/`harmful` only a fallback prior. This keeps
   the curator/proposer from becoming an LLM-fitness backdoor (§6).

---

## Sources (primary unless noted)

MARL credit assignment — COMA arXiv 1705.08926 / AAAI-18 ojs.aaai.org 11794 ·
difference rewards / WLU NASA NTRS 20010071848 · Difference Rewards Policy
Gradients arXiv 2012.11258 · VDN arXiv 1706.05296 · QMIX PMLR v80 rashid18a ·
Shapley Counterfactual Credits MARL arXiv 2106.00285 · SHARP (LLM MAS Shapley)
arXiv 2602.08335 · Shapley cost/MC — Interpretable-ML-book (Molnar) shapley ·
regression-adjusted MC arXiv 2506.11849 · RUDDER arXiv 1806.07857 /
ml-jku.github.io/rudder · Hindsight Credit Assignment arXiv 1912.02503 · PRM —
"Let's Verify Step by Step" arXiv 2305.20050 · Uesato process/outcome
mathai2022 pdf (arXiv 2211.14275) · Ought "Supervise Process not Outcomes" ·
**LLM-agent attribution — C3 "Exact Is Easier" arXiv 2603.06859 (strongest
on-point)** · Who&When / "Which Agent Causes Task Failures" ICML 2025 arXiv
2505.00212 (PMLR v267) · MAST "Why Do Multi-Agent LLM Systems Fail" arXiv
2503.13657 · Temporal×Structural CA for LLM-MAS prompt-opt arXiv 2605.30227 ·
Traceability & Accountability survey (emergentmind, *secondary*) ·
LLM-Guided CA in MARL NeurIPS 2025 workshop (anti-pattern) · "From Reasoning to
Agentic" CA survey (Apr 2026, *ResearchGate listing — pointer only*).

This-system: `opencode-plugin/src/bench/ab-stats.ts` (`pairedRunStats`,
`mcnemarExactOneSided`, `bootstrapTaskCi`), `.../bench/cmd-ab.ts` (split /
`splitHash` / sentinels / `resume` / early-stop), `.../harness-store.ts`
(`AbVerdict`, `AbSetStats`, `SessionRecord`), `.../propose.ts` (taxonomy,
bulletAssessments, rejected-candidate feedback), fleet-squad spec §6 / §9.3–§9.5,
`master-open-questions-research.md` (R4).
