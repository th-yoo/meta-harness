# Addendum 02 — SUT render-rate sweep: INFEASIBLE on existing data; what the store says instead (2026-08-21)

User go for the zero-spend SUT spontaneous-render sweep; sibling flagged
selection bias (failure-only corpus) and required a corpus-composition
check first. The check ended the sweep:

## Composition facts

- The store holds **ZERO gcode-to-text trajectory files** (`*.ndjson`): the
  task appears in NO candidate's traj dir — consistent with the known
  store gotchas (traj persistence incomplete in early loops; `--results-file`
  kills `--save-all-traj`).
- What exists: **6 trace JSONs** (v1/v2, sonnet era) — metadata only
  (toolUsage COUNTS, no command content). Transcript-based render
  detection is IMPOSSIBLE on them; per the probe's own method lesson,
  nothing weaker than transcripts is acceptable.

**The sweep as registered cannot run on existing data.** Measuring SUT
spontaneous render rate requires new instrumented runs (spend) — or stays
unmeasured.

## What the traces DO say (outcome-level, selection-bias-free for v1/v2)

`gcode-to-text` in stored candidate runs: **5 passed / 1 failed** at
`anthropic/claude-sonnet-5` (v1: 1/1; v2: 4/5). The task is NOT a wall at
sonnet tier. Whatever mechanism those passes used (unknowable without
transcripts), the bullet's headroom ON THIS TASK at sonnet is at most the
residual ~1/6 — matching the fresh-context probe's spontaneous 2/2.

## Consequences

1. **The render-bullet ab is deprioritized further.** Two independent
   signals (fresh-context spontaneous 2/2; stored sonnet 5/6 pass) point
   the same way: at sonnet tier the behavior/capability largely exists.
   Remaining unknowns: haiku tier (the baseline band's tier — the bullet
   ab would run there, and none of today's evidence covers haiku), and the
   broader spatial sub-band beyond gcode. An ab would be justified by
   evidence of ABSENCE at the target tier, which nothing currently
   provides cheaply.
2. Sibling's wording hold ADOPTED: no crop-awareness clause on one
   incident — recorded as a hypothesis for the ab's error analysis, grown
   only if crop-induced errors survive in a bullet arm.
3. Method-ledger line (both lanes): **an artifact check after agent
   cleanup is a check whose false negative cannot announce itself** —
   score behavior from transcripts. Recorded here and in addendum-01; goes
   to resume.md at its next touch.
4. Store-instrumentation note: any future behavior-rate question needs
   trajs; store-writing runs under a pinned version are the only path
   (`--layers global --pin account-global=v999`), per the standing banner.
