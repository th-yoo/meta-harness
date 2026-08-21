# L1 ladder-bullet trial — PRE-REGISTRATION (2026-08-21)

Registered BEFORE any model call, on an explicit user spend go. Spec §4
("Validation: standard candidate → ab → verdict on the band. Own spend go.").

## State established before running (zero spend, all verified)

- **Active = `v17`, whose playbook is pure `v0` baseline text** — six generic
  orientation bullets, `addedBy: v0`. **The loop has adopted ZERO proposer
  bullets in its entire history.**
- Proposer bullets ever produced: **three.** `v18 b7` (spend unused budget on a
  different approach) → **REJECTED** on held-out regression, root-caused as a
  lexical trigger. `v20 b7` + `b8` (scoped-command verification; do not abandon a
  measurably-matching lead) → **INCONCLUSIVE**.
- `v19`/`v21`/`v22` are A/A and probe-isolation copies, never cranks (verified in
  `meta.json`, after nearly reporting them as "the proposer stopped producing").
- Ladder/split-class bullets in any candidate playbook: **zero**, across the
  committed store (23 versions) and the live store (`v18`,`v20`,`v21`,`v22`).
- Band: `term-bench2/splits/band-interior-8.txt`, 8 tasks. It contains **two of
  the four length sub-band members** (`llm-inference-batching-scheduler`,
  `tune-mjcf`) and not the other two (`path-tracing`, `write-compressor`).
- Length sub-band evidence in store: `path-tracing` 14 trajs,
  `llm-inference-batching-scheduler` 7, `tune-mjcf` 5, `write-compressor` 0.

## The design constraint that shapes this trial

Spec §4 forbids hand-writing the bullets: *"routed through the STANDARD
diagnosis-driven proposer path — no bypass script; if the standard path cannot
express one of them, that bullet is dropped, not smuggled."*

The proposer (`lesson-proposer.ts`) is **diagnosis-driven and emits EXACTLY ONE
bullet or abstains**, targeting the highest-count failure mode. It cannot be
handed three pre-chosen bullets. **Therefore this trial does not test the three
registered wordings. It tests whether the standard path, run on real failure
evidence, produces a ladder/split-shaped bullet at all.** That is the honest
form of "L1 ladder trial" under the spec's own no-bypass rule, and it is stated
here so the result is not later re-described as something else.

## Stages, and the spend gate between them

1. **`failure-taxonomy`** — classifies stored failure trajectories into modes.
   Model calls: yes, bounded by `--limit`.
2. **`propose-lesson --create vN`** — ONE model call, emits one bullet or abstains,
   stages an inactive candidate.
3. **`ab` vN vs v17 on `band-interior-8`** — the expensive stage. **Not entered
   automatically**; stage 2's output is reported first.

## Pre-registered outcomes — all four are results, none is a failure

- **A: proposer ABSTAINS (rules 2/8/9).** The standard path cannot express a
  ladder bullet on current evidence. Per spec the bullet is **dropped, not
  smuggled** — trial ends without ab spend. If the abstention is **rule 9**
  ("switch actuator": same mode targeted ≥2 times and still dominant), that is
  the strongest result available here, because it is the proposer stating that
  the bullet LEVEL is wrong — which is the actuation finding this whole line has
  been circling.
- **B: proposes a LADDER/SPLIT-shaped bullet.** Proceed to ab on the band. This
  is the outcome §4 was written for.
- **C: proposes a NON-ladder bullet.** Then the ladder bullets are not indicated
  by measured evidence. Record it; whether to ab it is a separate decision, since
  ab-ing it tests the loop, not the ladder.
- **D: the path errors** (transport, no evidence, malformed diagnosis). An
  infrastructure result, recorded as such, never dressed as an abstention.

## Registered predictions (so they cannot be adjusted after)

- **Most likely A or C, not B.** The evidence base is dominated by non-length
  failure modes (the store's largest traj populations are `sparql-university`,
  `gcode-to-text-card`, `path-tracing`), and D&C addresses only length-induced
  failure — a minority sub-band per the spec's own probe.
- **If B and then ab: expect under-actuation, not lift.** Priors, all measured:
  loop-1 prose lesson-following **1/8**; `v13` awareness-prose **0/4**
  ("checked-and-shrugged"); `v18` REJECTED; `v20` INCONCLUSIVE. G3 already
  registers under-actuation as expected and states a null is informative about
  level 2, not a defect in the trial.
- **The genuinely unbought number** is narrow: whether trigger/hard-gate phrasing
  actuates where awareness prose did not. Nothing else here is new information.

## Guards

- No hand-written playbook. No bypass script. If I find myself editing
  `playbook.json` directly, the trial is void.
- Verdicts are immutable; corrections by addendum only.
- `--layers none` silently discards trajectories — never used here.
- Store-writing runs are not resumable; `ab` is.
