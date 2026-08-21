# L1 ladder-bullet trial — VERDICT (2026-08-21)

Pre-registered outcome **C: the standard path proposed a NON-ladder bullet.**
The ladder bullets are **not indicated by the measured evidence.**

## Stage 1 — taxonomy on the length sub-band

Source: `v20`'s own 13 trajectories, the only length-sub-band evidence in the
store (`path-tracing` x7, `llm-inference-batching-scheduler` x6). Judge:
`anthropic/claude-sonnet-5`. 8 of the 13 were failures.

**`modeCounts = {incomplete: 8}` — unanimous.**

`incomplete` is defined as *"Ran out of runway — time/turn budget exhausted or
the attempt stops partway with work visibly unfinished."* Confound checked and
cleared: these are 69-185 trajectory events and 30-87 KB each, i.e. genuine
runway exhaustion after substantial work, **not** the zero-turn harness-timeout
artifact this repo has been bitten by before.

**This REFUTES the trial's registered prediction** ("most likely A or C, not B"
was registered on the assumption the evidence would not be overload-shaped). The
evidence IS overload-shaped, unanimously.

## Stage 2 — what the standard path actually proposed

> **b7 (42w, mode=incomplete):** "When investigating a large or ambiguous target
> before writing code, cap exploration to a fixed number of steps (e.g., 5-8 tool
> calls), then write and test a first-draft implementation immediately, even if
> imperfect, and refine it iteratively rather than continuing open-ended
> analysis."

`falsify_if`: *"If in the A/B, path-tracing/batching sessions still exhaust
budget in analysis without ever writing a draft despite the bullet, or if any
guard task regresses because agents now submit premature drafts before
sufficient investigation."*

`expect_improve`: `path-tracing`, `llm-inference-batching-scheduler`.
All five declared guards defended individually.

## The finding

**The bullet contains ZERO split/decompose/divide content. It is a TIMEBOXING
bullet, not a divide-and-conquer bullet.**

Against spec §4's three registered ladder wordings:

| registered bullet | present in the emitted bullet? |
|---|---|
| 1. cheapest test that could prove it wrong | partially — "write and test a first draft" is draft-as-test |
| 2. split the work into independently checkable parts | **absent** |
| 3. simplest structure that solves; open-ended exploration only when the path depends on it | **the converse is present** — cap open-ended exploration |

The root causes are why. All eight converge on the same mechanism, e.g.
*"Agent over-invested turns in exhaustive manual pattern discovery instead of
quickly settling on an approximate procedural model and moving to
implementation, exhausting its budget during analysis."*

So the length sub-band's failures **are** overload-shaped — but the measured
mechanism is **failure to converge**, not too-much-to-hold-at-once. The
evidence-derived fix is to bound exploration and draft early. **D&C's "split it"
prescription does not follow from the only length-sub-band evidence that
exists.**

## What this cost, and what earned its keep

**The no-bypass rule earned its keep outright.** Spec §4 forbids hand-writing
the bullets and mandates the standard diagnosis-driven path. Had the three
registered wordings been injected directly — which is what "run the L1 ladder
trial" naively means — bullet 2 would have shipped, and the evidence does not
support it. The rule caught a wrong bullet before it was bought.

## Two defects found in the harness along the way

1. **`DEFAULT_JUDGE_MODEL` routes to an unconfigured provider.**
   `openrouter/google/gemini-2.5-flash` against an opencode `auth.json` holding
   only `anthropic`. Every call fails, is labelled `transient provider error`,
   burns three retries, falls back to `other`, and the command **exits 0**. The
   first taxonomy run returned `20 classified -> other=20` — a dead transport
   wearing a result. See `addendum-01-judge-transport.md`.
2. **The recency-capped taxonomy sample was 80% self-authored probe tasks.**
   `v17`'s 25 trajectories are `gcode-to-text-card` x10, `extract-elf-card` x4,
   `image-channel-probe` x3, `raman-fitting-*` x3 — and zero band tasks.
   Diagnosing those would have proposed a bullet about our own probe work. Third
   live instance of the authorship-boundary law in one day, and the tool printed
   the warning itself ("recency-capped at 30 — a biased sample") in output that
   had already been read.

## Declared deviations

- Judge model switched to `anthropic/claude-sonnet-5` (the authenticated
  provider). Prior crank taxonomies used gemini-flash, so **no cross-crank
  mode-count comparison from this taxonomy is valid** (proposer rule 10).
- `v20`'s `taxonomy.json` was copied into `v17` so the staged candidate sits on
  the 6 baseline bullets and yields a **single-bullet delta** — `ab` hardcodes
  `baseline = activeVersion()`, so proposing from `v20` would have measured
  `b7 + b8 + new` as one number. The trajectories came from the `v20` arm, whose
  two extra bullets measured INCONCLUSIVE.
- `candidates/v17/playbook.json` was absent in the live store and was restored
  by copying `active/playbook.json` (content-identical; `active/.version` = v17).
  Store repair, no bullet content authored.
- `propose-lesson`'s first call was rejected by its own gate for omitting
  `predictions.falsify_if` (rule 12). It has no retry — logs and returns 1. The
  re-run succeeded. Gate working as designed.

## State

`v23` staged INACTIVE: 6 baseline + b7, bullet present in `system.md`. Active
remains `v17`. **No ab has been run.** Spend so far: ~30 judge calls.
