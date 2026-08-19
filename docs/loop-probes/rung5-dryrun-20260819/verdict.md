# Rung-5 dry-run verdict (2026-08-19, `yoo-dev`) — the harness-side divide renders well enough that rung-5 is NOT DEAD; it is not yet shown to be worth a build

**Revision note.** The first version of this verdict claimed "26 tiles, every
one independently readable", called a merge tolerance "real structure, not a
fitted constant", and declared the u-sign orientation residual irreducible.
The sibling session `meta-harness-f7` refuted all three on request. Every
correction below was verified locally with the instrument before being
accepted — the u-sign and separation numbers in this document are my own
re-measurements, not quoted claims.

**Question asked (the staged free go):** before spending anything on a rung-5
arm, render `flag{gc0d3_iz_ch4LLenGiNg}`'s 26 glyphs through the existing
pipeline and eyeball whether they are legible at all. If the harness can
divide perfectly and the glyphs still can't be read, rung-5 is dead before
it is built.

**Answer: not dead.** The divide yields exactly 26 glyph tiles and most are
readable in isolation. Zero model spend, zero bench spend — pure local
rasterization of the fixture.

**What this does NOT establish: that rung-5 is worth building.** A
necessary-condition screen only carries information when it FAILS. It did not
fail, which is the uninformative direction. Spending that as "unblocked" was
the original error; the honest status is "not eliminated", and the build go
still needs the delivery-channel check below.

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
  26 — components are not glyphs.
- Parameter-free u-overlap merge → **exactly 26 glyphs**, with a computed
  separation margin (below) rather than a tuned tolerance.
- Both projection sign ambiguities are now resolved deterministically, neither
  by convention (below).
- Stroke render (connect consecutive-in-file points, break on a jump > 1.0
  plane unit = a travel move) is crisp. The bare-dot render — literally what
  the clustering sees — is sparse and much harder to read at the same scale.

## Legibility, corrected: 23–24 of 26, not 26

The original "every one independently readable" contradicted this document's
own third design load. Reading `contact-sheet.png` honestly:

- tiles 10 and 13 are faint horizontal dashes (6.04 × 0.01 and 6.95 × 0.25
  plane units). With no baseline cue in a bbox crop they read as hyphen or
  overline at least as readily as underscore.
- tile 7 is an oval; `0` versus `O` is undecidable from its own tile.

So 23–24/26. An overstated necessary condition is exactly how a screening
test quietly becomes a claim.

**The reader substitution, now named.** `whole.png` was read by an opus-tier
reader who already knew the target string and used word context — leetspeak
flag shape — to resolve it. Per-glyph division is precisely the operation
that removes that context, so **`whole.png` is not evidence for tile-level
legibility**; only `contact-sheet.png` bears on the arm, and it is the weaker
artifact. The arm's reader is haiku-tier, and what it would receive is a
rendering choice that does not exist in the harness yet.

## The gating question before any build go

**What does the agent physically receive — an image, or text?** The bench
driver is `claude-code` (`opencode-plugin/src/bench/drivers/claude-code.ts`,
argv `claude -p <instruction>`), whose Read tool does render PNGs, so an
image channel plausibly exists and haiku 4.5 is vision-capable. That is an
argument, not a measurement: it has not been verified end-to-end in-container.
If the delivery channel is not an image the agent can actually see, this
entire dry-run measures something the arm never touches. **Verifying the
channel is free and must precede the ~2-3h build, not follow it.**

## Design loads

**1. Both SVD sign ambiguities are resolved — the "irreducible" residual was
refuted.** The first render came out mirrored and upside-down; numpy's
singular vectors carry arbitrary sign.

*Viewing side:* pin the plane normal `vt[2]` to world +z and set
`v = normal × u`, so the basis is right-handed and the viewer sits outside
the part. Pin the NORMAL, never the in-plane axis: `sign(vt[1]·ẑ)` gives the
right answer here but on a margin of 0.054 (the text plane is
near-horizontal, so in-plane axes carry almost no z), against the normal's
0.935. **That margin — 0.935 versus 0.054 — is the genuinely new measurement
here.**

*Reading order:* the original claim that u's own sign is "genuinely not
derivable from the coordinates" was wrong. The slicer emits glyphs strictly
left to right, and the fixture carries that order. Re-measured locally: glyph
u-position versus median point file index gives **r = +0.988, monotone over
25/25 consecutive steps** (point-level r = 0.983); the flipped sign gives
−0.988, so the choice is unambiguous. `orient_u_by_file_order` now applies it,
flipping BOTH axes when needed — a 180° in-plane rotation, since flipping u
alone would mirror the text and silently undo the viewing-side pin — and
reports |r| so a fixture where file order does not run along the text is
surfaced rather than silently oriented.

Single-fixture caveat applies to this correction too: verify across other
strings before it enters a sampler contract.

**2. Connected components ≠ glyphs (31 vs 26) — and the merge tolerance was a
fitted constant.** The extras are the two `i` dots, a split `l`, and stem
fragments. A naive one-tile-per-component divide hands the agent bare dots
and stems, and silently reports 31 glyphs for a 26-glyph string.

The original "plateau" claim (stable across merge-gap −0.2..+0.5, therefore
real structure) does not survive its own report. Re-measured: the tightest
inter-glyph gap on this string is **+0.63**, and the widest intra-glyph gap
is **−0.89**. The claimed plateau sits strictly inside [−0.89, +0.63] — its
ceiling is just under this string's tightest kerning and its floor just above
this font's widest intra-glyph split. That is one string in one font: the
shape of a fitted constant, validated where the answer (26) was already
known, which is exactly where a fitted rule looks stable.

What transfers is not the number but the **existence of a separation** between
those two statistics. The instrument now merges at plain u-overlap — no free
parameter at all — and `separation_margin` computes `max_intra` and
`min_inter` per artifact, reporting SEPARATED/OVERLAPPING and failing loud
when they cross, instead of inviting someone to tune the tolerance until the
count looks right. **This is the sixth fix-the-evidence instance of the arc,
and the first where the error was about to be baked in as a constant rather
than carried as a derivation.**

**3. Per-glyph crops destroy the cross-glyph metrics that disambiguate
look-alikes.** As above for `0`/`O` and the two underscores. Lowercase `l`
(0.99 × 8.90) and capital `L` (5.74 × 8.89) have identical heights in this
font and are separated by width alone, which the tile does keep. So: render
tiles at a common scale (the instrument does) **and** carry each tile's
baseline / v-offset, or the divide manufactures exactly the ambiguity rung-5
exists to remove.

## Instrument placement

`sync-task-copies.sh` is an explicit allowlist (`validator`, `spec_check`,
`hook`, `readers`), so this tool cannot silently ship into a container, and
nothing imports it. But every other module in `term-bench2/seam-gate/` is
stdlib-only *because it must run in-container*, and this is the first
numpy+cv2 module in that directory. That invariant was undeclared; it is now
stated in the module docstring as "stdlib-only, except dev tools, which are
never staged".

## Artifacts

`whole.png` (undivided string, pinned orientation — see the caveat above
about what it does and does not evidence), `contact-sheet.png` (26 merged
glyph tiles, reading order, index-labelled), `report.txt` (point count,
extents, file-order |r|, separation margin, component/glyph counts, per-glyph
geometry). Per-glyph `glyph-NN.png` files are regenerable from the instrument
and deliberately not committed.
