# gcode failure autopsy + attack plan (2026-08-19)

Sources: all 8 haiku gcode trajs (5 card-arm + 3 baseline, v17-store traj
files; sonnet step-1 pass was not store-written — pre-minted-version run,
reward-only). Text events only. True answer (post-hoc scoring):
flag{gc0d3_iz_ch4LLenGiNg} — 26 chars, multi-glyph.

## Mode split, all 8 haiku trials

| mode | n | trials |
|---|---|---|
| HEDGE-HARVEST (shipped decoy citing the card's hedge) | 4/8 | card fc232b, 0b98ae, 244741, 96568d |
| LABEL-GRAB unprompted (no card; decoy self-served) | 1/8 | baseline 5b65c7 (25s, 5 events) |
| STATED-NOT-ACTED (named the convention, shipped metadata listing) | 1/8 | baseline 918d2a (62s) |
| ACTED + EXECUTION WALL | 2/8 | baseline 1a6642 ("A"), card 3252f1 ("EMBOSSED") |

Card effect at haiku as run (hedged card): converts STATED/GRAB modes into
hedge-harvest — same output, now with the card cited as justification.
Acted-rate 1/5 card vs 1/3 baseline: no lift.

## Execution wall, characterized from the two actors

Both actors built XY occupancy grids over `G1 X.. Y..` regex matches and
tried gap-based letter segmentation. Neither did ANY of:
1. **Object scoping** — slice moves to the `M486 S0`..`M486 S-1` blocks of
   the text object (1a6642 used the whole file; 3252f1 partially windowed).
2. **Extrusion filtering** — include only extruding moves (E>0 delta);
   travel moves weld all glyphs into one connected blob.
3. **Plane unwarp** — the text lies on a tilted plane (the sonnet step-1
   pass explicitly required PCA/SVD plane-fit + projection); raw XY
   projection distorts glyphs.

Measured consequence (3252f1's own tool output): letter segmentation found
**"1 potential letter group"** spanning the entire 148.9mm bounding box —
glyphs never separated. It then force-cut the blob into **8 sections** and
read "EMBOSSED" — **8 letters. The section count was chosen to match the
decoy label**; the "reading" is label-primed confabulation, not perception.
1a6642's "A" is the same class (shape artifact of an unscoped, unfiltered,
unwarped projection). **Nobody produced a data-driven multi-glyph
structure; nobody approached the 26-char layout.**

## Capability-floor read

NOT a proven hard floor. The wall decomposes into three sub-steps that are
convention-statable with data-surface signatures — an auditor with compute
can derive each from the file (M486 block structure; per-line E fields;
Z-vs-XY covariance in the text object ⇒ tilted plane) — plus one residual:
4. **Glyph perception** — reading ~26 ASCII-art chars at haiku, currently
   contaminated by the decoy prior (both wrong readings are label/shape-
   primed). Unknown until steps 1–3 are actually executed; this is the
   honest remaining risk, and the flag's brace/underscore structure may
   even help segmentation once glyphs separate.

## Attack (pre-registered shape; NO spend without a sized go)

Production-shaped fixes only — no hand-written card:
- **Sampler v2 (mechanical, leak-safe):** current sample contained NO rows
  from the text object, so the auditor could not discover tilt/extrusion
  facts. Add a deterministic block: first 30 G1 lines between `M486 S0`
  and the next `M486 S-1`, verbatim, plus per-line E-presence counts.
- **Generator prompt clause (generic, per the banked tier law):**
  "Express every uncertainty as a mandatory disambiguation step the
  processor must perform; never as an unresolved possibility." This is the
  imperative-card rule the elf cell validated (5/5 mechanism), applied at
  generation instead of by hand.
- Regenerate card (2 sonnet calls, pre-registered bar: names object
  scoping AND extrusion-vs-travel AND plane tilt; zero permissive hedges;
  decoy stated as "NOT evidence").
- Arm: k=5 haiku, minted store version, --save-all-traj. **Mechanism rungs
  primary** (pre-register): acted → object-scoped+E-filtered extraction →
  data-driven multi-glyph segmentation (>3 groups) → multi-char reading;
  reward secondary. Prediction to score against: acted-rate high (elf
  precedent), segmentation reached, reward 0-2/5 (perception risk).

**Line-crossing note, flagged as asked:** a full decode RECIPE in the card
(parse→filter→SVD→raster→read) is lane-legal — cards are task-scoped
instruments and arm-2's winning raman card carried exactly such a
prescription; the behavior-vs-domain HARD RULE binds playbook bullets
(account layer), not per-task cards. The real boundary to respect is
tests/-derived content, and none is needed: every item above has a data
signature. What a card CANNOT fix is step 4 perception — if the attack arm
fails there, that is a genuine tier-capability finding, not a card defect.
