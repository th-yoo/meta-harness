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
- Parameter-free u-overlap merge → **exactly 26 glyphs**, with computed
  margins (below) rather than a tuned tolerance. Carry the same caveat here
  as for the merge rule: 26 is an answer that was already known, so this is a
  count agreeing with a target, not an independent measurement of it.
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

**And 23–24/26 is itself an upper bound, not a measurement.** The tiles were
judged by a reader who already knew the target string — knowing the answer is
what makes tile 7 read as an ambiguous `0`/`O` rather than an unidentifiable
oval, and what allows tiles 10 and 13 to be classified as underscores at all.
A naive reader has none of that. The contamination named below for
`whole.png` applies to this number too.

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

**A confound that check must be pre-registered against** (raised by the
sibling lane, which measured it): the shipped bench audit path sends the
opencode-flavored id `anthropic/claude-sonnet-5` to the ACP wire and gets
`terminal_reason=api_error`, while the same wire accepts the bare
`claude-sonnet-5`. Any channel check that resolves a model id from the
opencode-flavored bench constants rather than a bare CLI id will therefore
fail as a TRANSPORT error that presents as a perception result. Pin the model
id explicitly in the check's pre-registration, and treat any `api_error` as a
transport failure to be fixed and re-run — never as evidence that the tier
cannot see the glyph. The same rule applies to the arm itself.

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

What transfers is not the number but the **margin** — how far the merge's
decisions sit from flipping. The instrument now merges at plain u-overlap, no
free parameter at all. **This is the sixth fix-the-evidence instance of the
arc, and the first where the error was about to be baked in as a constant
rather than carried as a derivation.**

*Second correction, and the sharpest lesson here.* The first replacement for
that constant returned a `separated` boolean asserting `max_intra < min_inter`
and claimed to "fail loud when they cross". **That guard was vacuous: it could
never fire.** The classifier is `lo <= right`, so intra-glyph gaps are always
≤ 0 and inter-glyph gaps always > 0, making the comparison true for every
possible artifact — the classification predicate *is* the quantity being
compared. The console line reading SEPARATED was a formatting operation on a
foregone conclusion.

Two independent finds, same hour: a regression test written against a
deliberately fragile fixture failed on its first run, and the sibling reviewer
derived the tautology from the source. Worth recording that **a guard that
cannot fire is weaker evidence than the fitted constant it replaced** — the
constant at least made a checkable claim. This is the same disease one level
up from the error it was meant to fix.

What replaced it is reported, never thresholded: `max_intra` (narrowest
overlap that still merged), `min_inter` (narrowest gap that still split), and
**fragility** — dimensionless, derived wholly from the artifact, and able to
come back near zero, which it does on a fragile fixture.

*Third correction, and the metric bit back twice.* The first fragility divided
by median glyph **width** — computed from the very partition it was scoring.
That bias runs the dangerous way. When a divide **shatters** (cell too small,
projection broken) glyph widths collapse while inter-fragment gaps grow, so
the ratio *rises*: measured on synthetic components, a healthy 10-glyph
partition scored 0.088 and a shattered 30-fragment one scored **2.000** — the
broken divide reporting ~23× safer than the correct one. A metric that
rewarded the failure it existed to catch.

Normalizing by median glyph **height** fixes the denominator, since text
height is font-fixed and untouched by any horizontal merge decision. Being
honest about what that does and does not buy: it cuts the inversion to ~3.9×
(0.057 healthy vs 0.222 shattered) but **does not remove it**, because
shattering also widens `min_inter` in the numerator. Fragility measures
closeness-to-flipping and cannot be repaired into a measure of correctness. A
high fragility is not reassurance.

**Coverage** = sum of glyph widths / total u-extent is therefore the
shattering detector, and it separates the same synthetics cleanly and in the
right direction: 0.913 healthy versus 0.341 shattered.

*Fourth correction — and the reason this section is the longest in the
document.* Coverage and fragility are **both blind to over-merge**, the
opposite failure, and score it as ideal. Measured on a third synthetic where
30 components collapse into one blob: coverage **1.000**, the theoretical
maximum and *better than the correct partition's 0.913*, with fragility 0.556,
the highest of the three. Structural, not tuning: over-merging conserves the
width sum while absorbing the gaps, so coverage peaks at exactly the failure
it cannot see; and with no inter-glyph gaps left, `min_inter` is +∞ so
fragility collapses to |max_intra|, which *grows* as components pile up.

**That is three checks in a row on this instrument that could not report the
condition they were named for** — a boolean true by construction, a metric
inverted by shattering, and a pair blind to over-merge. They share one cause,
and it is the transferable lesson of this probe: *every one was a statistic
computed from the very partition it was scoring. A quantity derived downstream
of the decision under test cannot audit that decision.*

**Median aspect** (median glyph width / height) is the two-sided detector, and
the only quantity here carrying a prior from **outside** the artifact — Latin
glyphs are not several times wider than tall. It rises on fusing and falls on
shattering: synthetics 0.63 healthy, 0.11 shattered, 3.89 fused, with the real
fixture at 0.66, beside healthy, as the prior predicts. Because it encodes an
outside prior it *can be wrong* about a given artifact — precisely the property
the other two structurally lack.

Median rather than max, learned by measurement: the max form read **413** on
the real fixture and fired a false over-merge alarm, because the two
underscores are legitimately flat (6.04 × 0.01) and a max is decided by them
alone. Every synthetic had uniform glyph heights, so none could have caught
it — *a detector validated only on synthetic fixtures is validated against the
fixture generator, not the artifact.*

Real fixture: max_intra −0.89, min_inter +0.63, fragility **0.071**, coverage
**0.794**, median aspect **0.66**. Choosing a cutoff on any of them would
re-commit the original error, so the instrument prints all three and leaves
the judgment to a human. The console does carry three advisory eyeball
triggers (0.02, 0.5, 2.5); those numbers are arbitrary, are labelled as such
in the source, change no exit code, and must never become tuning targets.

**Still open, and named rather than closed:** fragility measures how close the
overlap partition came to changing, not whether that partition is *right*. A
genuinely independent check would classify by a signal the overlap predicate
does not use — gap-distribution bimodality, or stroke/file-order contiguity,
since components of one glyph are contiguous in deposition — and require the
two partitions to agree. That check can disagree, which is the property this
one still lacks. Not built; flagged for whoever builds the rung-5 sampler.

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
