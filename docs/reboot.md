# REBOOT — Gall's-law restart (2026-07-21)

**User decision (2026-07-21): restart the project on a Gall's-law basis.** We keep everything
*proven* (the lab), delete/ignore everything *unproven-by-running* (the design sprawl), and grow
the system one proven increment at a time. Standing values: **"I only value self improvable
agent"** + the distance-to-verdict rule (tooling freeze until a gated verdict).

## Why reboot (diagnosis, agreed)

Weeks in, zero demonstrated improvement. Root cause = **breadth-before-proof sequencing**: an
architecture city-plan (fleet/squad D1–D9, self-hosting, singleton master, Phase-4 riders,
credit-assignment groundwork) designed before any simple loop had ever produced certified lift —
a textbook Gall's-law violation ("a complex system designed from scratch never works"). Three
loop iterations ran on the wrong platform (haiku, capability-bound) while the decisive prior art
(AHE, #3 on TB2) sat unread on the leaderboard. Full technique inventory + evidence audit:
[`techs.md`](techs.md).

What survives the reboot (Gall: evolve from the simple system that WORKS — the proven kernel):
runner + podman bench, versioned store, `bench failure-taxonomy`, the McNemar gate machinery,
env-artifact forensics, the 10-task opus band. What is explicitly NOT carried forward as active
work: everything in [`explicitly-not-now.md`](explicitly-not-now.md) plus all fleet/self-hosting
build work (paper stays as reference).

## The loop (user's formulation, amended)

> 1. Pick task(s) from TB2.0 shown solvable by another Anthropic-LLM harness.
> 2. Pick ONE tech known-working (evidence-cited), prove it with the gate.
> 3. Goto 2 with the next tech.

**Amendment (adopted):** the proof unit is a SMALL BAND (2–3 tasks), not a single task — our own
openssl episode proved single-task/small-n "lift" is variance+artifact (0/2→1/2, discarded), and
single-binomial power math makes one-task proof *expensive*, not simple (~20 trials/arm for a
0.3→0.7 shift). Step-1's "another Anthropic harness solves it" = an **achievability certificate**
(wozcode ≥80%) that structurally excludes the capability-bound trap; success labels age safely
across model versions (failure labels don't — 6 of 26 leaderboard "fails" were opus-4.8 aces).

## Loop-1 task pick (2026-07-21, data-driven — token/time budget is the binding constraint)

Selected from the measured opus band (`term-bench2/splits/opus-band.txt`,
`term-bench2/rebaseline/opus-A-20260721.final.json`) on trial-cost × lift-room × mode-family:

| Task | Baseline (k=3) | Mean trial | Rationale |
|---|---|---|---|
| **sparql-university** | 1/3 | **90s** (cheapest in band) | Max lift-room; 3/10→7+/10 at k=10 = unmistakable demonstration |
| **financial-document-processor** | 2/3 | 116s | Near-flip; literal field/format requirements = spec-precision/looks_done family (the lesson tech's best-evidenced class) |
| **sanitize-git-repo** | 2/3 | 148s | Near-flip; rule-compliance per literal criteria — same mode family |

**Built-in bet:** all three are precision/rule-compliance-flavored → plausibly one shared failure
mode → ONE lesson lifts ≥1 visibly (the user's requirement: at least one task must *show* the
agent improved).

**Rejected on data:** mailman, path-tracing-reverse (3600s timeout tails = budget bombs);
query-optimize (704s ≈ 6× sparql per trial); build-pmars, cancel-async-tasks, polyglot-rust-c
(2–4× cost) — **reserved as the loop-2 held-out set** (budget cut converted into design win).

**Guards:** configure-git-webserver + count-dataset-tokens (cheap aces, k=3 each) — regression
check, the anti-AHE edge.

## Loop-1 protocol (~2 hr wall, ~75 trials total)

1. **Baseline arm**: store-writing run (NO `--results-file`) under active **v7** (byte-identical
   to v0; recreate from the committed snapshot per [`resume.md`](resume.md) recipe), 3 tasks ×
   k=10 — captures opus failing trajectories + gate-grade baseline. tmux only.
2. **Taxonomy**: `bench failure-taxonomy --layer account-global --candidate v7 --limit 20
   --model anthropic/claude-opus-4-8` → modes + `general_mechanism` per failure.
3. **ONE lesson** distilled from the dominant mode → **v8 = v7 + one playbook bullet** (single
   component edit, nothing rewritten).
4. **Candidate arm**: activate v8, same 3 tasks × k=10 + guards k=3.
5. **Verdict**: McNemar on ~30 pairs + per-task deltas + guard non-regression. Post-run audit
   before any math (auth-race grep, turns=0/elapsed forensics, setup_failed check).

**Honest limits, stated in advance:** (a) all 3 tasks are lesson-source (held-in) — loop-1 buys
*demonstration + guards*, NOT held-out generalization (that's loop-2 on the reserved tasks);
(b) ~30 pairs detects large effects (~20pp+); smaller true lifts may read null — a null here is
a provable "no large effect", which is still the differentiating claim (AHE cannot prove null).

## Tech queue for step-3 iterations (each evidence-cited, one at a time)

1. **Memory lesson (taxonomy-distilled)** — loop-1, running. Evidence: AHE ablation winner + our
   detection validation.
2. **AgentConfig knobs** (timeouts/budgets rider — machinery shipped in Phase 4). Evidence: our
   timeout-mode data (haiku v3: incomplete 13/19; opus band timeout tails).
3. **Verify/self-check workflow variants** (best-of-N with self-generated repro tests). Evidence:
   deep-research (best-of-N +15pp; workflow > prompt on fixed model). Deferred until 1–2 prove
   or null out.

Each iteration: same protocol, next tech, one component, gated. Complexity only ever enters
through a passed gate — Gall's law with statistics.
