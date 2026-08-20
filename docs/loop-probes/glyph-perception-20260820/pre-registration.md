# Pre-registration — per-glyph perception probe (2026-08-20, lane A on lane-B machinery)

## Question

The rung-5 delivery-channel verdict left exactly one measurement open:
*render N single glyphs from the real fixture's own alphabet, one tile per
call, score PER GLYPH*. This probe asks it, plus the D&C question on top:
**does glyph-by-glyph decomposition improve reading over the whole string on
the SAME fixture?** User go 2026-08-20 ("Probe gcode. Let's look the agent
properly process glyph by glyph.").

## Instrument and stimulus

Tiles from lane B's proven divider (`term-bench2/seam-gate/render_glyphs.py`,
unchanged, the rung-5 dry-run instrument): 26 `glyph-NN.png` tiles + one
`whole.png`, rendered from the real fixture. Ground truth (harness-known,
never in any prompt): `flag{gc0d3_iz_ch4LLenGiNg}` — 26 glyphs, reading
order = tile order.

## Arms

- **Arm W (control, 1 call):** model shown `whole.png`. Prompt: "This image
  shows a rendered line of text. Transcribe it exactly, character by
  character. Output ONLY the transcription on a single line. If a character
  is unreadable, write `?` in its place."
- **Arm G (treatment, 26 calls):** model shown one `glyph-NN.png` per call,
  independently (no context carryover, no neighbor tiles). Prompt: "This
  image shows exactly one rendered character (a letter, digit, or
  punctuation mark; letter case matters). Output ONLY that single character.
  If unreadable, output `?`."

Model: sonnet tier, both arms (the bench SUT tier). Transport: this
session's subagents reading the PNG via the image-capable Read tool. Total
spend: 27 calls. No prompt contains the answer string, its length, its
format, or any alphabet restriction beyond letter/digit/punctuation.

## Scoring (mechanical, script)

Per-position exact character match against ground truth (case-sensitive).
Arm W's line is aligned per position after stripping whitespace; a W answer
of wrong LENGTH is scored by Levenshtein alignment and additionally reported
as a length error. `?` = counted wrong, tracked separately as abstention.
Confusion pairs reported.

## Registered decision rule

Let accG = per-glyph accuracy of arm G, accW = per-position accuracy of arm W.

- **accG ≥ 0.90 AND accG − accW ≥ 0.10** → decomposition materially rescues
  perception → rung-5 arm ALIVE (licenses only the next design step, not a
  build).
- **accG ≤ accW** → decomposition adds nothing on this fixture → perception,
  not context, is the binding constraint → **rung-5 DEAD** for this fixture
  class.
- Otherwise → INCONCLUSIVE; report the confusion structure and stop.

Also reported, no rule attached: case-confusion rate (e.g. `L`↔`l`,
`G`↔`g` — the fixture contains both cases of two letters, the known hard
part); abstention counts per arm; whether arm W's errors cluster at
positions where arm G also fails (shared-perception errors) or not
(context/segmentation errors — the class decomposition should remove).

## Registered confound

Arm W may exploit the `flag{...}` string-format prior (a real-task advantage
whole-string reading legitimately has); this biases AGAINST finding a G
lift and is accepted — a G win despite it is stronger, a G loss partly
attributable to it will be noted, not excused.

## Disclosure

I know the ground-truth string (public in lane-B's committed verdict).
Scoring is mechanical. Tiles were rendered before this registration; NO
model call has been made. The renderer is lane B's committed instrument,
untouched.
