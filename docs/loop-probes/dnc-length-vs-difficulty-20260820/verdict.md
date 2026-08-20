# Length-vs-difficulty verdict (2026-08-20, `yoo-dev`)

Scored against `pre-registration.md`, written before any per-session metric
was computed. Scorer: `classify.py` (deterministic, zero model spend).
Corpus: 196 failed trajs, 16 passed trajs, across all store candidates;
0 excluded (M8), 0 unparseable lines in the analyzed corpus.

**Headline: the pooled pre-registered rule lands INCONCLUSIVE (hard-only
11.7% < 30%; hard+thrash 50.0% > 15%) — but the per-task breakdown is
strongly BIMODAL, and that bimodality is the actionable result: length-induced
failure is a property of a TASK SUBSET, not of the band. A blanket level-2
orchestration stage is NOT justified; the pooled question was the wrong
grain.**

## Pooled result

| class | n | share |
|---|---|---|
| LENGTH-hard | 23 | 11.7% |
| LENGTH-thrash | 75 | 38.3% |
| DIFFICULTY | 82 | 41.8% |
| AMBIGUOUS | 16 | 8.2% |

Decision rule: hard-only 11.7% (< 30% → not ALIVE); hard+thrash 50.0%
(> 15% → not NULL) → **INCONCLUSIVE**, per-task breakdown reported, stop.

## The bimodality (per-task, n ≥ 3)

**Length-signature tasks** — path-tracing (12/14 hard; spot-checked: 23–46KB
tool output with last error at 0.79–0.96 of the traj — genuinely heavy AND
failing late), write-compressor (4/4 hard), tune-mjcf (2/3 hard),
llm-inference-batching-scheduler (2 hard + 3 thrash, and fails carry 4.18×
the tool-output of passes).

**Pure-difficulty tasks** — torch-tensor-parallelism (17/17), polyglot-rust-c
(13/13), configure-git-webserver (11/11): short, clean, wrong (spot-checked
torch-tt: 2.7–8.3KB output, 9–24 turns, ≤3 tool errors — no length profile at
all).

**Thrash-dominated, weak** — raman-fitting (31/40 thrash) and sam-cell-seg
(22/25 thrash) supply 53 of the 75 thrash sessions, and every spot-checked
raman thrash count is exactly 1 repeated command (the minimum the rule
counts) — consistent with retry-against-a-gate stuck-ness, not context
degradation. Excluding these two tasks, hard+thrash falls from 50.0% to
~22% of the remainder. The thrash class as pre-registered is too coarse to
distinguish "forgot earlier attempts" from "keeps hitting the same wall";
it should not carry a build decision.

## Within-task contrast (corroboration, causally ambiguous)

Fails are heavier than passes in all five contrastable tasks (1.35×–7.56×).
Consistent with length-induced failure AND with failure-causes-length
(flailing produces output). Corroboration only.

## Consequences

1. **Level-2 harness orchestration as a blanket stage: NOT justified.** The
   majority signature (difficulty + weak thrash) is exactly what D&C theory
   says decomposition does not fix.
2. **A length-failure sub-band exists**: path-tracing, write-compressor,
   tune-mjcf, llm-inference-batching-scheduler. If level 2 is ever probed,
   THIS is the treatment group, and pure-difficulty tasks
   (torch-tensor-parallelism, polyglot-rust-c, configure-git-webserver) are
   the control where D&C should show NOTHING — a built-in falsification arm.
3. **Level-1 playbook bullets unaffected** — guard 2 (escalate on observed
   overload signatures) matches the sub-band's actual profile (heavy output,
   late errors).
4. The per-task grain, not the pooled share, is what transfers — pooling
   assumed the band was homogeneous and the data refused.

## Not measured

Causality (no controlled split-vs-whole comparison); model attention;
whether the sub-band's failures are FIXED by splitting (that is the next
probe, and it costs model spend — own go); haiku vs sonnet differences
(mixed corpus, descriptive only); the 83 failed sessions with no stored
trajectory (the `--layers none` discard class — invisible here, exactly as
the resume banner warns).
