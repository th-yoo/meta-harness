# Per-glyph perception verdict (2026-08-20, `yoo-dev`, lane A on lane-B machinery)

Scored against `pre-registration.md` + `amendment-01.md` (both written before
any answer was read). Scorer: `score.py`, mechanical, raw answers committed
under `answers/`. Stimulus: lane B's committed renderer on the -gate fixture
(whole.png md5 `1b5e3767…`, tiles reproducible via
`python3 term-bench2/seam-gate/render_glyphs.py --out <dir>`). 27 sonnet
calls, independent contexts, no prompt carried the answer.

**Headline: the registered rule fires in the direction nobody designed for —
accG = 0.500 ≤ accW = 1.000 → decomposition adds nothing → RUNG-5 DEAD for
this fixture class. The whole-string arm read the render PERFECTLY
(26/26, exact string match); glyph-by-glyph isolation HALVED accuracy.**

## The numbers

| endpoint | arm W (whole) | arm G (per-glyph) |
|---|---|---|
| per-position accuracy | **26/26 = 1.000** | 13/26 = 0.500 |
| reassembled exact match | **TRUE** | FALSE (`FNag(gCOa3?KZ~Ch4LLenGANg3`) |
| subgroup (excl. pre-declared hard/confusable, n=22) | — | 13/22 = 0.591 |
| abstentions | 0 | 1 (tile 10, `_`) |

Error overlap: **zero shared errors; all 13 errors are G-only.** Arm W made
no error for decomposition to remove — the premise of the per-glyph divide
(compounding per-glyph errors that isolation would fix) is measured
BACKWARDS on this fixture: isolation *introduces* errors.

## The mechanism (from the confusion structure, not speculation)

The G errors are not random misreads; they are exactly the information the
divide DESTROYS:

- **Case errors (5):** `F/f`, `C/c` ×2, `Z/z`, `O/0` — letter case is
  UNDECIDABLE from an isolated tile: the renderer normalizes each tile to
  its own bounding box, so x-height vs cap-height — the case signal — exists
  only RELATIVE to neighboring glyphs. Whole-string context carries it;
  isolation deletes it.
- **Scale/baseline errors (5):** `_`→`~`/abstain, `{`→`(`, `}`→`3`, `d`→`a`
  — same deletion: a 6.04×0.01 underscore is a dash without line context; a
  brace needs the line's vertical extent.
- **Shape-prior errors (3):** `l`→`N`, `i`→`K`, `i`→`A` — stroke-rendered
  glyphs read differently without the string's font-consistency prior.

Sibling's dry-run eyeball read was 23–24/26 WITH whole-string context;
per-tile calls score 13/26. Consistent: context was always the carrier.

## Consequences

1. **Rung-5 is DEAD for this fixture class** by its own open question,
   measured at the arm's task shape. The per-glyph divide severs a coupling
   channel the axis criterion's u-overlap analysis never saw: glyph
   identity couples to neighbors through RELATIVE SCALE and CASE, not
   spatial overlap. Criterion (a) as applied to gcode measured spatial
   coupling only — the criterion's per-fixture caveat lands, and the D&C
   guard gains a measured example: a low-SPATIAL-coupling axis can still
   sever a non-spatial dependency whose loss is unrecoverable at merge.
2. **Perception is NOT the gcode task's bottleneck.** Sonnet reads the
   whole render flawlessly. The SUT's failures on gcode-to-text must live
   UPSTREAM of reading — producing/choosing to produce a render at all.
   That redirects any future gcode work from perception scaffolding to
   render-production behavior.
3. **For the D&C spec:** this is the first measured instance of the
   escalation ladder's converse — the SIMPLEST structure (one call, whole
   artifact) beat the decomposed pipeline because the decomposition
   boundary crossed an invisible dependency. "Simplest that solves" was not
   just cheaper; it was CORRECT and the decomposition was not.

## Registered confound, honestly weighed

Arm W had the `flag{...}` format prior available. It cannot explain the
result: W was perfect on the non-format-determined characters too
(`gc0d3_iz_ch4LLenGiNg` interior), and the prior explains at most the
braces/underscores, not `F/f` or `i/K`. The G loss is mechanism (deleted
relative geometry), not prior asymmetry — but n=1 fixture, k=1 per tile;
scope is this fixture class, per the registration.

## Not measured

Other fixtures/fonts (a renderer that preserves a common baseline/scale per
tile could revive per-glyph reading — that is a DIFFERENT divide, with the
scale channel deliberately carried across the cut); haiku tier; k>1
stability; whether tile-plus-line-context hybrid prompts recover the loss.
