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
Two of the four orientations are killed deterministically by pinning the
viewing side: take the plane normal vt[2], point it along world +z (the
outward face), and build v = normal x u so the basis is right-handed, i.e.
the viewer sits on the outward side. The remaining ambiguity is u's own sign
(a 180-degree in-plane rotation); it is NOT derivable from the coordinates
and is left to the reader.
"""

import argparse
import os
import sys

import numpy as np
import cv2

_SEAM_GATE_DIR = os.path.dirname(os.path.abspath(__file__))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import readers  # noqa: E402
import validator  # noqa: E402


def project_pinned(points):
    """SVD plane fit + projection with the basis sign pinned to the outward
    (+z normal) viewing side. Returns an (N, 2) array of (u, v)."""
    arr = np.array(points, dtype=float)
    centered = arr - arr.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    normal = vt[2] * (1.0 if vt[2][2] > 0 else -1.0)
    u = vt[0]
    v = np.cross(normal, u)
    return np.column_stack([centered @ u, centered @ v])


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


def merge_by_u_overlap(xy, comps, gap_tol):
    """Group components into glyphs: sorted by u, a component joins the
    current glyph while its u-span starts no later than the glyph's current
    right edge + gap_tol. This is what turns an 'i' (dot + stem, two
    components) back into one glyph. Returns a list of index arrays, in
    left-to-right reading order."""
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
    xy = project_pinned(points)
    say(f"projected extent: u {xy[:,0].min():.2f}..{xy[:,0].max():.2f}  "
        f"v {xy[:,1].min():.2f}..{xy[:,1].max():.2f}")

    comps = components_at_cell(xy, args.cell)
    if comps is None:
        say(f"cell={args.cell}: grid cap exceeded, nothing to render")
        open(os.path.join(args.out, "report.txt"), "w").write("\n".join(lines) + "\n")
        return 1
    say(f"cell={args.cell}: {len(comps)} connected components")

    glyphs = merge_by_u_overlap(xy, comps, args.merge_gap)
    say(f"after u-overlap merge (gap {args.merge_gap}): {len(glyphs)} glyphs "
        f"(expected {args.expect_glyphs})")

    tiles = []
    say("\nper-glyph (reading order):")
    for rank, idxs in enumerate(glyphs):
        sub = xy[idxs]
        say(f"  {rank:02d}: pts={len(idxs):5d}  u={sub[:,0].min():8.2f}..{sub[:,0].max():7.2f}  "
            f"size={sub[:,0].ptp():5.2f}x{sub[:,1].ptp():5.2f}")
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
