#!/usr/bin/env python3
"""Seam-gate calibration harness (Task 3).

Proves the gcode-to-text-gate spec's predicates against reality: generates an
ORACLE artifact set (a correct filter/plane-fit/projection pipeline run over a
real gcode file) and a BAD artifact set (reproducing the measured v1-arm
failure shape -- an agent that forgot to scope its filter, and one that
forgot to do a real plane-basis projection), runs the Task-2 validator against
both, and asserts the gate actually discriminates: the oracle must pass every
seam, the bad set must fail at least two.

In its default mode it also CALIBRATES seam `s4` (the cluster-count seam):
it searches a fixed set of candidate cell sizes, picks the smallest cell
whose oracle component count lands in a plausible glyph-count range, and
REWRITES `--spec` on disk with the measured cell + a bounds window around
that count. `--check-only` skips the search/rewrite and just re-proves an
already-calibrated spec (see Task 5 reuse below).

Retarget note (controller ruling, plan defect fix): seam `s4` was originally
specced to target a "clusters" artifact holding pre-computed centroids (one
row per component). That's wrong for `conncomp2d`'s semantics -- it
rasterizes the artifact's own *points*, and a file of centroids collapses
every component to a single pixel, under the validator's 3-pixel component
floor (`_MIN_COMPONENT_PIXELS` in validator.py) -- so the oracle would
false-FAIL. This harness instead targets `s4` at the `projected` artifact
(the raw `u v` projected points), and the reference spec's "clusters"
artifact-id/seam entries are removed by `rewrite_spec` below. `clusters.txt`
remains a harness OUTPUT (one informational row per component, `cx cy
pixels`) written by this script for calibration printouts -- it is not
referenced by any seam and never validated.

Id-only artifacts (Task 7 structural fix): the spec's top-level "artifacts"
id->path map is gone -- specs now carry a flat `artifactIds` list of bare
ids, and validator.py resolves each id to `<root>/.seam/<id>.txt` by
convention. `rewrite_spec` below operates on that id-only shape.

CLI:
    python3 calibrate_gcode.py <gcode_path> [--spec PATH] [--check-only]
    python3 calibrate_gcode.py <gcode_path> --emit-evidence

`<gcode_path>` is a plain-text (or gzip-compressed, detected by a `.gz`
suffix) gcode file, e.g. the terminal-bench-2 gcode-to-text task's
`text.gcode[.gz]` fixture. `--spec` defaults to this repo's own
`specs/gcode-to-text-gate.json`; Task 5 (or any later re-verification) can
pass a copy of that spec with `--check-only` to re-run the oracle-pass /
bad-fail assertions without touching it -- see `--check-only`'s help text.

`--emit-evidence` (Task 7 item 2) is a separate, spec-independent mode: it
computes and prints the measured statistic or response curve for every
vocabulary op with a free numeric parameter -- see `emit_evidence_block`
below -- from `<gcode_path>` alone, then exits. It never opens or touches
`--spec`. This is the "cards derive bounds, never guess them" evidence a
card generator/sampler should be given (see SPEC.md's evidence-emission
contract sentence) -- the join-probe's B2 arm designed the richest seam set
of any generated card and died on exactly one guessed number (a cluster
cell size with no evidence backing it); this closes that gap.

Exit code: 0 if oracle passes every seam and bad fails >= 2 seams (and, in
non-check-only mode, the rewritten spec still validates); 1 otherwise. This
is a developer/calibration tool, not the fail-open gate itself (see
validator.py's module docstring for that contract) -- unexpected errors here
are allowed to raise and produce a normal nonzero-exit traceback.
"""

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

_SEAM_GATE_DIR = os.path.dirname(os.path.abspath(__file__))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import validator  # noqa: E402 -- reuse the real conncomp2d + constants, see below
from spec_check import check_spec  # noqa: E402

DEFAULT_SPEC_PATH = os.path.join(_SEAM_GATE_DIR, "specs", "gcode-to-text-gate.json")
VALIDATOR_PATH = os.path.join(_SEAM_GATE_DIR, "validator.py")

# Cluster-seam calibration search space (brief, verbatim).
CELL_CANDIDATES = [0.3, 0.4, 0.5, 0.8, 1.0]
TARGET_MIN, TARGET_MAX = 10, 40
# Oracle glyph truth for this fixture (26 glyphs in the "Embossed text"
# object) -- used only as the fallback search's "closest to" anchor.
TARGET_TRUTH = 26

_M486_S_RE = re.compile(r"^M486\s+S(-?\d+)")


# --------------------------------------------------------------------------
# Gcode parsing (single pass -> both the ORACLE and the whole-file-unfiltered
# BAD point sets).
# --------------------------------------------------------------------------

def open_gcode(path):
    """Open a plain-text or gzip-compressed gcode file for reading, tolerant
    of non-UTF-8 bytes (some gcode slicers emit stray latin-1 bytes in
    comments -- never let a decode error abort calibration over a comment
    we don't even parse)."""
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def parse_line_params(line):
    """Split a gcode motion line into (command, {letter: float}).

    Decimal commas are converted to periods before parsing (some gcode
    exports use locale-formatted decimals) -- see the controller ruling's
    oracle-generation facts. A token that still doesn't parse as a float is
    skipped (defensive; this fixture doesn't actually contain any).
    """
    parts = line.split()
    cmd = parts[0] if parts else ""
    params = {}
    for tok in parts[1:]:
        if not tok:
            continue
        letter = tok[0]
        try:
            val = float(tok[1:].replace(",", "."))
        except ValueError:
            continue
        params[letter] = val
    return cmd, params


def collect_points(gcode_path):
    """Single pass over the gcode file. Returns (oracle_points, bad_points),
    each a list of (x, y, z) tuples.

    oracle_points: G1 lines with an E param, inside an `M486 S0` ... `M486
    S-1` scope (the "Embossed text" object per this fixture's M486 A-tags),
    that also carry an X or Y param (i.e. actual planar motion, not a
    retraction-only E move) -- measured to select exactly 38,972 points on
    the real fixture, matching the controller ruling's oracle-generation
    facts (plane fit z=0.3325x+0.1720y-30.37, R^2=0.9878).

    bad_points: every G1 line in the WHOLE file, unscoped, regardless of E/
    X/Y presence -- the "whole-file unfiltered, travel included, no S0
    scoping" v1-arm failure shape. Position (x, y, z) is tracked
    incrementally across all G0/G1 motion so both sets share one walk of
    the file.
    """
    oracle_points = []
    bad_points = []
    cur_s = None
    x = y = z = 0.0
    with open_gcode(gcode_path) as f:
        for raw_line in f:
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line.startswith("M486"):
                m = _M486_S_RE.match(line)
                if m:
                    cur_s = int(m.group(1))
                continue
            if line.startswith("G0") or line.startswith("G1"):
                cmd, params = parse_line_params(line)
                if "X" in params:
                    x = params["X"]
                if "Y" in params:
                    y = params["Y"]
                if "Z" in params:
                    z = params["Z"]
                if cmd == "G1":
                    bad_points.append((x, y, z))
                    if cur_s == 0 and "E" in params and ("X" in params or "Y" in params):
                        oracle_points.append((x, y, z))
    return oracle_points, bad_points


# --------------------------------------------------------------------------
# Plane fit / projection (numpy required -- imported lazily by main()).
# --------------------------------------------------------------------------

def svd_plane_project(points, np):
    """SVD plane fit + project: mean-center the (x,y,z) cloud, take the top-2
    singular vectors as the in-plane basis, and project every point onto it.
    Returns an (N, 2) array of (u, v).
    """
    arr = np.array(points, dtype=float)
    centered = arr - arr.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    basis = vt[:2]
    return centered @ basis.T


def affine_residual_ratio(points, np):
    """Same metric seam s3 (`affine_residual_below`) checks: fit z = a*x +
    b*y + c by least squares, return var(residual) / var(z). Informational
    only here (written to plane.txt) -- the actual pass/fail always comes
    from running the real validator against the artifact file, not this
    function.
    """
    arr = np.array(points, dtype=float)
    x, y, z = arr[:, 0], arr[:, 1], arr[:, 2]
    a = np.column_stack([x, y, np.ones_like(x)])
    try:
        coef, _, _, _ = np.linalg.lstsq(a, z, rcond=None)
    except np.linalg.LinAlgError:
        return float("nan")
    resid = z - a @ coef
    z_var = float(np.var(z))
    if z_var == 0:
        return 0.0 if float(np.var(resid)) == 0 else float("inf")
    return float(np.var(resid) / z_var)


# --------------------------------------------------------------------------
# Cluster counting / calibration search. Reuses validator.op_cluster_count_
# in_range directly (not a reimplementation) so the calibration is guaranteed
# to match whatever the real gate will compute -- the whole point of
# "calibration" is picking numbers the actual predicate will honor.
# --------------------------------------------------------------------------

_COUNT_RE = re.compile(r"^(\d+) components")


def cluster_count_at_cell(proj_path, cell, np):
    """Run the validator's real conncomp2d op with permissive bounds (so it
    always "passes") purely to extract the component count from its detail
    string. Returns None if the grid-size cap was exceeded at this cell.
    """
    passed, detail = validator.op_cluster_count_in_range(proj_path, cell, 0, 10**9, np)
    m = _COUNT_RE.match(detail)
    if not passed and m is None:
        return None  # grid-cap exceeded (or some other non-count failure)
    return int(m.group(1)) if m else None


def search_cell(oracle_proj_path, np):
    """Search CELL_CANDIDATES (ascending) for the smallest cell whose oracle
    component count lands in [TARGET_MIN, TARGET_MAX]. Falls back to the
    cell whose count is closest to TARGET_TRUTH if none land in range.

    Returns (cell, count, results, is_fallback) where `results` is the full
    [(cell, count_or_None), ...] sweep, for printing.
    """
    results = [(cell, cluster_count_at_cell(oracle_proj_path, cell, np)) for cell in CELL_CANDIDATES]
    for cell, count in results:
        if count is not None and TARGET_MIN <= count <= TARGET_MAX:
            return cell, count, results, False
    valid = [(cell, count) for cell, count in results if count is not None]
    if not valid:
        raise RuntimeError(
            "cluster-cell search: every candidate cell exceeded the "
            f"{validator._MAX_GRID_DIM}x{validator._MAX_GRID_DIM} grid cap "
            "-- the projection artifact's coordinate extent is unexpectedly large"
        )
    cell, count = min(valid, key=lambda cc: abs(cc[1] - TARGET_TRUTH))
    return cell, count, results, True


def compute_cluster_rows(xy_array, cell, np):
    """Informational-only: run the SAME rasterize + 8-connected flood fill as
    validator.op_cluster_count_in_range (reusing its frozen constants
    `_NEIGHBORS_8` / `_MIN_COMPONENT_PIXELS` for consistency), but return
    per-component (cx, cy, pixels) rows instead of just a count -- the
    validator's own function only returns an aggregate count + detail
    string, not per-component detail, so this exists purely to produce
    clusters.txt's printout content. Never used for any pass/fail decision.
    """
    if len(xy_array) == 0:
        return []
    x, y = xy_array[:, 0], xy_array[:, 1]
    xmin, ymin = float(x.min()), float(y.min())
    gx = np.floor((x - xmin) / cell).astype(int)
    gy = np.floor((y - ymin) / cell).astype(int)
    w, h = int(gx.max()) + 1, int(gy.max()) + 1
    if w > validator._MAX_GRID_DIM or h > validator._MAX_GRID_DIM:
        return []  # informational only -- silently skip rather than blow up
    grid = np.zeros((h, w), dtype=bool)
    grid[gy, gx] = True
    visited = np.zeros_like(grid, dtype=bool)
    rows = []
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
            if len(cells) >= validator._MIN_COMPONENT_PIXELS:
                mean_i = sum(c[0] for c in cells) / len(cells)
                mean_j = sum(c[1] for c in cells) / len(cells)
                cx = xmin + (mean_j + 0.5) * cell
                cy = ymin + (mean_i + 0.5) * cell
                rows.append((cx, cy, len(cells)))
    return rows


# --------------------------------------------------------------------------
# Artifact writing
# --------------------------------------------------------------------------

def write_rows(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for row in rows:
            f.write(" ".join(f"{v:.6f}" for v in row) + "\n")


def write_artifact_set(root, points, proj_xy, plane_ratio, cluster_rows):
    seam_dir = Path(root, ".seam")
    write_rows(seam_dir / "points.txt", points)
    write_rows(seam_dir / "projected.txt", proj_xy)
    write_rows(seam_dir / "plane.txt", [(plane_ratio,)])
    write_rows(seam_dir / "clusters.txt", cluster_rows)


# --------------------------------------------------------------------------
# Spec rewrite
# --------------------------------------------------------------------------

def find_seam(spec, seam_id):
    for seam in spec.get("seams", []):
        if seam.get("id") == seam_id:
            return seam
    return None


def extract_cluster_predicate(spec):
    """Read the current s4 cell/min/max from a spec (used in --check-only
    mode, and as a fallback default). Returns (cell, min, max)."""
    seam = find_seam(spec, "s4")
    if seam and seam.get("predicate", {}).get("op") == "cluster_count_in_range":
        pred = seam["predicate"]
        return pred.get("cell", 0.5), pred.get("min", 10), pred.get("max", 40)
    return 0.5, 10, 40


def rewrite_spec(spec, cell, lo, hi):
    """Return a deep-copied spec with s4 retargeted at the `projected`
    artifact id and calibrated, and the `clusters` artifact-id/seam entries
    removed entirely (controller ruling -- see module docstring).

    Operates on the Task-7 id-only spec shape: `artifactIds` is a flat list
    of bare ids (no paths anywhere), and `seam.artifact` references an entry
    in that list directly -- validator.py resolves each id to
    `<root>/.seam/<id>.txt` by convention (see validator.resolve_artifact_id).

    Strips "s4" out of the top-level `provisional` list (dropping the key
    entirely if that empties it) -- fix-round ruling (LOW-1, task-3-review.md):
    once s4's bounds are the measured calibrated numbers, `provisional`'s
    documented meaning ("placeholder bounds pending calibration," SPEC.md /
    schema.json) is stale for it, not just advisory. `provisional` stays an
    OPTIONAL top-level key in the *format* -- schema.json/spec_check.py
    accept a spec with or without it -- only this specific, now-calibrated
    spec instance drops it. (An earlier version of this function left the
    key in place specifically to avoid breaking test_schema.py's assertion
    that it was present; that assertion has since been amended to assert
    the opposite -- see test_schema.py::TestReferenceSpec.)
    """
    spec = json.loads(json.dumps(spec))  # cheap deep copy
    seam = find_seam(spec, "s4")
    if seam is None:
        raise RuntimeError("spec has no seam id 's4' to calibrate")
    # Retarget s4 first, THEN drop the "clusters" artifact id and any
    # remaining seam that still references it -- s4 itself used to be one of
    # those, but it's being repointed at "projected" below, not deleted.
    seam["artifact"] = "projected"
    if "artifactIds" in spec:
        spec["artifactIds"] = [aid for aid in spec["artifactIds"] if aid != "clusters"]
    spec["seams"] = [s for s in spec.get("seams", []) if s.get("artifact") != "clusters"]
    seam = find_seam(spec, "s4")
    seam["predicate"] = {
        "op": "cluster_count_in_range",
        "method": "conncomp2d",
        "cell": cell,
        "min": lo,
        "max": hi,
    }
    seam["onFail"] = (
        f"projected.txt component count is outside [{lo},{hi}] at cell={cell}mm "
        "-- glyph clustering on the plane-basis projection is not isolating one "
        "component per character (Task-3 calibrated against the oracle gcode "
        "artifact; see calibrate_gcode.py)."
    )
    if "provisional" in spec:
        remaining = [sid for sid in spec["provisional"] if sid != "s4"]
        if remaining:
            spec["provisional"] = remaining
        else:
            del spec["provisional"]
    return spec


# --------------------------------------------------------------------------
# Validator invocation
# --------------------------------------------------------------------------

def run_validator(spec_path, root, source=None):
    """Shell out to the real validator.py CLI (not an in-process import) --
    this is the black-box entry point the actual gate uses, and the whole
    point of this harness is proving the CLI contract holds, not just an
    internal function.

    `source` (Task 7 item 4), when given, is passed through as validator.py's
    --source -- needed for any source_crosscheck seam to actually be
    exercised rather than fail-open-FAIL on "no --source provided".
    """
    cmd = [sys.executable, VALIDATOR_PATH, "--spec", str(spec_path), "--root", str(root)]
    if source is not None:
        cmd += ["--source", str(source)]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=_SEAM_GATE_DIR,
    )
    lines = [l for l in proc.stdout.strip().splitlines() if l]
    fails = [l for l in lines if " FAIL " in l]
    return proc.returncode, lines, fails


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=(
            "Seam-gate calibration harness: generates ORACLE and BAD artifact "
            "sets from a real gcode file and proves the gcode-to-text-gate "
            "spec's predicates against both -- the oracle must pass every "
            "seam, the bad set must fail at least two. In default mode it "
            "also searches cluster-seam (s4) cell sizes and REWRITES the "
            "spec's s4 predicate with calibrated bounds."
        )
    )
    parser.add_argument(
        "gcode",
        help="path to a plain-text (or .gz) gcode file, e.g. the tb2 "
        "gcode-to-text task's text.gcode[.gz] fixture",
    )
    parser.add_argument(
        "--spec",
        default=DEFAULT_SPEC_PATH,
        help=(
            "path to the seam spec JSON to calibrate against / verify "
            "(default: this repo's specs/gcode-to-text-gate.json). Later "
            "tasks (e.g. Task 5) can pass a copy of the already-calibrated "
            "spec with --check-only to re-prove it against a fresh gcode "
            "fixture without touching it."
        ),
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help=(
            "skip the cell-size search and spec rewrite; just generate "
            "ORACLE/BAD artifacts and run the oracle-pass / bad-fail "
            "assertions against --spec exactly as given, printing per-seam "
            "results and exiting 0 on success, 1 on failure. Does not "
            "modify --spec on disk."
        ),
    )
    parser.add_argument(
        "--emit-evidence",
        action="store_true",
        help=(
            "print a sample-ready evidence block -- the measured statistic "
            "or response curve for every vocabulary op with a free numeric "
            "parameter, computed from <gcode> alone -- then exit. Ignores "
            "and never touches --spec (a card generator/sampler should be "
            "given this instead of guessing bounds; see SPEC.md's "
            "evidence-emission contract sentence)."
        ),
    )
    return parser.parse_args(argv)


# --------------------------------------------------------------------------
# --emit-evidence (Task 7 item 2): "for each op with a free numeric
# parameter, the evidence carries the measured statistic or its response
# curve over a frozen grid -- cards derive bounds, never guess them" (SPEC.md).
# --------------------------------------------------------------------------

def variance_ratio_component(points, component, np):
    """Measured SVD variance ratio for `component` -- the same statistic
    seam s6 (variance_ratio_below) checks. Informational only here (used for
    the evidence block) -- the actual pass/fail always comes from running
    the real validator against the artifact file, same caveat as
    affine_residual_ratio above.
    """
    arr = np.array(points, dtype=float)
    centered = arr - arr.mean(axis=0)
    try:
        _, s, _ = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError:
        return float("nan")
    if component >= len(s):
        return float("nan")
    total = float(np.sum(s ** 2))
    return 0.0 if total == 0 else float((s[component] ** 2) / total)


def column_spreads(points, np):
    """Measured per-column standard deviation -- the same statistic
    spread_above checks. Returns one std per column, in column order."""
    arr = np.array(points, dtype=float)
    if arr.size == 0:
        return []
    return [float(np.std(arr[:, j])) for j in range(arr.shape[1])]


def cluster_count_sweep(proj_points, np, cell_candidates=CELL_CANDIDATES):
    """Component count vs cell over `cell_candidates`, computed against
    `proj_points` via the real conncomp2d op (validator.op_cluster_count_in_range,
    through cluster_count_at_cell) -- same sweep search_cell runs, exposed
    here purely for evidence printing regardless of whether any candidate
    lands in the target range. Returns [(cell, count_or_None), ...].
    """
    with tempfile.TemporaryDirectory(prefix="seamgate-evidence-") as tmp:
        proj_path = Path(tmp, ".seam", "projected.txt")
        write_rows(proj_path, proj_points)
        return [(cell, cluster_count_at_cell(str(proj_path), cell, np)) for cell in cell_candidates]


def emit_evidence_block(gcode_path, oracle_points, bad_points, oracle_proj, oracle_ratio, np):
    """Build the sample-ready evidence text block: the measured statistic or
    response curve for every vocabulary op with a free numeric parameter,
    computed from the given gcode file. Pure function of already-computed
    data (no I/O beyond cluster_count_sweep's own temp-file use) so it's
    directly unit-testable.
    """
    lines = [f"SEAM-GATE EVIDENCE (gcode={gcode_path})"]

    # row_count_in_range's free params (min, max): the raw counts a card
    # should derive bounds from, scoped (oracle, S0-extruding) and whole-file
    # (bad, unscoped) -- explicitly required by the brief.
    lines.append(
        f"row_count: scoped(S0-extruding, oracle)={len(oracle_points)} "
        f"whole_file(G1, unscoped)={len(bad_points)}"
    )

    # affine_residual_below's free param (max_ratio).
    lines.append(f"affine_residual_ratio (points, cols=[0,1,2]): {oracle_ratio:.6f}")

    # variance_ratio_below's free param (max), component 2 (the op's use in
    # this spec's s6).
    var_ratio = variance_ratio_component(oracle_points, 2, np)
    lines.append(f"variance_ratio (points, component=2): {var_ratio:.6f}")

    # spread_above's free param (min_std): per-column spread on both
    # artifacts this pipeline produces.
    for j, std in enumerate(column_spreads(oracle_points, np)):
        lines.append(f"spread (points, col={j}): std={std:.6f}")
    for j, std in enumerate(column_spreads(oracle_proj, np)):
        lines.append(f"spread (projected, col={j}): std={std:.6f}")

    # cluster_count_in_range's free param (cell): response curve over the
    # frozen grid, not a single guessed number.
    lines.append(f"cluster_count_vs_cell (projected, conncomp2d, grid={cell_candidates_str()}):")
    for cell, count in cluster_count_sweep(oracle_proj, np):
        count_str = "grid-cap exceeded" if count is None else f"{count} components"
        lines.append(f"  cell={cell} -> {count_str}")

    return "\n".join(lines)


def cell_candidates_str():
    return "[" + ",".join(str(c) for c in CELL_CANDIDATES) + "]"


def main(argv):
    args = parse_args(argv)
    import numpy as np  # noqa: E402 -- lazy import, dev tool, not fail-open

    if args.emit_evidence:
        oracle_points, bad_points = collect_points(args.gcode)
        if not oracle_points:
            print("SEAM-GATE CALIBRATE: no oracle (M486 S0, E-param, X/Y-present) points found "
                  "in the gcode file -- check the M486 scoping / filter logic", file=sys.stderr)
            return 1
        if not bad_points:
            print("SEAM-GATE CALIBRATE: no G1 points found in the gcode file at all", file=sys.stderr)
            return 1
        oracle_proj = svd_plane_project(oracle_points, np)
        oracle_ratio = affine_residual_ratio(oracle_points, np)
        print(emit_evidence_block(args.gcode, oracle_points, bad_points, oracle_proj, oracle_ratio, np))
        return 0

    with open(args.spec) as f:
        spec = json.load(f)
    errors = check_spec(spec)
    if errors:
        print(f"SEAM-GATE CALIBRATE: --spec is not a valid seam spec: {'; '.join(errors)}", file=sys.stderr)
        return 1

    oracle_points, bad_points = collect_points(args.gcode)
    if not oracle_points:
        print("SEAM-GATE CALIBRATE: no oracle (M486 S0, E-param, X/Y-present) points found "
              "in the gcode file -- check the M486 scoping / filter logic", file=sys.stderr)
        return 1
    if not bad_points:
        print("SEAM-GATE CALIBRATE: no G1 points found in the gcode file at all", file=sys.stderr)
        return 1

    print(f"SEAM-GATE CALIBRATE: parsed {len(oracle_points)} oracle points, "
          f"{len(bad_points)} whole-file (bad) G1 points from {args.gcode}")

    oracle_proj = svd_plane_project(oracle_points, np)
    oracle_ratio = affine_residual_ratio(oracle_points, np)
    # BAD "raw-XY projection" reproduces the "forgot the plane-basis
    # projection" bug in isolation from the "forgot to scope the filter" bug:
    # it takes the CORRECTLY S0-scoped oracle points and just passes their
    # raw x,y through as if that were the projection (u=x, v=y, no SVD).
    # Measured on the real fixture: this drops the connected-component count
    # from ~30 (properly projected) to ~9 at the calibrated cell -- the
    # un-rotated raw x,y smears/merges glyphs that the plane-basis rotation
    # separates cleanly, reliably failing s4. (Building it instead from the
    # whole-file-unfiltered bad point set was tried and measured NOT to
    # reliably fail s4 -- the travel-inflated cloud's raw x,y coincidentally
    # lands inside plausible bounds on this fixture, which would silently
    # fail to reproduce the measured failure the brief calls for.)
    bad_proj = np.array([[p[0], p[1]] for p in oracle_points], dtype=float)
    bad_ratio = affine_residual_ratio(bad_points, np)

    with tempfile.TemporaryDirectory(prefix="seamgate-calib-oracle-") as oracle_root, \
            tempfile.TemporaryDirectory(prefix="seamgate-calib-bad-") as bad_root:

        if args.check_only:
            cell, lo, hi = extract_cluster_predicate(spec)
            final_spec = spec
            print(f"SEAM-GATE CALIBRATE: --check-only, using spec's existing s4 "
                  f"cell={cell} min={lo} max={hi}")
        else:
            # Write the oracle projection artifact first (search needs it on
            # disk -- op_cluster_count_in_range reads a file, not an array).
            oracle_proj_path = Path(oracle_root, ".seam", "projected.txt")
            write_rows(oracle_proj_path, oracle_proj)
            cell, count, results, is_fallback = search_cell(str(oracle_proj_path), np)
            print("SEAM-GATE CALIBRATE: cluster cell search "
                  f"(target range [{TARGET_MIN},{TARGET_MAX}], truth={TARGET_TRUTH} glyphs):")
            for c, cnt in results:
                cnt_str = "grid-cap exceeded" if cnt is None else f"{cnt} components"
                marker = " <- selected" if c == cell else ""
                print(f"  cell={c} -> {cnt_str}{marker}")
            if is_fallback:
                lo, hi = max(3, count - 5), count + 8
                print(f"SEAM-GATE CALIBRATE WARNING: no candidate cell landed in "
                      f"[{TARGET_MIN},{TARGET_MAX}]; falling back to the cell closest to "
                      f"{TARGET_TRUTH} (cell={cell}, count={count}); bounds=[{lo},{hi}]")
            else:
                lo, hi = count - 5, count + 8
            final_spec = rewrite_spec(spec, cell, lo, hi)
            rewrite_errors = check_spec(final_spec)
            if rewrite_errors:
                print("SEAM-GATE CALIBRATE: rewritten spec failed its own validation: "
                      f"{'; '.join(rewrite_errors)}", file=sys.stderr)
                return 1
            with open(args.spec, "w") as f:
                json.dump(final_spec, f, indent=2)
                f.write("\n")
            print(f"SEAM-GATE CALIBRATE: rewrote {args.spec} -- s4 cell={cell} "
                  f"min={lo} max={hi} (oracle count={count})")

        oracle_cluster_rows = compute_cluster_rows(oracle_proj, cell, np)
        bad_cluster_rows = compute_cluster_rows(bad_proj, cell, np)
        write_artifact_set(oracle_root, oracle_points, oracle_proj, oracle_ratio, oracle_cluster_rows)
        write_artifact_set(bad_root, bad_points, bad_proj, bad_ratio, bad_cluster_rows)

        spec_on_disk = args.spec  # for check_only this is unmodified; else just rewritten
        code_oracle, lines_oracle, fails_oracle = run_validator(spec_on_disk, oracle_root, source=args.gcode)
        code_bad, lines_bad, fails_bad = run_validator(spec_on_disk, bad_root, source=args.gcode)

        print("SEAM-GATE CALIBRATE: oracle validator run:")
        for l in lines_oracle:
            print(f"  {l}")
        print("SEAM-GATE CALIBRATE: bad validator run:")
        for l in lines_bad:
            print(f"  {l}")

        ok = True
        if code_oracle != 0 or fails_oracle:
            print(f"SEAM-GATE CALIBRATE: FAILED -- oracle artifacts must pass ALL seams; "
                  f"failed: {fails_oracle}", file=sys.stderr)
            ok = False
        if len(fails_bad) < 2:
            print(f"SEAM-GATE CALIBRATE: FAILED -- bad artifacts must fail >= 2 seams; "
                  f"only failed: {fails_bad}", file=sys.stderr)
            ok = False
        if ok:
            print("SEAM-GATE CALIBRATE: OK -- oracle all-pass, bad "
                  f"{len(fails_bad)}-seam fail")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
