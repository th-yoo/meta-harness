#!/usr/bin/env python3
"""Seam-gate validator kernel (Task 2).

Loads a seam spec (validated via Task-1's `spec_check.check_spec`), evaluates
every seam's predicate directly against the artifact on disk, and reports
PASS/FAIL per seam.

CLI:
    python3 validator.py --spec <spec.json> --root <dir> [--source <path>]

`--root` is the directory artifact ids resolve under: `/app` in-container, a
temp dir in tests (see `resolve_artifact_id` below for the exact rule).
`--source` is the task's own input file (e.g. `/app/text.gcode`), needed only
by seams using the `source_crosscheck` op (Task 7 item 4) -- omit it and any
such seam fails its predicate with a clear detail, never an internal error.

Artifact identity (Task 7 structural fix): specs carry a flat `artifactIds`
list -- bare ids, never paths. Every id resolves by convention to
`<root>/.seam/<id>.txt`; there is no path field anywhere in the spec for a
generated card to invent a filename into (the measured failure mode a prior
probe round found -- see docs/loop-probes/census-e2e-20260819/gcode-card/
verdict.md, "Card regen v4" section).

Output: one line per seam, `SEAM <id> PASS|FAIL <detail>`, to stdout.
Exit code: 0 if every seam passed, 1 if any seam failed.

Fail-open contract: this is a gate, and gates must never wedge an agent's
session on the gate's own bugs. Two distinct failure classes exist:

  - Predicate FAIL (expected, data-dependent): an artifact is missing, empty,
    unreadable (binary/non-UTF-8 content, non-finite nan/inf tokens, ragged
    columns, out-of-range indices), or numerically doesn't satisfy its
    predicate. These are normal outcomes -- reported as `SEAM <id> FAIL
    <detail>`, and the overall exit code is 1 (block). Every op function
    below is written to catch this class itself and return `(False, detail)`
    rather than raise. This is also a deliberate security boundary: an
    artifact that's garbage in some *new* way we didn't anticipate must still
    fail the seam, not silently allow the gate -- see `_safe_parse` and the
    grid-size cap in `op_cluster_count_in_range` below, both added after a
    review found garbage-input shapes that used to escape as internal
    errors.
  - Internal error (unexpected: validator bugs, a malformed spec, numpy
    missing, a spec file that's absent/corrupt JSON, malformed CLI
    arguments): anything that reaches `main()`'s top-level handlers. Printed
    as `SEAM-GATE INTERNAL ERROR <msg>` and the process **exits 0** (allow)
    -- a broken gate must never be indistinguishable from a broken agent.

Artifact format: whitespace- or comma-separated numeric text files. Parsed
tolerantly -- non-numeric lines (including non-finite nan/inf tokens, which
Python's `float()` otherwise parses successfully) are skipped outright, not
partially parsed; rows exceeding a per-artifact cap (500,000) beyond the cap
are simply not read. Non-UTF-8/binary artifact content is treated the same
way as a missing file (predicate FAIL), not surfaced as an internal error.
See `parse_artifact` / `_safe_parse`.

`cluster_count_in_range`'s `conncomp2d` method is implemented with numpy
only (no scipy): points are rasterized onto a boolean grid at the given cell
size (capped at `_MAX_GRID_DIM` per side so pathological coordinate
magnitudes can't force an unbounded allocation), and connected components
are found via an explicit stack-based (iterative, not recursive) flood fill
with 8-connectivity. See `op_cluster_count_in_range`.

Threat model: this gate defends against lazy non-compliance (an agent that
under-filters data or skips a step), not an adversarial agent -- one that
edits `spec.json` or the hook script itself is outside scope, the same trust
model as the repo's own completion gate. The `--_force-no-numpy`-style test
hook was deliberately *not* shipped as a documented CLI flag for this
reason (see `_TEST_NO_NUMPY_ENV` below): a `--help`-visible, always-available
gate-bypass switch is a bigger risk than the convenience it buys in tests.
"""

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

from readers import ReaderError, read_source
from spec_check import check_spec

# Test-only escape hatch for simulating "numpy unavailable" without a real
# broken environment. Deliberately an environment variable, not a CLI flag
# (see MEDIUM-4 in the task-2 review): a `--help`-visible flag that forces a
# full gate bypass on request is a bigger risk than the convenience it buys
# in tests. Never documented in `--help`.
_TEST_NO_NUMPY_ENV = "SEAM_GATE_TEST_NO_NUMPY"

MAX_ROWS = 500_000

# 8-connected neighbor offsets for conncomp2d's flood fill.
_NEIGHBORS_8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

# Minimum pixel count for a rasterized component to count as a real cluster
# (per SPEC.md's `cluster_count_in_range`: "minimum pixel floor of 3").
_MIN_COMPONENT_PIXELS = 3

# Per-dimension cap on the conncomp2d rasterization grid. Keeps the boolean
# grid's memory bounded regardless of agent-controlled coordinate magnitude
# vs. cell size (task-2 review LOW-5).
_MAX_GRID_DIM = 4096

_TOKEN_SPLIT_RE = re.compile(r"[,\s]+")


# --------------------------------------------------------------------------
# Artifact id resolution
# --------------------------------------------------------------------------

def resolve_artifact_id(artifact_id, root):
    """Resolve a bare artifact id (e.g. "points") to its on-disk path under
    --root, by convention: "<root>/.seam/<id>.txt".

    This is the whole of Task 7's structural fix: the prior "artifacts"
    id->path map is gone, so there is no field anywhere in a spec for an
    author (human or generated) to invent a filename into. The same
    convention resolves correctly in both contexts the brief names:
    in-container with `--root /app`, id "points" resolves to
    "/app/.seam/points.txt"; in tests with `--root <tmpdir>`, it resolves to
    "<tmpdir>/.seam/points.txt" so tests never need to fake a real /app.
    """
    return str(Path(root, ".seam", f"{artifact_id}.txt"))


# --------------------------------------------------------------------------
# Tolerant artifact parsing
# --------------------------------------------------------------------------

def parse_artifact(path, max_rows=MAX_ROWS):
    """Parse a whitespace-/comma-separated numeric text file into rows of floats.

    Tolerant: a line that doesn't parse cleanly to all-numeric, all-finite
    tokens is skipped outright (not partially parsed) -- this includes lines
    with non-numeric tokens AND lines containing nan/inf tokens (Python's
    `float()` parses "nan"/"inf" successfully, so those need an explicit
    `math.isfinite` check; without it they'd reach op arithmetic like
    `np.linalg.lstsq` or grid-index casts and blow up as an internal error
    instead of a predicate FAIL -- see task-2 review HIGH-2). Stops reading
    once `max_rows` numeric rows have been collected.

    Raises OSError (e.g. FileNotFoundError, PermissionError) if the file
    itself can't be opened/read, and UnicodeDecodeError if its content isn't
    valid UTF-8 text -- callers (`_safe_parse`) catch both and turn them into
    a predicate FAIL, per the "unreadable artifact = predicate FAIL, not
    internal error" rule (task-2 review HIGH-1).
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
            if not all(math.isfinite(v) for v in vals):
                continue  # nan/inf token(s): treat like a non-numeric line, skip it
            rows.append(vals)
    return rows


def _safe_parse(path):
    """Parse `path`, returning (rows, None) on success or (None, detail) on
    any data-level problem (missing file, unreadable file, non-UTF-8/binary
    content). Never raises -- this is the shared "unreadable artifact ->
    predicate FAIL" boundary that every op besides artifact_exists funnels
    through.
    """
    if not os.path.isfile(path):
        return None, f"artifact file not found: {path}"
    try:
        rows = parse_artifact(path)
    except OSError as e:
        return None, f"artifact unreadable: {e}"
    except UnicodeDecodeError as e:
        return None, f"artifact is not valid UTF-8 text (binary/corrupt content): {e}"
    return rows, None


# --------------------------------------------------------------------------
# The 9 predicate ops (Task 7 item 4 adds source_crosscheck). Each returns
# (passed: bool, detail: str) and never
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
    try:
        coef, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
    except np.linalg.LinAlgError as e:
        # Defense-in-depth: parse_artifact already strips nan/inf rows, so
        # this shouldn't normally trigger, but any other degenerate/singular
        # input (e.g. all-duplicate rows) must still fail the seam, not crash
        # the gate -- matches the guard op_variance_ratio_below already has
        # around its svd() call.
        return False, f"least-squares fit failed to converge: {e}"
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
    if w > _MAX_GRID_DIM or h > _MAX_GRID_DIM:
        # Agent-controllable memory bound: an artifact's coordinate range vs.
        # `cell` size directly sizes this boolean grid. Without a cap,
        # pathological coordinates (a pipeline bug, or an adversarial write)
        # force an oversized allocation that either raises MemoryError (which
        # would otherwise escape as an internal error / fail-open exit 0 --
        # an induced bypass of the gate) or OOM-kills the process outright.
        # Capping and reporting a FAIL here keeps this a normal, expected
        # predicate outcome instead (task-2 review LOW-5).
        return False, (
            f"artifact coordinate range exceeds grid bounds at this cell size "
            f"({w}x{h} cells > {_MAX_GRID_DIM}x{_MAX_GRID_DIM} cap; cell={cell})"
        )
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


def op_source_crosscheck(path, reader_id, sample_n, source):
    """Cross-checks `sample_n` deterministically-sampled artifact rows
    against the task's own SOURCE file, via the frozen reader registry
    (readers.py). This is the only op that reasons about anything outside
    the artifact itself -- every other op is artifact-internal, which was
    the exact gap Task 7 item 4 closes (an agent could satisfy every other
    seam with internally-consistent but source-unfaithful data).

    Sampling rule (frozen, deterministic -- no randomness): step =
    len(rows) // sample_n; sampled indices are 0, step, 2*step, ... for as
    many multiples as land inside the artifact. If step < 1 (fewer artifact
    rows than sample_n), that's a predicate FAIL with a clear detail, not a
    crash or a silently-degenerate sample.

    Comparison: each sampled artifact row is compared, coordinate-by-
    coordinate, against the reader's row at the SAME index in its
    source-derived list, within 1e-3 absolute tolerance per coordinate. A
    short source-derived list (index out of range) counts as a mismatch, not
    a skip -- the whole point is that source and artifact must agree at
    matching positions.

    Fail-open contract (mirrors every other op + the module docstring's
    threat model): a missing `source`, an unknown `reader_id`, a leak-rule
    violation, or an unreadable source file are all ReaderError /
    OSError/UnicodeDecodeError -- all folded into a predicate FAIL here,
    never allowed to reach main()'s internal-error path.
    """
    rows, err = _safe_parse(path)
    if err:
        return False, err
    if not rows:
        return False, "no numeric rows found in artifact"
    if not source:
        return False, "no --source provided -- source_crosscheck requires the task's input file path"

    step = len(rows) // sample_n
    if step < 1:
        return False, (
            f"not enough artifact rows ({len(rows)}) to sample sample={sample_n} "
            "(need at least `sample` rows -- floor(len/sample) would be 0)"
        )
    indices = [i * step for i in range(sample_n) if i * step < len(rows)]

    try:
        source_rows = read_source(reader_id, source)
    except ReaderError as e:
        return False, f"source_crosscheck reader error: {e}"
    except (OSError, UnicodeDecodeError) as e:
        return False, f"source_crosscheck could not read source: {e}"

    mismatches = []
    for idx in indices:
        artifact_row = rows[idx]
        if idx >= len(source_rows):
            mismatches.append((idx, "source-derived list shorter than this index"))
            continue
        source_row = source_rows[idx]
        ncmp = min(len(artifact_row), len(source_row))
        bad = [
            j for j in range(ncmp)
            if abs(artifact_row[j] - source_row[j]) > 1e-3
        ]
        if bad or len(artifact_row) < len(source_row):
            mismatches.append((idx, f"coord(s) {bad} exceed 1e-3 tolerance" if bad else "row too short"))

    n_sampled = len(indices)
    n_mismatched = len(mismatches)
    rate = (n_mismatched / n_sampled) if n_sampled else 1.0
    passed = n_mismatched == 0
    detail = (
        f"reader={reader_id} sampled {n_sampled}/{len(rows)} artifact rows "
        f"(step={step}) against source -- {n_mismatched} mismatched "
        f"({rate:.1%})"
    )
    if mismatches:
        first_idx, first_reason = mismatches[0]
        detail += f"; first mismatch at row {first_idx}: {first_reason}"
    return passed, detail


# --------------------------------------------------------------------------
# Seam evaluation + CLI
# --------------------------------------------------------------------------

def evaluate_seam(seam, root, np, source=None):
    predicate = seam["predicate"]
    op = predicate["op"]
    resolved = resolve_artifact_id(seam["artifact"], root)

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
    elif op == "source_crosscheck":
        return op_source_crosscheck(resolved, predicate["reader"], predicate["sample"], source)
    else:
        # Unreachable in practice: check_spec (run before this) rejects any
        # op outside the frozen vocabulary. If we get here, it's a bug --
        # let it raise so it surfaces as SEAM-GATE INTERNAL ERROR.
        raise RuntimeError(f"unknown op '{op}' reached the evaluator after spec validation")


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Seam-gate validator kernel")
    parser.add_argument("--spec", required=True, help="path to the seam spec JSON")
    parser.add_argument("--root", required=True, help="directory artifact ids resolve under")
    parser.add_argument(
        "--source",
        default=None,
        help=(
            "path to the task's own input file (e.g. /app/text.gcode); only "
            "needed by seams using the source_crosscheck op -- omitted or "
            "wrong, any such seam fails its predicate with a clear detail, "
            "not an internal error"
        ),
    )
    # No test-hook CLI flag here (deliberately -- see _TEST_NO_NUMPY_ENV above
    # and MEDIUM-4 in the task-2 review): the numpy-unavailable escape hatch
    # is an undocumented env var, not a --help-visible argparse option.
    return parser.parse_args(argv)


def run(args):
    """Does the real work; any exception raised here (including numpy's
    ImportError) is caught by main() and turned into the fail-open path."""
    if os.environ.get(_TEST_NO_NUMPY_ENV) == "1":
        raise ImportError(
            f"numpy import disabled via {_TEST_NO_NUMPY_ENV}=1 (test-only escape hatch)"
        )
    import numpy as np

    with open(args.spec) as f:
        spec = json.load(f)

    errors = check_spec(spec)
    if errors:
        raise RuntimeError("malformed spec: " + "; ".join(errors))

    any_fail = False
    for seam in spec["seams"]:
        passed, detail = evaluate_seam(seam, args.root, np, source=args.source)
        print(f"SEAM {seam['id']} {'PASS' if passed else 'FAIL'} {detail}")
        if not passed:
            any_fail = True
    return 1 if any_fail else 0


def main(argv):
    """Top-level entry point. Both CLI-argument parsing and the actual run
    are covered by the fail-open contract -- a malformed/missing --spec or
    --root, an unknown flag, or any other reason argparse would normally
    sys.exit(2) must still land on exit 0 with an INTERNAL ERROR line
    (task-2 review MEDIUM-3), not escape the documented 0/1 contract.
    """
    try:
        args = parse_args(argv)
        return run(args)
    except SystemExit as e:
        # argparse (or anything else in this scope) called sys.exit()
        # directly. A clean `-h`/`--help` exit (code 0/None) is left alone --
        # argparse already printed its own help text, and exit 0 already
        # matches the fail-open target, so there's nothing to reclassify.
        # Anything else (missing required arg, unknown flag, etc. -> code 2)
        # gets folded into the same INTERNAL ERROR message as any other
        # internal failure.
        if e.code not in (0, None):
            print(f"SEAM-GATE INTERNAL ERROR argument parsing failed (exit code {e.code})")
        return 0
    except Exception as e:
        print(f"SEAM-GATE INTERNAL ERROR {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
