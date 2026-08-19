# Rung-5 dry-run verdict (2026-08-19, `yoo-dev`) — the harness-side divide RENDERS LEGIBLY; build is unblocked, with three named design loads

**Question asked (the staged free go):** before spending anything on a rung-5
arm, render `flag{gc0d3_iz_ch4LLenGiNg}`'s 26 glyphs through the existing
pipeline and eyeball whether they are legible at all. If the harness can
divide perfectly and the glyphs still can't be read, rung-5 is dead before
it is built.

**Answer: legible.** Whole-string render reads `flag{gc0d3_iz_ch4LLenGiNg}`
cleanly (`whole.png`); the divide yields exactly 26 glyph tiles, every one
independently readable (`contact-sheet.png`). Zero model spend, zero bench
spend — pure local rasterization of the fixture.

Instrument: `term-bench2/seam-gate/render_glyphs.py` (developer tool, same
contract as `calibrate_gcode.py` — never imported by `validator.py`, never
decides pass/fail). Reproduce with:

```
python3 term-bench2/seam-gate/render_glyphs.py --out <dir>
```

Everything in the pipeline is reused, not reimplemented:
`readers.read_gcode_g1_points` for M486-S0 extruding-G1 scoping, the SVD
plane fit, and `validator._NEIGHBORS_8` / `_MIN_COMPONENT_PIXELS` /
`_MAX_GRID_DIM` for the clustering the s4 seam already counts.

## Measured

- 38972 S0 extruding points; projected extent u −77.59..90.57, v −6.28..5.78.
- Clustering at the calibrated cell 0.4 gives **31 connected components**, not
  26 — components are not glyphs (see load 2).
- **u-interval overlap merge → exactly 26 glyphs**, and the count is stable
  across a merge-gap tolerance of −0.2 to +0.5, a wide plateau rather than a
  fitted constant. Full per-glyph geometry in `report.txt`.
- Stroke render (connect consecutive-in-file points, break on a jump > 1.0
  plane unit = a travel move) is crisp. The bare-dot render — literally what
  the clustering sees — is sparse and much harder to read at the same scale;
  a rung-5 sampler should hand over strokes, not dots.

## Three design loads, all measured here, none fatal

**1. The SVD basis sign is arbitrary, and the first render came out
mirrored/upside-down.** This is the card's H5 hypothesis ("viewed from the
print-facing side… not derivable from coordinates alone") turned from a
guess into a measurement. Two of the four orientations are killed
deterministically by pinning the viewing side: take the plane normal `vt[2]`,
point it along world +z (the outward face), and set `v = normal × u` so the
basis is right-handed and the viewer sits outside the part. That renders
upright with no magic flag and is what `project_pinned` now does. **Do not
pin the in-plane axis directly** — `sign(vt[1]·ẑ)` happens to give the right
answer on this fixture, but on a margin of 0.054: the text plane is
near-horizontal, so the in-plane axes carry almost no z and the sign is one
rounding away from flipping. The normal's own z-component is 0.935; that is
the robust thing to pin, with the in-plane axis derived from it. Residual: u's sign, i.e. a 180° in-plane
rotation, is genuinely not derivable from the coordinates. A rung-5 sampler
must either fix it by convention or accept that half the time it hands the
agent upside-down text.

**2. Connected components ≠ glyphs — 31 vs 26.** The extras are the two
`i` dots, a split `l`, and stem fragments. A naive one-tile-per-component
divide hands the agent tiles that are a bare dot or a bare stem: unreadable
in isolation, and worse, silently wrong (the agent reads 31 glyphs from a
26-glyph string). The u-overlap merge fixes it. Note also that the component
count moved 30→31 purely from the basis sign flip changing grid offsets,
while the merged glyph count stayed 26 — the merged count is the stable
quantity. The s4 seam's [10, 40] component window survives both.

**3. Per-glyph crops destroy the cross-glyph metrics that disambiguate
look-alikes.** Concretely, from `report.txt`: the `0` in `gc0d3` is
5.95 × 8.78 plane units and in isolation is simply an oval — `0` vs `O` is
undecidable from its own tile. The two `_` glyphs are 6.04 × 0.01 and
6.95 × 0.25, i.e. flat lines whose only distinguishing cue against a hyphen
is their position *below* the baseline, which a bbox crop throws away.
Lowercase `l` (0.99 × 8.90) and capital `L` (5.74 × 8.89) have identical
heights in this font and are separated by width alone, which the tile does
keep. So: render tiles at a common scale (this instrument does — a single
`px_per_unit` for all tiles) **and** carry each tile's baseline/v-offset,
or the divide will manufacture exactly the ambiguity rung-5 exists to remove.

## Reading for the rung-5 build

The perception wall that capped the rung-4 enforcement arm at reward 0/5 is
**not** a wall against reading these glyphs — rendered and divided, the
string is plainly legible. That makes the ~2-3h rung-5 build (harness
divides, agent reads one glyph at a time) worth its own go, and it now has a
working divide to build on rather than a hypothesis.

What this dry-run does **not** measure: whether haiku can read a glyph tile.
Legible-to-a-human is a necessary condition, not the arm. The arm remains
its own pre-registered, sized go.

Artifacts here: `whole.png` (undivided string, pinned orientation),
`contact-sheet.png` (26 merged glyph tiles, reading order, index-labelled),
`report.txt` (point count, extents, component/glyph counts, per-glyph
geometry). Per-glyph `glyph-NN.png` files are regenerable from the
instrument and deliberately not committed.
