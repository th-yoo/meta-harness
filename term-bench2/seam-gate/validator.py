#!/usr/bin/env python3
"""Seam-gate validator kernel (Task 2).

Loads a seam spec (validated via Task-1's `spec_check.check_spec`), evaluates
every seam's predicate directly against the artifact on disk, and reports
PASS/FAIL per seam.

CLI:
    python3 validator.py --spec <spec.json> --root <dir>

`--root` is the directory artifact paths resolve under: `/app` in-container,
a temp dir in tests (see `resolve_artifact_path` below for the exact rule).

Output: one line per seam, `SEAM <id> PASS|FAIL <detail>`, to stdout.
Exit code: 0 if every seam passed, 1 if any seam failed.

Fail-open contract: this is a gate, and gates must never wedge an agent's
session on the gate's own bugs. Two distinct failure classes exist:

  - Predicate FAIL (expected, data-dependent): an artifact is missing, empty,
    unparseable, ragged, or numerically doesn't satisfy its predicate. These
    are normal outcomes -- reported as `SEAM <id> FAIL <detail>`, and the
    overall exit code is 1 (block). Every op function below is written to
    catch this class itself and return `(False, detail)` rather than raise.
  - Internal error (unexpected: validator bugs, a malformed spec, numpy
    missing, a spec file that's absent/corrupt JSON): anything that reaches
    the top-level `except Exception` in `main()`. Printed as
    `SEAM-GATE INTERNAL ERROR <msg>` and the process **exits 0** (allow) --
    a broken gate must never be indistinguishable from a broken agent.

Artifact format: whitespace- or comma-separated numeric text files. Parsed
tolerantly -- non-numeric lines are skipped outright, not partially parsed;
rows exceeding a per-artifact cap (500,000) beyond the cap are simply not
read. See `parse_artifact`.

`cluster_count_in_range`'s `conncomp2d` method is implemented with numpy
only (no scipy): points are rasterized onto a boolean grid at the given cell
size, and connected components are found via an explicit stack-based
(iterative, not recursive) flood fill with 8-connectivity. See
`op_cluster_count_in_range`.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

from spec_check import check_spec

MAX_ROWS = 500_000

# 8-connected neighbor offsets for conncomp2d's flood fill.
_NEIGHBORS_8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

# Minimum pixel count for a rasterized component to count as a real cluster
# (per SPEC.md's `cluster_count_in_range`: "minimum pixel floor of 3").
_MIN_COMPONENT_PIXELS = 3

_TOKEN_SPLIT_RE = re.compile(r"[,\s]+")


# --------------------------------------------------------------------------
# Path resolution
# --------------------------------------------------------------------------

def resolve_artifact_path(artifact_path, root):
    """Resolve a spec artifact path (e.g. "/app/.seam/points.txt") under --root.

    Spec artifact paths are always absolute in-container paths rooted at a
    single top-level directory segment (e.g. "/app/..." -- see SPEC.md).
    The validator drops that one leading segment and re-joins the remainder
    under --root. This makes the *same* spec resolve correctly in both
    contexts the brief names: in-container with `--root /app`, "/app/.seam/x"
    round-trips to itself (identity); in tests with `--root <tmpdir>`, it
    resolves to "<tmpdir>/.seam/x" so tests never need to fake a real /app.

    Non-absolute or degenerate paths (no segment to drop) fall back to
    joining the path as-is under root, so this never raises on odd input --
    any resulting bogus path just surfaces as a normal "file not found"
    predicate FAIL downstream.
    """
    p = PurePosixPath(artifact_path)
    if p.is_absolute():
        segments = p.parts[1:]  # drop the leading '/'
        if len(segments) > 1:
            segments = segments[1:]  # drop the container-root segment (e.g. 'app')
    else:
        segments = p.parts
    return str(Path(root, *segments)) if segments else str(Path(root))


# --------------------------------------------------------------------------
# Tolerant artifact parsing
# --------------------------------------------------------------------------

def parse_artifact(path, max_rows=MAX_ROWS):
    """Parse a whitespace-/comma-separated numeric text file into rows of floats.

    Tolerant: a line that doesn't parse cleanly to all-numeric tokens is
    skipped outright (not partially parsed). Stops reading once `max_rows`
    numeric rows have been collected. Raises OSError (e.g. FileNotFoundError,
    PermissionError) if the file itself can't be opened/read -- callers
    (`_safe_parse`) catch that and turn it into a predicate FAIL, per the
    "unreadable artifact = predicate FAIL, not internal error" rule.
    """
    rows = []
    with open(path, "r") as f:
        for line in f:
            if len(rows) >= max_rows:
                break
            line = line.strip()
            if not line:
                continue
            tokens = [t for t in _TOKEN_SPLIT_RE.split(line) if t]
            if not tokens:
                continue
            try:
                vals = [float(t) for t in tokens]
            except ValueError:
                continue  # non-numeric line: skip it entirely
            rows.append(vals)
    return rows


def _safe_parse(path):
    """Parse `path`, returning (rows, None) on success or (None, detail) on
    any data-level problem (missing file, unreadable file). Never raises --
    this is the shared "unreadable artifact -> predicate FAIL" boundary that
    every op besides artifact_exists funnels through.
    """
    if not os.path.isfile(path):
        return None, f"artifact file not found: {path}"
    try:
        rows = parse_artifact(path)
    except OSError as e:
        return None, f"artifact unreadable: {e}"
    return rows, None


# --------------------------------------------------------------------------
# The 8 predicate ops. Each returns (passed: bool, detail: str) and never
# raises for data-level problems (missing/empty/ragged/short artifacts) --
# those are folded into a FAIL result with an explanatory detail. Only truly
# unexpected exceptions (programming bugs, numpy internals blowing up in a
# way we didn't anticipate) are allowed to propagate to main()'s fail-open
# handler.
# --------------------------------------------------------------------------

def op_artifact_exists(path):
    if not os.path.isfile(path):
        return False, f"artifact file not found: {path}"
    size = os.path.getsize(path)
    if size == 0:
        return False, f"artifact file is empty: {path}"
    return True, f"artifact present, {size} bytes"


def op_row_count_in_range(path, lo, hi):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    n = len(rows)
    passed = lo <= n <= hi
    return passed, f"{n} numeric rows (expected [{lo},{hi}])"


def op_numeric_cols(path, n):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    if not rows:
        return False, "no numeric rows found in artifact"
    bad = [(i, len(r)) for i, r in enumerate(rows) if len(r) != n]
    if bad:
        i, actual = bad[0]
        return False, (
            f"row {i} has {actual} numeric columns (expected {n}); "
            f"{len(bad)}/{len(rows)} rows mismatched"
        )
    return True, f"all {len(rows)} rows have {n} numeric columns"


def op_affine_residual_below(path, cols, max_ratio, np):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    i, j, k = cols
    needed = max(cols) + 1
    usable = [r for r in rows if len(r) >= needed]
    if len(usable) < needed + 1:
        return False, (
            f"not enough usable rows with >= {needed} columns to fit an "
            f"affine model (have {len(usable)})"
        )
    arr = np.array(usable, dtype=float)
    x, y, z = arr[:, i], arr[:, j], arr[:, k]
    A = np.column_stack([x, y, np.ones_like(x)])
    coef, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
    resid = z - A @ coef
    resid_var = float(np.var(resid))
    z_var = float(np.var(z))
    if z_var == 0:
        ratio = 0.0 if resid_var == 0 else float("inf")
    else:
        ratio = resid_var / z_var
    passed = ratio < max_ratio
    return passed, f"residual/variance ratio = {ratio:.6f} (threshold < {max_ratio})"


def op_variance_ratio_below(path, component, max_v, np):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    if not rows:
        return False, "no numeric rows found in artifact"
    ncols = len(rows[0])
    usable = [r for r in rows if len(r) == ncols]
    if len(usable) < 2:
        return False, "not enough consistent-shape rows to compute SVD"
    arr = np.array(usable, dtype=float)
    if component >= arr.shape[1]:
        return False, (
            f"component {component} out of range for artifact with "
            f"{arr.shape[1]} columns"
        )
    centered = arr - arr.mean(axis=0)
    try:
        _, s, _ = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError as e:
        return False, f"SVD failed to converge: {e}"
    if component >= len(s):
        return False, (
            f"component {component} out of range: SVD produced only "
            f"{len(s)} singular values ({len(usable)} rows x {arr.shape[1]} cols)"
        )
    total = float(np.sum(s ** 2))
    ratio = 0.0 if total == 0 else float((s[component] ** 2) / total)
    passed = ratio < max_v
    return passed, f"component {component} variance ratio = {ratio:.6f} (threshold < {max_v})"


def op_spread_above(path, col, min_std, np):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    usable = [r for r in rows if len(r) > col]
    if not usable:
        return False, f"no rows have a column {col}"
    arr = np.array([r[col] for r in usable], dtype=float)
    std = float(np.std(arr))
    passed = std > min_std
    return passed, f"column {col} std = {std:.6f} (threshold > {min_std})"


def op_cluster_count_in_range(path, cell, cmin, cmax, np):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    usable = [r for r in rows if len(r) >= 2]
    if not usable:
        return False, "no rows with >= 2 numeric columns (need x,y) found in artifact"
    arr = np.array(usable, dtype=float)
    x, y = arr[:, 0], arr[:, 1]
    xmin, ymin = float(x.min()), float(y.min())
    gx = np.floor((x - xmin) / cell).astype(int)
    gy = np.floor((y - ymin) / cell).astype(int)
    w, h = int(gx.max()) + 1, int(gy.max()) + 1
    grid = np.zeros((h, w), dtype=bool)
    grid[gy, gx] = True

    visited = np.zeros_like(grid, dtype=bool)
    count = 0
    for i0 in range(h):
        for j0 in range(w):
            if not grid[i0, j0] or visited[i0, j0]:
                continue
            # Stack-based (iterative) flood fill -- no recursion, no scipy.
            stack = [(i0, j0)]
            visited[i0, j0] = True
            size = 0
            while stack:
                ci, cj = stack.pop()
                size += 1
                for di, dj in _NEIGHBORS_8:
                    ni, nj = ci + di, cj + dj
                    if 0 <= ni < h and 0 <= nj < w and grid[ni, nj] and not visited[ni, nj]:
                        visited[ni, nj] = True
                        stack.append((ni, nj))
            if size >= _MIN_COMPONENT_PIXELS:
                count += 1

    passed = cmin <= count <= cmax
    return passed, f"{count} components at cell={cell} (expected [{cmin},{cmax}])"


def op_value_in_range(path, row, col, lo, hi):
    rows, err = _safe_parse(path)
    if err:
        return False, err
    if row >= len(rows):
        return False, f"row {row} out of range (artifact has {len(rows)} numeric rows)"
    if col >= len(rows[row]):
        return False, f"col {col} out of range (row {row} has {len(rows[row])} columns)"
    val = rows[row][col]
    passed = lo <= val <= hi
    return passed, f"value at [{row},{col}] = {val} (expected [{lo},{hi}])"


# --------------------------------------------------------------------------
# Seam evaluation + CLI
# --------------------------------------------------------------------------

def evaluate_seam(seam, artifacts, root, np):
    predicate = seam["predicate"]
    op = predicate["op"]
    resolved = resolve_artifact_path(artifacts[seam["artifact"]], root)

    if op == "artifact_exists":
        return op_artifact_exists(resolved)
    elif op == "row_count_in_range":
        return op_row_count_in_range(resolved, predicate["min"], predicate["max"])
    elif op == "numeric_cols":
        return op_numeric_cols(resolved, predicate["n"])
    elif op == "affine_residual_below":
        return op_affine_residual_below(resolved, predicate["cols"], predicate["max_ratio"], np)
    elif op == "variance_ratio_below":
        return op_variance_ratio_below(resolved, predicate["component"], predicate["max"], np)
    elif op == "spread_above":
        return op_spread_above(resolved, predicate["col"], predicate["min_std"], np)
    elif op == "cluster_count_in_range":
        return op_cluster_count_in_range(resolved, predicate["cell"], predicate["min"], predicate["max"], np)
    elif op == "value_in_range":
        return op_value_in_range(resolved, predicate["row"], predicate["col"], predicate["min"], predicate["max"])
    else:
        # Unreachable in practice: check_spec (run before this) rejects any
        # op outside the frozen vocabulary. If we get here, it's a bug --
        # let it raise so it surfaces as SEAM-GATE INTERNAL ERROR.
        raise RuntimeError(f"unknown op '{op}' reached the evaluator after spec validation")


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Seam-gate validator kernel")
    parser.add_argument("--spec", required=True, help="path to the seam spec JSON")
    parser.add_argument("--root", required=True, help="directory artifact paths resolve under")
    parser.add_argument(
        "--_force-no-numpy",
        dest="force_no_numpy",
        action="store_true",
        help=(
            "test hook only: simulate `numpy` being unavailable, to exercise the "
            "fail-open path without an actual broken environment"
        ),
    )
    return parser.parse_args(argv)


def run(args):
    """Does the real work; any exception raised here (including numpy's
    ImportError) is caught by main() and turned into the fail-open path."""
    if args.force_no_numpy:
        raise ImportError("numpy import forced-disabled via --_force-no-numpy (test hook)")
    import numpy as np

    with open(args.spec) as f:
        spec = json.load(f)

    errors = check_spec(spec)
    if errors:
        raise RuntimeError("malformed spec: " + "; ".join(errors))

    any_fail = False
    for seam in spec["seams"]:
        passed, detail = evaluate_seam(seam, spec["artifacts"], args.root, np)
        print(f"SEAM {seam['id']} {'PASS' if passed else 'FAIL'} {detail}")
        if not passed:
            any_fail = True
    return 1 if any_fail else 0


def main(argv):
    args = parse_args(argv)
    try:
        return run(args)
    except Exception as e:
        print(f"SEAM-GATE INTERNAL ERROR {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
