# Amendment 01 — sibling-lane criteria (registered before any answer read)

Timing: arm calls were dispatched when this arrived; ZERO answers had been
read or scored. Everything here is scoring/interpretation policy, not
stimulus or prompt change (prompts already conform: alphabet-as-class only,
no position, no neighbors, abstention legal, same renderer both arms,
mechanical scoring).

## Scope flags (registered)

1. The divider runs with the FITTED cell 0.4 and `--expect-glyphs 26` —
   answer-shaped, acceptable HERE because the question is perception GIVEN a
   correct divide. **Conclusions scope to "given the divide"; nothing here
   validates the divider.**
2. The scorer holds the ground-truth string. §1 bans answer keys in the
   HARNESS; a probe's scorer is the instrument that evaluates the harness
   and may hold oracles. Stated so nobody conflates them later.
3. Fixture pinned: `term-bench2/probe-tasks/gcode-to-text-gate/environment/
   text.gcode.gz` (the -gate copy, not -card; copies can drift).

## Confusable classes, pre-declared (before scoring)

- Pairs: {0,O}, {1,l,I}, {5,S}, {2,Z}.
- Expected-hard tiles (from the rung-5 dry-run's own geometry, not from any
  answer): tile 07 (0/O undecidable FROM ITS OWN TILE), tiles 10 and 13
  (underscores rendering as faint 6.04×0.01 dashes).
- Scoring is UNCHANGED (exact match, case-sensitive) — the amendment adds a
  SUBGROUP analysis: headline accuracy reported overall AND excluding the
  pre-declared confusable/hard tiles, so known-ambiguous glyphs cannot
  decide the verdict alone. A confusable-pair miss is reported as
  "confusable-class error" distinct from other misses.

## Endpoints (both, never substituted)

1. Per-glyph accuracy (primary, drives the registered decision rule).
2. Reassembled-string exact match (arm G answers concatenated in tile order
   vs ground truth; arm W's line as given) — the task-shaped endpoint.

## Context definition (registered as the treatment)

Arm G reveals: character-class alphabet (letter/digit/punctuation) YES;
position NO; neighbors NO; string format NO. Arm W is the same rendering
from the same script. The measured difference is therefore attributable to
per-glyph isolation vs whole-string context, given the divide.

## Rule check (their lane's method, applied)

"What would have to be true for the decision rule to fail?" — the rule
compares accG to accW on the same fixture; it would mislead if arm W's
format prior (`flag{...}`) inflates accW (registered as a confound biasing
AGAINST a G lift — acceptable direction), or if the confusables dominate
both arms equally (the subgroup analysis exposes this). No instrument
assumption found encoded in the rule itself.
