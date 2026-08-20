# F4 retraction — offset-reciprocal was built on a fabrication (2026-08-20)

**Retracted:** `5e3df53` (`offset-reciprocal`, `lane-a-v4`), reverted in
`5982a08`. The prompt's separate, older answer-key example (line 15,
present since `a97156a`) removed in `0a79de5`, version `lane-a-v5`.

## What F4 claimed

The adherence probe (`docs/loop-probes/reval-adherence-20260819/verdict.md`,
finding F4) observed all four trap cells deriving Raman shift as
`ν̃_laser − 1e7/λ` — reciprocal composed with offset, two ops — and concluded
the single-op whitelist could not express the trap class, so a correct audit
could never pass. `5e3df53` added the op.

## Why that is refuted

The task's own oracle is `shift = 1e7/x` at argmax. The real peak is
`x = 6327.285` (intensity 13950) → `1e7/6327.285 = 1580.46` — the graphene
G band under **plain `reciprocal`, already in the whitelist**. The models'
laser-offset derivations were anchored on BASELINE x-values (intensity
~5600), not the peak: a fabricated convention story that back-solved to the
desired canonical. The op was built for the fabrication; nobody checked the
models' claims against the artifact before building. (Method rule, again:
check every model claim against the artifact.)

## The deeper contamination (new finding, bias audit 2026-08-20)

The shipped prompt's inline-arithmetic example was `1e7 / 6327.285 = 1580.6`
— the fixture's exact peak and answer — since lane-a-v2 (`a97156a`),
predating F4. Two consequences:

1. Any raman audit under lane-a-v2..v4 received its own answer in the
   prompt. Raman results through this auditor are contaminated.
2. **Hypothesis (recorded, not established):** the example taught `1e7`;
   the probe measured "every model attempt used 1e7 on Angstrom data". The
   contamination may have seeded the very fabrication class F4 was built
   on. Deciding this needs a clean-prompt re-probe and is NOT authorized
   here.
3. **F5 confound (sibling-lane note, 2026-08-20):** the adherence probe
   attributed the fabricated landing inputs (F5) purely to sampler
   head/tail blindness. If the example taught the 1e7 fixation, part of
   that fabrication may be prompt-seeded rather than sampler-caused. A
   future probe must not re-attribute F5 without a clean-prompt run.

## What survives of F4

The narrow observation stands: the whitelist genuinely cannot express a
two-op claim. What died is the inference that this trap class REQUIRES one.
Whether any legitimate task class does is a design question for the
redundancy redesign (queue #2/#3), not grounds for another per-trap op —
by CLAUDE.md §1, ops are added only with oracle-set AND bad-set validation,
never one trap at a time.

## Status

`offset-reciprocal` absent from source and prompt; `lane-a-v4` retired;
regression pin test in `opencode-plugin/test/bench-convention-audit.test.ts`
guards the removal. Revalidator still ships OFF; the total bypass
(canonical/delta ownership) is untouched by this cleanup and remains the
open design item.
