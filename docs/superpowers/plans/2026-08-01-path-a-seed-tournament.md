# Path A — seed-scale rewrite tournament (TB2 agent harness)

**Status:** DRAFT — awaiting user review + go. No spend authorized by this
document; every stage below has its own go line.
**Date:** 2026-08-01 (MacBook draft; execution = office box, podman).
**Pre-data amendment (2026-08-01, before Stage 0):** all trial arms run
**`claude-opus-5`** (`anthropic/claude-opus-5` via opencode) — Opus updated
to 5, user directive to use it wherever opus was used. Consequence: v7's
HISTORICAL band rates (measured on opus-4-8) are no longer a valid screen
baseline, so Stage 1 gains a concurrent v7 k=1 arm (+7 trials); Stage 2's
paired v7 control arm already handles this by construction. No verdict
semantics change.
**Lane:** TB2 agent harness store (opencode `account-global` layer,
candidates v0..v11 lineage, active=**v7**). This is NOT the kkamak §4.3
live-trial lane — no interaction with gate-outcomes, trial-arms,
calibration, or the activation precondition. Bench is the separate sharp
instrument; only the *lessons* transfer.

## Why a tournament, why now (position vs the record)

- **Single-bullet loop is spent as a primary strategy.** Loop-1 v8 =
  provable null (lesson ignored 7/8). Loop-2 v9 = certified on sparql
  (p=0.020) then **guard-rejected** (cgw 0/3 — spec-overtrust). Loop-3
  v10 = rejected (cgw double-trap). Active is still v7; zero prose
  adoptions in the TB2 lane ever. The one falsification worth keeping:
  *content-matched* lessons DO grip (v9 trajectories) — prose is not dead,
  single-bullet increments are.
- **The baseline is nearly empty.** v7's assembled harness = **394 chars**
  (byte-identical to v0). The wozcode gap (opencode 51.7% vs wozcode 80.2%,
  same model class, ~28pp ≈ all harness/workflow) says the headroom is in
  workflow scaffolding, not model capability. A seed-scale rewrite is the
  first attempt to actually fill the harness slot, not decorate it.
- **Low event rates only detect large effects** (roadmap strategy
  reminder). One high-contrast trial beats five undetectable ones. A
  whole-seed rewrite is the high-contrast object available today, with
  zero dependence on Path B's calendar.

## Candidates (N=3 full rewrites + control)

Each candidate = complete `system.md` (+ playbook if used) replacing v7's
394-char scaffold. **Authoring inputs are the accumulated evidence, not
fresh invention:** v0/v3/v7 failure taxonomies (`term-bench2/store/global/
candidates/*/taxonomy.json`), loop-1..3 verdict mechanisms
(interpretation-overfit self-validated on dev data; spec-overtrust; "trust
but verify what the grader can test"; cgw double-trap), R-row lessons
(R1-R10), and the wozcode-gap analysis
(`docs/2026-07-20-opus-candidate-tasks.md`).

- **S1 — verification-first seed:** the agent's core loop is
  claim→check→only-then-proceed; never trust task prose the grader can
  test; self-run the verifier-shaped check before declaring done. (Distills
  loop-2/3's spec-overtrust mechanism + A2's completion-gate insight into
  prose workflow.)
- **S2 — interpretation-policy seed:** ambiguity handling as an explicit
  procedure — enumerate readings for ambiguous TERMS only, verify explicit
  environment promises, prefer the reading the grader can mechanically
  test. (The sharpened loop-3 rule, seed-scale instead of one bullet.)
- **S3 — workflow-scaffold seed:** plan/execute/verify phase discipline,
  stop-condition hygiene, failure-mode checklist derived from taxonomy
  modes (incomplete / looks_done / long-grind). (Attacks the 28pp
  harness-workflow gap directly.)
- **Control:** v7 unchanged.

Authoring is model-work but cheap (single session, no bench trials).
Recipe constraint (loop-2 trap, binding): candidate `system.md` must
CONTAIN the full text — `composeHarness` silently drops playbook-only
additions. Launch check: "Harness assembled (N chars)" must exceed 394 by
roughly the seed's size, per arm, before any trial counts.

## Task sets (pre-registered, from the audited Cat-A screen)

- **Held-in band (7):** path-tracing-reverse, mailman, headless-terminal,
  sanitize-git-repo, query-optimize, financial-document-processor,
  sparql-university.
- **Held-out reserve (3):** build-pmars, cancel-async-tasks,
  polyglot-rust-c (loop-4's reserved set, still lesson-naive — stays
  untouched until the confirm stage).
- **Guards (6 aces, non-regression):** chess-best-move,
  configure-git-webserver, count-dataset-tokens, path-tracing,
  write-compressor, feal-linear-cryptanalysis. cgw stays in despite its
  double-trap record — it is the guard that killed v9/v10 and that is
  exactly its job.

## Stages (each with its own go)

**Stage 0 — author candidates (go: cheap, one session).** Write S1-S3 from
the evidence inputs. Commit candidate texts under
`term-bench2/store/global/candidates/` as INACTIVE (surgical store sync,
never blind export). No bench spend.

**Stage 1 — screen (go: ~37 trials).** S1, S2, S3 **plus a concurrent v7
arm** (amendment above: historical opus-4-8 band rates are not a valid
baseline under opus-5; band definition = 0<pass<1 still from the k=3
screen). Each arm × held-in band (7) × **k=1**, **opus-5**, width 4,
`--no-pack-measured --no-oauth-gate`, tmux (never setsid). 28 trials + up
to 9 re-rolls for R2-flagged artifacts. Decision rule (screen has NO
verdict authority): rank by band passes; kill any candidate strictly below
the concurrent v7 arm's band rate; at most **2 advance**. Est 2-4h wall.

**Stage 2 — confirm (go: ~100-120 trials, the real spend).**
- v7 control arm: held-in band × **k=5** = 35 trials (store-writing — this
  doubles as the never-run loop-1 k-boost baseline for the band subset).
- Each surviving candidate: held-in band × k=5 = 35 trials/arm.
- **Verdict (pre-registered):** McNemar on per-task paired majorities +
  pooled Fisher, candidate vs v7. Certify requires p<0.05 AND no band task
  regressing from ≥3/5 to ≤1/5 (the v3-rejection shape).
- Est 3-6h per arm (band tasks grind 30-60min); schedule = office nights,
  one arm per tmux run.

**Stage 3 — guards + held-out (go folded into stage 2's winner only).**
- Guards: winner × 6 aces × k=3 = 18 trials. ANY ace dropping below 2/3 =
  REJECT (v9 precedent: certified-then-guard-rejected is a real and
  accepted outcome).
- Held-out reserve: winner × 3 tasks × k=5 = 15 trials, **directional
  report only** (loop-4's generalization question; not an adoption gate at
  this n — pre-registered as evidence, not verdict).

**Adoption rule:** stage 2 certify + stage 3 guards hold → activate winner
as v12 on the office store, sync snapshot + score.json to
`term-bench2/store/` (surgical diff-first), record in HISTORY (first
prose adoption in the TB2 lane if it lands). Anything less → v7 stays
active, verdicts + trajectories become proposer evidence.

## Honest power + risk register

- 35 pairs/arm detects ~20-25pp lifts; a real 10pp lift will likely read
  null. Null is still provable knowledge (the project's one claimed edge).
  Do not scale k mid-run to chase significance (pre-registration is the
  point; SPRT stays deferred per explicitly-not-now §7.5).
- Screen k=1 false-kills a good candidate ~30-50% per task draw — accepted
  (same bounded blind spot as the k=3 Cat-A screen; tournament exists to
  spend confirm-k only on survivors).
- Store-writing runs are NOT resumable; strip partial tasks if interrupted
  (B1 lesson). R2 audit (auth-race grep + turns:0 triage) before ANY math.
- v7 on the office store is host-local — if drifted, recreate from the
  committed snapshot (recipe in resume.md 07-21 block) BEFORE stage 1.
- Weekly token limit: stage 2 is 2-3 nights of opus trials; check budget
  standing before each go.

## Not in scope (do not silently resurrect)

- kkamak §4.3 live-trial lane (own machinery, own calendar, A/A first).
- SPRT / sequential stopping (§7.5 stays dead).
- Single-bullet candidates (spent; factory/propose-lesson may author
  bullets INTO a seed rewrite, not as standalone candidates).
- New runner tooling (distance-to-verdict rule: freeze until a gated
  verdict; the runner as-is sufficed for loops 1-3).
