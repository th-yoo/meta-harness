#!/usr/bin/env python3
# GENERATED COPY — source of truth: term-bench2/seam-gate/ — edit there and re-run sync-task-copies.sh
"""Frozen source-reader registry for the `source_crosscheck` predicate op
(Task 7 item 4 -- the elf desk-check finding that the seam-gate's vocabulary
was entirely artifact-internal, so fidelity-to-source was inexpressible).

Each reader takes the TASK'S SOURCE FILE path and returns an ordered list of
numeric tuples independently re-derived from that source -- validator.py's
`op_source_crosscheck` samples an artifact's own rows at deterministic
indices and compares them against this list at the same indices, within
tolerance. This is a cross-check, not a re-implementation of the whole
pipeline: readers only need to reproduce the *source-truth* values an
honestly-computed artifact row should match, not any downstream geometry
(plane fit, projection, clustering).

Deliberately self-contained (stdlib only, no numpy) and does NOT import
calibrate_gcode.py or validator.py -- calibrate_gcode.py already imports
validator.py to reuse its conncomp2d op, so a readers->calibrate_gcode (or
readers->validator->calibrate_gcode) edge would risk a circular import. Any
duplication with calibrate_gcode.collect_points's oracle-branch parsing is
intentional and small; this module's own tests (test_readers.py) pin its
behavior independently.

Leak rule (hard boundary, enforced by `_check_leak_free`, not just
documented): readers may only read the task's INPUT file. A source path
containing "/tests/" or "/solution/" is refused outright -- a reader must
never become a side channel for reading test fixtures or the reference
solution. Enforced on every registry entry point, not just this one reader,
so it's not an ops-vocabulary opt-in a future reader could accidentally skip.

Registry: currently ONE entry, "gcode_g1_points" (this task). Designed for
one-file-per-reader growth -- REGISTRY is a flat dict, `read_source(reader_id,
source_path)` is the single call surface every future reader is added behind.

Fail-open discipline (mirrors validator.py's ops): every expected failure
mode here (missing file, unreadable file, non-UTF-8 content, a leak-rule
violation) raises `ReaderError`, a normal Python exception subclass that
validator.py's op_source_crosscheck catches and turns into a predicate FAIL
with a clear detail -- never an internal error. Only a genuinely unexpected
bug is allowed to propagate past that boundary.
"""

import gzip
import re

_LEAK_SUBSTRINGS = ("/tests/", "/solution/")

_M486_S_RE = re.compile(r"^M486\s+S(-?\d+)")


class ReaderError(Exception):
    """An expected, data-level reader failure (leak-rule violation, missing/
    unreadable source, non-UTF-8 content). Callers (validator.py) catch this
    and fold it into a predicate FAIL -- it is never allowed to surface as a
    SEAM-GATE INTERNAL ERROR."""


def _check_leak_free(source_path):
    """Refuse any source path that looks like it points at tests/ or
    solution/ content -- readers read the task INPUT only. Raises
    ReaderError; never returns a bool (so a caller can't accidentally ignore
    the result -- see validator.op_source_crosscheck)."""
    path_str = str(source_path)
    for pattern in _LEAK_SUBSTRINGS:
        if pattern in path_str:
            raise ReaderError(
                f"reader refuses source path containing '{pattern}' "
                f"(readers may only read the task's input file): {path_str}"
            )


def _open_source_text(source_path):
    """Open a plain-text or gzip-compressed source file for tolerant text
    reading. Raises ReaderError (not OSError/UnicodeDecodeError directly) on
    any failure to open -- callers don't need a second except clause."""
    try:
        if str(source_path).endswith(".gz"):
            return gzip.open(source_path, "rt", encoding="utf-8", errors="replace")
        return open(source_path, "r", encoding="utf-8", errors="replace")
    except OSError as e:
        raise ReaderError(f"source file unreadable: {e}") from e


def _parse_gcode_line_params(line):
    """Split a gcode motion line into (command, {letter: float}). Decimal
    commas are converted to periods (some gcode exports use locale-formatted
    decimals) -- matches calibrate_gcode.py's parse_line_params rule."""
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


def read_gcode_g1_points(source_path):
    """Reader "gcode_g1_points": re-parses the source gcode file's M486-S0
    ("Embossed text" object, per this fixture's tag) extruding G1 lines --
    i.e. G1 moves inside an M486 S0 ... S-1 scope that carry an E param AND
    an X or Y param (actual planar deposition motion, not a retraction-only
    E move) -- and returns their (x, y, z) positions in file order.

    This is the same S0-scoping rule as calibrate_gcode.collect_points's
    oracle branch (independently implemented here -- see module docstring
    for why no import edge exists between the two), and is the source-truth
    a correctly-filtered points.txt artifact's rows should match 1:1, in
    order, at any sampled index.
    """
    _check_leak_free(source_path)
    points = []
    cur_s = None
    x = y = z = 0.0
    try:
        with _open_source_text(source_path) as f:
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
                    cmd, params = _parse_gcode_line_params(line)
                    if "X" in params:
                        x = params["X"]
                    if "Y" in params:
                        y = params["Y"]
                    if "Z" in params:
                        z = params["Z"]
                    if cmd == "G1" and cur_s == 0 and "E" in params and ("X" in params or "Y" in params):
                        points.append((x, y, z))
    except UnicodeDecodeError as e:
        raise ReaderError(f"source file is not valid UTF-8 text (binary/corrupt content): {e}") from e
    return points


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

REGISTRY = {
    "gcode_g1_points": read_gcode_g1_points,
}


def read_source(reader_id, source_path):
    """Single call surface for every reader: look up `reader_id` in REGISTRY
    and run it against `source_path`. Raises ReaderError for an unknown
    reader id (not KeyError) -- keeps the "unknown reader = clear FAIL
    detail, not an internal error" contract in one place, since every
    reader's own leak-check + open-failure paths already raise ReaderError
    too.
    """
    reader = REGISTRY.get(reader_id)
    if reader is None:
        raise ReaderError(
            f"unknown reader id '{reader_id}' (registered: {sorted(REGISTRY)})"
        )
    return reader(source_path)
