#!/usr/bin/env python3
"""Harness-side glyph renderer -- the rung-5 "the harness divides, the agent
conquers one glyph at a time" instrument, and its dry-run.

Like calibrate_gcode.py this is a DEVELOPER tool, not part of the fail-open
gate: it never decides pass/fail and validator.py never imports it. It exists
so a rung-5 sampler (and, first, a human eyeballing this dry-run) can see the
2D image the divide would actually hand an agent.

Pipeline, all of it reused rather than reimplemented:
  readers.read_gcode_g1_points   M486-S0 extruding-G1 scoping (the gate's own)
  SVD plane fit + projection     as calibrate_gcode.svd_plane_project, with
                                 the basis sign PINNED (see below)
  grid + 8-connected flood fill  validator._NEIGHBORS_8 / _MIN_COMPONENT_
                                 PIXELS / _MAX_GRID_DIM, the clustering the
                                 s4 seam already counts
  u-interval merge               components whose u-spans overlap are one
                                 glyph (an 'i' is two components, not two
                                 glyphs)

BASIS SIGN. numpy's SVD returns singular vectors of arbitrary sign, so a bare
`vt[:2]` projection renders the text mirrored or upside down about half the
time -- measured, not theorized (the first dry-run render came out flipped).
Both sign ambiguities are resolved here, neither by convention:

  viewing side  take the plane normal vt[2], point it along world +z (the
                outward face), and build v = normal x u so the basis is
                right-handed and the viewer sits outside the part. Pin the
                NORMAL, never the in-plane axis: on this fixture the normal's
                z-component is 0.935 while vt[1]'s is 0.054, one rounding
                from flipping.
  reading order the slicer emits glyphs left to right, so u's own sign is
                recovered by requiring u-order to agree with FILE order
                (see `orient_u_by_file_order`). Measured on this fixture,
                POINT-level (what the function computes and prints):
                |r| = 0.983. The verdict separately reports a glyph-level
                r = 0.988 over median file index per glyph; that is a
                different statistic and is not what this code returns.

DEPENDENCIES. Every other module in this directory is stdlib-only because it
must run inside the task container. This one is not (numpy + cv2) and is
never staged there -- sync-task-copies.sh is an explicit allowlist. The
directory invariant is "stdlib-only, except dev tools, which are never
staged"; keep new in-container modules stdlib-only.
"""

import argparse
import os
import sys
from typing import NamedTuple

import numpy as np
import cv2

_SEAM_GATE_DIR = os.path.dirname(os.path.abspath(__file__))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import readers  # noqa: E402
import validator  # noqa: E402


def orient_u_by_file_order(xy):
    """Resolve u's sign -- the 180-degree in-plane rotation the viewing-side
    pin leaves open -- by requiring the projected reading order to agree with
    the order the slicer emitted the points in. Deposition runs left to right
    across the string, so the correct sign correlates positively with file
    index and the flipped one correlates equally negatively; the choice is
    unambiguous whenever |r| is not ~0.

    Correcting a negative r flips BOTH axes -- a 180-degree in-plane rotation,
    which keeps the viewing side the normal already pinned. Flipping u alone
    would mirror the text and silently undo that pin.

    Returns (xy, |r|). A near-zero |r| means file order does NOT run along the
    text (a differently-ordered slicer, or a fixture whose glyphs interleave)
    -- the caller is told, rather than silently handed an orientation this
    rule cannot justify.
    """
    idx = np.arange(len(xy), dtype=float)
    r = float(np.corrcoef(xy[:, 0], idx)[0, 1])
    if r < 0:
        xy = -xy
    return xy, abs(r)


def project_pinned(points):
    """SVD plane fit + projection with BOTH basis signs resolved: the viewing
    side from the plane normal, u's own sign from file order. Returns
    ((N, 2) array of (u, v), |r| of the file-order agreement)."""
    arr = np.array(points, dtype=float)
    centered = arr - arr.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    normal = vt[2] * (1.0 if vt[2][2] > 0 else -1.0)
    u = vt[0]
    v = np.cross(normal, u)
    return orient_u_by_file_order(np.column_stack([centered @ u, centered @ v]))


def components_at_cell(xy, cell):
    """The s4 seam's own rasterize + 8-connected flood fill, but returning the
    POINT INDICES per component instead of a count, so each component can be
    re-rendered at a finer resolution than the clustering grid. Returns None
    if the grid cap is exceeded."""
    x, y = xy[:, 0], xy[:, 1]
    xmin, ymin = float(x.min()), float(y.min())
    gx = np.floor((x - xmin) / cell).astype(int)
    gy = np.floor((y - ymin) / cell).astype(int)
    w, h = int(gx.max()) + 1, int(gy.max()) + 1
    if w > validator._MAX_GRID_DIM or h > validator._MAX_GRID_DIM:
        return None
    grid = np.zeros((h, w), dtype=bool)
    grid[gy, gx] = True
    members = {}
    for idx, (i, j) in enumerate(zip(gy, gx)):
        members.setdefault((int(i), int(j)), []).append(idx)

    visited = np.zeros_like(grid)
    comps = []
    for i0 in range(h):
        for j0 in range(w):
            if not grid[i0, j0] or visited[i0, j0]:
                continue
            stack = [(i0, j0)]
            visited[i0, j0] = True
            cells = []
            while stack:
                ci, cj = stack.pop()
                cells.append((ci, cj))
                for di, dj in validator._NEIGHBORS_8:
                    ni, nj = ci + di, cj + dj
                    if 0 <= ni < h and 0 <= nj < w and grid[ni, nj] and not visited[ni, nj]:
                        visited[ni, nj] = True
                        stack.append((ni, nj))
            if len(cells) < validator._MIN_COMPONENT_PIXELS:
                continue
            comps.append(np.array(sorted(i for c in cells for i in members.get(c, [])), dtype=int))
    return comps


# Advisory eyeball triggers. NOT arbitrary, and not calibrated either: each
# was chosen to sit between the two artifacts in hand (e.g. COVERAGE_LOW 0.5
# lies between the shattered synthetic's 0.341 and the fixture's 0.794). That
# is weaker than a calibrated threshold and stronger than a number pulled from
# nowhere, and saying "arbitrary" discourages the re-examination they need.
# They change no exit code and must never become tuning targets. Defined here
# so the tests import them instead of duplicating the literals.
FRAGILITY_LOW = 0.02
COVERAGE_LOW = 0.5
ASPECT_HIGH = 2.5
WIDTH_RATIO_HIGH = 2.0


class MergeMargins(NamedTuple):
    """What separation_margin reports. A named tuple because this return grew
    from 3 fields to 5 across three rounds of review, each time because a
    metric turned out to be blind to a failure mode; positional unpacking at
    every call site made each of those a mechanical edit."""
    max_intra: float
    min_inter: float
    fragility: float
    coverage: float
    median_aspect: float
    width_ratio: float
    pitch_ratio: float
    glyph_count: int


def separation_margin(xy, comps):
    """Describe the merge's partition. NOTHING HERE IS A CORRECTNESS CHECK --
    see the limits table below, which is the most important thing in this
    docstring.

    Merging at gap_tol=0 ("components whose u-spans overlap are one glyph") has
    no free parameter. What is reported is how far the partition sits from
    deforming, computed per artifact rather than shipped as constants:

        max_intra      narrowest overlap that still merged (<= 0)
        min_inter      narrowest gap that still split (> 0)
        fragility      min(|max_intra|, min_inter) / median glyph HEIGHT
        coverage       sum of glyph widths / total u-extent
        median_aspect  median glyph width / height
        width_ratio    widest glyph / median glyph width
        pitch_ratio    median glyph width / median inter-glyph gap
        glyph_count    glyphs produced (width_ratio is meaningless at 1)

    THREE EARLIER VERSIONS OF THIS FUNCTION SHIPPED A CHECK THAT COULD NOT
    REPORT ITS OWN CONDITION, and the history is kept because the cause
    generalizes:
      1. a `separated` boolean asserting max_intra < min_inter -- vacuous, the
         classifier IS `lo <= right` so it held for every input;
      2. fragility normalized by median glyph WIDTH -- a shattered divide
         scored 2.000 against healthy 0.088, i.e. ~23x SAFER, because the
         denominator collapsed with the partition it scored;
      3. median_aspect taken as a MAX -- read 413 on the real fixture and
         false-alarmed, because two underscores are legitimately flat
         (6.04 wide x 0.01 tall).
    Every one was a statistic computed from the very partition it scored. A
    quantity derived downstream of the decision under test cannot audit that
    decision. An earlier version added "and no further aggregate will fix
    this"; review refuted it by constructing pitch_ratio, so the weaker and
    true statement is that each aggregate needs an axis the failure does not
    deform. Full confidence still needs an independently-derived partition
    (stroke or file-order contiguity) compared against the u-overlap one.

    LIMITS TABLE. Measured, not reasoned. Real-fixture figures from
    text.gcode.gz at cell 0.4; synthetics in test_render_glyphs.

    Note the difference between MOVES and REPORTS: only a statistic with a
    trigger reports. median_aspect moves on shattering (0.11) but has no
    low-side trigger, so it never says so -- coverage is the only thing that
    reports shattering. A statistic that moves is not a detector.

      failure                  REPORTS it        moves only    blind / WRONG
      shattering               coverage 0.341    median_aspect width_ratio
      (cell too small)         (trigger 0.5)     0.11;         (1.00, equal
                                                 pitch_ratio   fragments);
                                                 9.5 -> 0.5,   fragility 0.057
                                                 the largest   -> 0.222, i.e.
                                                 move in this  the shattered
                                                 table         partition still
                                                               scores ~3.9x
                                                               SAFER. The
                                                               oldest inversion
                                                               here: the height
                                                               denominator cut
                                                               it from ~23x but
                                                               never removed it,
                                                               because
                                                               shattering also
                                                               widens min_inter
      global fusion            median_aspect     --            coverage
      (all -> one blob)        3.89 (trigger                   (1.000, ABOVE
                               2.5)                            correct);
                                                               fragility
                                                               (0.556, reads
                                                               safest);
                                                               width_ratio
                                                               (n=1, 1.00);
                                                               pitch_ratio
                                                               (no gaps, NaN)
      partial fusion           width_ratio 2.28  --            median_aspect
      (one pair merges)        (trigger 2.0)                   (0.68 vs 0.66);
                                                               coverage
                                                               (0.803, ABOVE
                                                               correct);
                                                               fragility
                                                               (unchanged);
                                                               pitch_ratio
                                                               (3.96 vs 3.90)
      UNIFORM fusion           NOTHING reports   pitch_ratio   all four
      (every glyph merges      it -- pitch_ratio 3.90 -> 8.30  triggers.
      with a neighbour)        moves but carries (alternating  13 glyphs of
                               no trigger        pairs), 5.00  26 survive:
                                                 (13 tightest  width_ratio
                                                 gaps)         1.23,
                                                               median_aspect
                                                               1.38, coverage
                                                               0.896 -- BETTER
                                                               than the
                                                               correct 0.794

    PITCH_RATIO (median glyph width / median inter-glyph gap) exists because
    the claim "no further aggregate can catch uniform fusion" -- made in an
    earlier version of this docstring -- was REFUTED by review. Fusion consumes
    gaps without stretching the survivors, so the gap median is an axis this
    failure does not deform: the same move as height-for-shattering and
    width-for-partial-fusion, applied a third time.

    It carries NO trigger, deliberately. The separation is real but modest and
    depends on which gaps fuse: 3.90 correct vs 8.30 when alternating pairs
    merge, but only 5.00 when the thirteen tightest gaps go instead (the
    reviewer proposing it estimated ~7.4 for that variant; measurement gives
    5.00, so the adversarial case separates less than predicted). Any cutoff
    between 3.90 and 5.00 would be fitted to these two artifacts, which is the
    error this whole function documents. It is printed for a human to weigh.
    It is blind to partial fusion (3.96 vs 3.90), undefined at one glyph, and
    carries coverage's no-word-spaces prior.

    So the TRIGGERED detectors catch non-uniform deformation only. A partition
    error that deforms every glyph roughly equally moves numerator and
    denominator together in each of them; pitch_ratio is the one statistic
    that survives that, and it is reported without a trigger.

    OUTSIDE PRIORS, all three of them, none unique. median_aspect assumes
    Latin glyphs are not several times wider than tall; coverage assumes no
    word-spaces and no wide kerning (a spaced string lowers it with a perfect
    partition); width_ratio assumes no glyph exceeds ~2x the median width
    (this fixture is already at 1.45, and a string mixing one wide glyph with
    narrow ones crosses 2.0 while correctly partitioned). Each can therefore
    be WRONG about a particular artifact -- which the three purely internal
    statistics structurally cannot be, and which is why they were useless.
    width_ratio has a second gap: it only moves when a fusion produces the
    WIDEST glyph in the string, so merging the two 1.01-wide i-class glyphs
    with a neighbour reaches ~3.2 against an 8.25 maximum and does not move it
    at all.

    Real fixture, correct partition: max_intra -0.89, min_inter +0.63,
    fragility 0.071, coverage 0.794, median_aspect 0.66, width_ratio 1.45.
    """
    if not comps:
        # keyword form on purpose: this return has silently fallen out of step
        # with the field list once already as the tuple grew
        return MergeMargins(max_intra=float("-inf"), min_inter=float("inf"),
                            fragility=float("nan"), coverage=float("nan"),
                            median_aspect=float("nan"), width_ratio=float("nan"),
                            pitch_ratio=float("nan"), glyph_count=0)
    spans = sorted((float(xy[c][:, 0].min()), float(xy[c][:, 0].max())) for c in comps)
    intra, inter = [], []
    right = spans[0][1]
    for lo, hi in spans[1:]:
        (intra if lo <= right else inter).append(lo - right)
        right = max(right, hi)
    max_intra = max(intra) if intra else float("-inf")
    min_inter = min(inter) if inter else float("inf")

    glyphs = merge_by_u_overlap(xy, comps, 0.0)
    heights = [float(np.ptp(xy[g][:, 1])) for g in glyphs]
    widths = [float(np.ptp(xy[g][:, 0])) for g in glyphs]
    scale = float(np.median(heights)) if heights else 0.0
    closest = min(abs(max_intra), min_inter)
    fragility = closest / scale if scale > 0 and np.isfinite(closest) else float("nan")

    extent = float(np.ptp(xy[:, 0]))
    coverage = sum(widths) / extent if extent > 0 else float("nan")

    ratios = [w / h for w, h in zip(widths, heights) if h > 0]
    median_aspect = float(np.median(ratios)) if ratios else float("nan")

    med_w = float(np.median(widths)) if widths else 0.0
    width_ratio = (max(widths) / med_w) if med_w > 0 else float("nan")

    # `inter` IS the between-glyph gap list. A boundary survives into two
    # separate glyphs exactly when lo > right, which is the same predicate that
    # built `inter`, over the same sorted spans with the same running maximum.
    # An earlier version recomputed this over glyph spans and filtered on
    # `b[0] > a[1]` -- a condition true for every consecutive pair by
    # construction, so the filter never dropped an element: another guard that
    # could not fire, written into the function whose docstring memorialises
    # that defect. Verified identical element-for-element on the real fixture
    # and all three synthetics.
    med_gap = float(np.median(inter)) if inter else float("nan")
    pitch_ratio = (med_w / med_gap) if med_gap and med_gap > 0 else float("nan")

    return MergeMargins(max_intra, min_inter, fragility, coverage,
                        median_aspect, width_ratio, pitch_ratio, len(glyphs))


def merge_by_u_overlap(xy, comps, gap_tol):
    """Group components into glyphs: sorted by u, a component joins the
    current glyph while its u-span starts no later than the glyph's current
    right edge + gap_tol. This is what turns an 'i' (dot + stem, two
    components) back into one glyph. Returns a list of index arrays, in
    left-to-right reading order.

    gap_tol=0 (the default) is the parameter-free rule -- plain u-overlap.
    Any other value is an exploration knob; see separation_margin for why a
    nonzero tolerance must not be shipped."""
    spans = sorted((float(xy[c][:, 0].min()), float(xy[c][:, 0].max()), i)
                   for i, c in enumerate(comps))
    glyphs, cur = [], None
    for lo, hi, i in spans:
        if cur is not None and lo <= cur[1] + gap_tol:
            cur = (cur[0], max(cur[1], hi), cur[2] + [i])
        else:
            if cur is not None:
                glyphs.append(cur)
            cur = (lo, hi, [i])
    if cur is not None:
        glyphs.append(cur)
    return [np.sort(np.concatenate([comps[i] for i in ids])) for _, _, ids in glyphs]


def render(pts, px_per_unit, pad_px, stroke, gap_break):
    """Rasterize a point subset, image row 0 = high v (text renders upright).
    stroke=False draws the bare deposition points (what the clustering sees);
    stroke=True connects consecutive-in-file points, breaking whenever the
    jump exceeds gap_break (a travel move between two recorded extrusions)."""
    x, y = pts[:, 0], pts[:, 1]
    xmin, xmax = float(x.min()), float(x.max())
    ymin, ymax = float(y.min()), float(y.max())
    w = max(1, int(round((xmax - xmin) * px_per_unit))) + 2 * pad_px
    h = max(1, int(round((ymax - ymin) * px_per_unit))) + 2 * pad_px
    img = np.full((h, w), 255, np.uint8)

    def to_px(p):
        return (int(round((p[0] - xmin) * px_per_unit)) + pad_px,
                h - 1 - (int(round((p[1] - ymin) * px_per_unit)) + pad_px))

    if stroke:
        for pa, pb in zip(pts[:-1], pts[1:]):
            if np.hypot(pb[0] - pa[0], pb[1] - pa[1]) > gap_break:
                continue
            cv2.line(img, to_px(pa), to_px(pb), 0, 1, cv2.LINE_AA)
    else:
        for p in pts:
            cx, cy = to_px(p)
            img[cy, cx] = 0
    return img


def contact_sheet(tiles):
    """One labelled row of glyph tiles, left to right in reading order."""
    cells = []
    height = max(t.shape[0] for t in tiles) + 22
    for rank, t in enumerate(tiles):
        cell = np.full((height, t.shape[1] + 10), 255, np.uint8)
        cell[0:t.shape[0], 5:5 + t.shape[1]] = t
        cv2.putText(cell, str(rank), (5, height - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, 0, 1, cv2.LINE_AA)
        cells.append(cell)
        cells.append(np.full((height, 3), 180, np.uint8))
    return np.hstack(cells)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gcode", default=os.path.join(
        _SEAM_GATE_DIR, "..", "probe-tasks", "gcode-to-text-gate", "environment", "text.gcode.gz"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--cell", type=float, default=0.4,
                    help="clustering cell size (0.4 = the calibrated s4 cell)")
    ap.add_argument("--merge-gap", type=float, default=0.0,
                    help="u-span gap tolerated when merging components into one glyph")
    ap.add_argument("--px-per-unit", type=float, default=24.0)
    ap.add_argument("--gap-break", type=float, default=1.0,
                    help="stroke render: u-v jump above this is a travel move, not a stroke")
    ap.add_argument("--expect-glyphs", type=int, default=26,
                    help="glyph count this fixture should divide into (report only)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    lines = []

    def say(s):
        print(s)
        lines.append(s)

    points = readers.read_gcode_g1_points(args.gcode)
    say(f"S0 extruding points: {len(points)}")
    xy, order_r = project_pinned(points)
    say(f"projected extent: u {xy[:,0].min():.2f}..{xy[:,0].max():.2f}  "
        f"v {xy[:,1].min():.2f}..{xy[:,1].max():.2f}")
    say(f"u-sign from file order: |r| = {order_r:.4f}"
        + ("" if order_r >= 0.5 else "   *** WEAK -- file order does not run along the text, "
                                     "orientation is NOT justified by this rule ***"))

    comps = components_at_cell(xy, args.cell)
    if comps is None:
        say(f"cell={args.cell}: grid cap exceeded, nothing to render")
        open(os.path.join(args.out, "report.txt"), "w").write("\n".join(lines) + "\n")
        return 1
    if not comps:
        # separation_margin tolerates this, but contact_sheet's max() over an
        # empty tile list does not -- the "does not crash" property has to hold
        # for the TOOL, not just the function
        say(f"cell={args.cell}: no components survived the "
            f"{validator._MIN_COMPONENT_PIXELS}-pixel floor, nothing to render")
        open(os.path.join(args.out, "report.txt"), "w").write("\n".join(lines) + "\n")
        return 1
    say(f"cell={args.cell}: {len(comps)} connected components")

    m = separation_margin(xy, comps)
    say(f"merge margins: narrowest overlap that merged {m.max_intra:+.2f}, "
        f"narrowest gap that split {m.min_inter:+.2f}")
    say(f"  fragility {m.fragility:.3f} (closest decision / median glyph height) -- "
        f"how near a decision came to flipping; blind to over-merge")
    say(f"  coverage {m.coverage:.3f} (glyph widths / u-extent) -- "
        f"detects SHATTERING only; over-merge drives it to 1.000")
    say(f"  median aspect {m.median_aspect:.2f} (median glyph width/height) -- "
        f"REPORTS global fusion (high trigger only); moves on shattering but "
        f"has no low trigger, so it never says so; blind to partial fusion")
    say(f"  width ratio {m.width_ratio:.2f} (widest / median glyph width) over "
        f"{m.glyph_count} glyphs -- catches PARTIAL fusion; reads a degenerate "
        f"1.00 at one glyph and on shattering")
    say(f"  pitch ratio {m.pitch_ratio:.2f} (median glyph width / median gap) -- "
        f"the only one whose move on UNIFORM fusion is diagnostic (aspect and "
        f"coverage also move there, but toward reassurance); no trigger")

    # Four advisory triggers; see the module-level constants for what they are
    # and are not. The `not (x > y)` form is deliberate: it fires on NaN.
    # NONE of them catches uniform fusion -- see the limits table.
    if not (m.fragility > FRAGILITY_LOW):
        say("*** fragility near zero -- some component nearly changed glyphs ***")
    if not (m.coverage > COVERAGE_LOW):
        say("*** coverage low -- signature of a SHATTERED divide (cell too "
            "small, projection broken); note fragility reads HIGH here ***")
    if not (m.width_ratio < WIDTH_RATIO_HIGH) and m.glyph_count > 1:
        say("*** one glyph far wider than the rest -- signature of PARTIAL "
            "fusion (cell slightly too large); note median aspect, coverage "
            "and fragility all read HEALTHY here ***")
    if not (m.median_aspect < ASPECT_HIGH):
        say("*** typical glyph far wider than tall -- signature of OVER-MERGE; "
            "note coverage reads near 1.000 and fragility HIGH here, so "
            "neither of those can catch this ***")
    say("    (reported, never enforced -- judge them; do NOT tune --merge-gap "
        "until the count looks right. The four TRIGGERS above are all blind to "
        "uniform fusion; pitch ratio moves on it but deliberately carries no "
        "trigger -- see separation_margin's limits table)")
    if args.merge_gap != 0.0:
        say(f"    NOTE: margins above describe the parameter-free gap_tol=0 "
            f"partition, but --merge-gap {args.merge_gap} was used for the "
            f"glyphs rendered below -- they are not the same partition")

    glyphs = merge_by_u_overlap(xy, comps, args.merge_gap)
    say(f"after u-overlap merge (gap {args.merge_gap}): {len(glyphs)} glyphs "
        f"(expected {args.expect_glyphs})")

    tiles = []
    say("\nper-glyph (reading order):")
    for rank, idxs in enumerate(glyphs):
        sub = xy[idxs]
        say(f"  {rank:02d}: pts={len(idxs):5d}  u={sub[:,0].min():8.2f}..{sub[:,0].max():7.2f}  "
            f"size={np.ptp(sub[:,0]):5.2f}x{np.ptp(sub[:,1]):5.2f}")
        dots = render(sub, args.px_per_unit, 6, False, args.gap_break)
        strokes = render(sub, args.px_per_unit, 6, True, args.gap_break)
        height = max(dots.shape[0], strokes.shape[0])

        def padded(im):
            p = np.full((height, im.shape[1]), 255, np.uint8)
            p[:im.shape[0]] = im
            return p
        cv2.imwrite(os.path.join(args.out, f"glyph-{rank:02d}.png"),
                    np.hstack([padded(dots), np.full((height, 8), 200, np.uint8), padded(strokes)]))
        tiles.append(strokes)

    cv2.imwrite(os.path.join(args.out, "contact-sheet.png"), contact_sheet(tiles))
    cv2.imwrite(os.path.join(args.out, "whole.png"),
                render(xy, args.px_per_unit / 2, 10, True, args.gap_break))
    say(f"\nwrote whole.png, contact-sheet.png, {len(tiles)} glyph-NN.png into {args.out}")
    open(os.path.join(args.out, "report.txt"), "w").write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
